const mongoose = require('mongoose');
const { FoodCenter, FoodSlot, MEALS } = require('./food.model');
const Provider = require('../provider/provider.model');
const { issuePass, toClient } = require('../pass/pass.service');
const { withTransaction } = require('../../utils/tx');
const { istDate, istDateTime, isDateString } = require('../../utils/time');
const { badRequest, notFound, conflict } = require('../../utils/httpError');

/** Kitchens with their meal slots for one day (default: today, IST). */
const listCenters = async (eventId, { sector, date } = {}) => {
    if (!mongoose.isValidObjectId(eventId)) throw badRequest('Invalid event id');
    const day = isDateString(date) ? date : istDate();
    const verified = await Provider.find({ eventId, verificationStatus: 'VERIFIED' }, '_id').lean();
    const filter = { eventId, isActive: true, providerId: { $in: verified.map((p) => p._id) } };
    if (sector) filter.sector = String(sector);

    const centers = await FoodCenter.find(filter).populate('providerId', 'name').lean();
    const slots = await FoodSlot.find({ foodCenterId: { $in: centers.map((c) => c._id) }, date: day }).lean();
    const order = Object.keys(MEALS);
    return {
        date: day,
        meals: MEALS,
        centers: centers.map(({ providerId, ...c }) => ({
            ...c,
            provider: providerId,
            slots: slots
                .filter((s) => String(s.foodCenterId) === String(c._id))
                .sort((a, b) => order.indexOf(a.meal) - order.indexOf(b.meal)),
        })),
    };
};

const humanDate = (d) =>
    istDateTime(d, '12:00').toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' });

const windowFor = (slot) => {
    if (process.env.PASS_TIME_WINDOWS === 'relaxed') {
        return { from: istDateTime(slot.date, '00:00'), until: istDateTime(slot.date, '23:59') };
    }
    return { from: istDateTime(slot.date, slot.startTime), until: istDateTime(slot.date, slot.endTime) };
};

/**
 * 1-tap meal token.
 *  - quota: atomic decrement of `remaining`, only while remaining > 0
 *  - anti-hoarding: dedupeKey MEAL:<event>:<date>:<meal>:<user> is a UNIQUE
 *    index, so MongoDB rejects a second lunch token for the same person on the
 *    same day, at any kitchen, even if both requests arrive simultaneously.
 */
const claim = async (slotId, user) => {
    const slot = await FoodSlot.findById(slotId).lean();
    if (!slot) throw notFound('Meal slot not found');
    const center = await FoodCenter.findById(slot.foodCenterId).lean();
    const { from, until } = windowFor(slot);
    if (new Date() > until) throw badRequest(`The ${MEALS[slot.meal].label.toLowerCase()} window is over`);

    const dedupeKey = `MEAL:${slot.eventId}:${slot.date}:${slot.meal}:${user._id}`;

    return withTransaction(async (session) => {
        const updated = await FoodSlot.findOneAndUpdate(
            { _id: slot._id, remaining: { $gt: 0 } },
            { $inc: { remaining: -1 } },
            { returnDocument: 'after', session }
        );
        if (!updated) throw conflict('All tokens for this meal are taken. Try another kitchen.', { remaining: 0 });
        try {
            const pass = await issuePass(
                {
                    type: 'MEAL',
                    userId: user._id,
                    eventId: slot.eventId,
                    providerId: center.providerId,
                    refId: slot._id,
                    title: `${MEALS[slot.meal].label} - ${center.name}`,
                    subtitle: `${humanDate(slot.date)}, ${slot.startTime} to ${slot.endTime}`,
                    details: { kitchen: center.name, sector: center.sector, meal: slot.meal, date: slot.date, menu: center.menu },
                    validFrom: from,
                    validUntil: until,
                    dedupeKey,
                },
                session
            );
            return { message: 'Meal token issued', remaining: updated.remaining, pass: toClient(pass) };
        } catch (err) {
            if (!session) await FoodSlot.updateOne({ _id: slot._id }, { $inc: { remaining: 1 } });
            if (err.code === 11000) {
                throw conflict(`You already have a ${MEALS[slot.meal].label.toLowerCase()} token for ${slot.date} (limit 1 per meal)`);
            }
            throw err;
        }
    });
};

module.exports = { listCenters, claim };
