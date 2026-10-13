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
        providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', default: null },
        preferredLanguage: { type: String, enum: ['en', 'hi', 'mr'], default: 'en' },
        isActive: { type: Boolean, default: true },
        // Account lockout after repeated wrong passwords
        failedLogins: { type: Number, default: 0 },
        lockUntil: { type: Date },
        // Bumped by "log out of all devices": tokens carrying an older version stop working
        tokenVersion: { type: Number, default: 0 },
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
        preferredLanguage: this.preferredLanguage,
    };
};

module.exports = mongoose.model('User', userSchema);
