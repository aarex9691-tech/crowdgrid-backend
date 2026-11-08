const mongoose = require('mongoose');

/**
 * Missing / found person photos, stored in MongoDB itself.
 *
 * Render's free tier wipes the server's disk on every restart and redeploy, so
 * files saved under uploads/ disappear. Photos are small (3 MB limit, far below
 * MongoDB's 16 MB document limit), so they live in the database with the report.
 */
const photoSchema = new mongoose.Schema(
    {
        data: { type: Buffer, required: true },
        contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp'], required: true },
        size: Number,
        reportId: { type: mongoose.Schema.Types.ObjectId, ref: 'LostFoundReport' },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true }
);

/** The real file type from the first bytes (the browser's claimed type is not trusted). */
const sniffImage = (buf) => {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
};

module.exports = { Photo: mongoose.model('LostFoundPhoto', photoSchema), sniffImage };
