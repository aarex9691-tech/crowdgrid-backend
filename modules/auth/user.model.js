const mongoose = require('mongoose');
const { ROLES } = require('../../config/roles');

const userSchema = new mongoose.Schema(
    {
        name: { type: String, required: [true, 'Name is required'], trim: true, maxlength: 80 },
        phone: {
            type: String,
            required: [true, 'Mobile number is required'],
            unique: true,
            trim: true,
            match: [/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'],
        },
        email: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
        passwordHash: { type: String, required: true, select: false },
        role: { type: String, enum: Object.values(ROLES), default: ROLES.USER },
        // NGO admins and volunteers belong to a service provider (NGO / trust)
        providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', default: null },
        preferredLanguage: { type: String, enum: ['en', 'hi', 'mr'], default: 'en' },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

userSchema.methods.toPublic = function toPublic() {
    return {
        _id: this._id,
        name: this.name,
        phone: this.phone,
        email: this.email,
        role: this.role,
        providerId: this.providerId,
        preferredLanguage: this.preferredLanguage,
    };
};

module.exports = mongoose.model('User', userSchema);
