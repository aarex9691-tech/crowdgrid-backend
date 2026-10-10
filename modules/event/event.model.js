const mongoose = require('mongoose');

/**
 * One collection for the three event families shown in the app:
 *   YATRA     - mega pilgrimage hubs (Kumbh Mela, Pandharpur Wari) with services underneath
 *   PUBLIC    - simple public events with one-tap RSVP and an entry pass
 *   CORPORATE - invitation-only events unlocked with an access code
 */
const sessionSchema = new mongoose.Schema(
    {
        code: { type: String, required: true },
        title: { type: String, required: true },
        kind: { type: String, enum: ['SESSION', 'MEAL'], default: 'SESSION' },
        time: String,
    },
    { _id: false }
);

const eventSchema = new mongoose.Schema(
    {
        title: { type: String, required: true, trim: true },
        slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
        kind: { type: String, enum: ['YATRA', 'PUBLIC', 'CORPORATE'], required: true },
        tagline: String,
        description: String,
        city: { type: String, required: true },
        state: String,
        venue: String,
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },
        coverImage: String,

        // YATRA
        isFlagship: { type: Boolean, default: false },
        expectedFootfall: Number,
        keyDates: [{ _id: false, label: String, date: Date }],
        sectors: [String],

        // PUBLIC (headcount is updated atomically on RSVP)
        capacity: { type: Number, min: 0 },
        attendeesCount: { type: Number, default: 0, min: 0 },

        // CORPORATE
        companyName: String,
        accessCode: { type: String, select: false },
        sessions: [sessionSchema],

        organizerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
    },
    { timestamps: true }
);

eventSchema.index({ kind: 1, startDate: 1 });

module.exports = mongoose.model('Event', eventSchema);
