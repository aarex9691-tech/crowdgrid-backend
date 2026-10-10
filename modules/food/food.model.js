const mongoose = require('mongoose');

const MEALS = {
    BREAKFAST: { label: 'Breakfast', start: '07:00', end: '09:00' },
    LUNCH: { label: 'Lunch', start: '12:00', end: '15:00' },
    DINNER: { label: 'Dinner', start: '19:00', end: '22:00' },
};

const foodCenterSchema = new mongoose.Schema(
    {
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        providerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Provider', required: true },
        name: { type: String, required: true, trim: true },
        sector: { type: String, required: true },
        menu: [String],
        location: { lat: Number, lng: Number },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

/** One meal window at one kitchen on one day, with its token quota. */
const foodSlotSchema = new mongoose.Schema(
    {
        foodCenterId: { type: mongoose.Schema.Types.ObjectId, ref: 'FoodCenter', required: true },
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        date: { type: String, required: true }, // YYYY-MM-DD (IST)
        meal: { type: String, enum: Object.keys(MEALS), required: true },
        startTime: { type: String, required: true },
        endTime: { type: String, required: true },
        capacity: { type: Number, required: true, min: 0 },
        // Changed only with atomic $inc (see food.service.js)
        remaining: { type: Number, required: true, min: 0 },
    },
    { timestamps: true }
);

foodSlotSchema.index({ foodCenterId: 1, date: 1, meal: 1 }, { unique: true });
foodSlotSchema.index({ eventId: 1, date: 1 });

module.exports = {
    FoodCenter: mongoose.model('FoodCenter', foodCenterSchema),
    FoodSlot: mongoose.model('FoodSlot', foodSlotSchema),
    MEALS,
};
