const { Pass } = require('./pass.model');
const passToken = require('../../utils/passToken');
const { ROLES } = require('../../config/roles');
const { badRequest } = require('../../utils/httpError');

/** Creates a pass (inside the caller's transaction when `session` is given). */
const issuePass = async (data, session = null) => {
    const [pass] = await Pass.create([{ ...data, nonce: passToken.newNonce() }], { session });
    return pass;
};

/** Shape sent to the client: the pass plus its signed QR payload. */
const toClient = (pass) => {
    const p = pass.toObject ? pass.toObject() : pass;
    const now = Date.now();
    let state = p.status;
    if (p.status === 'ACTIVE' && new Date(p.validUntil).getTime() < now) state = 'EXPIRED';
    else if (p.status === 'ACTIVE' && new Date(p.validFrom).getTime() > now) state = 'UPCOMING';
    const { nonce, dedupeKey, ...rest } = p;
    return { ...rest, state, qr: p.status === 'ACTIVE' ? passToken.encode(p) : null };
};

const listMine = async (userId) => {
    const passes = await Pass.find({ userId, status: { $ne: 'CANCELLED' } })
        .populate('eventId', 'title city slug')
        .sort({ validFrom: 1 })
        .lean();
    return passes.map(toClient);
};

const summary = (pass) => ({
    _id: pass._id,
    type: pass.type,
    title: pass.title,
    subtitle: pass.subtitle,
    details: pass.details,
    holder: pass.userId && pass.userId.name ? { name: pass.userId.name, phone: maskPhone(pass.userId.phone) } : undefined,
    validFrom: pass.validFrom,
    validUntil: pass.validUntil,
    redeemedAt: pass.redeemedAt,
});

const maskPhone = (phone) => (phone ? `${'*'.repeat(6)}${String(phone).slice(-4)}` : undefined);

/**
 * Ground staff scan.
 *  1. Verify the HMAC signature (rejects counterfeit / edited QRs without a DB hit)
 *  2. Atomically flip ACTIVE -> REDEEMED, only if the pass is inside its validity
 *     window. Two volunteers scanning the same QR at the same moment: only one
 *     update can match, the other gets "already used".
 */
const scan = async (qr, scanner) => {
    const decoded = passToken.decode(qr);
    if (!decoded) return { result: 'REJECTED', reason: 'FAKE', message: 'Invalid or tampered QR code' };

    const now = new Date();
    const pass = await Pass.findById(decoded.passId).populate('userId', 'name phone').lean();
    if (!pass || pass.nonce !== decoded.nonce) {
        return { result: 'REJECTED', reason: 'NOT_FOUND', message: 'Pass not found' };
    }

    // NGO admins may only redeem passes for their own camps / kitchens
    if (scanner.role === ROLES.NGO_ADMIN && pass.providerId && String(pass.providerId) !== String(scanner.providerId)) {
        return { result: 'REJECTED', reason: 'WRONG_PROVIDER', message: 'This pass belongs to another camp or kitchen', pass: summary(pass) };
    }

    if (pass.status === 'CANCELLED') return { result: 'REJECTED', reason: 'CANCELLED', message: 'Pass was cancelled', pass: summary(pass) };
    if (now < pass.validFrom) return { result: 'REJECTED', reason: 'NOT_YET_VALID', message: `Not valid until ${fmt(pass.validFrom)}`, pass: summary(pass) };
    if (now > pass.validUntil) return { result: 'REJECTED', reason: 'EXPIRED', message: `Expired at ${fmt(pass.validUntil)}`, pass: summary(pass) };

    // Verify-only credentials (volunteer ID) are never used up
    if (!pass.singleUse) {
        if (pass.status !== 'ACTIVE') return { result: 'REJECTED', reason: 'INACTIVE', message: 'Credential is not active', pass: summary(pass) };
        return { result: 'VALID', message: 'VALID - ID VERIFIED', pass: summary(pass) };
    }

    const redeemed = await Pass.findOneAndUpdate(
        { _id: pass._id, status: 'ACTIVE', validFrom: { $lte: now }, validUntil: { $gte: now } },
        { $set: { status: 'REDEEMED', redeemedAt: now, redeemedBy: scanner._id } },
        { returnDocument: 'after' }
    )
        .populate('userId', 'name phone')
        .lean();

    if (!redeemed) {
        const latest = await Pass.findById(pass._id).lean();
        return {
            result: 'REJECTED',
            reason: 'ALREADY_USED',
            message: latest && latest.redeemedAt ? `Already used at ${fmt(latest.redeemedAt)}` : 'Pass already used',
            pass: summary(pass),
        };
    }
    return { result: 'VALID', message: 'VALID - CHECKED IN', pass: summary(redeemed) };
};

const fmt = (d) =>
    new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Cancels a pass and frees its dedupe key so the user can claim again. */
const cancelPass = async (passId, session = null) => {
    if (!passId) return;
    await Pass.updateOne({ _id: passId, status: 'ACTIVE' }, { $set: { status: 'CANCELLED' }, $unset: { dedupeKey: 1 } }, { session });
};

const requireQr = (qr) => {
    if (typeof qr !== 'string' || !qr.trim()) throw badRequest('QR payload is required');
    return qr.trim();
};

module.exports = { issuePass, toClient, listMine, scan, cancelPass, requireQr };
