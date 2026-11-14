const { Pass } = require('./pass.model');
const passToken = require('../../utils/passToken');
const { ROLES } = require('../../config/roles');
const { badRequest } = require('../../utils/httpError');
const realtime = require('../../utils/realtime');
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
    // cancelled passes stay visible for 30 days so the refund can be seen
    const since = new Date(Date.now() - 30 * 86400000);
    const passes = await Pass.find({ userId, $or: [{ status: { $ne: 'CANCELLED' } }, { cancelledAt: { $gte: since } }] })
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
    holder: pass.userId && pass.userId.name ? { name: pass.userId.name, phone: maskPhone(pass.userId.phone), photoUrl: photoUrlFor(pass.userId.photoKey) } : undefined,
    validFrom: pass.validFrom,
    validUntil: pass.validUntil,
    redeemedAt: pass.redeemedAt,
});

const { photoUrlFor } = require('../auth/avatar');
const Event = require('../event/event.model');

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

    const pass = await Pass.findById(decoded.passId).populate('userId', 'name countryCode phone photoKey').lean();
    if (!pass || pass.nonce !== decoded.nonce) {
        return { result: 'REJECTED', reason: 'NOT_FOUND', message: 'Pass not found' };
    }
    return redeem(pass, scanner);
};

/** Events this corporate admin organises (their desk may only check badges for these). */
/** The pass types each organisation host may check in: its own kind of event only. */
const HOST_PASS_TYPES = { [ROLES.CORPORATE_ADMIN]: ['CORPORATE'], [ROLES.EVENT_HOST]: ['PUBLIC'], [ROLES.ORG_HOST]: ['PUBLIC', 'CORPORATE'] };

const ownEventIds = async (scanner) => (await Event.find({ organizerId: scanner._id }).select('_id').lean()).map((e) => String(e._id));

/**
 * Who may redeem which pass:
 *  - NGO admins, and volunteers who serve an NGO, only passes of that NGO's camps and kitchens;
 *  - corporate admins only badges for their own events (never a pilgrim's meal, stay or bus pass);
 *  - the control room and general volunteers, any pass.
 * Returns a REJECTED result, or null when the scanner may redeem it.
 */
const scopeError = async (pass, scanner) => {
    const servesNgo = scanner.role === ROLES.NGO_ADMIN || (scanner.role === ROLES.VOLUNTEER && scanner.providerId);
    if (servesNgo && pass.providerId && String(pass.providerId) !== String(scanner.providerId)) {
        return { result: 'REJECTED', reason: 'WRONG_PROVIDER', message: 'This pass belongs to another camp or kitchen', pass: summary(pass) };
    }
    const hostTypes = HOST_PASS_TYPES[scanner.role];
    if (hostTypes) {
        // organisation hosts check in their own events only: tickets / badges, never stays, meals or buses
        if (!hostTypes.includes(pass.type)) {
            return { result: 'REJECTED', reason: 'WRONG_SERVICE', message: 'This desk checks event entry only. Send them to the right counter.', pass: summary(pass) };
        }
        if (!(await Event.exists({ _id: pass.eventId, organizerId: scanner._id }))) {
            return { result: 'REJECTED', reason: 'WRONG_EVENT', message: 'This pass is for another organiser\'s event', pass: summary(pass) };
        }
    }
    return null;
};

/** Checks scope and validity, then redeems the pass atomically (single use). */
const redeem = async (pass, scanner) => {
    const now = new Date();
    const outOfScope = await scopeError(pass, scanner);
    if (outOfScope) return outOfScope;

    if (pass.status === 'CANCELLED') return { result: 'REJECTED', reason: 'CANCELLED', message: `This pass was cancelled on ${fmt(pass.updatedAt)}. Do not let them in.`, pass: summary(pass) };
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
        .populate('userId', 'name countryCode phone photoKey')
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
    // Live update: check-in and meal counters in the control room and the NGO portal
    realtime.notify(['control', redeemed.providerId && `provider:${redeemed.providerId}`], 'scan', { type: redeemed.type });
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
/**
 * Static personal QRs (CGU, the same picture every time) can be screenshotted and
 * shared. Live QRs (CGL) change every 30 s. STATIC_PERSONAL_QR=deny refuses static
 * ones; the default accepts them but tells the volunteer to check the person's ID.
 */
const staticAllowed = () => process.env.STATIC_PERSONAL_QR !== 'deny';

const scanPersonal = async (qr, scanner, { service = 'ANY', passId } = {}) => {
    let holder;
    let isStatic = false;
    if (passToken.isLiveQr(qr)) {
        const parsed = passToken.parseLive(qr);
        if (!parsed) return { result: 'REJECTED', reason: 'FAKE', message: 'Invalid or tampered QR code' };
        holder = await User.findById(parsed.userId).select('name countryCode phone photoKey isActive +qrNonce').lean();
        if (!holder || !holder.isActive || !holder.qrNonce) return { result: 'REJECTED', reason: 'REVOKED', message: 'This personal QR is no longer valid. Ask for the new one.' };
        const check = passToken.checkLive(parsed, holder.qrNonce);
        if (check === 'FAKE') return { result: 'REJECTED', reason: 'FAKE', message: 'Invalid or tampered QR code (or the QR was reset)' };
        if (check === 'EXPIRED') return { result: 'REJECTED', reason: 'OLD_SCREENSHOT', message: 'This QR is more than a minute old: probably a screenshot. Ask them to open the live QR in the app.' };
    } else {
        const decoded = passToken.decodeUser(qr);
        if (!decoded) return { result: 'REJECTED', reason: 'FAKE', message: 'Invalid or tampered QR code' };
        holder = await User.findById(decoded.userId).select('name countryCode phone photoKey isActive +qrNonce').lean();
        if (!holder || !holder.isActive || holder.qrNonce !== decoded.nonce) {
            return { result: 'REJECTED', reason: 'REVOKED', message: 'This personal QR was reset or is no longer valid. Ask for the new one.' };
        }
        if (!staticAllowed()) return { result: 'REJECTED', reason: 'STATIC_QR', message: 'Only the live (moving) QR is accepted. Ask them to open My Passbook in the app.' };
        isStatic = true;
    }
    const person = { name: holder.name, phone: maskPhone(holder.phone), photoUrl: photoUrlFor(holder.photoKey) };

    const now = new Date();
    const filter = { userId: holder._id, status: 'ACTIVE', validFrom: { $lte: now }, validUntil: { $gte: now } };
    const types = SERVICE_TYPES[String(service).toUpperCase()] ?? null;
    if (types) filter.type = { $in: types };
    // a host's desk only ever looks at tickets for its own events
    const hostScope = HOST_PASS_TYPES[scanner.role] ? { type: { $in: HOST_PASS_TYPES[scanner.role] }, eventId: { $in: await ownEventIds(scanner) } } : null;
    if (hostScope) Object.assign(filter, hostScope);
    // NGO admins and NGO volunteers only redeem passes for their own camps / kitchens (or passes with no provider)
    if (scanner.role === ROLES.NGO_ADMIN || (scanner.role === ROLES.VOLUNTEER && scanner.providerId)) {
        filter.$or = [{ providerId: scanner.providerId || null }, { providerId: null }, { providerId: { $exists: false } }];
    }
    let candidates = await Pass.find(filter).sort({ validUntil: 1 }).populate('userId', 'name countryCode phone photoKey').lean();

    if (passId) {
        candidates = candidates.filter((p) => String(p._id) === String(passId));
        if (!candidates.length) return { result: 'REJECTED', reason: 'NOT_FOUND', message: 'That pass is no longer valid', holder: person };
    }
    if (!candidates.length) {
        const why = await whyNothingHere(holder._id, types, now, hostScope);
        // a host's desk is told nothing about someone who has no ticket for its own events
        if (hostScope && why.reason === 'NO_VALID_PASS') return { ...why, message: 'No ticket for your events', personal: true };
        return { ...why, holder: person, personal: true };
    }
    if (candidates.length > 1) {
        return { result: 'CHOOSE', message: `${holder.name} has ${candidates.length} valid passes here. Choose one.`, holder: person, options: candidates.map(summary), personal: true, staticQr: isStatic };
    }
    const done = await redeem(candidates[0], scanner);
    // a static QR could be someone else's screenshot: ask for ID before letting them in
    if (isStatic && done.result === 'VALID') done.message = `${done.message} - static QR: check their ID`;
    return { ...done, holder: person, personal: true, staticQr: isStatic };
};

const TYPE_WORD = { LODGING: 'stay', MEAL: 'meal token', TRANSIT: 'bus pass', PUBLIC: 'event ticket', CORPORATE: 'event badge', VOLUNTEER: 'volunteer ID' };

/**
 * A personal QR with nothing to redeem here: say why (cancelled, already used,
 * not valid yet) instead of a bare "no pass", looking at this person's passes
 * for this counter from the last day and the coming days.
 */
const whyNothingHere = async (userId, types, now, scope = null) => {
    const near = { userId, validUntil: { $gte: new Date(now.getTime() - 86400000) } };
    if (types) near.type = { $in: types };
    if (scope) Object.assign(near, scope);
    const passes = await Pass.find(near).sort({ updatedAt: -1 }).limit(20).lean();
    const word = (p) => TYPE_WORD[p.type] || 'pass';
    const cancelled = passes.find((p) => p.status === 'CANCELLED');
    const used = passes.find((p) => p.status === 'REDEEMED' && p.validUntil >= now);
    const later = passes.filter((p) => p.status === 'ACTIVE' && p.validFrom > now).sort((a, b) => a.validFrom - b.validFrom)[0];
    if (used) return { result: 'REJECTED', reason: 'ALREADY_USED', message: `Their ${word(used)} "${used.title}" was already used at ${fmt(used.redeemedAt)}`, pass: summary(used) };
    if (later) return { result: 'REJECTED', reason: 'NOT_YET_VALID', message: `Their ${word(later)} "${later.title}" is valid from ${fmt(later.validFrom)}`, pass: summary(later) };
    if (cancelled) return { result: 'REJECTED', reason: 'CANCELLED', message: `Their ${word(cancelled)} "${cancelled.title}" was cancelled on ${fmt(cancelled.updatedAt)}. Do not let them in.`, pass: summary(cancelled) };
    return { result: 'REJECTED', reason: 'NO_VALID_PASS', message: 'This person has no pass for this counter' };
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
    return {
        qr: passToken.encodeUser(String(user._id), doc.qrNonce), // static fallback (old phones without Web Crypto)
        // the phone makes the live QR itself every 30 s from this key, even offline
        live: { key: passToken.liveKey(String(user._id), doc.qrNonce), periodS: passToken.LIVE_PERIOD_S, userId: String(user._id) },
    };
};

const fmt = (d) =>
    new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Cancels a pass and frees its dedupe key so the user can claim again. */
const cancelPass = async (passId, session = null, extra = {}) => {
    if (!passId) return;
    // `extra` (cancelledAt, refund) is written in the same update, so the refund record can never be lost
    await Pass.updateOne({ _id: passId, status: 'ACTIVE' }, { $set: { status: 'CANCELLED', ...extra }, $unset: { dedupeKey: 1 } }, { session });
};

const requireQr = (qr) => {
    if (typeof qr !== 'string' || !qr.trim()) throw badRequest('QR payload is required');
    return qr.trim();
};

module.exports = { issuePass, toClient, listMine, scan, cancelPass, requireQr, myQr, SERVICE_TYPES };
