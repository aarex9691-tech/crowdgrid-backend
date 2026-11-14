const mongoose = require('mongoose');

const DOMAINS = ['CROWD_CONTROL', 'LANGAR_SERVING', 'SENIOR_ESCORT', 'FIRST_AID'];
// The photo ID a volunteer registers with. Only the last 4 characters are kept (never a full Aadhaar number).
const ID_TYPES = { AADHAAR: 'Aadhaar (masked)', VOTER: 'Voter ID', DL: 'Driving licence', PAN: 'PAN card', PASSPORT: 'Passport', COLLEGE: 'College ID' };

const applicationSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' }, // trust applied to (optional)
        domain: { type: String, enum: DOMAINS, required: true },
        sector: String,
        dates: [String],
        note: { type: String, maxlength: 500 },
        idType: { type: String, enum: Object.keys(ID_TYPES) },
        idLast4: { type: String, maxlength: 4 },
        // photo of the ID card (image or PDF, at most 2 MB): only the control room and the volunteer can open it
        idDocument: {
            data: { type: Buffer, select: false },
            contentType: { type: String, enum: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] },
            size: Number,
        },
        // set when a control-room officer has seen the ID card in person; needed before the first duty
        idVerifiedAt: Date,
        idVerifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
        reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        reviewedAt: Date,
        rejectionReason: String,
    },
    { timestamps: true }
);

// One application per person per event
applicationSchema.index({ userId: 1, eventId: 1 }, { unique: true });
applicationSchema.index({ eventId: 1, status: 1 }); // the control room's roster of approved volunteers

module.exports = { VolunteerApplication: mongoose.model('VolunteerApplication', applicationSchema), DOMAINS, ID_TYPES };
