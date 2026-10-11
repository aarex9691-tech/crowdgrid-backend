const mongoose = require('mongoose');

/** Append-only record of sensitive actions: who did what, to what, and when. */
const auditSchema = new mongoose.Schema(
    {
        actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        actorName: String,
        actorRole: String,
        action: { type: String, required: true }, // e.g. PROVIDER_VERIFIED, PASS_REDEEMED
        targetType: String, // Provider, Pass, SosIncident, ...
        targetId: mongoose.Schema.Types.ObjectId,
        summary: String, // human-readable line for the control room
        meta: { type: mongoose.Schema.Types.Mixed },
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

auditSchema.index({ createdAt: -1 });
auditSchema.index({ actorId: 1, createdAt: -1 });

module.exports = mongoose.model('AuditLog', auditSchema);
