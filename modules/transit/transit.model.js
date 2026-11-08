const mongoose = require('mongoose');

const checkpointSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        type: { type: String, enum: ['STOP', 'WATER', 'TOILET', 'AMBULANCE', 'GHAT'], default: 'STOP' },
        lat: Number,
        lng: Number,
    },
    { _id: false }
);

const transitRouteSchema = new mongoose.Schema(
    {
        eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
        name: { type: String, required: true },
        kind: { type: String, enum: ['SHUTTLE', 'PROCESSION'], default: 'SHUTTLE' },
        origin: String,
        destination: String,
        vehicleType: String,
        frequencyMins: Number,
        firstDeparture: String,
        lastDeparture: String,
        fare: { type: Number, default: 0 }, // 0 = free seva
        // Seats: a day's passes are capped at seatsPerTrip x the number of departures that day
        // (or seatsPerDay when the operator sets it directly)
        seatsPerTrip: { type: Number, min: 1, max: 200, default: 20 },
        seatsPerDay: { type: Number, min: 0 },
        boardingGate: String,
        checkpoints: [checkpointSchema],
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

/** Seats sold per route per travel day (one row each; see utils/dailyCapacity.js). */
const transitDaySchema = new mongoose.Schema(
    {
        routeId: { type: mongoose.Schema.Types.ObjectId, ref: 'TransitRoute', required: true },
        date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
        booked: { type: Number, required: true, min: 0, default: 0 },
    },
    { timestamps: true }
);
transitDaySchema.index({ routeId: 1, date: 1 }, { unique: true });

const minutes = (hhmm) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Seats a route can carry in one day. */
const seatsPerDayOf = (route) => {
    if (Number.isFinite(route.seatsPerDay)) return route.seatsPerDay;
    const first = minutes(route.firstDeparture);
    const last = minutes(route.lastDeparture);
    const every = route.frequencyMins > 0 ? route.frequencyMins : 30;
    const trips = first !== null && last !== null && last >= first ? Math.floor((last - first) / every) + 1 : 1;
    return trips * (route.seatsPerTrip || 20);
};

module.exports = mongoose.model('TransitRoute', transitRouteSchema);
module.exports.TransitDay = mongoose.model('TransitDay', transitDaySchema);
module.exports.seatsPerDayOf = seatsPerDayOf;
