const { Pass } = require('./pass.model');
const passToken = require('../../utils/passToken');
const { ROLES } = require('../../config/roles');
const { badRequest } = require('../../utils/httpError');
const User = require('../auth/user.model');
const audit = require('../audit/audit.service');

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
/** Scan with an audit trail of every accepted and rejected pass. */
const scan = async (qr, scanner, opts = {}) => {
    const result = await scanPass(qr, scanner, opts);
    if (result.result === 'CHOOSE') return result; // nothing decided yet
    audit.record({
        actor: scanner,
        action: result.result === 'VALID' ? 'PASS_ACCEPTED' : 'PASS_REJECTED',
        targetType: 'Pass',
        targetId: result.pass?._id,
        summary: `${scanner.name} scanned ${result.pass ? `"${result.pass.title}"` : 'a QR code'}: ${result.result === 'VALID' ? 'valid' : result.reason?.toLowerCase().replace(/_/g, ' ')}`,
        meta: { reason: result.reason },
    });
    return result;
};

const scanPass = async (qr, scanner, opts = {}) => {
    if (passToken.isUserQr(qr)) return scanPersonal(qr, scanner, opts);
    const decoded = passToken.decode(qr);
    if (!decoded) return { result: 'REJECTED', reason: 'FAKE', message: 'Invalid or tampered QR code' };

    const pass = await Pass.findById(decoded.passId).populate('userId', 'name countryCode phone').lean();
    if (!pass || pass.nonce !== decoded.nonce) {
        return { result: 'REJECTED', reason: 'NOT_FOUND', message: 'Pass not found' };
    }
    return redeem(pass, scanner);
};

/** Checks scope and validity, then redeems the pass atomically (single use). */
const redeem = async (pass, scanner) => {
    const now = new Date();
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
        .populate('userId', 'name countryCode phone')
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

/** Which pass types each scanning point accepts. */
const SERVICE_TYPES = {
    ANY: null,
    FOOD: ['MEAL'],
    LODGING: ['LODGING'],
    TRANSIT: ['TRANSIT'],
    ENTRY: ['PUBLIC', 'CORPORATE'],
    VOLUNTEER: ['VOLUNTEER'],
};

/**
 * One QR per person. The scanner says where it is (food counter, camp gate,
 * bus gate, event entry); the server finds that person's passes that are valid
 * here and now, and redeems the matching one. Each pass is still single use.
 * When two passes match (e.g. two camps), the volunteer picks one.
 */
const scanPersonal = async (qr, scanner, { service = 'ANY', passId } = {}) => {
    const decoded = passToken.decodeUser(qr);
    if (!decoded) return { result: 'REJECTED', reason: 'FAKE', message: 'Invalid or tampered QR code' };
    const holder = await User.findById(decoded.userId).select('+qrNonce name countryCode phone isActive').lean();
    if (!holder || !holder.isActive || holder.qrNonce !== decoded.nonce) {
        return { result: 'REJECTED', reason: 'REVOKED', message: 'This personal QR was reset or is no longer valid. Ask for the new one.' };
    }
    const person = { name: holder.name, phone: maskPhone(holder.phone) };

    const now = new Date();
    const filter = { userId: holder._id, status: 'ACTIVE', validFrom: { $lte: now }, validUntil: { $gte: now } };
    const types = SERVICE_TYPES[String(service).toUpperCase()] ?? null;
    if (types) filter.type = { $in: types };
    if (scanner.role === ROLES.CORPORATE_ADMIN) filter.type = { $in: ['CORPORATE'] };
    // NGO admins only redeem passes for their own camps / kitchens (or passes with no provider)
    if (scanner.role === ROLES.NGO_ADMIN) {
        filter.$or = [{ providerId: scanner.providerId || null }, { providerId: null }, { providerId: { $exists: false } }];
    }
    let candidates = await Pass.find(filter).sort({ validUntil: 1 }).populate('userId', 'name countryCode phone').lean();

    if (passId) {
        candidates = candidates.filter((p) => String(p._id) === String(passId));
        if (!candidates.length) return { result: 'REJECTED', reason: 'NOT_FOUND', message: 'That pass is no longer valid', holder: person };
    }
    if (!candidates.length) {
        return { result: 'REJECTED', reason: 'NO_VALID_PASS', message: 'No valid pass for this counter right now', holder: person };
    }
    if (candidates.length > 1) {
        return { result: 'CHOOSE', message: `${holder.name} has ${candidates.length} valid passes here. Choose one.`, holder: person, options: candidates.map(summary) };
    }
    return redeem(candidates[0], scanner);
};

/** The person's own QR (created on first use). reset=true issues a new one and kills old copies. */
const myQr = async (user, { reset = false } = {}) => {
    let doc = await User.findById(user._id).select('+qrNonce').lean();
    if (!doc.qrNonce || reset) {
        const nonce = passToken.newNonce();
        await User.updateOne({ _id: user._id }, { $set: { qrNonce: nonce } });
        doc = { ...doc, qrNonce: nonce };
        if (reset) audit.record({ actor: user, action: 'PERSONAL_QR_RESET', targetType: 'User', targetId: user._id, summary: `${user.name} reset their personal QR` });
    }
    return { qr: passToken.encodeUser(String(user._id), doc.qrNonce) };
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

module.exports = { issuePass, toClient, listMine, scan, cancelPass, requireQr, myQr, SERVICE_TYPES };
