/**
 * SIMULATED demo history for the analytics dashboard.
 *
 * A freshly seeded database has no past activity, so the charts would be empty.
 * This builds a reproducible, clearly labelled history for the last N days:
 * demo pilgrims (phones 70000000xx, names "Demo Pilgrim NN") who checked in at
 * camps, ate at kitchens, took buses, paid online and raised a few SOS alerts.
 * None of it changes today's bed or meal counts. Everything is validated
 * against the real Mongoose schemas before it is written.
 *
 * Used by scripts/seed.js; also unit-tested in scripts/unit-test.js.
 */
const mongoose = require('mongoose');
const crypto = require('crypto');
const { istDate, istDateTime, addDays } = require('../utils/time');

const DEMO_PHONE_PREFIX = '70000000';
const DEMO_USERS = 60;

/** Small seeded random generator, so every seed produces the same history. */
const rng = (seed = 2027) => {
    let t = seed >>> 0;
    return () => {
        t += 0x6d2b79f5;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
};

/**
 * @param ctx { event, lodgings, centers, routes, authority, volunteer, passwordHash }
 * @returns { users, passes, orders, sos } plain documents (with createdAt) ready to insert
 */
const buildHistory = (ctx, { days = 14, now = new Date(), seed = 2027 } = {}) => {
    const rand = rng(seed);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
    const oid = () => new mongoose.Types.ObjectId();
    const today = istDate(now);
    const at = (date, minutes) => new Date(istDateTime(date, '00:00').getTime() + minutes * 60000);

    const users = Array.from({ length: DEMO_USERS }, (_, i) => ({
        _id: oid(),
        name: `Demo Pilgrim ${String(i + 1).padStart(2, '0')}`,
        countryCode: '91',
        phone: `${DEMO_PHONE_PREFIX}${String(i + 1).padStart(2, '0')}`,
        role: 'USER',
        passwordHash: ctx.passwordHash,
        createdAt: at(addDays(today, -days), 9 * 60),
    }));

    const passes = [];
    const orders = [];
    const sos = [];
    const base = (type, user, extra) => ({
        _id: oid(), type, userId: user._id, eventId: ctx.event._id, nonce: crypto.randomUUID(), singleUse: true, ...extra,
    });

    // d = -1 is tomorrow: only the bookings made today for tomorrow's check-in
    for (let d = days - 1; d >= -1; d--) {
        const date = addDays(today, -d);
        const isTomorrow = d === -1;
        const isToday = d === 0;
        const nowMin = isToday ? Math.floor((now - istDateTime(date, '00:00')) / 60000) : isTomorrow ? -1 : 24 * 60;
        const todayMin = Math.floor((now - istDateTime(today, '00:00')) / 60000);
        // Crowds grow as Dhwajarohan gets closer; weekends are busier
        const weekday = new Date(istDateTime(date, '12:00')).getUTCDay(); // 0 = Sunday
        const busy = (1 + (days - d) / days) * (weekday === 0 || weekday === 6 ? 1.35 : 1);
        const happened = (minute) => minute <= nowMin; // today only up to the current time

        // Camp check-ins (booked online the day before, scanned at the gate)
        for (let i = 0, n = Math.round(between(14, 26) * busy); i < n; i++) {
            const l = pick(ctx.lodgings);
            const user = pick(users);
            const scanMin = between(9 * 60, 21 * 60);
            const bookMin = between(8 * 60, 22 * 60);
            // Tomorrow's stays: booked today (only up to now), not checked in yet
            if (isTomorrow ? bookMin > todayMin : !happened(scanMin)) continue;
            const bookedAt = at(addDays(date, -1), bookMin);
            const beds = between(1, 4);
            const p = base('LODGING', user, {
                providerId: l.providerId, refId: l._id, title: l.name, subtitle: l.sector,
                details: { sector: l.sector, beds, checkIn: date, checkOut: addDays(date, 2), demo: true },
                validFrom: istDateTime(date, '00:00'), validUntil: istDateTime(addDays(date, 2), '23:59'), createdAt: bookedAt,
                ...(isTomorrow ? { status: 'ACTIVE' } : { status: 'REDEEMED', redeemedAt: at(date, scanMin), redeemedBy: ctx.volunteer._id }),
            });
            passes.push(p);
            if (l.pricePerNight > 0) {
                const amount = l.pricePerNight * beds * 2;
                orders.push({
                    _id: oid(), userId: user._id, total: amount, currency: 'INR', status: 'PAID', refunded: 0,
                    items: [{ _id: oid(), kind: 'LODGING', refId: l._id, label: l.name, detail: `${beds} bed(s), 2 nights`, amount, status: 'ISSUED', passId: p._id }],
                    payment: { provider: 'SIMULATED', method: rand() < 0.75 ? 'UPI' : 'CARD', account: 'demo', reference: `DEMO${crypto.randomBytes(4).toString('hex').toUpperCase()}`, paidAt: bookedAt },
                    createdAt: bookedAt,
                });
            }
        }

        // Meals served: tokens claimed shortly before, scanned during the meal window
        const MEAL_WINDOWS = { BREAKFAST: [7 * 60, 9 * 60], LUNCH: [12 * 60, 15 * 60], DINNER: [19 * 60, 22 * 60] };
        const MEAL_LOAD = { BREAKFAST: [35, 55], LUNCH: [60, 90], DINNER: [45, 70] };
        for (const [meal, [from, to]] of Object.entries(MEAL_WINDOWS)) {
            for (let i = 0, n = Math.round(between(...MEAL_LOAD[meal]) * busy); i < n; i++) {
                const c = pick(ctx.centers);
                const user = pick(users);
                // Lunch peaks around 13:00, dinner around 20:00
                const scanMin = Math.min(to - 1, from + Math.floor(((rand() + rand()) / 2) * (to - from)));
                if (!happened(scanMin)) continue;
                const people = rand() < 0.55 ? 1 : between(2, 6);
                passes.push(base('MEAL', user, {
                    providerId: c.providerId, refId: c._id, title: `${meal[0]}${meal.slice(1).toLowerCase()} - ${c.name}`, subtitle: date,
                    details: { kitchen: c.name, sector: c.sector, meal, date, people, demo: true },
                    status: 'REDEEMED', validFrom: at(date, from - 60), validUntil: at(date, to),
                    createdAt: at(date, Math.max(0, scanMin - between(20, 180))), redeemedAt: at(date, scanMin), redeemedBy: ctx.volunteer._id,
                }));
            }
        }

        // Shuttle boarding
        for (let i = 0, n = Math.round(between(25, 40) * busy); i < n; i++) {
            const r = pick(ctx.routes);
            const user = pick(users);
            const scanMin = between(5 * 60, 22 * 60);
            if (!happened(scanMin)) continue;
            const issuedAt = at(date, Math.max(0, scanMin - between(5, 90)));
            const p = base('TRANSIT', user, {
                refId: r._id, title: r.name, subtitle: `${r.origin} to ${r.destination}`, details: { route: r.name, fare: r.fare || 0, demo: true },
                status: 'REDEEMED', validFrom: istDateTime(date, '00:00'), validUntil: istDateTime(date, '23:59'),
                createdAt: issuedAt, redeemedAt: at(date, scanMin), redeemedBy: ctx.volunteer._id,
            });
            passes.push(p);
            if (r.fare > 0) {
                orders.push({
                    _id: oid(), userId: user._id, total: r.fare, currency: 'INR', status: 'PAID', refunded: 0,
                    items: [{ _id: oid(), kind: 'TRANSIT', refId: r._id, label: r.name, amount: r.fare, status: 'ISSUED', passId: p._id }],
                    payment: { provider: 'SIMULATED', method: 'UPI', account: 'demo', reference: `DEMO${crypto.randomBytes(4).toString('hex').toUpperCase()}`, paidAt: issuedAt },
                    createdAt: issuedAt,
                });
            }
        }

        // SOS alerts, answered within minutes and resolved
        const SOS_TYPES = ['MEDICAL', 'MEDICAL', 'LOST', 'CROWD', 'GENERAL'];
        for (let i = 0, n = between(1, 4); i < n; i++) {
            const created = between(6 * 60, 22 * 60);
            if (!happened(created + 60)) continue;
            const respond = between(2, 12);
            const resolve = respond + between(8, 45);
            const lat = 20.0059 + (rand() - 0.5) * 0.01;
            const lng = 73.7897 + (rand() - 0.5) * 0.01;
            sos.push({
                _id: oid(), userId: pick(users)._id, eventId: ctx.event._id, type: pick(SOS_TYPES), message: 'Demo alert (simulated history)',
                location: { lat, lng, accuracy: between(5, 40) }, locationHistory: [{ lat, lng, at: at(date, created) }],
                status: 'RESOLVED', assignedTo: ctx.volunteer._id,
                createdAt: at(date, created), acknowledgedAt: at(date, created + respond), resolvedAt: at(date, created + resolve),
            });
        }
    }
    return { users, passes, orders, sos };
};

/** Validates every document against its Mongoose schema; throws on the first invalid one. */
const prepareHistory = async (models, history) => {
    const plan = [
        [models.User, history.users],
        [models.Pass, history.passes],
        [models.Order, history.orders],
        [models.SosIncident, history.sos],
    ];
    const out = [];
    for (const [Model, docs] of plan) {
        const ready = [];
        for (const d of docs) {
            const doc = new Model(d);
            try {
                await doc.validate();
            } catch (err) {
                throw new Error(`Demo history: invalid ${Model.modelName}: ${err.message}`);
            }
            const obj = doc.toObject({ depopulate: true });
            obj.createdAt = d.createdAt;
            obj.updatedAt = d.redeemedAt || d.resolvedAt || d.createdAt;
            ready.push(obj);
        }
        out.push([Model, ready]);
    }
    return out;
};

/** Inserts the validated documents directly, so the historical createdAt dates are kept. */
const insertHistory = async (models, history) => {
    const plan = await prepareHistory(models, history);
    for (const [Model, docs] of plan) {
        for (let i = 0; i < docs.length; i += 1000) await Model.collection.insertMany(docs.slice(i, i + 1000), { ordered: false });
    }
    return plan.map(([Model, docs]) => `${docs.length} ${Model.modelName}`).join(', ');
};

module.exports = { buildHistory, prepareHistory, insertHistory, DEMO_PHONE_PREFIX, DEMO_USERS };
