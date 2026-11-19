const mongoose = require('mongoose');

/*
 * Kitchen services (langar trusts, annakshetras, community kitchens).
 *
 *  1. KitchenApplication: the organisation asks the Super Admin to recognise it, once, with its
 *     registration number and certificate. Approval makes the account a Kitchen Manager.
 *  2. ServiceRequest: for each yatra it wants to serve at, the Kitchen Manager asks that yatra's
 *     District Control Room. Approval gives it a verified organisation (Provider) at that yatra only,
 *     so it can list kitchens and meal tokens there. Another yatra needs another request.
 */

const ORG_TYPES = ['TRUST', 'NGO', 'ASHRAM', 'COMMUNITY_KITCHEN', 'COMPANY', 'OTHER'];
// FSSAI is the food-business licence every kitchen should hold; the others as for event hosts
const ID_TYPES = ['FSSAI', 'GSTIN', 'DARPAN', 'UDYAM', 'REG'];
const STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];

const document = {
    data: { type: Buffer, select: false },
    contentType: { type: String, enum: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] },
    size: Number,
};

const kitchenApplicationSchema = new mongoose.Schema(
    {
        applicantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        orgName: { type: String, required: true, trim: true, maxlength: 120 },
        orgType: { type: String, enum: ORG_TYPES, required: true },
        idType: { type: String, enum: ID_TYPES, required: true },
        idNumber: { type: String, required: true, maxlength: 40 },
        idCheck: { type: String, enum: ['VALID', 'UNCHECKED'], required: true },
        city: { type: String, required: true, maxlength: 60 },
        contactName: { type: String, required: true, maxlength: 80 },
        contactCountryCode: { type: String, required: true },
        contactPhone: { type: String, required: true },
        mealsPerDay: { type: Number, min: 1, max: 1000000 },
        description: { type: String, maxlength: 500 },
        // the licence or registration certificate: only the applicant and the Super Admin can open it
        document,
        status: { type: String, enum: STATUSES, default: 'PENDING' },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reviewedAt: Date,
        rejectionReason: { type: String, maxlength: 300 },
        // one waiting request per account; one organisation per registration number (the database enforces both)
        pendingFor: { type: mongoose.Schema.Types.ObjectId },
        activeIdKey: { type: String },
    },
    { timestamps: true }
);
kitchenApplicationSchema.index({ pendingFor: 1 }, { unique: true, sparse: true });
kitchenApplicationSchema.index({ activeIdKey: 1 }, { unique: true, sparse: true });
kitchenApplicationSchema.index({ status: 1, createdAt: -1 });

const serviceRequestSchema = new mongoose.Schema(
    {
        organiserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        orgName: { type: String, required: true, maxlength: 120 },
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        sector: { type: String, maxlength: 80 },
        mealsPerDay: { type: Number, min: 1, max: 1000000 },
        note: { type: String, maxlength: 500 },
        status: { type: String, enum: STATUSES, default: 'PENDING' },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reviewedAt: Date,
        rejectionReason: { type: String, maxlength: 300 },
        providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' }, // created on approval
        // one open (waiting or approved) request per kitchen per yatra
        openKey: { type: String },
    },
    { timestamps: true }
);
serviceRequestSchema.index({ openKey: 1 }, { unique: true, sparse: true });
serviceRequestSchema.index({ status: 1, createdAt: -1 });
serviceRequestSchema.index({ organiserId: 1, eventId: 1 });

module.exports = {
    KitchenApplication: mongoose.model('KitchenApplication', kitchenApplicationSchema),
    ServiceRequest: mongoose.model('ServiceRequest', serviceRequestSchema),
    ORG_TYPES,
    ID_TYPES,
};
