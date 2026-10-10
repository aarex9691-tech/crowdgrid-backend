const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
    {
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
        kind: { type: String, enum: ['MISSING', 'FOUND'], required: true },
        personName: { type: String, trim: true },
        age: Number,
        gender: { type: String, enum: ['MALE', 'FEMALE', 'OTHER', 'UNKNOWN'], default: 'UNKNOWN' },
        description: { type: String, maxlength: 600 },
        clothes: { type: String, maxlength: 300 },
        lastSeenAt: String, // place
        currentlyAt: String, // for FOUND: camp / police post where the person is safe
        contactPhone: String,
        photoUrl: String,
        status: { type: String, enum: ['OPEN', 'REUNITED'], default: 'OPEN' },
        reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    },
    { timestamps: true }
);

reportSchema.index({ kind: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('LostFoundReport', reportSchema);
