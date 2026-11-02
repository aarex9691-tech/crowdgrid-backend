const mongoose = require('mongoose');
const TransitRoute = require('./transit.model');
const Event = require('../event/event.model');
const { Pass } = require('../pass/pass.model');
const { issuePass, toClient } = require('../pass/pass.service');
const { istDate, istDateTime } = require('../../utils/time');
const { HttpError, badRequest, notFound } = require('../../utils/httpError');
const realtime = require('../../utils/realtime');
const { groupSize } = require('../../utils/limits');

const list = async (eventId) => {
    if (!mongoose.isValidObjectId(eventId)) throw badRequest('Invalid event id');
    return TransitRoute.find({ eventId, isActive: true }).sort({ kind: 1, name: 1 }).lean();
};

/** Price check for the cart (fare is always read from the database). */
const quote = async (routeId, people = 1) => {
    people = groupSize(people, 'people on one bus pass');
    if (!mongoose.isValidObjectId(routeId)) throw badRequest('Invalid route');
    const route = await TransitRoute.findById(routeId).lean();
    if (!route || !route.isActive) throw notFound('Route not found');
    if (route.kind !== 'SHUTTLE') throw badRequest('Procession routes do not need a boarding pass');
    const day = await travelDay(route);
    const who = people > 1 ? ` for ${people} people` : '';
    return { route, label: route.name, detail: `Day pass${who} for ${day} - ${route.origin} to ${route.destination}`, amount: (route.fare || 0) * people };
};

/** Travel day: today, or the yatra's first day when it has not started yet (Wari, Rath Yatra). */
const travelDay = async (route) => {
    const ev = await Event.findById(route.eventId, 'startDate').lean();
    const today = istDate();
    const first = ev?.startDate ? istDate(ev.startDate) : today;
    return first > today ? first : today;
};

/** Boarding pass for the travel day. Asking twice returns the same pass. */
const boardingPass = async (routeId, user, { paidByOrder = null, people = 1 } = {}) => {
    people = groupSize(people, 'people on one bus pass');
    const route = await TransitRoute.findById(routeId).lean();
    if (!route || !route.isActive) throw notFound('Route not found');
    if (route.kind !== 'SHUTTLE') throw badRequest('Procession routes do not need a boarding pass');
    const day = await travelDay(route);
    const dedupeKey = `TRANSIT:${route._id}:${day}:${user._id}`;

    const existing = await Pass.findOne({ dedupeKey });
    if (existing) return { message: `You already have a boarding pass for ${day}`, pass: toClient(existing), existing: true };
    if ((route.fare || 0) > 0 && !paidByOrder) {
        throw new HttpError(402, `This bus costs ₹${route.fare} per person. Add it to your cart and pay at checkout.`);
    }

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
                people,
                frequencyMins: route.frequencyMins,
                date: day,
                ...(paidByOrder ? { paid: route.fare, orderId: String(paidByOrder._id) } : {}),
            },
            validFrom: istDateTime(day, '00:00'),
            validUntil: istDateTime(day, '23:59'),
            dedupeKey,
        });
        realtime.notify('control', 'passes', { type: 'TRANSIT' });
        return { message: people > 1 ? `Boarding pass ready for ${people} people` : 'Boarding pass ready', pass: toClient(pass) };
    } catch (err) {
        if (err.code === 11000) return { message: `You already have a boarding pass for ${day}`, pass: toClient(await Pass.findOne({ dedupeKey })), existing: true };
        throw err;
    }
};

module.exports = { list, quote, boardingPass };
