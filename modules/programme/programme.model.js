const mongoose = require('mongoose');

/*
 * A programme for pilgrims inside a yatra (a bhandara, satsang, free health camp, bhajan evening...),
 * held by a recognised kitchen service approved for that yatra, or by an approved event host.
 * It goes live only when the yatra's District Control Room approves it. Pilgrims reserve a free
 * place (up to the capacity) and get a QR pass that the organiser scans at the entrance.
 */
const TYPES = ['BHANDARA', 'SATSANG', 'HEALTH_CAMP', 'BHAJAN', 'CULTURAL', 'OTHER'];

const programmeSchema = new mongoose.Schema(
    {
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true }, // the yatra
        organiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        organiserName: { type: String, required: true, maxlength: 120 },
        title: { type: String, required: true, trim: true, maxlength: 100 },
        type: { type: String, enum: TYPES, required: true },
        date: { type: String, required: true }, // YYYY-MM-DD (IST), a day of the yatra
        startTime: { type: String, required: true }, // HH:MM
        endTime: { type: String, required: true },
        venue: { type: String, required: true, maxlength: 120 },
        sector: { type: String, maxlength: 80 },
        capacity: { type: Number, required: true, min: 1, max: 5000 },
        // places taken; changed only with an atomic $inc, never above capacity
        registered: { type: Number, default: 0, min: 0 },
        description: { type: String, maxlength: 500 },
        status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reviewedAt: Date,
        rejectionReason: { type: String, maxlength: 300 },
    },
    { timestamps: true }
);
programmeSchema.index({ eventId: 1, status: 1, date: 1 });
programmeSchema.index({ organiserId: 1, createdAt: -1 });
programmeSchema.index({ status: 1, createdAt: -1 });

module.exports = { Programme: mongoose.model('Programme', programmeSchema), TYPES };
