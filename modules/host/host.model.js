const mongoose = require('mongoose');

/**
 * An organisation asking to host events on CrowdGrid (public events, campus & corporate events,
 * or both). The Super Admin checks the ID number and the registration certificate, then approves
 * (the applicant's account becomes a host) or rejects with a reason.
 */
const KINDS = ['PUBLIC', 'CORPORATE', 'BOTH'];
const ORG_TYPES = ['EDUCATION', 'CHARITY', 'COMPANY', 'CULTURAL', 'GOVT', 'OTHER'];
const ID_TYPES = ['GSTIN', 'CIN', 'DARPAN', 'AISHE', 'UDYAM', 'REG'];

const hostApplicationSchema = new mongoose.Schema(
    {
        applicantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        kind: { type: String, enum: KINDS, required: true },
        orgName: { type: String, required: true, trim: true, maxlength: 120 },
        orgType: { type: String, enum: ORG_TYPES, required: true },
        idType: { type: String, enum: ID_TYPES, required: true },
        idNumber: { type: String, required: true, maxlength: 40 },
        idCheck: { type: String, enum: ['VALID', 'UNCHECKED'], required: true }, // INVALID ones are refused
        city: { type: String, required: true, maxlength: 60 },
        contactName: { type: String, required: true, maxlength: 80 },
        contactCountryCode: { type: String, required: true },
        contactPhone: { type: String, required: true },
        contactEmail: { type: String, lowercase: true, trim: true, maxlength: 120 },
        website: { type: String, trim: true, maxlength: 200 },
        expectedSize: { type: Number, min: 1, max: 10000000 },
        description: { type: String, maxlength: 500 },
        // The registration certificate (PDF or image, at most 2 MB): only the applicant and the Super Admin can open it
        document: {
            data: { type: Buffer, select: false },
            contentType: { type: String, enum: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] },
            size: Number,
        },
        status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reviewedAt: Date,
        reviewNote: { type: String, maxlength: 300 },
        rejectionReason: { type: String, maxlength: 300 },
        // Set while the request is waiting or approved, so the database itself keeps
        // one waiting request per person and one organisation per ID number
        pendingFor: { type: mongoose.Schema.Types.ObjectId },
        activeIdKey: { type: String },
    },
    { timestamps: true }
);
hostApplicationSchema.index({ pendingFor: 1 }, { unique: true, sparse: true });
hostApplicationSchema.index({ activeIdKey: 1 }, { unique: true, sparse: true });
hostApplicationSchema.index({ applicantId: 1, createdAt: -1 });
hostApplicationSchema.index({ status: 1, createdAt: -1 });

const HostApplication = mongoose.models.HostApplication || mongoose.model('HostApplication', hostApplicationSchema);
module.exports = { HostApplication, KINDS, ORG_TYPES, ID_TYPES };
