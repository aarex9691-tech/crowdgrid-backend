/**
 * Live demo simulator: makes the dashboard and control room move during a presentation.
 *
 *   npm run simulate                      (backend must be running: npm run dev)
 *   API_URL=http://localhost:5000 SIM_INTERVAL=4 npm run simulate
 *
 * It behaves like real people using the real API (no shortcuts into the
 * database): demo pilgrims book free camp beds, claim meal tokens and bus
 * passes; the demo volunteer scans their personal QR at the right counter;
 * now and then a pilgrim raises an SOS and the district control room
 * acknowledges and resolves it. Every step goes through the normal checks
 * (limits, permissions, single-use passes) and triggers the normal live updates.
 * Press Ctrl+C to stop. Needs `npm run seed` first (demo pilgrims 7000000001-...).
 */
require('dotenv').config();
const { istDate, addDays } = require('../utils/time');

const API = (process.env.API_URL || `http://localhost:${process.env.PORT || 5000}`).replace(/\/$/, '') + '/api';
const INTERVAL = Math.max(2, Number(process.env.SIM_INTERVAL || 4)) * 1000;
const PASSWORD = process.env.SIM_PASSWORD || 'Crowd@123';
const PILGRIMS = 15; // logins are rate limited, so a small group is reused

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const stamp = () => new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
const log = (icon, msg) => console.log(`${stamp()}  ${icon}  ${msg}`);

async function call(token, method, path, body) {
    const res = await fetch(API + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.message || `${res.status} ${path}`);
        err.status = res.status;
        throw err;
    }
    return data;
}

const login = async (phone) => {
    const { token, user } = await call(null, 'POST', '/auth/login', { identifier: phone, phone, password: PASSWORD });
    return { token, name: user.name };
};

async function main() {
    log('▶', `Simulator using ${API}, one action every ${INTERVAL / 1000}s. Ctrl+C to stop.`);
    const authority = await login('9000000002');
    const volunteer = await login('9000000005');
    const pilgrims = [];
    for (let i = 1; i <= PILGRIMS; i++) {
        try {
            pilgrims.push(await login(`70000000${String(i).padStart(2, '0')}`));
        } catch (e) {
            if (i === 1) throw new Error(`Demo pilgrims not found (${e.message}). Run "npm run seed" first.`);
        }
    }
    const events = await call(null, 'GET', '/events?kind=YATRA');
    const event = events.find((e) => e.isFlagship) || events[0];
    log('✓', `Logged in ${pilgrims.length} demo pilgrims, the volunteer and the control room. Event: ${event.title}`);

    const scanAt = async (pilgrim, service) => {
        const { qr } = await call(pilgrim.token, 'GET', '/passes/my-qr');
        let r = await call(volunteer.token, 'POST', '/passes/scan', { qr, service });
        if (r.result === 'CHOOSE') r = await call(volunteer.token, 'POST', '/passes/scan', { qr, service, passId: r.options[0].id || r.options[0]._id });
        return r;
    };

    const actions = {
        // Book 1-2 beds in a free camp, check in at the gate, sometimes cancel later
        async beds() {
            const p = pick(pilgrims);
            const camps = (await call(null, 'GET', `/lodgings?eventId=${event._id}`)).filter((l) => !l.pricePerNight && l.availableBeds > 2);
            if (!camps.length) return log('…', 'No free camp with beds left');
            const camp = pick(camps);
            const today = istDate();
            const res = await call(p.token, 'POST', `/lodgings/${camp._id}/book`, { beds: 1 + Math.floor(Math.random() * 2), checkIn: today, checkOut: addDays(today, 1) });
            log('🛏', `${p.name} booked ${res.booking.bedLabel} at ${camp.name}`);
            if (Math.random() < 0.7) {
                await sleep(1500);
                const s = await scanAt(p, 'LODGING');
                log('✔', `Checked in at the camp gate: ${s.message}`);
            } else {
                setTimeout(() => call(p.token, 'POST', `/lodgings/bookings/${res.booking._id}/cancel`).then(() => log('↩', `${p.name} cancelled the booking at ${camp.name}`)).catch(() => {}), 30000);
            }
        },
        // Claim a meal token during an open meal window and get it scanned at the counter
        async meal() {
            const p = pick(pilgrims);
            const { centers } = await call(null, 'GET', `/food?eventId=${event._id}`);
            const now = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }).slice(0, 5);
            const open = centers.flatMap((c) => (c.slots || []).filter((s) => s.startTime <= now && now < s.endTime && s.remaining > 6).map((s) => ({ c, s })));
            if (!open.length) return actions.bus(); // no meal being served right now
            const { c, s } = pick(open);
            const people = Math.random() < 0.5 ? 1 : 2 + Math.floor(Math.random() * 4);
            await call(p.token, 'POST', `/food/slots/${s._id}/claim`, { people });
            log('🍛', `${p.name} took a ${s.meal.toLowerCase()} token for ${people} at ${c.name}`);
            await sleep(1500);
            const r = await scanAt(p, 'FOOD');
            log('✔', `Served at the kitchen counter: ${r.message}`);
        },
        // Free shuttle pass, scanned at the bus gate
        async bus() {
            const p = pick(pilgrims);
            const routes = (await call(null, 'GET', `/transit?eventId=${event._id}`)).filter((r) => !r.fare && r.kind === 'SHUTTLE');
            if (!routes.length) return;
            const route = pick(routes);
            const res = await call(p.token, 'POST', `/transit/${route._id}/pass`);
            if (res.existing) return log('…', `${p.name} already has a ${route.name} pass today`);
            log('🚌', `${p.name} got a boarding pass for ${route.name}`);
            await sleep(1500);
            const r = await scanAt(p, 'TRANSIT');
            log('✔', `Boarded at the bus gate: ${r.message}`);
        },
        // SOS near Ramkund, acknowledged and then resolved by the control room
        async sos() {
            const p = pick(pilgrims);
            const type = pick(['MEDICAL', 'LOST', 'CROWD', 'GENERAL']);
            const { incident, updated } = await call(p.token, 'POST', '/sos', { eventId: event._id, type, lat: 20.0059 + (Math.random() - 0.5) * 0.006, lng: 73.7897 + (Math.random() - 0.5) * 0.006, accuracy: 15, message: 'Simulated alert (demo)' });
            if (updated) return log('…', `${p.name} updated an open SOS`);
            log('🚨', `${p.name} raised a ${type.toLowerCase()} SOS`);
            setTimeout(() => call(authority.token, 'PATCH', `/sos/${incident._id}`, { status: 'ACKNOWLEDGED' }).then(() => log('☎', 'Control room acknowledged the SOS')).catch(() => {}), 8000 + Math.random() * 8000);
            setTimeout(() => call(authority.token, 'PATCH', `/sos/${incident._id}`, { status: 'RESOLVED' }).then(() => log('✅', 'SOS resolved')).catch(() => {}), 30000 + Math.random() * 30000);
        },
    };
    const weights = [['beds', 3], ['meal', 4], ['bus', 3], ['sos', 1]];
    const total = weights.reduce((s, [, w]) => s + w, 0);

    let stopping = false;
    process.on('SIGINT', () => {
        stopping = true;
        log('■', 'Stopping simulator');
        setTimeout(() => process.exit(0), 200);
    });
    while (!stopping) {
        let r = Math.random() * total;
        const [name] = weights.find(([, w]) => (r -= w) < 0) || weights[0];
        try {
            await actions[name]();
        } catch (e) {
            log('…', `${name}: ${e.message}`); // limits are expected, e.g. "1 token per meal"
        }
        await sleep(INTERVAL);
    }
}

main().catch((e) => {
    console.error(`Simulator stopped: ${e.message}`);
    process.exit(1);
});
