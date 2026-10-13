const mongoose = require('mongoose');
const { Lodging, LodgingBooking, CATEGORIES } = require('./lodging.model');
const Provider = require('../provider/provider.model');
const Event = require('../event/event.model');
const { issuePass, toClient, cancelPass } = require('../pass/pass.service');
const { withTransaction } = require('../../utils/tx');
const bedAlloc = require('./beds');
const audit = require('../audit/audit.service');
const { istDate, istDateTime, isDateString } = require('../../utils/time');
const { HttpError, badRequest, notFound, conflict, forbidden } = require('../../utils/httpError');

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
 * The claim runs on its own, outside any transaction: a single-document update
 * is already atomic, and keeping it out of a multi-document transaction means
 * hundreds of simultaneous requests never trigger transaction write-conflict
 * retries (200 racing requests finish in about a second instead of a minute).
 * The booking and its QR pass are then written together in one transaction
 * (Atlas). If that step fails for any reason, the beds are handed back.
 */
/** Nights between two YYYY-MM-DD dates (a same-day stay counts as one night). */
const nightsBetween = (checkIn, checkOut) =>
    Math.max(1, Math.round((istDateTime(checkOut, '12:00') - istDateTime(checkIn, '12:00')) / 86400000));

/**
 * Price check for the cart: validates the request exactly like a booking would,
 * without writing anything. Price is always computed here, never sent by the browser.
 */
const quote = async (lodgingId, { beds, checkIn, checkOut } = {}) => {
    const count = Number(beds);
    if (!Number.isInteger(count) || count < 1 || count > MAX_BEDS_PER_USER) {
        throw badRequest(`You can book between 1 and ${MAX_BEDS_PER_USER} beds`);
    }
    if (!mongoose.isValidObjectId(lodgingId)) throw badRequest('Invalid camp');
    const lodging = await Lodging.findById(lodgingId).populate('providerId', 'name verificationStatus').lean();
    if (!lodging || !lodging.isActive) throw notFound('Camp not found');
    if (lodging.providerId?.verificationStatus !== 'VERIFIED') throw forbidden('This camp is not verified yet');
    if (lodging.availableBeds < count) throw conflict(lodging.availableBeds === 0 ? 'Sold out - no beds left at this camp' : `Only ${lodging.availableBeds} bed(s) left`);
    const event = await Event.findById(lodging.eventId).lean();
    const stay = parseStay(event, checkIn, checkOut);
    const nights = nightsBetween(stay.checkIn, stay.checkOut);
    const unitPrice = lodging.pricePerNight || 0;
    return {
        lodging,
        label: lodging.name,
        detail: `${count} bed${count > 1 ? 's' : ''} x ${nights} night${nights > 1 ? 's' : ''} x ₹${unitPrice} - ${stay.checkIn === stay.checkOut ? stay.checkIn : `${stay.checkIn} to ${stay.checkOut}`}`,
        amount: unitPrice * count * nights,
        stay,
    };
};

const book = async (lodgingId, user, { beds, guestNames = [], checkIn, checkOut } = {}, { paidByOrder = null } = {}) => {
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
    // Paid camps are booked through the cart and checkout (simulated payment)
    if ((lodging.pricePerNight || 0) > 0 && !paidByOrder) {
        throw new HttpError(402, `This camp costs ₹${lodging.pricePerNight} per bed per night. Add it to your cart and pay at checkout.`);
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

    // 1. Claim the beds atomically (no transaction, no conflict retries)
    const updated = await Lodging.findOneAndUpdate(
        { _id: lodging._id, isActive: true, availableBeds: { $gte: count } },
        { $inc: { availableBeds: -count } },
        { returnDocument: 'after' }
    );
    if (!updated) {
        const fresh = await Lodging.findById(lodging._id, 'availableBeds').lean();
        const left = fresh ? fresh.availableBeds : 0;
        throw conflict(left === 0 ? 'Sold out - no beds left at this camp' : `Only ${left} bed(s) left`, { availableBeds: left });
    }

    // 2. Number the beds (tent + bed). A unique index stops two bookings taking the same bed.
    const bookingId = new mongoose.Types.ObjectId();
    let bedNos;
    try {
        bedNos = await bedAlloc.allocate(lodging, bookingId, count);
    } catch (err) {
        await Lodging.updateOne({ _id: lodging._id }, { $inc: { availableBeds: count } });
        throw err;
    }
    const where = bedAlloc.describe(lodging, bedNos);

    // 3. Write booking + pass together; give the beds back if this fails
    try {
        return await withTransaction(async (session) => {
            const [booking] = await LodgingBooking.create(
                [{ _id: bookingId, lodgingId: lodging._id, eventId: lodging.eventId, userId: user._id, beds: count, guestNames: names, bedNos, bedLabel: where.text, ...stay }],
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
                    subtitle: `${where.text} - ${lodging.sector}`,
                    details: {
                        sector: lodging.sector,
                        tent: where.parts.map((p) => p.unit).join(' + '),
                        bedNumbers: where.parts.flatMap((p) => p.beds),
                        location: where.text,
                        beds: count,
                        guests: names,
                        checkIn: stay.checkIn,
                        checkOut: stay.checkOut,
                        provider: lodging.providerId.name,
                        ...(paidByOrder ? { paid: paidByOrder.amount, orderId: String(paidByOrder._id) } : {}),
                    },
                    validFrom: istDateTime(stay.checkIn, '00:00'),
                    validUntil: istDateTime(stay.checkOut, '23:59'),
                },
                session
            );
            booking.passId = pass._id;
            await booking.save({ session });
            return {
                message: `Booking confirmed: ${where.text}`,
                booking: booking.toObject(),
                availableBeds: updated.availableBeds,
                pass: toClient(pass),
            };
        });
    } catch (err) {
        await bedAlloc.release(bookingId);
        await Lodging.updateOne({ _id: lodging._id }, { $inc: { availableBeds: count } });
        throw err;
    }
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
        await bedAlloc.release(booking._id, session);
        await cancelPass(booking.passId, session);
        audit.record({ actor: user, action: 'BOOKING_CANCELLED', targetType: 'LodgingBooking', targetId: booking._id, summary: `${user.name} cancelled a ${booking.beds}-bed booking` });
        return { message: 'Booking cancelled', booking: booking.toObject() };
    });
};

const mine = async (userId) =>
    LodgingBooking.find({ userId }).populate('lodgingId', 'name sector category').sort({ createdAt: -1 }).lean();

/**
 * Theatre-style bed map for camp staff and authorities: every tent / room /
 * hall with each bed marked free, booked online (with guest and stay) or held
 * offline (walk-ins). NGO admins can only open their own camps.
 */
const bedMap = async (lodgingId, user) => {
    if (!mongoose.isValidObjectId(lodgingId)) throw badRequest('Invalid camp');
    const lodging = await Lodging.findById(lodgingId).populate('providerId', 'name').lean();
    if (!lodging) throw notFound('Camp not found');
    if (user.role === 'NGO_ADMIN' && String(lodging.providerId?._id) !== String(user.providerId)) {
        throw forbidden('You can only view your own camps');
    }
    const unit = bedAlloc.unitFor(lodging);
    const assignments = await bedAlloc.BedAssignment.find({ lodgingId: lodging._id }).lean();
    const bookingIds = [...new Set(assignments.filter((a) => a.bookingId).map((a) => String(a.bookingId)))];
    const bookings = await LodgingBooking.find({ _id: { $in: bookingIds } }).populate('userId', 'name').lean();
    const byId = new Map(bookings.map((b) => [String(b._id), b]));

    const taken = new Map();
    for (const a of assignments) {
        const b = a.bookingId && byId.get(String(a.bookingId));
        if (!b) {
            taken.set(a.bedNo, { status: 'HELD' });
            continue;
        }
        const idx = (b.bedNos || []).indexOf(a.bedNo);
        taken.set(a.bedNo, {
            status: 'BOOKED',
            guest: b.guestNames?.[idx] || null,
            bookedBy: b.userId?.name || null,
            checkIn: b.checkIn,
            checkOut: b.checkOut,
            bookingId: b._id,
        });
    }

    const units = [];
    const count = Math.ceil(lodging.totalBeds / unit.size);
    for (let u = 1; u <= count; u++) {
        const beds = [];
        for (let n = (u - 1) * unit.size + 1; n <= Math.min(u * unit.size, lodging.totalBeds); n++) {
            beds.push({ bedNo: n, bed: n - (u - 1) * unit.size, ...(taken.get(n) || { status: 'FREE' }) });
        }
        units.push({ unitNo: u, label: `${unit.label} ${unit.prefix}-${u}`, beds, free: beds.filter((b) => b.status === 'FREE').length });
    }
    return {
        lodging: { _id: lodging._id, name: lodging.name, sector: lodging.sector, category: lodging.category, provider: lodging.providerId?.name, totalBeds: lodging.totalBeds, availableBeds: lodging.availableBeds },
        unit: { label: unit.label, size: unit.size },
        summary: {
            units: units.length,
            free: units.reduce((s, x) => s + x.free, 0),
            booked: assignments.filter((a) => a.bookingId).length,
            held: assignments.filter((a) => !a.bookingId).length,
        },
        units,
    };
};

module.exports = { search, quote, book, cancel, mine, bedMap, MAX_BEDS_PER_USER };
