/**
 * Unit checks that need no database (npm run test:unit):
 *   - analytics chart builders (days, meals, occupancy, heat map, SOS response)
 *   - CSV export (quoting, formula-injection guard)
 *   - live updates: real Socket.IO server and clients, rooms per role
 *   - shared input rules (utils/validate.js)
 */
const assert = require('node:assert/strict');
const http = require('http');
const { io: connect } = require('socket.io-client');
const a = require('../modules/analytics/analytics.service');
const realtime = require('../utils/realtime');
const v = require('../utils/validate');
const { istDateTime, istDate } = require('../utils/time');

let failed = 0;
let passed = 0;
const check = async (name, fn) => {
    try {
        await fn();
        passed++;
        console.log(`PASS  ${name}`);
    } catch (err) {
        failed++;
        console.log(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
    }
};
const at = (day, hhmm) => istDateTime(day, hhmm);

(async () => {
    // ---------------------------------------------------------------- analytics
    const days = a.lastDays(3, '2026-10-17');
    await check('lastDays gives the last N IST dates, oldest first', () => assert.deepEqual(days, ['2026-10-15', '2026-10-16', '2026-10-17']));
    await check('lastDays crosses a month boundary', () => assert.deepEqual(a.lastDays(3, '2026-11-01'), ['2026-10-30', '2026-10-31', '2026-11-01']));

    const issued = [
        { type: 'LODGING', status: 'ACTIVE', createdAt: at('2026-10-15', '10:00') },
        { type: 'LODGING', status: 'CANCELLED', createdAt: at('2026-10-15', '11:00') },
        { type: 'MEAL', status: 'REDEEMED', createdAt: at('2026-10-16', '08:00') },
        { type: 'PUBLIC', status: 'ACTIVE', createdAt: at('2026-10-17', '09:00') },
        { type: 'CORPORATE', status: 'ACTIVE', createdAt: at('2026-10-17', '09:30') },
        { type: 'TRANSIT', status: 'ACTIVE', createdAt: at('2026-10-14', '09:30') }, // outside the window
    ];
    const redeemed = [
        { type: 'MEAL', redeemedAt: at('2026-10-16', '13:05'), details: { meal: 'LUNCH', people: 4 } },
        { type: 'MEAL', redeemedAt: at('2026-10-16', '08:10'), details: { meal: 'BREAKFAST' } },
        { type: 'LODGING', redeemedAt: at('2026-10-17', '23:30') },
        { type: 'MEAL', redeemedAt: at('2026-10-17', '00:15'), details: { meal: 'DINNER', people: 2 } },
    ];
    const orders = [
        { total: 300, refunded: 100, payment: { paidAt: at('2026-10-16', '12:00') } },
        { total: 99, payment: { paidAt: at('2026-10-17', '18:00') } },
    ];
    const sos = [
        { type: 'MEDICAL', status: 'RESOLVED', createdAt: at('2026-10-15', '10:00'), acknowledgedAt: at('2026-10-15', '10:04'), resolvedAt: at('2026-10-15', '10:30') },
        { type: 'LOST', status: 'OPEN', createdAt: at('2026-10-17', '07:00') },
        { type: 'MEDICAL', status: 'RESOLVED', createdAt: at('2026-10-17', '09:00'), resolvedAt: at('2026-10-17', '09:10') },
    ];
    const daily = a.buildDaily({ days, issued, redeemed, orders, sos });
    await check('Daily rows: one per day, cancelled and out-of-window passes ignored', () => {
        assert.equal(daily.length, 3);
        assert.deepEqual(daily.map((d) => d.lodging), [1, 0, 0]);
        assert.deepEqual(daily.map((d) => d.meals), [0, 1, 0]);
        assert.deepEqual(daily.map((d) => d.tickets), [0, 0, 2]);
        assert.deepEqual(daily.map((d) => d.transit), [0, 0, 0]);
    });
    await check('Daily scans use the IST date (00:15 and 23:30 IST fall on the 17th)', () => assert.deepEqual(daily.map((d) => d.scans), [0, 2, 2]));
    await check('Daily revenue subtracts refunds', () => assert.deepEqual(daily.map((d) => d.revenue), [0, 200, 99]));
    await check('Daily SOS counts', () => assert.deepEqual(daily.map((d) => d.sos), [1, 0, 2]));

    const meals = a.buildMeals({ days, redeemed });
    await check('Meals served count every person on a family token', () => {
        assert.equal(meals[1].LUNCH, 4);
        assert.equal(meals[1].BREAKFAST, 1);
        assert.equal(meals[2].DINNER, 2);
        assert.equal(meals[0].LUNCH, 0);
    });

    const occ = a.buildOccupancy([
        { sector: 'S1', totalBeds: 100, availableBeds: 25 },
        { sector: 'S1', totalBeds: 100, availableBeds: 75 },
        { sector: 'S2', totalBeds: 50, availableBeds: 0 },
        { sector: 'S3', totalBeds: 0, availableBeds: 0 },
    ]);
    await check('Occupancy groups by sector and sorts fullest first; empty sector is 0%', () => {
        assert.deepEqual(occ.map((o) => [o.name, o.camps, o.totalBeds, o.booked, o.occupancyPct]), [
            ['S2', 1, 50, 50, 100],
            ['S1', 2, 200, 100, 50],
            ['S3', 1, 0, 0, 0],
        ]);
    });

    const heat = a.buildHeatmap([{ redeemedAt: at('2026-10-19', '13:30') }, { redeemedAt: at('2026-10-19', '13:59') }, { redeemedAt: at('2026-10-18', '00:00') }]);
    await check('Heat map: Monday 13:00 IST has 2 scans, Sunday 00:00 has 1', () => {
        assert.equal(heat.days[0], 'Mon');
        assert.equal(heat.grid[0][13], 2);
        assert.equal(heat.grid[6][0], 1);
        assert.equal(heat.grid.flat().reduce((s, x) => s + x, 0), 3);
    });

    const s = a.buildSos(sos);
    await check('SOS: average first response 7 min (4 and 10), average resolve 20 min (30 and 10)', () => {
        assert.equal(s.total, 3);
        assert.equal(s.open, 1);
        assert.equal(s.avgResponseMin, 7);
        assert.equal(s.avgResolveMin, 20);
        assert.deepEqual(s.byType[0], { type: 'MEDICAL', count: 2 });
    });
    await check('SOS with no responses gives null averages, not NaN', () => {
        const e = a.buildSos([{ status: 'OPEN', createdAt: new Date() }]);
        assert.equal(e.avgResponseMin, null);
        assert.equal(e.avgResolveMin, null);
    });

    await check('CSV quotes commas and quotes, and neutralises spreadsheet formulas', () => {
        const csv = a.toCsv(['Name', 'Note'], [['Tent, A', 'He said "hi"'], ['=HYPERLINK("x")', '-5']]);
        assert.equal(csv, 'Name,Note\n"Tent, A","He said ""hi"""\n"\'=HYPERLINK(""x"")",\'-5\n');
    });
    await check('CSV daily report has a header and one row per day', () => {
        const csv = a.REPORTS.daily({ daily });
        const lines = csv.trim().split('\n');
        assert.equal(lines.length, 4);
        assert.match(lines[0], /^Date,Bed bookings/);
        assert.equal(lines[3], '2026-10-17,0,0,0,2,2,99,2');
    });

    // ---------------------------------------------------------------- simulated demo history
    {
        const mongoose = require('mongoose');
        const { buildHistory, prepareHistory } = require('./demo-history');
        const models = {
            User: require('../modules/auth/user.model'),
            Pass: require('../modules/pass/pass.model').Pass,
            Order: require('../modules/order/order.model'),
            SosIncident: require('../modules/sos/sos.model'),
        };
        const id = () => new mongoose.Types.ObjectId();
        const now = istDateTime('2026-10-18', '16:40');
        const ctx = {
            event: { _id: id() },
            lodgings: [{ _id: id(), providerId: id(), name: 'Ramkund Dharamshala', sector: 'S1', pricePerNight: 100 }, { _id: id(), providerId: id(), name: 'Tapovan Camp', sector: 'S2', pricePerNight: 0 }],
            centers: [{ _id: id(), providerId: id(), name: 'Godavari Langar', sector: 'S1' }],
            routes: [{ _id: id(), name: 'F4', origin: 'A', destination: 'B', fare: 10 }, { _id: id(), name: 'S1', origin: 'C', destination: 'D', fare: 0 }],
            volunteer: { _id: id() },
            passwordHash: '$2a$10$abcdefghijklmnopqrstuuJ8pJ0Gqv8m3bP8Qe2s1y3Qh5bVQ1G2a',
        };
        const h = buildHistory(ctx, { days: 14, now });
        let prepared;
        await check('Demo history: every document passes the real schema validation', async () => {
            prepared = await prepareHistory(models, h);
            console.log(`      (${h.users.length} demo pilgrims, ${h.passes.length} passes, ${h.orders.length} paid orders, ${h.sos.length} SOS alerts)`);
            assert.ok(h.passes.length > 2000, `only ${h.passes.length} passes`);
            assert.ok(h.orders.length > 50 && h.sos.length > 10 && h.users.length === 60);
        });
        await check('Demo history: same seed gives the same history (reproducible)', () => {
            const again = buildHistory(ctx, { days: 14, now });
            assert.equal(again.passes.length, h.passes.length);
            assert.equal(again.passes[100].details.kitchen ?? again.passes[100].title, h.passes[100].details.kitchen ?? h.passes[100].title);
        });
        await check('Demo history: nothing happens in the future, everything is inside the 14 days', () => {
            const first = istDateTime(a.lastDays(14, '2026-10-18')[0], '00:00').getTime() - 864e5; // bookings may be made the day before
            for (const p of h.passes) {
                assert.ok(p.redeemedAt <= now && p.createdAt <= p.redeemedAt, 'pass times');
                assert.ok(p.redeemedAt.getTime() >= first);
            }
            for (const s of h.sos) assert.ok(s.createdAt < s.acknowledgedAt && s.acknowledgedAt < s.resolvedAt && s.resolvedAt <= new Date(now.getTime() + 3600e3));
        });
        await check('Demo history: demo pilgrims are clearly labelled (70000000xx, "Demo Pilgrim")', () => {
            assert.ok(h.users.every((u) => /^70000000\d\d$/.test(u.phone) && u.name.startsWith('Demo Pilgrim')));
            assert.ok(h.passes.every((p) => p.details.demo === true));
        });
        await check('Demo history feeds every chart: 14 non-empty days, meals by type, revenue, heat map', () => {
            const days14 = a.lastDays(14, '2026-10-18');
            const passes = prepared.find(([M]) => M.modelName === 'Pass')[1];
            const dailyH = a.buildDaily({ days: days14, issued: passes, redeemed: passes, orders: h.orders, sos: h.sos });
            assert.ok(dailyH.every((d) => d.scans > 0), 'a day without scans');
            assert.ok(dailyH.slice(0, -1).every((d) => d.revenue > 0), 'a past day without revenue');
            const mealsH = a.buildMeals({ days: days14, redeemed: passes });
            assert.ok(mealsH.slice(0, -1).every((d) => d.BREAKFAST && d.LUNCH && d.DINNER));
            assert.ok(mealsH[13].DINNER === 0, 'dinner at 16:40 today has not happened yet');
            const busiest = a.buildHeatmap(passes).grid.flat().reduce((m, x) => Math.max(m, x), 0);
            assert.ok(busiest > 20);
        });
    }

    // ---------------------------------------------------------------- live updates
    const server = http.createServer();
    const USERS = {
        authority: { id: 'a1', role: 'AUTHORITY' },
        ngo: { id: 'n1', role: 'NGO_ADMIN', providerId: 'p1' },
        otherNgo: { id: 'n2', role: 'NGO_ADMIN', providerId: 'p2' },
        pilgrim: { id: 'u1', role: 'USER' },
        volunteer: { id: 'v1', role: 'VOLUNTEER' },
    };
    realtime.init(server, { origins: ['*'], authenticate: async (token) => { if (!USERS[token]) throw new Error('bad'); return USERS[token]; } });
    await new Promise((r) => server.listen(0, r));
    const url = `http://localhost:${server.address().port}`;
    const open = (token) => new Promise((resolve, reject) => {
        const c = connect(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false });
        c.on('connect', () => resolve(c));
        c.on('connect_error', reject);
    });
    const clients = {
        visitor: await open(null),
        authority: await open('authority'),
        ngo: await open('ngo'),
        otherNgo: await open('otherNgo'),
        pilgrim: await open('pilgrim'),
        volunteer: await open('volunteer'),
    };
    const listen = (event) => {
        const got = {};
        for (const [k, c] of Object.entries(clients)) {
            got[k] = [];
            c.on(event, (p) => got[k].push(p));
        }
        return got;
    };
    const settle = () => new Promise((r) => setTimeout(r, 150));

    await check('A bad token is refused at connection time', async () => {
        await assert.rejects(open('nope'), /Session expired/);
    });

    const sosGot = listen('sos');
    realtime.notify(['control', 'volunteers'], 'sos', { action: 'raised', id: 'x' });
    await settle();
    await check('SOS alert reaches the control room and volunteers only', () => {
        assert.equal(sosGot.authority.length, 1);
        assert.equal(sosGot.volunteer.length, 1);
        for (const k of ['visitor', 'ngo', 'otherNgo', 'pilgrim']) assert.equal(sosGot[k].length, 0, k);
        assert.equal(sosGot.authority[0].action, 'raised');
        assert.ok(sosGot.authority[0].at > 0);
    });

    const bedsGot = listen('beds');
    realtime.notify(['public', 'control', 'provider:p1'], 'beds', { lodgingId: 'L1' });
    await settle();
    await check('Bed change reaches everyone once (rooms are not double-counted)', () => {
        for (const k of Object.keys(clients)) assert.equal(bedsGot[k].length, 1, k);
    });

    const scanGot = listen('scan');
    realtime.notify(['control', 'provider:p1'], 'scan', { type: 'MEAL' });
    await settle();
    await check("A scan at NGO p1's kitchen is not sent to another NGO or to pilgrims", () => {
        assert.equal(scanGot.ngo.length, 1);
        assert.equal(scanGot.authority.length, 1);
        assert.equal(scanGot.otherNgo.length, 0);
        assert.equal(scanGot.pilgrim.length, 0);
        assert.equal(scanGot.visitor.length, 0);
    });

    const mine = listen('sos');
    realtime.notify(['user:u1'], 'sos', { action: 'updated', status: 'ACKNOWLEDGED' });
    await settle();
    await check("A pilgrim gets updates on their own SOS only", () => {
        assert.equal(mine.pilgrim.length, 1);
        assert.equal(mine.authority.length, 0);
    });

    const watchId = 'a'.repeat(24);
    clients.authority.emit('watch:lodging', watchId);
    clients.pilgrim.emit('watch:lodging', watchId);
    await settle();
    const mapGot = listen('beds');
    realtime.notify([`lodging:${watchId}`], 'beds', { lodgingId: watchId });
    await settle();
    await check('Only staff allowed to view inventory can follow a tent map', () => {
        assert.equal(mapGot.authority.length, 1);
        assert.equal(mapGot.pilgrim.length, 0);
    });

    await check('notify() is a no-op when the socket server is not running', async () => {
        Object.values(clients).forEach((c) => c.close());
        await realtime.close();
        realtime.notify('control', 'sos', {}); // must not throw
        server.close();
    });

    // ---------------------------------------------------------------- input rules (spot checks)
    await check('Validation: whole numbers, names, PIN codes, mobiles', () => {
        assert.throws(() => v.int('1e5', 'Capacity', { min: 1, max: 100000 }), /whole number/);
        assert.equal(v.int('250', 'Capacity', { min: 1, max: 100000 }), 250);
        assert.throws(() => v.text('Ram3sh', 'Name', 'personName'), /letters/);
        assert.equal(v.text('  Lata   Patil ', 'Name', 'personName'), 'Lata Patil');
        assert.throws(() => v.pincode('022001'), /cannot start with 0/);
        assert.deepEqual(v.mobile('44', '7700 900123', 'Contact'), { countryCode: '44', phone: '7700900123' });
        assert.throws(() => v.mobile('91', '5876543210', 'Contact'), /start with 6, 7, 8 or 9/);
    });

    console.log(`\n${passed} passed, ${failed} failed (today in IST: ${istDate()})`);
    process.exit(failed ? 1 : 0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
