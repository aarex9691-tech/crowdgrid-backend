const mongoose = require('mongoose');
const { conflict } = require('../../utils/httpError');
const { istDate, addDays } = require('../../utils/time');

/**
 * Bed availability PER NIGHT.
 *
 * A camp has `totalBeds`, of which `heldBeds` are kept offline (walk-ins, staff)
 * every night. The rest can be booked online, and each night is counted on its
 * own: one LodgingNight row per camp per night holds how many beds are booked.
 *
 *   free on a night = totalBeds - heldBeds - booked(that night)
 *
 * So a bed booked for 2 Aug is free again on 3 Aug. A stay from checkIn to
 * checkOut uses the nights checkIn .. checkOut - 1 (a same-day stay = 1 night).
 *
 * Zero double-booking: each night is claimed with ONE atomic conditional update
 * ($inc only while booked + beds <= capacity). A stay that cannot get every one
 * of its nights hands back the nights it already took and is refused.
 */
const nightSchema = new mongoose.Schema(
    {
        lodgingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lodging', required: true },
        date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // the night of YYYY-MM-DD (IST)
        booked: { type: Number, required: true, min: 0, default: 0 },
    },
    { timestamps: true }
);
nightSchema.index({ lodgingId: 1, date: 1 }, { unique: true });
const LodgingNight = mongoose.model('LodgingNight', nightSchema);

const MAX_NIGHTS = 7;

/** Nights a stay uses: checkIn .. checkOut - 1, or just checkIn for a same-day stay. */
const nightsOf = (checkIn, checkOut) => {
    if (!checkOut || checkOut <= checkIn) return [checkIn];
    const out = [];
    for (let d = checkIn; d < checkOut && out.length <= 366; d = addDays(d, 1)) out.push(d);
    return out;
};

/** Beds that can be booked online on any night. */
const capacityOf = (lodging) => Math.max(0, (lodging.totalBeds || 0) - (lodging.heldBeds || 0));

/** Map "lodgingId|date" -> booked, for the given camps and nights. */
const bookedMap = async (lodgingIds, dates) => {
    if (!lodgingIds.length || !dates.length) return new Map();
    const rows = await LodgingNight.find({ lodgingId: { $in: lodgingIds }, date: { $in: dates } }, 'lodgingId date booked').lean();
    return new Map(rows.map((r) => [`${r.lodgingId}|${r.date}`, r.booked]));
};

/**
 * Sets `availableBeds` on each camp: the beds free on EVERY night of the stay
 * (just `date` when no stay is given). Returns the same array, for chaining.
 */
const attachAvailability = async (lodgings, { checkIn, checkOut } = {}) => {
    const first = checkIn || istDate();
    const dates = nightsOf(first, checkOut);
    const booked = await bookedMap(lodgings.map((l) => l._id), dates);
    for (const l of lodgings) {
        const cap = capacityOf(l);
        const worst = Math.max(0, ...dates.map((d) => booked.get(`${l._id}|${d}`) || 0));
        l.availableBeds = Math.max(0, cap - worst);
        l.availabilityFor = { checkIn: first, checkOut: checkOut || first, nights: dates.length };
    }
    return lodgings;
};

/** One night: atomic "+beds while it still fits". Returns true if it was claimed. */
const claimNight = async (lodgingId, date, beds, cap) => {
    if (beds > cap) return false;
    const filter = { lodgingId, date, booked: { $lte: cap - beds } };
    try {
        // creates the night's row the first time anyone books it
        return !!(await LodgingNight.findOneAndUpdate(filter, { $inc: { booked: beds } }, { upsert: true, returnDocument: 'after' }));
    } catch (err) {
        if (err.code !== 11000) throw err;
        // the row exists but is too full to match (the upsert then clashed with it),
        // or two first bookings raced to create it: try once more without creating
        return !!(await LodgingNight.findOneAndUpdate(filter, { $inc: { booked: beds } }, { returnDocument: 'after' }));
    }
};

const releaseNights = async (lodgingId, dates, beds, session = null) => {
    if (!dates.length || !beds) return;
    await LodgingNight.updateMany({ lodgingId, date: { $in: dates }, booked: { $gte: beds } }, { $inc: { booked: -beds } }, { session });
};

/**
 * Claims `beds` on every night of the stay, or none at all.
 * Throws 409 naming the first night that is full.
 */
const claimStay = async (lodging, dates, beds) => {
    const cap = capacityOf(lodging);
    const taken = [];
    for (const date of dates) {
        if (await claimNight(lodging._id, date, beds, cap)) {
            taken.push(date);
            continue;
        }
        await releaseNights(lodging._id, taken, beds);
        const row = await LodgingNight.findOne({ lodgingId: lodging._id, date }, 'booked').lean();
        const left = Math.max(0, cap - (row?.booked || 0));
        throw conflict(
            left === 0 ? `Sold out on the night of ${date} - no beds left at this camp` : `Only ${left} bed(s) left on the night of ${date}`,
            { availableBeds: left, night: date }
        );
    }
    return dates;
};

/** Do two stays share at least one night? */
const overlaps = (a, b) => {
    const aNights = nightsOf(a.checkIn, a.checkOut);
    const bNights = new Set(nightsOf(b.checkIn, b.checkOut));
    return aNights.some((d) => bNights.has(d));
};

/** Date for the night shown by default on maps and dashboards: today, or the yatra's first day if later. */
const defaultNight = (event) => {
    const today = istDate();
    const start = event?.startDate ? istDate(new Date(event.startDate)) : today;
    return start > today ? start : today;
};

module.exports = { LodgingNight, MAX_NIGHTS, nightsOf, capacityOf, attachAvailability, claimStay, releaseNights, overlaps, defaultNight, bookedMap };
