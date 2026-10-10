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

module.exports = { encode, decode, newNonce };
