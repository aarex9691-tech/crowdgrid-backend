const mongoose = require('mongoose');
const { Lodging, LodgingBooking, CATEGORIES } = require('./lodging.model');
const Provider = require('../provider/provider.model');
const Event = require('../event/event.model');
const { issuePass, toClient, cancelPass } = require('../pass/pass.service');
const { withTransaction } = require('../../utils/tx');
const { istDate, istDateTime, isDateString } = require('../../utils/time');
const { badRequest, notFound, conflict, forbidden } = require('../../utils/httpError');

const MAX_BEDS_PER_USER = 4;

/** Camp search for the Lodging tab. Only camps run by verified providers are listed. */
const search = async (eventId, { sector, category, minBeds } = {}) => {
    if (!mongoose.isValidObjectId(eventId)) throw badRequest('Invalid event id');
    const verified = await Provider.find({ eventId, verificationStatus: 'VERIFIED' }, '_id').lean();
    const filter = { eventId, isActive: true, providerId: { $in: verified.map((p) => p._id) } };
    if (sector) filter.sector = String(sector);
    if (category && CATEGORIES.includes(String(category))) filter.category = String(category);
    if (minBeds) filter.availableBeds = { $gte: Number(minBeds) || 0 };

    const lodgings = await Lodging.find(filter)
        .populate('providerId', 'name type verificationStatus')
        .sort({ availableBeds: -1, distanceToGhatKm: 1 })
        .lean();
    return lodgings.map(({ providerId, ...l }) => ({ ...l, provider: providerId }));
};

const parseStay = (event, checkIn, checkOut) => {
    const eventStart = istDate(event.startDate);
    const eventEnd = istDate(event.endDate);
    const today = istDate();
    const inDate = isDateString(checkIn) ? checkIn : today > eventStart ? today : eventStart;
    const outDate = isDateString(checkOut) ? checkOut : inDate;
    if (outDate < inDate) throw badRequest('Check-out must be on or after check-in');
    if (inDate < today) throw badRequest('Check-in cannot be in the past');
    if (inDate > eventEnd || outDate > eventEnd) throw badRequest(`Stays must end by ${eventEnd}`);
    return { checkIn: inDate, checkOut: outDate };
};

/**
 * Bed booking - the zero double-booking guarantee.
 *
 * The bed count is decremented with ONE atomic findOneAndUpdate whose filter
 * requires `availableBeds >= beds`. MongoDB applies each single-document update
 * atomically, so if 200 pilgrims race for the last 10 beds, exactly 10 updates
 * match and the rest find nothing - no oversell, no locks held by the app.
 * (MySQL equivalent: SELECT ... FOR UPDATE then UPDATE inside a transaction.)
 *
 * The decrement, booking and QR pass are written in one transaction on Atlas;
 * on a standalone server a failure after the decrement gives the beds back.
 */
const book = async (lodgingId, user, { beds, guestNames = [], checkIn, checkOut } = {}) => {
    const count = Number(beds);
    if (!Number.isInteger(count) || count < 1 || count > MAX_BEDS_PER_USER) {
        throw badRequest(`You can book between 1 and ${MAX_BEDS_PER_USER} beds`);
    }
    const names = (Array.isArray(guestNames) ? guestNames : []).map((n) => String(n).trim()).filter(Boolean);
    if (names.length && names.length !== count) throw badRequest('Enter one guest name per bed');

    const lodging = await Lodging.findById(lodgingId).populate('providerId', 'name verificationStatus').lean();
    if (!lodging || !lodging.isActive) throw notFound('Camp not found');
    if (!lodging.providerId || lodging.providerId.verificationStatus !== 'VERIFIED') {
        throw forbidden('This camp is not verified yet');
    }
    const event = await Event.findById(lodging.eventId).lean();
    const stay = parseStay(event, checkIn, checkOut);

    // Per-person cap across the whole event (max 4 beds per mobile number)
    const [held] = await LodgingBooking.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(user._id)), eventId: lodging.eventId, status: 'CONFIRMED' } },
        { $group: { _id: null, beds: { $sum: '$beds' } } },
    ]);
    const already = held ? held.beds : 0;
    if (already + count > MAX_BEDS_PER_USER) {
        throw badRequest(`Limit is ${MAX_BEDS_PER_USER} beds per person for this yatra. You already hold ${already}.`);
    }

    return withTransaction(async (session) => {
        const updated = await Lodging.findOneAndUpdate(
            { _id: lodging._id, isActive: true, availableBeds: { $gte: count } },
            { $inc: { availableBeds: -count } },
            { returnDocument: 'after', session }
        );
        if (!updated) {
            const fresh = await Lodging.findById(lodging._id, 'availableBeds').session(session).lean();
            const left = fresh ? fresh.availableBeds : 0;
            throw conflict(left === 0 ? 'Sold out - no beds left at this camp' : `Only ${left} bed(s) left`, { availableBeds: left });
        }

        try {
            const [booking] = await LodgingBooking.create(
                [{ lodgingId: lodging._id, eventId: lodging.eventId, userId: user._id, beds: count, guestNames: names, ...stay }],
                { session }
            );
            const pass = await issuePass(
                {
                    type: 'LODGING',
                    userId: user._id,
                    eventId: lodging.eventId,
                    providerId: lodging.providerId._id,
                    refId: booking._id,
                    title: lodging.name,
                    subtitle: `${lodging.sector} - ${count} bed${count > 1 ? 's' : ''}`,
                    details: {
                        sector: lodging.sector,
                        beds: count,
                        guests: names,
                        checkIn: stay.checkIn,
                        checkOut: stay.checkOut,
                        provider: lodging.providerId.name,
                    },
                    validFrom: istDateTime(stay.checkIn, '00:00'),
                    validUntil: istDateTime(stay.checkOut, '23:59'),
                },
                session
            );
            booking.passId = pass._id;
            await booking.save({ session });
            return {
                message: 'Booking confirmed',
                booking: booking.toObject(),
                availableBeds: updated.availableBeds,
                pass: toClient(pass),
            };
        } catch (err) {
            // Standalone MongoDB (no transactions): give the beds back
            if (!session) await Lodging.updateOne({ _id: lodging._id }, { $inc: { availableBeds: count } });
            throw err;
        }
    });
};

/** Cancel a booking: flips status atomically, returns the beds, voids the pass. */
const cancel = async (bookingId, user) => {
    return withTransaction(async (session) => {
        const booking = await LodgingBooking.findOneAndUpdate(
            { _id: bookingId, userId: user._id, status: 'CONFIRMED' },
            { $set: { status: 'CANCELLED' } },
            { returnDocument: 'after', session }
        );
        if (!booking) throw notFound('Active booking not found');
        await Lodging.updateOne({ _id: booking.lodgingId }, { $inc: { availableBeds: booking.beds } }, { session });
        await cancelPass(booking.passId, session);
        return { message: 'Booking cancelled', booking: booking.toObject() };
    });
};

const mine = async (userId) =>
    LodgingBooking.find({ userId }).populate('lodgingId', 'name sector category').sort({ createdAt: -1 }).lean();

module.exports = { search, book, cancel, mine, MAX_BEDS_PER_USER };
