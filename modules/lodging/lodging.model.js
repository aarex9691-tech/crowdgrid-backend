const mongoose = require('mongoose');

const CATEGORIES = ['FREE_CAMP', 'DHARAMSHALA', 'FAMILY_TENT', 'SENIOR_DORM', 'ASHRAM'];

const lodgingSchema = new mongoose.Schema(
    {
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true },
        name: { type: String, required: true, trim: true },
        sector: { type: String, required: true },
        category: { type: String, enum: CATEGORIES, required: true },
        distanceToGhatKm: Number,
        amenities: [String],
        location: { lat: Number, lng: Number },
        pricePerNight: { type: Number, default: 0, min: 0 },
        totalBeds: { type: Number, required: true, min: 0 },
        // Live inventory. Only ever changed with atomic $inc (see lodging.service.js)
        availableBeds: { type: Number, required: true, min: 0 },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

lodgingSchema.index({ eventId: 1, sector: 1, category: 1 });

const bookingSchema = new mongoose.Schema(
    {
        lodgingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lodging', required: true },
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        beds: { type: Number, required: true, min: 1, max: 4 },
        guestNames: [String],
        checkIn: { type: String, required: true }, // YYYY-MM-DD (IST)
        checkOut: { type: String, required: true },
        status: { type: String, enum: ['CONFIRMED', 'CANCELLED'], default: 'CONFIRMED' },
        passId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pass' },
    },
    { timestamps: true }
);

bookingSchema.index({ userId: 1, eventId: 1, status: 1 });

module.exports = {
    Lodging: mongoose.model('Lodging', lodgingSchema),
    LodgingBooking: mongoose.model('LodgingBooking', bookingSchema),
    CATEGORIES,
};
