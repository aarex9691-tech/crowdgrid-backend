/**
 * Analytics for the authority dashboard and the NGO portal.
 *
 * The database work is a handful of indexed range reads (last N days); the
 * numbers for each chart are then built by small pure functions below, which
 * are easy to read and are unit-tested without a database
 * (scripts/analytics-test.js).
 */
const mongoose = require('mongoose');
const Event = require('../event/event.model');
const { Lodging } = require('../lodging/lodging.model');
const { Pass } = require('../pass/pass.model');
const Order = require('../order/order.model');
const SosIncident = require('../sos/sos.model');
const Provider = require('../provider/provider.model');
const { istDate, istDateTime, addDays } = require('../../utils/time');
const { badRequest, notFound } = require('../../utils/httpError');

const MEAL_KEYS = ['BREAKFAST', 'LUNCH', 'DINNER'];
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------------------------------------------------------------- helpers

/** The last `n` IST dates, oldest first, ending today. */
const lastDays = (n, today = istDate()) => Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));

const istParts = (date) => {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', hourCycle: 'h23' })
            .formatToParts(date)
            .map((p) => [p.type, p.value])
    );
    return { hour: Number(parts.hour), dow: DOW.indexOf(parts.weekday) };
};

const people = (p) => Math.max(1, Number(p?.details?.people) || 1);
const round1 = (x) => Math.round(x * 10) / 10;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const minutesBetween = (a, b) => (new Date(b) - new Date(a)) / 60000;

/** Empty row per day so charts show zero days instead of skipping them. */
const dayRows = (days, fields) => new Map(days.map((d) => [d, { date: d, ...Object.fromEntries(fields.map((f) => [f, 0])) }]));

// ---------------------------------------------------------------- pure builders (unit-tested)

/** Passes issued per day by type, scans per day, revenue and SOS per day. */
const buildDaily = ({ days, issued = [], redeemed = [], orders = [], sos = [] }) => {
    const rows = dayRows(days, ['lodging', 'meals', 'transit', 'tickets', 'scans', 'revenue', 'sos']);
    const add = (date, key, n = 1) => {
        const row = rows.get(istDate(new Date(date)));
        if (row) row[key] += n;
    };
    const KEY = { LODGING: 'lodging', MEAL: 'meals', TRANSIT: 'transit', PUBLIC: 'tickets', CORPORATE: 'tickets' };
    for (const p of issued) if (KEY[p.type] && p.status !== 'CANCELLED') add(p.createdAt, KEY[p.type]);
    for (const p of redeemed) if (p.redeemedAt) add(p.redeemedAt, 'scans');
    for (const o of orders) if (o.payment?.paidAt) add(o.payment.paidAt, 'revenue', (o.total || 0) - (o.refunded || 0));
    for (const s of sos) add(s.createdAt, 'sos');
    return [...rows.values()];
};

/** People actually served per meal per day (redeemed meal tokens, a family token counts every person). */
const buildMeals = ({ days, redeemed = [] }) => {
    const rows = dayRows(days, MEAL_KEYS);
    for (const p of redeemed) {
        if (p.type !== 'MEAL' || !p.redeemedAt) continue;
        const row = rows.get(istDate(new Date(p.redeemedAt)));
        const meal = p.details?.meal;
        if (row && MEAL_KEYS.includes(meal)) row[meal] += people(p);
    }
    return [...rows.values()];
};

/** Beds in use per sector, sorted by how full each sector is. */
const buildOccupancy = (lodgings = [], key = 'sector') => {
    const groups = new Map();
    for (const l of lodgings) {
        const k = l[key] || 'Other';
        const g = groups.get(k) || { name: k, totalBeds: 0, availableBeds: 0, camps: 0 };
        g.totalBeds += l.totalBeds || 0;
        g.availableBeds += l.availableBeds || 0;
        g.camps += 1;
        groups.set(k, g);
    }
    return [...groups.values()]
        .map((g) => ({ ...g, booked: g.totalBeds - g.availableBeds, occupancyPct: g.totalBeds ? Math.round(((g.totalBeds - g.availableBeds) / g.totalBeds) * 100) : 0 }))
        .sort((a, b) => b.occupancyPct - a.occupancyPct || a.name.localeCompare(b.name));
};

/** 7 x 24 grid (Mon..Sun x hour of day, IST) of how many passes were scanned. */
const buildHeatmap = (redeemed = []) => {
    const grid = DOW.map(() => Array(24).fill(0));
    for (const p of redeemed) {
        if (!p.redeemedAt) continue;
        const { dow, hour } = istParts(new Date(p.redeemedAt));
        if (dow >= 0 && hour >= 0 && hour < 24) grid[dow][hour] += 1;
    }
    return { days: DOW, grid };
};

/** SOS response: minutes to first response and to resolution, counts by type and status. */
const buildSos = (sos = []) => {
    const responded = sos.filter((s) => s.acknowledgedAt || s.resolvedAt).map((s) => minutesBetween(s.createdAt, s.acknowledgedAt || s.resolvedAt));
    const resolved = sos.filter((s) => s.resolvedAt).map((s) => minutesBetween(s.createdAt, s.resolvedAt));
    const byType = {};
    for (const s of sos) byType[s.type || 'GENERAL'] = (byType[s.type || 'GENERAL'] || 0) + 1;
    return {
        total: sos.length,
        open: sos.filter((s) => s.status !== 'RESOLVED').length,
        resolved: resolved.length,
        avgResponseMin: responded.length ? round1(avg(responded)) : null,
        avgResolveMin: resolved.length ? round1(avg(resolved)) : null,
        byType: Object.entries(byType).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    };
};

// ---------------------------------------------------------------- loaders

const DAY_OPTIONS = [7, 14, 30];
const parseDays = (v) => {
    const n = Number(v || 14);
    if (!DAY_OPTIONS.includes(n)) throw badRequest(`days must be one of ${DAY_OPTIONS.join(', ')}`);
    return n;
};

const resolveEvent = async (eventId) => {
    if (eventId) {
        if (!mongoose.isValidObjectId(eventId)) throw badRequest('Invalid event');
        const ev = await Event.findById(eventId, 'title kind').lean();
        if (!ev) throw notFound('Event not found');
        return ev;
    }
    return (await Event.findOne({ kind: 'YATRA', isFlagship: true }, 'title kind').lean()) || Event.findOne({ kind: 'YATRA' }, 'title kind').sort({ startDate: 1 }).lean();
};

/** District control-room analytics for one yatra over the last 7, 14 or 30 days. */
const overview = async ({ eventId, days: daysParam } = {}) => {
    const n = parseDays(daysParam);
    const event = await resolveEvent(eventId);
    if (!event) throw notFound('No yatra found');
    const days = lastDays(n);
    const since = istDateTime(days[0], '00:00');
    const today = days[days.length - 1];
    const match = { eventId: event._id };

    const PASS_FIELDS = 'type status createdAt redeemedAt providerId details.meal details.people';
    const [issued, redeemed, orders, sos, lodgings] = await Promise.all([
        Pass.find({ ...match, createdAt: { $gte: since } }, PASS_FIELDS).lean(),
        Pass.find({ ...match, redeemedAt: { $gte: since } }, PASS_FIELDS).lean(),
        Order.find({ status: 'PAID', 'payment.paidAt': { $gte: since } }, 'total refunded payment.paidAt').lean(),
        SosIncident.find({ createdAt: { $gte: since }, $or: [{ eventId: event._id }, { eventId: { $exists: false } }] }, 'type status createdAt acknowledgedAt resolvedAt').lean(),
        Lodging.find({ ...match, isActive: { $ne: false } }, 'name sector totalBeds availableBeds').lean(),
    ]);
    const openSos = await SosIncident.countDocuments({ status: { $ne: 'RESOLVED' } });

    const daily = buildDaily({ days, issued, redeemed, orders, sos });
    const meals = buildMeals({ days, redeemed });
    const sectors = buildOccupancy(lodgings, 'sector');
    const bedsTotal = sectors.reduce((s, x) => s + x.totalBeds, 0);
    const bedsFree = sectors.reduce((s, x) => s + x.availableBeds, 0);
    const todayRow = daily.find((d) => d.date === today) || {};
    const mealsToday = meals.find((d) => d.date === today) || {};

    return {
        event: { _id: event._id, title: event.title },
        days,
        generatedAt: new Date(),
        kpis: {
            bookingsToday: todayRow.lodging || 0,
            scansToday: todayRow.scans || 0,
            mealsServedToday: MEAL_KEYS.reduce((s, k) => s + (mealsToday[k] || 0), 0),
            revenue: daily.reduce((s, d) => s + d.revenue, 0),
            openSos,
            bedsTotal,
            bedsFree,
            occupancyPct: bedsTotal ? Math.round(((bedsTotal - bedsFree) / bedsTotal) * 100) : 0,
        },
        daily,
        meals,
        sectors,
        heatmap: buildHeatmap(redeemed),
        sos: { ...buildSos(sos), open: openSos },
    };
};

/** NGO portal analytics: the organisation's own camps and kitchens only. */
const ngoOverview = async (user, { providerId, days: daysParam } = {}) => {
    const n = parseDays(daysParam);
    const pid = user.role === 'NGO_ADMIN' ? user.providerId : providerId;
    if (!pid || !mongoose.isValidObjectId(pid)) throw badRequest(user.role === 'NGO_ADMIN' ? 'Your account is not linked to an organisation yet' : 'Choose an organisation');
    const provider = await Provider.findById(pid, 'name').lean();
    if (!provider) throw notFound('Organisation not found');
    const days = lastDays(n);
    const since = istDateTime(days[0], '00:00');
    const PASS_FIELDS = 'type status createdAt redeemedAt details.meal details.people details.kitchen';

    const [issued, redeemed, lodgings] = await Promise.all([
        Pass.find({ providerId: provider._id, createdAt: { $gte: since } }, PASS_FIELDS).lean(),
        Pass.find({ providerId: provider._id, redeemedAt: { $gte: since } }, PASS_FIELDS).lean(),
        Lodging.find({ providerId: provider._id, isActive: { $ne: false } }, 'name sector totalBeds availableBeds').lean(),
    ]);

    const rows = dayRows(days, ['checkIns', 'mealsServed', 'tokensIssued', 'bookings']);
    for (const p of redeemed) {
        const row = rows.get(istDate(new Date(p.redeemedAt)));
        if (!row) continue;
        if (p.type === 'LODGING') row.checkIns += 1;
        if (p.type === 'MEAL') row.mealsServed += people(p);
    }
    for (const p of issued) {
        if (p.status === 'CANCELLED') continue;
        const row = rows.get(istDate(new Date(p.createdAt)));
        if (!row) continue;
        if (p.type === 'MEAL') row.tokensIssued += people(p);
        if (p.type === 'LODGING') row.bookings += 1;
    }
    const kitchens = new Map();
    for (const p of redeemed) {
        if (p.type !== 'MEAL') continue;
        const k = p.details?.kitchen || 'Kitchen';
        kitchens.set(k, (kitchens.get(k) || 0) + people(p));
    }
    const daily = [...rows.values()];
    const camps = buildOccupancy(lodgings, 'name');
    const today = daily[daily.length - 1];
    return {
        provider: { _id: provider._id, name: provider.name },
        days,
        kpis: {
            checkInsToday: today.checkIns,
            mealsServedToday: today.mealsServed,
            bedsTotal: camps.reduce((s, c) => s + c.totalBeds, 0),
            bedsFree: camps.reduce((s, c) => s + c.availableBeds, 0),
        },
        daily,
        camps,
        kitchens: [...kitchens.entries()].map(([name, served]) => ({ name, served })).sort((a, b) => b.served - a.served),
    };
};

// ---------------------------------------------------------------- CSV export

const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Quote when needed; a leading = + - @ is prefixed so spreadsheets never run it as a formula
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';

const REPORTS = {
    daily: (o) => toCsv(['Date', 'Bed bookings', 'Meal tokens', 'Bus passes', 'Event tickets', 'Passes scanned', 'Revenue (INR)', 'SOS alerts'],
        o.daily.map((d) => [d.date, d.lodging, d.meals, d.transit, d.tickets, d.scans, d.revenue, d.sos])),
    meals: (o) => toCsv(['Date', 'Breakfast served', 'Lunch served', 'Dinner served'], o.meals.map((d) => [d.date, d.BREAKFAST, d.LUNCH, d.DINNER])),
    sectors: (o) => toCsv(['Sector', 'Camps', 'Total beds', 'Beds booked', 'Beds free', 'Occupancy %'],
        o.sectors.map((s) => [s.name, s.camps, s.totalBeds, s.booked, s.availableBeds, s.occupancyPct])),
};

const exportCsv = async (query = {}) => {
    const report = String(query.report || 'daily');
    if (!REPORTS[report]) throw badRequest(`report must be one of ${Object.keys(REPORTS).join(', ')}`);
    const o = await overview(query);
    return { filename: `crowdgrid-${report}-${o.days[0]}-to-${o.days[o.days.length - 1]}.csv`, body: REPORTS[report](o) };
};

module.exports = { overview, ngoOverview, exportCsv, lastDays, buildDaily, buildMeals, buildOccupancy, buildHeatmap, buildSos, toCsv, REPORTS, DAY_OPTIONS };
