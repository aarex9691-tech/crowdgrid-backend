const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { HttpError, badRequest } = require('../../utils/httpError');

/**
 * One-time codes that prove a pilgrim owns the mobile number they sign up with.
 * Without this, one person could make many accounts with made-up numbers and get
 * around the "5 per account" limits, or raise fake SOS alerts.
 *
 * Like the payment gateway, the SMS sender is pluggable:
 *   OTP_PROVIDER=SIMULATED (default)  the code is returned in the API response and
 *                                     shown on screen, so the demo needs no SMS account
 *   (later) MSG91 / Firebase / Twilio  add a provider with the same send() signature
 * OTP_REQUIRED=false turns the check off (e.g. for load tests).
 *
 * Codes: 6 digits, stored only as a bcrypt hash, valid 5 minutes, 5 wrong tries,
 * used once, at most 3 per number per hour.
 */
const TTL_MIN = 5;
const MAX_TRIES = 5;
const MAX_PER_HOUR = 3;

const otpSchema = new mongoose.Schema(
    {
        countryCode: { type: String, required: true },
        phone: { type: String, required: true },
        codeHash: { type: String, required: true },
        purpose: { type: String, enum: ['REGISTER'], default: 'REGISTER' },
        expiresAt: { type: Date, required: true },
        attempts: { type: Number, default: 0 },
        usedAt: Date,
    },
    { timestamps: true }
);
otpSchema.index({ countryCode: 1, phone: 1, createdAt: -1 });
otpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 }); // MongoDB deletes old codes after a day
const OtpCode = mongoose.model('OtpCode', otpSchema);

const providers = {
    SIMULATED: {
        name: 'SIMULATED',
        // No SMS is sent: the code goes back to the screen so the demo works anywhere
        async send({ code }) {
            return { delivered: false, devCode: code };
        },
    },
};
const provider = () => providers[process.env.OTP_PROVIDER || 'SIMULATED'] || providers.SIMULATED;
const required = () => process.env.OTP_REQUIRED !== 'false';

/** Creates and "sends" a code for this number. */
const issue = async ({ countryCode, phone }) => {
    const since = new Date(Date.now() - 3600 * 1000);
    if ((await OtpCode.countDocuments({ countryCode, phone, createdAt: { $gte: since } })) >= MAX_PER_HOUR) {
        throw new HttpError(429, `Too many codes for this number. Please wait an hour and try again.`);
    }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await OtpCode.create({ countryCode, phone, codeHash: await bcrypt.hash(code, 8), expiresAt: new Date(Date.now() + TTL_MIN * 60000) });
    const sent = await provider().send({ countryCode, phone, code });
    return {
        message: sent.delivered ? `We sent a 6-digit code to +${countryCode} ${phone}` : 'Demo mode: no SMS is sent. Your code is shown below.',
        expiresInMin: TTL_MIN,
        ...(sent.devCode ? { devCode: sent.devCode } : {}),
    };
};

/** Checks the latest code for this number and uses it up. Throws 400 when wrong. */
const consume = async ({ countryCode, phone }, code) => {
    if (!required()) return true;
    const given = String(code || '').trim();
    if (!/^\d{6}$/.test(given)) throw badRequest('Enter the 6-digit code sent to your mobile');
    const otp = await OtpCode.findOne({ countryCode, phone, usedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    if (!otp) throw badRequest('The code has expired. Ask for a new one.');
    if (otp.attempts >= MAX_TRIES) throw badRequest('Too many wrong codes. Ask for a new one.');
    if (!(await bcrypt.compare(given, otp.codeHash))) {
        await OtpCode.updateOne({ _id: otp._id }, { $inc: { attempts: 1 } });
        throw badRequest('That code is not right. Check the SMS and try again.');
    }
    // single use, even if two sign-ups race with the same code
    const used = await OtpCode.findOneAndUpdate({ _id: otp._id, usedAt: null }, { $set: { usedAt: new Date() } });
    if (!used) throw badRequest('This code was already used. Ask for a new one.');
    return true;
};

module.exports = { OtpCode, issue, consume, required, TTL_MIN, MAX_TRIES, MAX_PER_HOUR };
