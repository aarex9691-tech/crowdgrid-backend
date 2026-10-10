const mongoose = require('mongoose');
const TransitRoute = require('./transit.model');
const { Pass } = require('../pass/pass.model');
const { issuePass, toClient } = require('../pass/pass.service');
const { istDate, istDateTime } = require('../../utils/time');
const { badRequest, notFound } = require('../../utils/httpError');

const list = async (eventId) => {
    if (!mongoose.isValidObjectId(eventId)) throw badRequest('Invalid event id');
    return TransitRoute.find({ eventId, isActive: true }).sort({ kind: 1, name: 1 }).lean();
};

/** Boarding pass for today. Asking twice returns the same pass. */
const boardingPass = async (routeId, user) => {
    const route = await TransitRoute.findById(routeId).lean();
    if (!route || !route.isActive) throw notFound('Route not found');
    if (route.kind !== 'SHUTTLE') throw badRequest('Procession routes do not need a boarding pass');
    const day = istDate();
    const dedupeKey = `TRANSIT:${route._id}:${day}:${user._id}`;

    const existing = await Pass.findOne({ dedupeKey });
    if (existing) return { message: 'You already have a boarding pass for today', pass: toClient(existing) };

    try {
        const pass = await issuePass({
            type: 'TRANSIT',
            userId: user._id,
            eventId: route.eventId,
            refId: route._id,
            title: route.name,
            subtitle: `${route.origin} to ${route.destination}`,
            details: {
                gate: route.boardingGate,
                vehicle: route.vehicleType,
                fare: route.fare,
                frequencyMins: route.frequencyMins,
                date: day,
            },
            validFrom: istDateTime(day, '00:00'),
            validUntil: istDateTime(day, '23:59'),
            dedupeKey,
        });
        return { message: 'Boarding pass ready', pass: toClient(pass) };
    } catch (err) {
        if (err.code === 11000) return { message: 'You already have a boarding pass for today', pass: toClient(await Pass.findOne({ dedupeKey })) };
        throw err;
    }
};

module.exports = { list, boardingPass };
