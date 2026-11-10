const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('./user.model');
const audit = require('../audit/audit.service');
const { ROLES } = require('../../config/roles');
const { SALT_ROUNDS, phoneQuery, cleanPhoneOrThrow } = require('./auth.service');
const { badRequest, forbidden, notFound } = require('../../utils/httpError');

/**
 * Help desk password reset (no SMS needed).
 * A pilgrim who forgot their password goes to a help desk with an ID. Staff look the account up
 * by mobile number, check the name against the ID, and give a temporary password. All the
 * account's devices are logged out, and it must set its own password at the next login.
 *
 * Authority staff can reset pilgrim (USER) accounts. The Super Admin can reset any account
 * except other Super Admins and their own.
 */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: easy to read out and type
const DIGITS = '23456789'; // no 0 or 1
const pick = (set, n) => Array.from({ length: n }, () => set[crypto.randomInt(set.length)]).join('');
/** e.g. "KTRM-4827": letters and digits, so it passes the normal password rule. */
const tempPassword = () => `${pick(LETTERS, 4)}-${pick(DIGITS, 4)}`;

const maskPhone = (cc, phone) => `+${cc || '91'} ${'*'.repeat(Math.max(0, String(phone).length - 4))}${String(phone).slice(-4)}`;

const canReset = (actor, target) => {
    if (String(actor._id) === String(target._id)) return 'Use "Change password" in your own profile instead';
    if (actor.role === ROLES.SUPER_ADMIN) return target.role === ROLES.SUPER_ADMIN ? 'Another Super Admin account cannot be reset here' : '';
    if (actor.role === ROLES.AUTHORITY) return target.role === ROLES.USER ? '' : 'Only pilgrim accounts can be reset at the help desk. Staff accounts are reset by the Super Admin.';
    return 'Your role cannot reset passwords';
};

const shape = (actor, u) => ({
    _id: u._id,
    name: u.name,
    role: u.role,
    phone: maskPhone(u.countryCode, u.phone),
    city: u.city,
    locked: !!(u.lockUntil && u.lockUntil > new Date()),
    waitingForNewPassword: !!u.mustChangePassword,
    canReset: !canReset(actor, u),
    reason: canReset(actor, u) || undefined,
});

/** Finds the account for a mobile number (exact match only, no browsing). */
const lookup = async (actor, { countryCode, phone }) => {
    const mobile = cleanPhoneOrThrow(countryCode, phone);
    const u = await User.findOne(phoneQuery(mobile)).lean();
    if (!u) throw notFound('No account uses this mobile number');
    return shape(actor, u);
};

const reset = async (actor, userId) => {
    const u = await User.findById(userId);
    if (!u) throw notFound('Account not found');
    if (!u.isActive) throw badRequest('This account is disabled');
    const why = canReset(actor, u);
    if (why) throw forbidden(why);

    const temp = tempPassword();
    u.passwordHash = await bcrypt.hash(temp, SALT_ROUNDS);
    u.mustChangePassword = true;
    u.tokenVersion = (u.tokenVersion || 0) + 1; // logs out every device
    u.failedLogins = undefined;
    u.lockUntil = undefined;
    await u.save();
    await audit.record({
        actor,
        action: 'PASSWORD_RESET_BY_STAFF',
        targetType: 'User',
        targetId: u._id,
        summary: `${actor.name} reset the password of ${u.name} (${maskPhone(u.countryCode, u.phone)}) at the help desk`,
    });
    return {
        tempPassword: temp,
        account: shape(actor, u.toObject()),
        message: `Give this temporary password to ${u.name}. They must set their own password when they log in. All their devices have been logged out.`,
    };
};

module.exports = { lookup, reset, tempPassword, canReset };
