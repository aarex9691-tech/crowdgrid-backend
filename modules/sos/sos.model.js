const mongoose = require('mongoose');

const sosSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
        type: { type: String, enum: ['GENERAL', 'MEDICAL', 'LOST', 'CROWD', 'FIRE'], default: 'GENERAL' },
        message: { type: String, maxlength: 300 },
        location: {
            lat: Number,
            lng: Number,
            accuracy: Number, // metres
        },
        locationHistory: [{ _id: false, lat: Number, lng: Number, at: Date }],
        status: { type: String, enum: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'], default: 'OPEN' },
        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        resolvedAt: Date,
    },
    { timestamps: true }
);

sosSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('SosIncident', sosSchema);
