const jwt = require('jsonwebtoken');
const User = require('../modules/auth/user.model');
const { hasPermission } = require('../config/roles');
const { unauthorized, forbidden } = require('../utils/httpError');

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
    return {
        _id: user._id,
        id: String(user._id),
        name: user.name,
        phone: user.phone,
        role: user.role,
        providerId: user.providerId || null,
    };
};

const requireAuth = async (req, res, next) => {
    const token = readToken(req);
    if (!token) throw unauthorized('Please log in to continue');
    req.user = await loadUser(token);
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

module.exports = { requireAuth, optionalAuth, requirePermission };
