const crypto = require('crypto');

/**
 * Tamper-proof QR payloads.
 *
 * A QR encodes:  CG1.<passId>.<nonce>.<signature>
 *   nonce     = random UUIDv4 stored on the pass
 *   signature = HMAC-SHA256(QR_SECRET, "<passId>.<nonce>") (base64url, 32 chars)
 *
 * Without the server secret nobody can produce a valid signature, so a
 * counterfeit or edited QR is rejected before the database is even queried.
 */
const PREFIX = 'CG1';

const secret = () => {
    const s = process.env.QR_SECRET || process.env.JWT_SECRET;
    if (!s) throw new Error('QR_SECRET (or JWT_SECRET) must be set');
    return s;
};

const sign = (passId, nonce) =>
    crypto.createHmac('sha256', secret()).update(`${passId}.${nonce}`).digest('base64url').slice(0, 32);

const newNonce = () => crypto.randomUUID();

const encode = (pass) => `${PREFIX}.${pass._id}.${pass.nonce}.${sign(String(pass._id), pass.nonce)}`;

/** Returns { passId, nonce } when the signature is genuine, otherwise null. */
const decode = (payload) => {
    if (typeof payload !== 'string') return null;
    const parts = payload.trim().split('.');
    if (parts.length !== 4 || parts[0] !== PREFIX) return null;
    const [, passId, nonce, signature] = parts;
    if (!/^[a-f0-9]{24}$/i.test(passId)) return null;
    const expected = Buffer.from(sign(passId, nonce));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    return { passId, nonce };
};

/**
 * Personal QR (one per person, opens all their passes):
 *   CGU.<userId>.<nonce>.<signature>
 * signed over "U.<userId>.<nonce>" so a pass signature can never be reused as a
 * personal one. The nonce lives on the user; resetting it kills old screenshots.
 */
const USER_PREFIX = 'CGU';
const encodeUser = (userId, nonce) => `${USER_PREFIX}.${userId}.${nonce}.${sign(`U.${userId}`, nonce)}`;

const decodeUser = (payload) => {
    if (typeof payload !== 'string') return null;
    const parts = payload.trim().split('.');
    if (parts.length !== 4 || parts[0] !== USER_PREFIX) return null;
    const [, userId, nonce, signature] = parts;
    if (!/^[a-f0-9]{24}$/i.test(userId)) return null;
    const expected = Buffer.from(sign(`U.${userId}`, nonce));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
    return { userId, nonce };
};

/**
 * LIVE personal QR (changes every 30 seconds, like a bank's OTP app):
 *   CGL.<userId>.<window>.<code>
 *   window = floor(unix seconds / 30)
 *   code   = HMAC-SHA256(liveKey, "<window>") (base64url, 16 chars)
 *   liveKey = HMAC-SHA256(QR_SECRET, "LIVE.<userId>.<qrNonce>") - given only to that user
 * The phone computes the code itself (Web Crypto), so it keeps changing offline too.
 * A screenshot stops working within about a minute; resetting the QR (new nonce)
 * changes the key.
 */
const LIVE_PREFIX = 'CGL';
const LIVE_PERIOD_S = 30;
const LIVE_SKEW = 2; // accept codes up to 2 windows (60 s) old or ahead: phone clocks drift

const liveKey = (userId, nonce) => crypto.createHmac('sha256', secret()).update(`LIVE.${userId}.${nonce}`).digest('base64url');
const liveCode = (key, window) => crypto.createHmac('sha256', Buffer.from(key, 'utf8')).update(String(window)).digest('base64url').slice(0, 16);
const currentWindow = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / LIVE_PERIOD_S);
const encodeLive = (userId, nonce, window = currentWindow()) => `${LIVE_PREFIX}.${userId}.${window}.${liveCode(liveKey(userId, nonce), window)}`;

/** Parses a live QR; the code can only be checked once the user's nonce is loaded (checkLive). */
const parseLive = (payload) => {
    if (typeof payload !== 'string') return null;
    const parts = payload.trim().split('.');
    if (parts.length !== 4 || parts[0] !== LIVE_PREFIX) return null;
    const [, userId, w, code] = parts;
    if (!/^[a-f0-9]{24}$/i.test(userId) || !/^\d{1,12}$/.test(w) || !/^[A-Za-z0-9_-]{16}$/.test(code)) return null;
    return { userId, window: Number(w), code };
};

/** 'OK', 'EXPIRED' (an old screenshot) or 'FAKE'. */
const checkLive = (parsed, nonce, nowMs = Date.now()) => {
    const expected = Buffer.from(liveCode(liveKey(parsed.userId, nonce), parsed.window));
    const given = Buffer.from(parsed.code);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return 'FAKE';
    return Math.abs(currentWindow(nowMs) - parsed.window) <= LIVE_SKEW ? 'OK' : 'EXPIRED';
};

const isUserQr = (payload) => typeof payload === 'string' && (payload.trim().startsWith(`${USER_PREFIX}.`) || payload.trim().startsWith(`${LIVE_PREFIX}.`));
const isLiveQr = (payload) => typeof payload === 'string' && payload.trim().startsWith(`${LIVE_PREFIX}.`);

module.exports = { encode, decode, newNonce, encodeUser, decodeUser, isUserQr, isLiveQr, liveKey, liveCode, encodeLive, parseLive, checkLive, currentWindow, LIVE_PERIOD_S };
