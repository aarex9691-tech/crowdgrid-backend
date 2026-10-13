const mongoose = require('mongoose');

/**
 * One collection for the three event families shown in the app:
 *   YATRA     - mega pilgrimage hubs (Kumbh Mela, Pandharpur Wari) with services underneath
 *   PUBLIC    - paid public events (tickets bought at checkout) with an entry pass
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
        tagline: { type: String, maxlength: 120 },
        description: { type: String, maxlength: [500, 'Description can be at most 500 characters'] },
        city: { type: String, required: true, maxlength: 60 },
        state: { type: String, maxlength: 60 },
        venue: { type: String, maxlength: 120 },
        startDate: { type: Date, required: true },
        endDate: { type: Date, required: true },

        // YATRA
        isFlagship: Boolean, // only stored on the flagship yatra
        expectedFootfall: Number,
        keyDates: { type: [{ _id: false, label: String, date: Date }], default: undefined },
        sectors: { type: [String], default: undefined },

        // PUBLIC: paid events (headcount is updated atomically when tickets are issued)
        category: { type: String, enum: ['SPIRITUAL', 'CULTURAL', 'HERITAGE_WALK', 'SEVA', 'WORKSHOP', 'OTHER'] },
        address: { type: String, maxlength: 200 }, // street / landmark, typed or from Google Maps
        pincode: { type: String, match: [/^\d{6}$/, 'Pincode must be 6 digits'] },
        location: { _id: false, lat: { type: Number, min: -90, max: 90 }, lng: { type: Number, min: -180, max: 180 } },
        ticketPrice: { type: Number, min: 0 }, // rupees per person
        minAge: { type: Number, min: 0, max: 100 },
        hostName: { type: String, maxlength: 80 },
        contactPhone: { type: String, match: [/^[6-9]\d{9}$/, 'Contact must be a 10-digit Indian mobile number'] },
        capacity: { type: Number, min: 0 },
        attendeesCount: { type: Number, min: 0 }, // set to 0 only for PUBLIC / CORPORATE events

        // CORPORATE
        companyName: String,
        accessCode: { type: String, select: false },
        sessions: { type: [sessionSchema], default: undefined },

        organizerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
    },
    { timestamps: true }
);

eventSchema.index({ kind: 1, startDate: 1 });

module.exports = mongoose.model('Event', eventSchema);
