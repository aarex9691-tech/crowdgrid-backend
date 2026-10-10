const mongoose = require('mongoose');
const Provider = require('../provider/provider.model');
const { Lodging, LodgingBooking, CATEGORIES } = require('../lodging/lodging.model');
const { FoodCenter, FoodSlot, MEALS } = require('../food/food.model');
const { Pass } = require('../pass/pass.model');
const { ROLES } = require('../../config/roles');
const { istDate, istDateTime, isDateString } = require('../../utils/time');
const { badRequest, forbidden, notFound } = require('../../utils/httpError');

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
    const today = istDate();
    const [lodgings, centers] = await Promise.all([
        Lodging.find({ providerId: provider._id }).sort({ sector: 1 }).lean(),
        FoodCenter.find({ providerId: provider._id }).lean(),
    ]);
    const [slots, checkInsToday, bookings] = await Promise.all([
        FoodSlot.find({ foodCenterId: { $in: centers.map((c) => c._id) }, date: today }).lean(),
        Pass.countDocuments({ providerId: provider._id, status: 'REDEEMED', redeemedAt: { $gte: istDateTime(today, '00:00') } }),
        LodgingBooking.countDocuments({ lodgingId: { $in: lodgings.map((l) => l._id) }, status: 'CONFIRMED' }),
    ]);
    return {
        provider,
        today,
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
    const totalBeds = Number(body.totalBeds);
    if (!Number.isInteger(totalBeds) || totalBeds < 1) throw badRequest('totalBeds must be a positive whole number');
    if (!CATEGORIES.includes(body.category)) throw badRequest(`category must be one of ${CATEGORIES.join(', ')}`);
    const lodging = await Lodging.create({
        eventId: provider.eventId,
        providerId: provider._id,
        name: body.name,
        sector: body.sector,
        category: body.category,
        distanceToGhatKm: body.distanceToGhatKm,
        amenities: Array.isArray(body.amenities) ? body.amenities : [],
        location: body.location,
        pricePerNight: body.pricePerNight || 0,
        totalBeds,
        availableBeds: totalBeds,
    });
    return lodging.toObject();
};

/** Add (positive) or remove (negative) beds. Removing only succeeds if those beds are free. */
const adjustBeds = async (user, lodgingId, change) => {
    const delta = Number(change);
    if (!Number.isInteger(delta) || delta === 0) throw badRequest('change must be a non-zero whole number');
    const lodging = await Lodging.findById(lodgingId).lean();
    if (!lodging) throw notFound('Camp not found');
    const provider = await resolveProvider(user, lodging.providerId);
    if (String(provider._id) !== String(lodging.providerId)) throw forbidden('Not your camp');
    const filter = { _id: lodging._id };
    if (delta < 0) filter.availableBeds = { $gte: -delta };
    const updated = await Lodging.findOneAndUpdate(filter, { $inc: { totalBeds: delta, availableBeds: delta } }, { returnDocument: 'after' }).lean();
    if (!updated) throw badRequest('Cannot remove beds that are already booked');
    return updated;
};

const addFoodCenter = async (user, body = {}) => {
    const provider = await resolveProvider(user, body.providerId);
    const center = await FoodCenter.create({
        eventId: provider.eventId,
        providerId: provider._id,
        name: body.name,
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
    if (!MEALS[meal]) throw badRequest(`meal must be one of ${Object.keys(MEALS).join(', ')}`);
    const cap = Number(capacity);
    if (!Number.isInteger(cap) || cap < 0) throw badRequest('capacity must be a whole number');

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
        return slot.toObject();
    }
    // Change quota atomically, never below tokens already issued
    const delta = cap - existing.capacity;
    const filter = { _id: existing._id };
    if (delta < 0) filter.remaining = { $gte: -delta };
    const updated = await FoodSlot.findOneAndUpdate(filter, { $inc: { capacity: delta, remaining: delta } }, { returnDocument: 'after' }).lean();
    if (!updated) throw badRequest('Capacity cannot be lower than tokens already issued');
    return updated;
};

module.exports = { dashboard, addLodging, adjustBeds, addFoodCenter, setSlot };
