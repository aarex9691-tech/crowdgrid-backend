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
const realtime = require('../../utils/realtime');

const { MAX_PER_ACCOUNT } = require('../../utils/limits');
const nightsLib = require('./nights');
const MAX_BEDS_PER_USER = MAX_PER_ACCOUNT; // 5 beds per account on any one night

/**
 * Camp search for the Lodging tab. Only camps run by verified providers are listed.
 * `availableBeds` is worked out for the chosen stay (beds free on EVERY night of it),
 * or for the yatra's next night when no dates are given.
 */
const search = async (eventId, { sector, category, minBeds, checkIn, checkOut } = {}) => {
    if (!mongoose.isValidObjectId(eventId)) throw badRequest('Invalid event id');
    const verified = await Provider.find({ eventId, verificationStatus: 'VERIFIED' }, '_id').lean();
    const filter = { eventId, isActive: true, providerId: { $in: verified.map((p) => p._id) } };
    if (sector) filter.sector = String(sector);
    if (category && CATEGORIES.includes(String(category))) filter.category = String(category);

    const event = await Event.findById(eventId, 'startDate endDate').lean();
    const first = isDateString(checkIn) ? checkIn : nightsLib.defaultNight(event);
    const last = isDateString(checkOut) && checkOut >= first ? checkOut : first;

    const lodgings = await Lodging.find(filter).populate('providerId', 'name type verificationStatus').lean();
    await nightsLib.attachAvailability(lodgings, { checkIn: first, checkOut: last });
    const min = Number(minBeds) || 0;
    return lodgings
        .filter((l) => l.availableBeds >= min)
        .sort((a, b) => b.availableBeds - a.availableBeds || (a.distanceToGhatKm || 0) - (b.distanceToGhatKm || 0))
        .map(({ providerId, ...l }) => ({ ...l, provider: providerId }));
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
    const nights = nightsLib.nightsOf(inDate, outDate);
    if (nights.length > nightsLib.MAX_NIGHTS) throw badRequest(`A stay can be at most ${nightsLib.MAX_NIGHTS} nights so more pilgrims get a bed`);
    return { checkIn: inDate, checkOut: outDate, nights };
};

/** One full name per bed (people staying in the tent). */
const guestNamesFor = (guestNames, count) => {
    const names = (Array.isArray(guestNames) ? guestNames : []).map((n) => String(n).trim()).filter(Boolean);
    if (names.length !== count) throw badRequest(`Enter the name of each person staying (${count} name${count > 1 ? 's' : ''})`);
    if (names.some((n) => n.length < 2 || n.length > 60)) throw badRequest('Each guest name must be 2 to 60 characters');
    return names;
};

/**
 * Tents and beds of one camp for a stay, for the pilgrim to choose from.
 * A bed counts as free only if it is free on EVERY night of the stay. No names are shown.
 */
const stayMap = async (lodgingId, { checkIn, checkOut } = {}) => {
    if (!mongoose.isValidObjectId(lodgingId)) throw badRequest('Invalid camp');
    const lodging = await Lodging.findById(lodgingId).populate('providerId', 'name verificationStatus').lean();
    if (!lodging || !lodging.isActive) throw notFound('Camp not found');
    if (lodging.providerId?.verificationStatus !== 'VERIFIED') throw forbidden('This camp is not verified yet');
    const event = await Event.findById(lodging.eventId).lean();
    const stay = parseStay(event, checkIn, checkOut);
    const taken = await bedAlloc.takenOn(lodging._id, stay.nights);
    const unit = bedAlloc.unitFor(lodging);
    const units = [];
    for (let u = 1; u <= Math.ceil(lodging.totalBeds / unit.size); u++) {
        const beds = [];
        for (let n = (u - 1) * unit.size + 1; n <= Math.min(u * unit.size, lodging.totalBeds); n++) beds.push({ bedNo: n, bed: n - (u - 1) * unit.size, free: !taken.has(n) });
        units.push({ unitNo: u, label: `${unit.label} ${unit.prefix}-${u}`, beds, free: beds.filter((b) => b.free).length });
    }
    return {
        lodging: { _id: lodging._id, name: lodging.name, category: lodging.category, pricePerNight: lodging.pricePerNight || 0 },
        stay: { checkIn: stay.checkIn, checkOut: stay.checkOut, nights: stay.nights.length },
        unit: { label: unit.label, size: unit.size },
        free: units.reduce((s, x) => s + x.free, 0),
        units,
    };
};

/** Nights between two YYYY-MM-DD dates (a same-day stay counts as one night). */
const nightsBetween = (checkIn, checkOut) => nightsLib.nightsOf(checkIn, checkOut).length;

/**
 * Price check for the cart: validates the request exactly like a booking would,
 * without writing anything. Price is always computed here, never sent by the browser.
 */
const quote = async (lodgingId, { beds, checkIn, checkOut, bedNos, guestNames } = {}, { requireNames = false } = {}) => {
    const count = Number(beds);
    if (!Number.isInteger(count) || count < 1 || count > MAX_BEDS_PER_USER) {
        throw badRequest(`You can book between 1 and ${MAX_BEDS_PER_USER} beds`);
    }
    if (!mongoose.isValidObjectId(lodgingId)) throw badRequest('Invalid camp');
    const lodging = await Lodging.findById(lodgingId).populate('providerId', 'name verificationStatus').lean();
    if (!lodging || !lodging.isActive) throw notFound('Camp not found');
    if (lodging.providerId?.verificationStatus !== 'VERIFIED') throw forbidden('This camp is not verified yet');
    const event = await Event.findById(lodging.eventId).lean();
    const stay = parseStay(event, checkIn, checkOut);
    await nightsLib.attachAvailability([lodging], stay);
    if (lodging.availableBeds < count) {
        throw conflict(lodging.availableBeds === 0 ? 'Sold out for these dates - no beds left at this camp' : `Only ${lodging.availableBeds} bed(s) left for these dates`);
    }
    if (requireNames) guestNamesFor(guestNames, count);
    // Beds chosen on the map must still be free on every night of the stay
    let where = null;
    if (bedNos !== undefined && bedNos !== null) {
        const chosen = bedAlloc.checkChosen(lodging, bedNos, count);
        const taken = await bedAlloc.takenOn(lodging._id, stay.nights);
        const clash = chosen.filter((n) => taken.has(n));
        if (clash.length) throw conflict(`${bedAlloc.describe(lodging, clash).text} ${clash.length > 1 ? 'are' : 'is'} already taken for these dates. Please choose other beds.`, { takenBeds: clash });
        where = bedAlloc.describe(lodging, chosen).text;
    }
    const nights = stay.nights.length;
    const unitPrice = lodging.pricePerNight || 0;
    return {
        lodging,
        label: lodging.name,
        detail: `${where ? `${where} · ` : ''}${count} bed${count > 1 ? 's' : ''} x ${nights} night${nights > 1 ? 's' : ''} x ₹${unitPrice} - ${stay.checkIn === stay.checkOut ? stay.checkIn : `${stay.checkIn} to ${stay.checkOut}`}`,
        amount: unitPrice * count * nights,
        stay: { checkIn: stay.checkIn, checkOut: stay.checkOut },
    };
};

/**
 * Bed booking - the zero double-booking guarantee, night by night.
 *
 * 1. Every night of the stay is claimed with ONE atomic conditional update on that
 *    night's row ($inc only while booked + beds <= capacity; see nights.js). If 200
 *    pilgrims race for the last 10 beds of a night, exactly 10 updates match.
 *    A stay that cannot get all its nights gives back the ones it took.
 * 2. Bed numbers: the same beds for every night, guarded by a unique index on
 *    (camp, bed, night).
 * 3. The booking and its QR pass are written together in one transaction (Atlas).
 *    If any later step fails, the nights and bed numbers are handed back.
 * The claims run outside the transaction on purpose: single-document updates are
 * already atomic, and keeping them out avoids write-conflict retries under load.
 */
const book = async (lodgingId, user, { beds, guestNames = [], checkIn, checkOut, bedNos } = {}, { paidByOrder = null, requireNames = false } = {}) => {
    const count = Number(beds);
    if (!Number.isInteger(count) || count < 1 || count > MAX_BEDS_PER_USER) {
        throw badRequest(`You can book between 1 and ${MAX_BEDS_PER_USER} beds`);
    }
    // Bookings from the app need one name per person; older callers may leave names out
    const names = requireNames ? guestNamesFor(guestNames, count) : (Array.isArray(guestNames) ? guestNames : []).map((n) => String(n).trim()).filter(Boolean);
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
    const dates = stay.nights;
    const chosen = bedNos !== undefined && bedNos !== null ? bedAlloc.checkChosen(lodging, bedNos, count) : null;

    // Per-person cap: at most 5 beds on any one night (stays on other nights don't count)
    const mineHere = await LodgingBooking.find({ userId: user._id, eventId: lodging.eventId, status: 'CONFIRMED' }, 'beds checkIn checkOut nights').lean();
    const already = Math.max(0, ...dates.map((d) => mineHere.filter((b) => (b.nights?.length ? b.nights : nightsLib.nightsOf(b.checkIn, b.checkOut)).includes(d)).reduce((s, b) => s + b.beds, 0)));
    if (already + count > MAX_BEDS_PER_USER) {
        throw badRequest(`Limit is ${MAX_BEDS_PER_USER} beds per person on any night. You already hold ${already} on these dates.`);
    }

    // 1. Claim every night atomically (all or nothing)
    await nightsLib.claimStay(lodging, dates, count);

    // 2. Number the beds (tent + bed), the same beds every night
    const bookingId = new mongoose.Types.ObjectId();
    let bedNumbers;
    try {
        bedNumbers = chosen ? await bedAlloc.allocateChosen(lodging, bookingId, chosen, dates) : await bedAlloc.allocate(lodging, bookingId, count, dates);
    } catch (err) {
        await nightsLib.releaseNights(lodging._id, dates, count);
        throw err;
    }
    const where = bedAlloc.describe(lodging, bedNumbers);

    // 3. Write booking + pass together; give the nights and beds back if this fails
    let result;
    try {
        result = await withTransaction(async (session) => {
            const [booking] = await LodgingBooking.create(
                [{ _id: bookingId, lodgingId: lodging._id, eventId: lodging.eventId, userId: user._id, beds: count, guestNames: names, bedNos: bedNumbers, bedLabel: where.text, checkIn: stay.checkIn, checkOut: stay.checkOut, nights: dates }],
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
                        nights: dates.length,
                        provider: lodging.providerId.name,
                        ...(lodging.routeNode ? { routeNode: lodging.routeNode } : {}),
                        ...(paidByOrder ? { paid: paidByOrder.amount, orderId: String(paidByOrder._id) } : {}),
                    },
                    validFrom: istDateTime(stay.checkIn, '00:00'),
                    validUntil: istDateTime(stay.checkOut, '23:59'),
                },
                session
            );
            booking.passId = pass._id;
            await booking.save({ session });
            return { message: `Booking confirmed: ${where.text}`, booking: booking.toObject(), pass: toClient(pass) };
        });
    } catch (err) {
        // Only failures BEFORE the booking is saved give the beds back. Each step is guarded on its own,
        // so a failing release is logged and the original error still reaches the pilgrim.
        await bedAlloc.release(bookingId).catch((e) => console.error(`[lodging] could not release beds of ${bookingId}: ${e.message}`));
        await nightsLib.releaseNights(lodging._id, dates, count).catch((e) => console.error(`[lodging] could not release nights of ${lodging._id} (${dates.join(', ')}): ${e.message}`));
        throw err;
    }
    // The booking is confirmed from here on: these steps are best effort and never undo it
    try {
        const [after] = await nightsLib.attachAvailability([{ ...lodging }], stay);
        result.availableBeds = after.availableBeds;
    } catch (e) {
        console.warn(`[lodging] booked, but could not re-read availability: ${e.message}`);
    }
    try {
        bedsChanged(lodging._id, lodging.providerId._id); // after commit, so screens re-read the new count
    } catch (e) {
        console.warn(`[lodging] booked, but the live update failed: ${e.message}`);
    }
    return result;
};

/** Cancel a booking: flips status atomically, gives every night and bed back, voids the pass. */
const cancel = async (bookingId, user, { passUpdate = {} } = {}) => {
    const result = await withTransaction(async (session) => {
        const booking = await LodgingBooking.findOneAndUpdate(
            { _id: bookingId, userId: user._id, status: 'CONFIRMED' },
            { $set: { status: 'CANCELLED' } },
            { returnDocument: 'after', session }
        );
        if (!booking) throw notFound('Active booking not found');
        const dates = booking.nights?.length ? booking.nights : nightsLib.nightsOf(booking.checkIn, booking.checkOut);
        await nightsLib.releaseNights(booking.lodgingId, dates, booking.beds, session);
        await bedAlloc.release(booking._id, session);
        await cancelPass(booking.passId, session, passUpdate);
        audit.record({ actor: user, action: 'BOOKING_CANCELLED', targetType: 'LodgingBooking', targetId: booking._id, summary: `${user.name} cancelled a ${booking.beds}-bed booking` });
        return { message: 'Booking cancelled', booking: booking.toObject() };
    });
    const camp = await Lodging.findById(result.booking.lodgingId, 'providerId').lean();
    bedsChanged(result.booking.lodgingId, camp?.providerId);
    return result;
};

/** Live update: bed counts on public pages, the camp's tent map, the NGO and the control room. */
function bedsChanged(lodgingId, providerId) {
    realtime.notify(['public', 'control', `lodging:${lodgingId}`, providerId && `provider:${providerId}`], 'beds', { lodgingId: String(lodgingId) });
}

const mine = async (userId) =>
    LodgingBooking.find({ userId }).populate('lodgingId', 'name sector category').sort({ createdAt: -1 }).lean();

/**
 * Theatre-style bed map for camp staff and authorities: every tent / room /
 * hall with each bed marked free, booked online (with guest and stay) or held
 * offline (walk-ins). NGO admins can only open their own camps.
 */
const bedMap = async (lodgingId, user, { date } = {}) => {
    if (!mongoose.isValidObjectId(lodgingId)) throw badRequest('Invalid camp');
    const lodging = await Lodging.findById(lodgingId).populate('providerId', 'name').lean();
    if (!lodging) throw notFound('Camp not found');
    if (user.role === 'NGO_ADMIN' && String(lodging.providerId?._id) !== String(user.providerId)) {
        throw forbidden('You can only view your own camps');
    }
    // The map shows ONE night: the chosen date, or today / the yatra's first night
    const event = await Event.findById(lodging.eventId, 'startDate').lean();
    const night = isDateString(date) ? date : nightsLib.defaultNight(event);
    await nightsLib.attachAvailability([lodging], { checkIn: night });
    const unit = bedAlloc.unitFor(lodging);
    const assignments = await bedAlloc.BedAssignment.find({ lodgingId: lodging._id, $or: [{ date: null }, { date: night }] }).lean();
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
        date: night,
        lodging: { _id: lodging._id, name: lodging.name, sector: lodging.sector, category: lodging.category, provider: lodging.providerId?.name, totalBeds: lodging.totalBeds, heldBeds: lodging.heldBeds || 0, availableBeds: lodging.availableBeds },
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

module.exports = { search, quote, book, cancel, mine, bedMap, stayMap, MAX_BEDS_PER_USER, nightsBetween };
