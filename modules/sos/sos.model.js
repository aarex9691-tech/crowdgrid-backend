const mongoose = require('mongoose');

// What the pilgrim needs help with (chosen on the SOS screen)
const SOS_TYPES = ['MEDICAL', 'CROWD', 'LOST', 'FIRE', 'GENERAL'];

const sosSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
        type: { type: String, enum: SOS_TYPES, default: 'GENERAL' },
        message: { type: String, maxlength: 300 },
        location: {
            lat: Number,
            lng: Number,
            accuracy: Number, // metres
        },
        locationHistory: [{ _id: false, lat: Number, lng: Number, at: Date }],
        status: { type: String, enum: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'], default: 'OPEN' },
        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        acknowledgedAt: Date, // first time staff responded (for response-time analytics)
        resolvedAt: Date,
        closedByUser: { type: Boolean, default: false }, // the pilgrim tapped "I'm safe now"
    },
    { timestamps: true }
);

sosSchema.index({ status: 1, createdAt: -1 });
sosSchema.index({ createdAt: -1 });
sosSchema.index({ userId: 1, createdAt: -1 }); // a person's own alerts, and the per-person alert limit

module.exports = mongoose.model('SosIncident', sosSchema);
module.exports.SOS_TYPES = SOS_TYPES;
