const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('./user.model');
const { sniffImage } = require('../lostfound/photo.model');
const { badRequest, notFound } = require('../../utils/httpError');

/**
 * Profile pictures, stored in MongoDB (Render's disk is wiped on restart).
 *
 * The browser crops the picture square and shrinks it to 256 px before upload, so each one is
 * a few dozen KB. It is served at /api/auth/photo/<key>, where the key is 32 random hex
 * characters that change with every new picture: only people who are shown the link (the owner,
 * and gate staff when they scan that person's pass) can find it.
 */
const MAX_BYTES = 1024 * 1024;

const avatarSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
        data: { type: Buffer, required: true },
        contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true },
        size: Number,
    },
    { timestamps: true }
);
const Avatar = mongoose.models.Avatar || mongoose.model('Avatar', avatarSchema);

const photoUrlFor = (key) => (key ? `/api/auth/photo/${key}` : undefined);

/** Saves a new picture for this user and removes the old one. */
const setPhoto = async (user, buffer) => {
    if (!buffer || !buffer.length) throw badRequest('Choose a photo to upload');
    if (buffer.length > MAX_BYTES) throw badRequest('The photo is too large. Use one under 1 MB.');
    const contentType = sniffImage(buffer);
    if (!contentType) throw badRequest('The photo must be a JPEG, PNG or WEBP image');

    const key = crypto.randomBytes(16).toString('hex');
    await Avatar.create({ key, userId: user._id, data: buffer, contentType, size: buffer.length });
    const before = await User.findByIdAndUpdate(user._id, { $set: { photoKey: key } }, { returnDocument: 'before' }).select('photoKey').lean();
    // Old pictures of this user are removed; the link of the previous one stops working at once
    await Avatar.deleteMany({ userId: user._id, key: { $ne: key } });
    if (!before) {
        await Avatar.deleteOne({ key });
        throw notFound('Account not found');
    }
    return { photoUrl: photoUrlFor(key) };
};

const removePhoto = async (user) => {
    await User.updateOne({ _id: user._id }, { $unset: { photoKey: 1 } });
    await Avatar.deleteMany({ userId: user._id });
    return { photoUrl: null };
};

/** The picture for a key, or null. */
const find = async (key) => {
    if (!/^[a-f0-9]{32}$/.test(String(key || ''))) return null;
    return Avatar.findOne({ key }); // not lean: `data` comes back as a Node Buffer
};

module.exports = { Avatar, setPhoto, removePhoto, find, photoUrlFor, MAX_BYTES };
