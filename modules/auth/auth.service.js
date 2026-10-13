const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('./user.model');
const { ROLES } = require('../../config/roles');
const { HttpError, badRequest, unauthorized, conflict, notFound } = require('../../utils/httpError');
const audit = require('../audit/audit.service');

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
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

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
const register = async ({ name, phone, countryCode, email, password }) => {
    validatePassword(password);
    const mobile = cleanPhoneOrThrow(countryCode, phone);
    if (await User.exists(phoneQuery(mobile))) throw conflict('An account with this mobile number already exists');
    if (email && (await User.exists({ email: String(email).toLowerCase() }))) {
        throw conflict('An account with this email already exists');
    }

    const user = await User.create({
        name,
        ...mobile,
        email: email || undefined,
        passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
        role: ROLES.USER,
    });
    return { token: signToken(user), user: user.toPublic() };
};

/** Log in with mobile number (or email) and password. */
const login = async ({ phone, email, identifier, countryCode, password }) => {
    const id = String(identifier || phone || email || '').trim();
    if (!id || !password) throw badRequest('Mobile number and password are required');

    const query = id.includes('@') ? { email: id.toLowerCase() } : phoneQuery(parseLoginPhone(id, countryCode));
    const user = await User.findOne(query).select('+passwordHash');

    // Account lockout: refuse while locked, even if the password is right
    if (user && user.lockUntil && user.lockUntil > new Date()) {
        const mins = Math.ceil((user.lockUntil - Date.now()) / 60000);
        throw new HttpError(429, `Too many wrong attempts. This account is locked for ${mins} more minute${mins > 1 ? 's' : ''}.`);
    }

    const ok = user && user.isActive && (await bcrypt.compare(String(password), user.passwordHash));
    if (!ok) {
        if (user) {
            // Atomic counter, so parallel guesses are all counted
            const updated = await User.findOneAndUpdate(
                { _id: user._id },
                { $inc: { failedLogins: 1 } },
                { returnDocument: 'after' }
            );
            if (updated.failedLogins >= MAX_FAILED_LOGINS) {
                await User.updateOne(
                    { _id: user._id },
                    { $set: { failedLogins: 0, lockUntil: new Date(Date.now() + LOCK_MINUTES * 60000) } }
                );
                audit.record({
                    actor: null,
                    action: 'ACCOUNT_LOCKED',
                    targetType: 'User',
                    targetId: user._id,
                    summary: `Account ${user.name} locked for ${LOCK_MINUTES} min after ${MAX_FAILED_LOGINS} wrong passwords`,
                });
                throw new HttpError(429, `Too many wrong attempts. This account is locked for ${LOCK_MINUTES} minutes.`);
            }
        }
        // Same message for unknown user and wrong password, so attackers cannot probe accounts
        throw unauthorized('Invalid mobile number or password');
    }

    if (user.failedLogins || user.lockUntil) {
        await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0 }, $unset: { lockUntil: 1 } });
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
const createStaff = async ({ name, phone, countryCode, email, password, role, providerId }, actor) => {
    const allowed = [ROLES.SUPER_ADMIN, ROLES.AUTHORITY, ROLES.CORPORATE_ADMIN, ROLES.VOLUNTEER, ROLES.NGO_ADMIN];
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
        const name = String(body.name).trim();
        if (name.length < 2 || name.length > 80) throw badRequest('Name must be 2 to 80 characters');
        set.name = name;
    }
    if (body.email !== undefined) {
        const email = String(body.email || '').trim().toLowerCase();
        if (email && !EMAIL_RE.test(email)) throw badRequest('Enter a valid email address');
        if (email && (await User.exists({ email, _id: { $ne: user._id } }))) throw conflict('This email is already used by another account');
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
        const c = String(body.city || '').trim();
        if (c.length > 60) throw badRequest('City can be at most 60 characters');
        put('city', c);
    }
    if (body.emergencyContact !== undefined) {
        const n = String(body.emergencyContact?.name || '').trim();
        const ph = String(body.emergencyContact?.phone || '').replace(/\D/g, '');
        if (!n && !ph) unset.emergencyContact = 1;
        else {
            if (!/^\d{10}$/.test(ph)) throw badRequest('Emergency contact number must be 10 digits');
            if (n.length > 60) throw badRequest('Emergency contact name can be at most 60 characters');
            set.emergencyContact = { name: n || undefined, phone: ph };
        }
    }
    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    if (!Object.keys(update).length) throw badRequest('Nothing to update');
    const updated = await User.findByIdAndUpdate(user._id, update, { returnDocument: 'after', runValidators: true });
    return updated.toPublic();
};

module.exports = { register, login, me, createStaff, logoutAll, updateProfile, ageOn, MIN_AGE, SALT_ROUNDS };
