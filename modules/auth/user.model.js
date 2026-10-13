const mongoose = require('mongoose');
const { ROLES } = require('../../config/roles');

const userSchema = new mongoose.Schema(
    {
        name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 80 },
        // Country code (digits, "91" for India) + national number (digits).
        // Per-country length rules live in utils/phone.js.
        countryCode: { type: String, default: '91', match: [/^\d{1,4}$/, 'Invalid country code'] },
        phone: {
            type: String,
            required: [true, 'Mobile number is required'],
            trim: true,
            match: [/^\d{6,14}$/, 'Enter a valid mobile number'],
        },
        email: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
        passwordHash: { type: String, required: true, select: false },
        role: { type: String, enum: Object.values(ROLES), default: ROLES.USER },
        // NGO admins and volunteers belong to a service provider (NGO / trust)
        providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider' }, // only for NGO staff
        // Optional profile, filled in from "Edit profile" (empty values are not stored)
        dateOfBirth: Date,
        gender: { type: String, enum: ['FEMALE', 'MALE', 'OTHER'] },
        city: { type: String, trim: true, maxlength: 60 },
        emergencyContact: {
            _id: false,
            name: { type: String, trim: true, maxlength: 60 },
            phone: { type: String, match: [/^\d{10}$/, 'Emergency contact must be a 10-digit number'] },
        },
        isActive: { type: Boolean, default: true },
        // Account lockout after repeated wrong passwords
        failedLogins: Number, // only stored after a wrong password
        lockUntil: { type: Date },
        // Bumped by "log out of all devices": tokens carrying an older version stop working
        tokenVersion: Number, // only stored after "log out of all devices"
        // Personal "one QR for everything" (see utils/passToken.js); reset to revoke old copies
        qrNonce: { type: String, select: false },
    },
    { timestamps: true }
);

// One account per mobile number (the same national number may exist in two countries)
userSchema.index({ countryCode: 1, phone: 1 }, { unique: true });

userSchema.methods.toPublic = function toPublic() {
    return {
        _id: this._id,
        name: this.name,
        countryCode: this.countryCode || '91',
        phone: this.phone,
        email: this.email,
        role: this.role,
        providerId: this.providerId,
        dateOfBirth: this.dateOfBirth,
        gender: this.gender,
        city: this.city,
        emergencyContact: this.emergencyContact?.phone ? this.emergencyContact : undefined,
    };
};

module.exports = mongoose.model('User', userSchema);
