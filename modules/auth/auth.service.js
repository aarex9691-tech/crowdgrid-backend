const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('./user.model');
const { ROLES } = require('../../config/roles');
const { HttpError, badRequest, unauthorized, conflict, notFound } = require('../../utils/httpError');
const v = require('../../utils/validate');
const audit = require('../audit/audit.service');
const otp = require('./otp');

const SALT_ROUNDS = 10;
const MIN_AGE = 18;
const MAX_AGE = 120;

/** Age in whole years on today's date in India (birthday not yet reached = one year less). */
function ageOn(isoDay) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
    if (!m) return null;
    const [y, mo, d] = m.slice(1).map(Number);
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null; // e.g. 31 Feb
    const [ty, tm, td] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()).split('-').map(Number);
    let age = ty - y;
    if (tm < mo || (tm === mo && td < d)) age -= 1;
    return age < 0 ? null : age;
}
const MAX_FAILED_LOGINS = 5; // wrong passwords from ONE device before that device is paused
const LOCK_MINUTES = 15;
// Wrong passwords from ALL devices together before the whole account is paused (stops guessing from
// many addresses) - high enough that a stranger cannot lock a pilgrim out of their own phone.
const MAX_ACCOUNT_FAILS = 30;

/** Wrong-password count per account and device; MongoDB deletes rows after the lock window. */
const loginGuardSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    client: { type: String, required: true }, // the device's IP address (behind Render's proxy)
    failed: { type: Number, default: 0 },
    lockUntil: Date,
    expireAt: { type: Date, required: true },
});
loginGuardSchema.index({ userId: 1, client: 1 }, { unique: true });
loginGuardSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
const LoginGuard = mongoose.models.LoginGuard || mongoose.model('LoginGuard', loginGuardSchema);
/**
 * Unknown mobile numbers and emails get their own counters too, under a made-up id derived from what
 * was typed. Then a made-up email is paused after 5 wrong tries exactly like a real one, and the
 * lockout cannot be used to find out which emails or numbers have an account.
 */
const ghostIdFor = (query) =>
    new mongoose.Types.ObjectId(require('crypto').createHash('sha256').update(`cg-login:${JSON.stringify(query)}`).digest().subarray(0, 12));
const MAX_PASSWORD_LENGTH = 128;
const lockedFor = (until) => Math.max(1, Math.ceil((until - Date.now()) / 60000));

const signToken = (user) =>
    jwt.sign({ sub: String(user._id), role: user.role, name: user.name, tv: user.tokenVersion || 0 }, process.env.JWT_SECRET, {
        expiresIn: '7d',
    });

const { phoneError, parseLoginPhone, digits, DEFAULT_CC } = require('../../utils/phone');

/**
 * Query for one mobile number. Accounts created before country codes existed
 * have no countryCode field; they are Indian (+91) numbers.
 */
const phoneQuery = ({ countryCode, phone }) =>
    countryCode === DEFAULT_CC ? { phone, $or: [{ countryCode: DEFAULT_CC }, { countryCode: { $exists: false } }] } : { countryCode, phone };

/** Validates a mobile number for its country; never trims extra digits silently. */
const cleanPhoneOrThrow = (countryCode, phone) => {
    const cc = digits(countryCode) || DEFAULT_CC;
    const n = digits(phone);
    const err = phoneError(cc, n);
    if (err) throw badRequest(err);
    return { countryCode: cc, phone: n };
};

/** New passwords: at least 8 characters with at least one letter and one number. */
const validatePassword = (password) => {
    if (typeof password !== 'string' || password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
        throw badRequest('Password must be at least 8 characters and include a letter and a number');
    }
    if (password.length > 128) throw badRequest('Password is too long');
};

/**
 * Public sign-up. Everyone starts as USER (pilgrim / attendee); any "role"
 * sent by the client is ignored. Higher roles are granted only through
 * approval flows or by the Super Admin (principle of least privilege).
 */
/** Step 1 of sign-up: a one-time code for the mobile number (see otp.js). */
const requestOtp = async ({ phone, countryCode }) => {
    const mobile = cleanPhoneOrThrow(countryCode, phone);
    if (await User.exists(phoneQuery(mobile))) throw conflict('An account with this mobile number already exists. Log in instead.');
    return otp.issue(mobile);
};

/** Sign up with a mobile number only. An email can be added later in the profile, then used to log in. */
const register = async ({ name: rawName, phone, countryCode, password, otp: code }) => {
    const name = v.text(rawName, 'Full name', 'personName', { required: true });
    validatePassword(password);
    const mobile = cleanPhoneOrThrow(countryCode, phone);
    if (await User.exists(phoneQuery(mobile))) throw conflict('An account with this mobile number already exists');
    // Step 2: the number must be verified with the code we sent to it
    await otp.consume(mobile, code);

    const user = await User.create({
        name,
        ...mobile,
        passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
        role: ROLES.USER,
    });
    return { token: signToken(user), user: user.toPublic() };
};

/** Log in with mobile number (or email) and password. */
let dummy;
const dummyHash = async () => (dummy ||= await bcrypt.hash('not-a-real-password', SALT_ROUNDS));
dummyHash().catch(() => {}); // ready before the first login, so that one is not slower either

const login = async ({ phone, email, identifier, countryCode, password, ip }) => {
    const id = String(identifier || phone || email || '').trim();
    if (!id || !password) throw badRequest('Mobile number (or email) and password are required');
    if (id.length > 254) throw unauthorized('Wrong mobile number, email or password');

    // An email (once added in the profile) or the registered mobile number
    const query = id.includes('@') ? { email: id.toLowerCase() } : phoneQuery(parseLoginPhone(id, countryCode));
    const user = await User.findOne(query).select('+passwordHash');
    const guardId = user ? user._id : ghostIdFor(query); // counters for real and made-up identities alike

    // Refuse while this device, or (after very many failures everywhere) the whole account, is paused
    const client = String(ip || 'unknown');
    {
        const now = new Date();
        const accountUntil = user ? user.lockUntil : (await LoginGuard.findOne({ userId: guardId, client: '*' }).lean())?.lockUntil;
        if (accountUntil && accountUntil > now) {
            const mins = lockedFor(accountUntil);
            throw new HttpError(429, `Too many wrong attempts on this account. Try again in ${mins} minute${mins > 1 ? 's' : ''}, or visit a help desk.`);
        }
        const guard = await LoginGuard.findOne({ userId: guardId, client }).lean();
        if (guard?.lockUntil && guard.lockUntil > now) {
            const mins = lockedFor(guard.lockUntil);
            throw new HttpError(429, `Too many wrong attempts from this device. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
        }
    }

    // Always one password check (a stand-in hash for unknown accounts), so the answer takes as long
    // either way: the speed of the reply must not tell which emails or numbers have an account.
    // An absurdly long password is simply wrong (passwords are at most 128 characters).
    const typed = String(password);
    const match = await bcrypt.compare(typed.length > MAX_PASSWORD_LENGTH ? '' : typed, user?.passwordHash || (await dummyHash()));
    const ok = !!user && user.isActive && match && typed.length <= MAX_PASSWORD_LENGTH;
    if (!ok) {
        {
            const lockAt = new Date(Date.now() + LOCK_MINUTES * 60000);
            // Atomic counters, so parallel guesses are all counted
            const guard = await LoginGuard.findOneAndUpdate(
                { userId: guardId, client },
                { $inc: { failed: 1 }, $set: { expireAt: lockAt } },
                { upsert: true, returnDocument: 'after' }
            );
            // all devices together, counted over a rolling 15 minutes (the row expires with the window)
            // A fixed 15-minute window from the first failure. A row whose window is over (but not yet removed
            // by the TTL cleanup, which can lag a minute) starts a new window instead of adding to the old count.
            const live = { $gt: ['$expireAt', new Date()] };
            const account = await LoginGuard.findOneAndUpdate(
                { userId: guardId, client: '*' },
                [{ $set: { failed: { $cond: [live, { $add: [{ $ifNull: ['$failed', 0] }, 1] }, 1] }, expireAt: { $cond: [live, '$expireAt', lockAt] } } }],
                { upsert: true, returnDocument: 'after', updatePipeline: true }
            );
            if (account.failed >= MAX_ACCOUNT_FAILS && !user) {
                // a made-up identity is paused on its counter row (there is no account to mark)
                await LoginGuard.updateOne({ _id: account._id }, { $set: { failed: 0, lockUntil: lockAt, expireAt: lockAt } });
                throw new HttpError(429, `Too many wrong attempts on this account. Try again in ${LOCK_MINUTES} minutes, or visit a help desk.`);
            }
            if (account.failed >= MAX_ACCOUNT_FAILS) {
                await User.updateOne({ _id: user._id }, { $set: { lockUntil: lockAt } });
                await LoginGuard.deleteOne({ _id: account._id });
                audit.record({
                    actor: null,
                    action: 'ACCOUNT_LOCKED',
                    targetType: 'User',
                    targetId: user._id,
                    summary: `Account ${user.name} paused for ${LOCK_MINUTES} min after ${MAX_ACCOUNT_FAILS} wrong passwords from several devices`,
                });
                throw new HttpError(429, `Too many wrong attempts on this account. Try again in ${LOCK_MINUTES} minutes, or visit a help desk.`);
            }
            if (guard.failed >= MAX_FAILED_LOGINS) {
                await LoginGuard.updateOne({ _id: guard._id }, { $set: { failed: 0, lockUntil: lockAt, expireAt: lockAt } });
                throw new HttpError(429, `Too many wrong attempts from this device. Try again in ${LOCK_MINUTES} minutes.`);
            }
        }
        // Same message for unknown user and wrong password, so attackers cannot probe accounts
        throw unauthorized('Wrong mobile number, email or password');
    }
    await LoginGuard.deleteMany({ userId: user._id, client: { $in: [client, '*'] } });

    if (user.failedLogins || user.lockUntil) {
        await User.updateOne({ _id: user._id }, { $unset: { failedLogins: 1, lockUntil: 1 } });
    }
    return { token: signToken(user), user: user.toPublic() };
};

const me = async (userId) => {
    const user = await User.findById(userId).populate('providerId', 'name verificationStatus eventId');
    if (!user) throw notFound('User not found');
    return { ...user.toPublic(), provider: user.providerId };
};

/** Invalidates every token this user has (all devices), then issues a fresh one for this device. */
const logoutAll = async (user) => {
    const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { tokenVersion: 1 } }, { returnDocument: 'after' });
    audit.record({ actor: user, action: 'LOGOUT_ALL_DEVICES', targetType: 'User', targetId: user._id, summary: `${user.name} logged out of all devices` });
    return { message: 'Logged out of all other devices', token: signToken(updated) };
};

/** Super Admin creates staff accounts (Authority, Corporate Admin, Volunteer, Super Admin). */
const createStaff = async ({ name, phone, countryCode, email, password, role, providerId, organisationName }, actor) => {
    const allowed = [ROLES.SUPER_ADMIN, ROLES.AUTHORITY, ROLES.CORPORATE_ADMIN, ROLES.EVENT_HOST, ROLES.ORG_HOST, ROLES.VOLUNTEER, ROLES.NGO_ADMIN];
    if (!allowed.includes(role)) throw badRequest(`Role must be one of ${allowed.join(', ')}`);
    validatePassword(password);
    const mobile = cleanPhoneOrThrow(countryCode, phone);
    if (await User.exists(phoneQuery(mobile))) throw conflict('An account with this mobile number already exists');
    const user = await User.create({
        name,
        ...mobile,
        email: email || undefined,
        passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
        role,
        providerId: providerId || null,
        // event hosts made directly by the Super Admin carry their organisation's name (shown on their events)
        ...([ROLES.CORPORATE_ADMIN, ROLES.EVENT_HOST, ROLES.ORG_HOST].includes(role) && organisationName ? { organisationName: v.text(organisationName, 'Organisation name', 'orgName', { required: true }) } : {}),
    });
    audit.record({ actor, action: 'STAFF_CREATED', targetType: 'User', targetId: user._id, summary: `${actor?.name || 'Admin'} created ${role} account for ${user.name}` });
    return user.toPublic();
};

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const GENDERS = ['FEMALE', 'MALE', 'OTHER'];

/**
 * Edit profile: name, email, date of birth, gender, city, emergency contact.
 * A field sent empty is removed from the database rather than stored blank.
 */
const updateProfile = async (user, body = {}) => {
    const set = {};
    const unset = {};
    const put = (k, v) => {
        if (v === undefined) return;
        if (v === null || v === '') unset[k] = 1;
        else set[k] = v;
    };

    if (body.name !== undefined) {
        set.name = v.text(body.name, 'Full name', 'personName', { required: true });
    }
    if (body.email !== undefined) {
        const email = String(body.email || '').trim().toLowerCase();
        if (email.length > 254 || (email && !EMAIL_RE.test(email))) throw badRequest('Enter a valid email address');
        const current = (await User.findById(user._id, 'email').lean())?.email || '';
        if (email && email !== current) {
            // At most 5 tries a day to set a new email (counted before the "already used" check),
            // so the profile cannot be used to test which emails are registered.
            const since = new Date(Date.now() - 24 * 3600 * 1000);
            const allowed = await User.findOneAndUpdate(
                { _id: user._id, $expr: { $lt: [{ $size: { $filter: { input: { $ifNull: ['$emailChangesAt', []] }, cond: { $gt: ['$$this', since] } } } }, 5] } },
                [{ $set: { emailChangesAt: { $concatArrays: [{ $filter: { input: { $ifNull: ['$emailChangesAt', []] }, cond: { $gt: ['$$this', since] } } }, [new Date()]] } } }],
                { updatePipeline: true, projection: { _id: 1 } }
            );
            if (!allowed) throw new HttpError(429, 'You can change your email 5 times a day. Try again tomorrow.');
            if (await User.exists({ email, _id: { $ne: user._id } })) throw conflict('This email is already used by another account');
        }
        put('email', email);
    }
    if (body.dateOfBirth !== undefined) {
        const raw = String(body.dateOfBirth || '');
        if (raw) {
            const age = ageOn(raw);
            if (age === null || age > MAX_AGE) throw badRequest('Enter a valid date of birth');
            if (age < MIN_AGE) throw badRequest(`You must be at least ${MIN_AGE} years old to use CrowdGrid`);
            put('dateOfBirth', new Date(`${raw}T00:00:00+05:30`));
        } else put('dateOfBirth', '');
    }
    if (body.gender !== undefined) {
        const g = String(body.gender || '').toUpperCase();
        if (g && !GENDERS.includes(g)) throw badRequest('Gender must be Female, Male or Other');
        put('gender', g);
    }
    if (body.city !== undefined) {
        put('city', v.text(body.city, 'City', 'city') || '');
    }
    if (body.emergencyContact !== undefined) {
        const ec = body.emergencyContact || {};
        const n = v.text(ec.name, 'Emergency contact name', { min: 2, max: 60, kind: 'name' });
        const contact = v.mobile(ec.countryCode, ec.phone, 'Emergency contact number');
        if (!n && !contact) unset.emergencyContact = 1;
        else {
            if (!contact) throw badRequest('Add the emergency contact\'s mobile number');
            if (contact.phone === user.phone && contact.countryCode === (user.countryCode || '91')) {
                throw badRequest('The emergency contact must be someone else, not your own number');
            }
            set.emergencyContact = { name: n, countryCode: contact.countryCode, phone: contact.phone };
        }
    }
    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    if (!Object.keys(update).length) throw badRequest('Nothing to update');
    const updated = await User.findByIdAndUpdate(user._id, update, { returnDocument: 'after', runValidators: true });
    return updated.toPublic();
};

/**
 * The account holder sets a new password (needed after a help desk reset, also usable any time).
 * Every other device is logged out; this device gets a fresh token.
 */
const changePassword = async (actor, { currentPassword, newPassword }) => {
    const user = await User.findById(actor._id).select('+passwordHash');
    if (!user) throw notFound('User not found');
    if (!currentPassword || !(await bcrypt.compare(String(currentPassword), user.passwordHash))) {
        throw badRequest(user.mustChangePassword ? 'The temporary password is not right. Type it exactly as the help desk gave it.' : 'Your current password is not right');
    }
    validatePassword(newPassword);
    if (await bcrypt.compare(String(newPassword), user.passwordHash)) throw badRequest('Choose a new password, not the one you have now');
    user.passwordHash = await bcrypt.hash(String(newPassword), SALT_ROUNDS);
    user.mustChangePassword = undefined;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    audit.record({ actor: user, action: 'PASSWORD_CHANGED', targetType: 'User', targetId: user._id, summary: `${user.name} set a new password` });
    return { message: 'Password changed. Other devices have been logged out.', token: signToken(user), user: user.toPublic() };
};

module.exports = {
    LoginGuard, requestOtp, register, login, me, createStaff, logoutAll, updateProfile, changePassword, ageOn, MIN_AGE, SALT_ROUNDS, phoneQuery, cleanPhoneOrThrow };
