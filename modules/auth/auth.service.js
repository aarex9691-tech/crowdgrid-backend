const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('./user.model');
const { ROLES } = require('../../config/roles');
const { HttpError, badRequest, unauthorized, conflict, notFound } = require('../../utils/httpError');
const audit = require('../audit/audit.service');

const SALT_ROUNDS = 10;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

const signToken = (user) =>
    jwt.sign({ sub: String(user._id), role: user.role, name: user.name, tv: user.tokenVersion || 0 }, process.env.JWT_SECRET, {
        expiresIn: '7d',
    });

const normalisePhone = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

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
const register = async ({ name, phone, email, password }) => {
    validatePassword(password);
    const cleanPhone = normalisePhone(phone);
    if (await User.exists({ phone: cleanPhone })) throw conflict('An account with this mobile number already exists');
    if (email && (await User.exists({ email: String(email).toLowerCase() }))) {
        throw conflict('An account with this email already exists');
    }

    const user = await User.create({
        name,
        phone: cleanPhone,
        email: email || undefined,
        passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
        role: ROLES.USER,
    });
    return { token: signToken(user), user: user.toPublic() };
};

/** Log in with mobile number (or email) and password. */
const login = async ({ phone, email, identifier, password }) => {
    const id = String(identifier || phone || email || '').trim();
    if (!id || !password) throw badRequest('Mobile number and password are required');

    const query = id.includes('@') ? { email: id.toLowerCase() } : { phone: normalisePhone(id) };
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
const createStaff = async ({ name, phone, email, password, role, providerId }, actor) => {
    const allowed = [ROLES.SUPER_ADMIN, ROLES.AUTHORITY, ROLES.CORPORATE_ADMIN, ROLES.VOLUNTEER, ROLES.NGO_ADMIN];
    if (!allowed.includes(role)) throw badRequest(`Role must be one of ${allowed.join(', ')}`);
    validatePassword(password);
    const cleanPhone = normalisePhone(phone);
    if (await User.exists({ phone: cleanPhone })) throw conflict('An account with this mobile number already exists');
    const user = await User.create({
        name,
        phone: cleanPhone,
        email: email || undefined,
        passwordHash: await bcrypt.hash(password, SALT_ROUNDS),
        role,
        providerId: providerId || null,
    });
    audit.record({ actor, action: 'STAFF_CREATED', targetType: 'User', targetId: user._id, summary: `${actor?.name || 'Admin'} created ${role} account for ${user.name}` });
    return user.toPublic();
};

module.exports = { register, login, me, createStaff, logoutAll, SALT_ROUNDS };
