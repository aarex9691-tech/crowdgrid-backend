const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('./user.model');
const { ROLES } = require('../../config/roles');
const { badRequest, unauthorized, conflict, notFound } = require('../../utils/httpError');

const SALT_ROUNDS = 10;

const signToken = (user) =>
    jwt.sign({ sub: String(user._id), role: user.role, name: user.name }, process.env.JWT_SECRET, {
        expiresIn: '7d',
    });

const normalisePhone = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

const validatePassword = (password) => {
    if (typeof password !== 'string' || password.length < 6) {
        throw badRequest('Password must be at least 6 characters');
    }
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
    // Same message for unknown user and wrong password, so attackers cannot probe accounts
    if (!user || !user.isActive || !(await bcrypt.compare(String(password), user.passwordHash))) {
        throw unauthorized('Invalid mobile number or password');
    }
    return { token: signToken(user), user: user.toPublic() };
};

const me = async (userId) => {
    const user = await User.findById(userId).populate('providerId', 'name verificationStatus eventId');
    if (!user) throw notFound('User not found');
    return { ...user.toPublic(), provider: user.providerId };
};

/** Super Admin creates staff accounts (Authority, Corporate Admin, Volunteer, Super Admin). */
const createStaff = async ({ name, phone, email, password, role, providerId }) => {
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
    return user.toPublic();
};

module.exports = { register, login, me, createStaff, SALT_ROUNDS };
