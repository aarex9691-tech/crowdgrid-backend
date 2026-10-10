const mongoose = require('mongoose');

/** An NGO, seva trust, ashram or government body that runs camps / kitchens at an event. */
const providerSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        type: { type: String, enum: ['NGO', 'TRUST', 'ASHRAM', 'GOVT'], default: 'NGO' },
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        registrationNumber: String,
        contactPhone: String,
        description: String,
        verificationStatus: { type: String, enum: ['PENDING', 'VERIFIED', 'REJECTED'], default: 'PENDING' },
        verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        verifiedAt: Date,
        rejectionReason: String,
    },
    { timestamps: true }
);

providerSchema.index({ eventId: 1, verificationStatus: 1 });

module.exports = mongoose.model('Provider', providerSchema);
