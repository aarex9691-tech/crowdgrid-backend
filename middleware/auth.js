const jwt = require('jsonwebtoken');
const User = require('../modules/auth/user.model');
const { hasPermission } = require('../config/roles');
const { HttpError, unauthorized, forbidden } = require('../utils/httpError');

const readToken = (req) => {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7) : null;
};

/**
 * Verifies the JWT and loads the user from the database, so a role change
 * (e.g. an NGO getting verified) takes effect immediately, and a deleted or
 * deactivated account stops working even if its token has not expired.
 */
const loadUser = async (token) => {
    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        throw unauthorized('Session expired or invalid. Please log in again.');
    }
    const user = await User.findById(decoded.sub).lean();
    if (!user || !user.isActive) throw unauthorized('Account not found or disabled');
    // "Log out of all devices" bumps tokenVersion; older tokens are rejected
    if ((decoded.tv || 0) !== (user.tokenVersion || 0)) throw unauthorized('You were logged out. Please log in again.');
    return {
        _id: user._id,
        id: String(user._id),
        name: user.name,
        countryCode: user.countryCode || '91',
        phone: user.phone,
        role: user.role,
        providerId: user.providerId || null,
        mustChangePassword: !!user.mustChangePassword,
    };
};

// While an account still has a temporary password from the help desk, only these work
const ALLOWED_BEFORE_NEW_PASSWORD = [/\/auth\/me$/, /\/auth\/password$/];
const passwordGate = (req) => {
    if (!req.user?.mustChangePassword) return;
    const path = (req.originalUrl || '').split('?')[0];
    if (ALLOWED_BEFORE_NEW_PASSWORD.some((re) => re.test(path))) return;
    throw new HttpError(403, 'Set a new password first. You are using a temporary password from the help desk.', { code: 'PASSWORD_CHANGE_REQUIRED' });
};

const requireAuth = async (req, res, next) => {
    const token = readToken(req);
    if (!token) throw unauthorized('Please log in to continue');
    req.user = await loadUser(token);
    passwordGate(req);
    next();
};

/** Attaches req.user when a valid token is present; never blocks. */
const optionalAuth = async (req, res, next) => {
    const token = readToken(req);
    if (token) {
        try {
            req.user = await loadUser(token);
        } catch {
            req.user = null;
        }
    }
    next();
};

/** Allows the request only if the user's role holds the permission (see config/roles.js). */
const requirePermission = (permission) => (req, res, next) => {
    if (!req.user) throw unauthorized();
    if (!hasPermission(req.user.role, permission)) throw forbidden();
    next();
};

module.exports = { requireAuth, optionalAuth, requirePermission, loadUser };
