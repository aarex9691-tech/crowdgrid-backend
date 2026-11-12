const { BedAssignment } = require('../lodging/beds');
const nightsLib = require('../lodging/nights');
const mongoose = require('mongoose');
const Provider = require('../provider/provider.model');
const Event = require('../event/event.model');
const eventWindow = require('../../utils/eventWindow');
const { Lodging, LodgingBooking, CATEGORIES } = require('../lodging/lodging.model');
const { FoodCenter, FoodSlot, MEALS } = require('../food/food.model');
const { Pass } = require('../pass/pass.model');
const { ROLES } = require('../../config/roles');
const { istDate, istDateTime, isDateString } = require('../../utils/time');
const { badRequest, forbidden, notFound } = require('../../utils/httpError');
const realtime = require('../../utils/realtime');
const v = require('../../utils/validate');
const audit = require('../audit/audit.service');

/**
 * NGO Camp & Kitchen portal. An NGO admin manages only its own provider;
 * a Super Admin may pass ?providerId= to act on any provider.
 */
const resolveProvider = async (user, providerId) => {
    const id = user.role === ROLES.SUPER_ADMIN && providerId ? providerId : user.providerId;
    if (!id || !mongoose.isValidObjectId(id)) throw forbidden('No organisation linked to this account');
    const provider = await Provider.findById(id).lean();
    if (!provider) throw notFound('Organisation not found');
    if (provider.verificationStatus !== 'VERIFIED') throw forbidden('Your organisation is awaiting verification');
    return provider;
};

const dashboard = async (user, providerId) => {
    const provider = await resolveProvider(user, providerId);
    const realToday = istDate();
    // The day the dashboard shows (beds left, meal quotas): today, or day 1 of a yatra that has not started yet
    const event = provider.eventId ? await Event.findById(provider.eventId, 'kind startDate endDate status').lean() : null;
    const today = event ? eventWindow.windowOf(event).first : realToday;
    const [lodgings, centers] = await Promise.all([
        Lodging.find({ providerId: provider._id }).sort({ sector: 1 }).lean().then((ls) => nightsLib.attachAvailability(ls, { checkIn: today })),
        FoodCenter.find({ providerId: provider._id }).lean(),
    ]);
    const [slots, checkInsToday, bookings] = await Promise.all([
        FoodSlot.find({ foodCenterId: { $in: centers.map((c) => c._id) }, date: today }).lean(),
        Pass.countDocuments({ providerId: provider._id, status: 'REDEEMED', redeemedAt: { $gte: istDateTime(realToday, '00:00') } }),
        LodgingBooking.countDocuments({ lodgingId: { $in: lodgings.map((l) => l._id) }, status: 'CONFIRMED' }),
    ]);
    return {
        provider,
        today, // the day shown: day 1 before the yatra starts
        prebooking: !!event && eventWindow.windowOf(event).prebooking,
        totals: {
            beds: lodgings.reduce((s, l) => s + l.totalBeds, 0),
            available: lodgings.reduce((s, l) => s + l.availableBeds, 0),
            bookings,
            checkInsToday,
        },
        lodgings,
        foodCenters: centers.map((c) => ({ ...c, slots: slots.filter((s) => String(s.foodCenterId) === String(c._id)) })),
    };
};

const addLodging = async (user, body = {}) => {
    const provider = await resolveProvider(user, body.providerId);
    const name = v.text(body.name, 'Camp name', 'campName', { required: true });
    const totalBeds = v.int(body.totalBeds, 'Total beds', { min: 1, max: 5000, required: true });
    const pricePerNight = v.int(body.pricePerNight, 'Price per night (₹)', { min: 0, max: 10000 }) || 0;
    if (!CATEGORIES.includes(body.category)) throw badRequest(`category must be one of ${CATEGORIES.join(', ')}`);
    const lodging = await Lodging.create({
        eventId: provider.eventId,
        providerId: provider._id,
        name,
        sector: body.sector,
        category: body.category,
        distanceToGhatKm: body.distanceToGhatKm,
        amenities: Array.isArray(body.amenities) ? body.amenities : [],
        location: body.location,
        pricePerNight,
        totalBeds,
        heldBeds: 0,
    });
    audit.record({ actor: user, action: 'CAMP_ADDED', targetType: 'Lodging', targetId: lodging._id, summary: `${user.name} added camp "${lodging.name}" with ${totalBeds} beds` });
    realtime.notify(['public', 'control', `provider:${provider._id}`], 'beds', { lodgingId: String(lodging._id) });
    return lodging.toObject();
};

/** Add (positive) or remove (negative) beds. Removing only succeeds if those beds are free. */
const adjustBeds = async (user, lodgingId, change) => {
    const delta = v.int(change, 'Change in beds', { min: -1000, max: 1000, required: true });
    if (delta === 0) throw badRequest('Change in beds cannot be 0');
    const lodging = await Lodging.findById(lodgingId).lean();
    if (!lodging) throw notFound('Camp not found');
    const provider = await resolveProvider(user, lodging.providerId);
    if (String(provider._id) !== String(lodging.providerId)) throw forbidden('Not your camp');
    // Only applies if nobody changed this camp's size in the meantime
    const filter = { _id: lodging._id, totalBeds: lodging.totalBeds };
    if (delta < 0) {
        const newTotal = lodging.totalBeds + delta;
        if (newTotal < (lodging.heldBeds || 0)) throw badRequest(`${lodging.heldBeds} beds are held offline, so the camp cannot go below that`);
        // The beds removed are the highest-numbered ones; they must be free tonight and on every later night
        const today = istDate();
        if (await BedAssignment.exists({ lodgingId: lodging._id, bedNo: { $gt: newTotal }, $or: [{ date: null }, { date: { $gte: today } }] })) {
            throw badRequest(`Beds above number ${newTotal} are booked on some nights, so they cannot be removed yet`);
        }
        const busiest = await nightsLib.LodgingNight.findOne({ lodgingId: lodging._id, date: { $gte: today } }).sort({ booked: -1 }).lean();
        if (busiest && busiest.booked > newTotal - (lodging.heldBeds || 0)) {
            throw badRequest(`${busiest.booked} beds are booked on the night of ${busiest.date}, so the camp cannot shrink to ${newTotal}`);
        }
    }
    const updated = await Lodging.findOneAndUpdate(filter, { $inc: { totalBeds: delta } }, { returnDocument: 'after' }).lean();
    if (!updated) throw badRequest('The camp was just changed by someone else. Please try again.');
    await nightsLib.attachAvailability([updated], { checkIn: istDate() });
    realtime.notify(['public', 'control', `lodging:${updated._id}`, `provider:${updated.providerId}`], 'beds', { lodgingId: String(updated._id) });
    audit.record({ actor: user, action: 'BEDS_ADJUSTED', targetType: 'Lodging', targetId: lodging._id, summary: `${user.name} ${delta > 0 ? 'added' : 'removed'} ${Math.abs(delta)} beds at "${lodging.name}"` });
    return updated;
};

const addFoodCenter = async (user, body = {}) => {
    const provider = await resolveProvider(user, body.providerId);
    const center = await FoodCenter.create({
        eventId: provider.eventId,
        providerId: provider._id,
        name: v.text(body.name, 'Kitchen name', 'campName', { required: true }),
        sector: body.sector,
        menu: Array.isArray(body.menu) ? body.menu : String(body.menu || '').split(',').map((s) => s.trim()).filter(Boolean),
        location: body.location,
    });
    return center.toObject();
};

/** Set the token quota for a meal at a kitchen on a day (creates or updates the slot). */
const setSlot = async (user, centerId, { date, meal, capacity } = {}) => {
    const center = await FoodCenter.findById(centerId).lean();
    if (!center) throw notFound('Kitchen not found');
    const provider = await resolveProvider(user, center.providerId);
    if (String(provider._id) !== String(center.providerId)) throw forbidden('Not your kitchen');
    if (!isDateString(date)) throw badRequest('date must be YYYY-MM-DD');
    // Meal slots only on days of the yatra that have not passed
    const event = await Event.findById(center.eventId, 'kind startDate endDate status').lean();
    eventWindow.assertOpen(event);
    eventWindow.assertDay(event, date);
    if (!MEALS[meal]) throw badRequest(`meal must be one of ${Object.keys(MEALS).join(', ')}`);
    const cap = v.int(capacity, 'Meal tokens', { min: 0, max: 20000, required: true });

    const existing = await FoodSlot.findOne({ foodCenterId: center._id, date, meal });
    if (!existing) {
        const slot = await FoodSlot.create({
            foodCenterId: center._id,
            eventId: center.eventId,
            date,
            meal,
            startTime: MEALS[meal].start,
            endTime: MEALS[meal].end,
            capacity: cap,
            remaining: cap,
        });
        realtime.notify(['public', 'control', `provider:${center.providerId}`], 'meals', { slotId: String(slot._id) });
        return slot.toObject();
    }
    // Change quota atomically, never below tokens already issued
    const delta = cap - existing.capacity;
    const filter = { _id: existing._id };
    if (delta < 0) filter.remaining = { $gte: -delta };
    const updated = await FoodSlot.findOneAndUpdate(filter, { $inc: { capacity: delta, remaining: delta } }, { returnDocument: 'after' }).lean();
    if (updated) realtime.notify(['public', 'control', `provider:${center.providerId}`], 'meals', { slotId: String(updated._id) });
    if (!updated) throw badRequest('Capacity cannot be lower than tokens already issued');
    audit.record({ actor: user, action: 'MEAL_QUOTA_CHANGED', targetType: 'FoodSlot', targetId: existing._id, summary: `${user.name} set ${meal.toLowerCase()} quota at "${center.name}" on ${date} to ${cap}` });
    return updated;
};

module.exports = { dashboard, addLodging, adjustBeds, addFoodCenter, setSlot };
