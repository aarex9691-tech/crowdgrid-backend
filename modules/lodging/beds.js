const mongoose = require('mongoose');
const { conflict } = require('../../utils/httpError');

/**
 * Tent / room / hall numbers for lodging bookings.
 *
 * A camp's beds are numbered 1..totalBeds and grouped into units of
 * `bedsPerUnit` (bed 1-10 = Tent T-1, bed 11-20 = Tent T-2, ...).
 * Every allocated bed is one BedAssignment document. A UNIQUE index on
 * (lodgingId, bedNo) means two bookings can never hold the same bed, even when
 * they are made at the same instant: the second insert is rejected and simply
 * retries with the next free beds.
 */
const UNIT_BY_CATEGORY = {
    FAMILY_TENT: { label: 'Tent', prefix: 'T', size: 6 },
    FREE_CAMP: { label: 'Tent', prefix: 'T', size: 20 },
    DHARAMSHALA: { label: 'Room', prefix: 'R', size: 10 },
    SENIOR_DORM: { label: 'Dorm', prefix: 'D', size: 12 },
    ASHRAM: { label: 'Hall', prefix: 'H', size: 25 },
};
const unitFor = (lodging) => {
    const base = UNIT_BY_CATEGORY[lodging.category] || UNIT_BY_CATEGORY.FREE_CAMP;
    return { ...base, size: lodging.bedsPerUnit || base.size };
};

const bedAssignmentSchema = new mongoose.Schema(
    {
        lodgingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Lodging', required: true },
        bedNo: { type: Number, required: true, min: 1 }, // 1..totalBeds across the whole camp
        bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'LodgingBooking', default: null }, // null = held offline (seed / walk-in)
    },
    { timestamps: true }
);
bedAssignmentSchema.index({ lodgingId: 1, bedNo: 1 }, { unique: true });
bedAssignmentSchema.index({ bookingId: 1 });
const BedAssignment = mongoose.model('BedAssignment', bedAssignmentSchema);

/** Bed number 1..N  ->  { unit: 'T-4', bed: 7 } */
const locate = (lodging, bedNo) => {
    const u = unitFor(lodging);
    return { unitNo: Math.ceil(bedNo / u.size), bed: ((bedNo - 1) % u.size) + 1 };
};

/** Human label, e.g. "Tent T-4 · Beds 7, 8" (beds of one booking may span two units). */
const describe = (lodging, bedNos) => {
    const u = unitFor(lodging);
    const groups = new Map();
    for (const n of [...bedNos].sort((a, b) => a - b)) {
        const { unitNo, bed } = locate(lodging, n);
        if (!groups.has(unitNo)) groups.set(unitNo, []);
        groups.get(unitNo).push(bed);
    }
    const parts = [...groups.entries()].map(([unitNo, beds]) => ({
        unit: `${u.label} ${u.prefix}-${unitNo}`,
        beds,
    }));
    return {
        parts,
        text: parts.map((p) => `${p.unit} · Bed${p.beds.length > 1 ? 's' : ''} ${p.beds.join(', ')}`).join(' + '),
    };
};

/**
 * Picks `count` free beds, keeping a family in ONE tent when any tent has room,
 * otherwise the lowest free beds. Pure function: `taken` is a Set of bed numbers.
 */
const pickBeds = (lodging, taken, count, spread = false) => {
    const u = unitFor(lodging);
    const total = lodging.totalBeds;
    const units = Math.ceil(total / u.size);
    // On a retry after a clash, pick random free beds inside the tent so that
    // racing bookings stop choosing the very same numbers again.
    const choose = (free) => {
        if (!spread || free.length === count) return free.slice(0, count);
        const pool = [...free];
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        return pool.slice(0, count).sort((a, b) => a - b);
    };
    for (let unitNo = 1; unitNo <= units; unitNo++) {
        const free = [];
        for (let n = (unitNo - 1) * u.size + 1; n <= Math.min(unitNo * u.size, total); n++) {
            if (!taken.has(n)) free.push(n);
        }
        if (free.length >= count) return choose(free);
    }
    const free = [];
    for (let n = 1; n <= total; n++) if (!taken.has(n)) free.push(n);
    return free.length >= count ? choose(free) : null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Allocates beds for a booking. Called AFTER the atomic availableBeds claim, so
 * enough beds are known to be free; the unique index settles any race between
 * two bookings picking the same numbers at the same moment (the loser retries).
 */
const allocate = async (lodging, bookingId, count, attempts = 40) => {
    for (let i = 0; i < attempts; i++) {
        const taken = new Set((await BedAssignment.find({ lodgingId: lodging._id }, 'bedNo').lean()).map((b) => b.bedNo));
        const beds = pickBeds(lodging, taken, count, i > 0);
        if (!beds) break;
        try {
            await BedAssignment.insertMany(
                beds.map((bedNo) => ({ lodgingId: lodging._id, bedNo, bookingId })),
                { ordered: true }
            );
            return beds;
        } catch (err) {
            // Someone took one of these beds a moment ago: undo ours and try again
            await BedAssignment.deleteMany({ bookingId });
            if (err.code !== 11000) throw err;
            await sleep(Math.random() * 20 * Math.min(i + 1, 5));
        }
    }
    throw conflict('Could not allocate bed numbers, please try again');
};

const release = (bookingId, session) => BedAssignment.deleteMany({ bookingId }, { session });

module.exports = { BedAssignment, UNIT_BY_CATEGORY, unitFor, locate, describe, pickBeds, allocate, release };
