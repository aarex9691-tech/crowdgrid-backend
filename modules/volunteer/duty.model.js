const mongoose = require('mongoose');

/**
 * Duty: one volunteer on one sector post for one shift.
 *   SCHEDULED -> ON_DUTY (volunteer checks in) -> DONE (checks out, or the control room ends it)
 *   SCHEDULED / ON_DUTY -> CANCELLED (control room)
 */
const DUTY_STATUSES = ['SCHEDULED', 'ON_DUTY', 'DONE', 'CANCELLED'];

const dutySchema = new mongoose.Schema(
    {
        volunteerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        sector: { type: String, required: true, trim: true, maxlength: 80 },
        post: { type: String, trim: true, maxlength: 80 }, // e.g. "Gate 3", "Ramkund steps"
        start: { type: Date, required: true },
        end: { type: Date, required: true },
        status: { type: String, enum: DUTY_STATUSES, default: 'SCHEDULED' },
        checkedInAt: Date,
        checkedOutAt: Date,
        assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true }
);
dutySchema.index({ eventId: 1, status: 1, start: 1 });
dutySchema.index({ volunteerId: 1, status: 1, start: 1 });

/** A short message from the control room to every volunteer, or to one sector. */
const broadcastSchema = new mongoose.Schema(
    {
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        sector: { type: String, trim: true, maxlength: 80 }, // empty = everyone at the event
        message: { type: String, required: true, trim: true, maxlength: 280 },
        sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        sentByName: String,
    },
    { timestamps: true }
);
broadcastSchema.index({ eventId: 1, createdAt: -1 });

module.exports = {
    Duty: mongoose.model('Duty', dutySchema),
    VolunteerBroadcast: mongoose.model('VolunteerBroadcast', broadcastSchema),
    DUTY_STATUSES,
};
