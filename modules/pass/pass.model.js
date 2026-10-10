const mongoose = require('mongoose');

/**
 * Every QR the app issues is a Pass: lodging, meal token, transit boarding
 * pass, public entry pass, corporate badge or volunteer ID. One collection
 * means one passbook query and one scanner endpoint.
 */
const PASS_TYPES = ['LODGING', 'MEAL', 'TRANSIT', 'PUBLIC', 'CORPORATE', 'VOLUNTEER'];

const passSchema = new mongoose.Schema(
    {
        type: { type: String, enum: PASS_TYPES, required: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' },
        refId: { type: mongoose.Schema.Types.ObjectId }, // booking / slot / route this pass is for

        title: { type: String, required: true },
        subtitle: String,
        details: { type: mongoose.Schema.Types.Mixed, default: {} },

        status: { type: String, enum: ['ACTIVE', 'REDEEMED', 'CANCELLED'], default: 'ACTIVE' },
        validFrom: { type: Date, required: true },
        validUntil: { type: Date, required: true },
        // Verify-only passes (volunteer ID) are checked but never used up
        singleUse: { type: Boolean, default: true },

        nonce: { type: String, required: true }, // random UUIDv4, part of the signed QR
        // Business-rule uniqueness, e.g. one meal token per user per meal per day.
        // The unique index makes MongoDB itself reject a second claim.
        dedupeKey: { type: String },

        redeemedAt: Date,
        redeemedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    },
    { timestamps: true }
);

passSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
passSchema.index({ userId: 1, createdAt: -1 });

module.exports = { Pass: mongoose.model('Pass', passSchema), PASS_TYPES };
