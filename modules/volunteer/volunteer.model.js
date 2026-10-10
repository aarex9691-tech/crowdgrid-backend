const mongoose = require('mongoose');

const DOMAINS = ['CROWD_CONTROL', 'LANGAR_SERVING', 'SENIOR_ESCORT', 'FIRST_AID'];

const applicationSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' }, // trust applied to (optional)
        domain: { type: String, enum: DOMAINS, required: true },
        sector: String,
        dates: [String],
        note: { type: String, maxlength: 500 },
        status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reviewedAt: Date,
        rejectionReason: String,
    },
    { timestamps: true }
);

// One application per person per event
applicationSchema.index({ userId: 1, eventId: 1 }, { unique: true });

module.exports = { VolunteerApplication: mongoose.model('VolunteerApplication', applicationSchema), DOMAINS };
