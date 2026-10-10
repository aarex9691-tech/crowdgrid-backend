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
        boardingGate: String,
        checkpoints: [checkpointSchema],
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model('TransitRoute', transitRouteSchema);
