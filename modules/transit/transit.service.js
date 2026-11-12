const mongoose = require('mongoose');
const TransitRoute = require('./transit.model');
const { TransitDay, seatsPerDayOf } = TransitRoute;
const capacity = require('../../utils/dailyCapacity');
const Event = require('../event/event.model');
const { Pass } = require('../pass/pass.model');
const { issuePass, toClient } = require('../pass/pass.service');
const { istDate, istDateTime, isDateString } = require('../../utils/time');
const { HttpError, badRequest, notFound, conflict } = require('../../utils/httpError');
const realtime = require('../../utils/realtime');
const { groupSize } = require('../../utils/limits');

/** Routes with seats left on the travel day: the chosen day, else today (or day 1 of a yatra that has not started). */
const list = async (eventId, { date } = {}) => {
    if (!mongoose.isValidObjectId(eventId)) throw badRequest('Invalid event id');
    const routes = await TransitRoute.find({ eventId, isActive: true }).sort({ kind: 1, name: 1 }).lean();
    const shuttles = routes.filter((r) => r.kind === 'SHUTTLE');
    if (!shuttles.length) return routes;
    let day;
    let prebooking;
    try {
        ({ day, prebooking } = await dayFor(shuttles[0], date));
    } catch (err) {
        if (err.status !== 400 || !/ended/.test(err.message)) throw err;
        // The yatra is over: the routes still show (procession routes need no pass), with no seats to book
        return routes.map((r) => (r.kind === 'SHUTTLE' ? { ...r, seatsPerDay: seatsPerDayOf(r), seatsLeft: 0, closed: err.message } : r));
    }
    const rows = await TransitDay.find({ routeId: { $in: shuttles.map((r) => r._id) }, date: day }, 'routeId booked').lean();
    const booked = new Map(rows.map((r) => [String(r.routeId), r.booked]));
    return routes.map((r) => {
        if (r.kind !== 'SHUTTLE') return r;
        const seats = seatsPerDayOf(r);
        return { ...r, travelDay: day, prebooking, seatsPerDay: seats, seatsLeft: Math.max(0, seats - (booked.get(String(r._id)) || 0)) };
    });
};

/** Price check for the cart (fare is always read from the database). */
const quote = async (routeId, people = 1, date = undefined) => {
    people = groupSize(people, 'people on one bus pass');
    if (!mongoose.isValidObjectId(routeId)) throw badRequest('Invalid route');
    const route = await TransitRoute.findById(routeId).lean();
    if (!route || !route.isActive) throw notFound('Route not found');
    if (route.kind !== 'SHUTTLE') throw badRequest('Procession routes do not need a boarding pass');
    const { day, prebooking } = await dayFor(route, date);
    const left = seatsPerDayOf(route) - (await capacity.bookedOn(TransitDay, { routeId: route._id, date: day }));
    if (left < people) throw conflict(left <= 0 ? `${route.name} is full for ${day}` : `Only ${left} seat(s) left on ${route.name} for ${day}`);
    const who = people > 1 ? ` for ${people} people` : '';
    return { route, day, label: route.name, detail: `${prebooking ? 'Pre-booked day pass' : 'Day pass'}${who} for ${day} - ${route.origin} to ${route.destination}`, amount: (route.fare || 0) * people };
};

/**
 * The travel day for a pass. With no day chosen: today, or day 1 of a yatra that has not started yet.
 * A chosen day must be a day of the yatra that has not passed. Booking a day before the yatra starts
 * is a pre-booking (marked on the pass, so the pilgrim and the scanner can see it).
 */
const dayFor = async (route, date) => {
    const ev = await Event.findById(route.eventId, 'startDate endDate status').lean();
    const today = istDate();
    // Nothing to travel to once the yatra is over (or archived)
    if (ev?.status === 'ARCHIVED' || (ev?.endDate && istDate(ev.endDate) < today)) throw badRequest('This yatra has ended. Shuttle passes are closed.');
    const start = ev?.startDate ? istDate(ev.startDate) : today;
    const last = ev?.endDate ? istDate(ev.endDate) : null;
    let day = start > today ? start : today;
    if (date !== undefined && date !== null && date !== '') {
        if (!isDateString(String(date))) throw badRequest('Choose a valid travel day');
        day = String(date);
        if (day < today) throw badRequest('That day has passed. Choose today or a later day of the yatra.');
        if (day < start || (last && day > last)) throw badRequest(`Choose a day of the yatra (${start} to ${last || start})`);
    }
    return { day, prebooking: today < start };
};
const travelDay = async (route, date) => (await dayFor(route, date)).day;

/** Boarding pass for the travel day. Asking twice returns the same pass. */
const boardingPass = async (routeId, user, { paidByOrder = null, people = 1, date = undefined } = {}) => {
    people = groupSize(people, 'people on one bus pass');
    const route = await TransitRoute.findById(routeId).lean();
    if (!route || !route.isActive) throw notFound('Route not found');
    if (route.kind !== 'SHUTTLE') throw badRequest('Procession routes do not need a boarding pass');
    const { day, prebooking } = await dayFor(route, date);
    const dedupeKey = `TRANSIT:${route._id}:${day}:${user._id}`;

    const existing = await Pass.findOne({ dedupeKey });
    if (existing) return { message: `You already have a boarding pass for ${day}`, pass: toClient(existing), existing: true };
    if ((route.fare || 0) > 0 && !paidByOrder) {
        throw new HttpError(402, `This bus costs ₹${route.fare} per person. Add it to your cart and pay at checkout.`);
    }

    // Seats for the whole group, atomically (no overselling even when many book at once)
    const dayKey = { routeId: route._id, date: day };
    if (!(await capacity.claim(TransitDay, dayKey, people, seatsPerDayOf(route)))) {
        const left = Math.max(0, seatsPerDayOf(route) - (await capacity.bookedOn(TransitDay, dayKey)));
        throw conflict(left === 0 ? `${route.name} is full for ${day}. Try another shuttle.` : `Only ${left} seat(s) left on ${route.name} for ${day}`, { seatsLeft: left });
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
                ...(prebooking ? { prebooked: true } : {}),
                ...(paidByOrder ? { paid: paidByOrder.amount, orderId: String(paidByOrder._id) } : {}),
            },
            validFrom: istDateTime(day, '00:00'),
            validUntil: istDateTime(day, '23:59'),
            dedupeKey,
        });
        realtime.notify('control', 'passes', { type: 'TRANSIT' });
        return { message: people > 1 ? `Boarding pass ready for ${people} people` : 'Boarding pass ready', pass: toClient(pass) };
    } catch (err) {
        await capacity.release(TransitDay, dayKey, people); // give the seats back
        if (err.code === 11000) return { message: `You already have a boarding pass for ${day}`, pass: toClient(await Pass.findOne({ dedupeKey })), existing: true };
        throw err;
    }
};

module.exports = { list, quote, boardingPass, travelDay };
