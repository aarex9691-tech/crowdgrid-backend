const mongoose = require('mongoose');

/**
 * What the control room has set for one walking lane. Lanes without a row
 * are NORMAL. The lanes themselves (ends, length) live in network.nashik.js.
 */
const LANE_STATUS = ['NORMAL', 'BUSY', 'CROWDED', 'CLOSED'];

const laneStatusSchema = new mongoose.Schema(
    {
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        laneId: { type: String, required: true, maxlength: 60 },
        status: { type: String, enum: LANE_STATUS, default: 'NORMAL' },
        note: { type: String, trim: true, maxlength: 120 },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true }
);

laneStatusSchema.index({ eventId: 1, laneId: 1 }, { unique: true });

module.exports = { LaneStatus: mongoose.model('LaneStatus', laneStatusSchema), LANE_STATUS };
