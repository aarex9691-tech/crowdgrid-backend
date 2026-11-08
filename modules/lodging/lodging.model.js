const mongoose = require('mongoose');
const { MAX_PER_ACCOUNT } = require('../../utils/limits');

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
        routeNode: String, // junction on the walking map (modules/route/network.*.js) this camp's gate opens onto
        pricePerNight: { type: Number, default: 0, min: 0 },
        totalBeds: { type: Number, required: true, min: 0 },
        // Beds per tent / room / hall (default by category, see beds.js)
        bedsPerUnit: { type: Number, min: 1, max: 500 },
        // Beds kept offline every night (walk-ins, staff). The rest are booked online
        // night by night: see nights.js (free on a night = totalBeds - heldBeds - booked).
        heldBeds: { type: Number, default: 0, min: 0 },
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
        beds: { type: Number, required: true, min: 1, max: MAX_PER_ACCOUNT }, // one booking holds up to the per-account limit (5)
        guestNames: [String],
        checkIn: { type: String, required: true }, // YYYY-MM-DD (IST)
        checkOut: { type: String, required: true },
        nights: [String], // the nights this stay uses (checkIn .. checkOut - 1)
        status: { type: String, enum: ['CONFIRMED', 'CANCELLED'], default: 'CONFIRMED' },
        passId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pass' },
        // Allocated bed numbers (1..totalBeds) and their label, e.g. "Tent T-4 · Beds 7, 8"
        bedNos: [Number],
        bedLabel: String,
    },
    { timestamps: true }
);

bookingSchema.index({ userId: 1, eventId: 1, status: 1 });

module.exports = {
    Lodging: mongoose.model('Lodging', lodgingSchema),
    LodgingBooking: mongoose.model('LodgingBooking', bookingSchema),
    CATEGORIES,
};
