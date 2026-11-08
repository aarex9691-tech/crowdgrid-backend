/**
 * End-to-end check of the new features against your real database.
 *   npm run test:flows
 *
 * Run it right AFTER `npm run seed` (it uses the seeded camps, kitchens and
 * buses). It creates its own test pilgrim and deletes everything it made.
 */
require('dotenv').config();
require('../utils/dns'); // optional DNS_SERVERS override for Atlas
const mongoose = require('mongoose');
const User = require('../modules/auth/user.model');
const Event = require('../modules/event/event.model');
const { Lodging, LodgingBooking } = require('../modules/lodging/lodging.model');
const { BedAssignment } = require('../modules/lodging/beds');
const { FoodSlot } = require('../modules/food/food.model');
const { Pass } = require('../modules/pass/pass.model');
const TransitRoute = require('../modules/transit/transit.model');
const Order = require('../modules/order/order.model');
const auth = require('../modules/auth/auth.service');
const lodging = require('../modules/lodging/lodging.service');
const food = require('../modules/food/food.service');
const orders = require('../modules/order/order.service');
const passes = require('../modules/pass/pass.service');
const events = require('../modules/event/event.service');
const { detectTransactionSupport } = require('../utils/tx');
const { istDate } = require('../utils/time');

let failed = 0;
const check = (name, ok, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
    if (!ok) failed++;
};
// Optional `about` regex: the error must be about the right thing, not some other rule
const expectError = async (name, fn, status, about) => {
    try {
        await fn();
        check(name, false, 'no error');
    } catch (err) {
        check(name, (!status || err.status === status) && (!about || about.test(err.message)), `${err.status} ${err.message}`);
    }
};

async function main() {
    await require('../utils/dns').connectMongo(mongoose, process.env.MONGO_URI);
    await detectTransactionSupport();
    const PHONE = '6999999990';
    await User.deleteMany({ phone: PHONE });
    let me;
    let savedLanes; // lane statuses before the route checks, put back afterwards
    let hostedId;
    let freeId;
    const groupIds = []; // events created by the group-ticket checks
    try {
        // ---- 1. Phone numbers ----
        await expectError('Register rejects a 12-digit Indian number', () => auth.register({ name: 'Test Pilgrim', phone: '900000000612', password: 'Crowd@123' }), 400, /mobile number/i);
        await expectError('Register rejects a 5-digit number', () => auth.register({ name: 'Test Pilgrim', phone: '90000', password: 'Crowd@123' }), 400, /mobile number/i);
        const reg = await auth.register({ name: 'Flow Test Pilgrim', phone: PHONE, countryCode: '91', password: 'Crowd@123' });
        me = await User.findById(reg.user._id).lean();
        check('Register with +91 works', !!me && me.countryCode === '91');
        const l1 = await auth.login({ identifier: PHONE, password: 'Crowd@123' });
        const l2 = await auth.login({ identifier: `+91 ${PHONE.slice(0, 5)} ${PHONE.slice(5)}`, password: 'Crowd@123' });
        check('Login with 10 digits and with +91 format', !!l1.token && !!l2.token);
        const demo = await auth.login({ identifier: '9000000006', password: process.env.SEED_PASSWORD });
        check('Demo pilgrim 9000000006 can still log in', !!demo.token);

        const event = await Event.findOne({ isFlagship: true }).lean();
        const user = { ...me, id: String(me._id) };

        // ---- 2. Free camp gets tent + bed numbers ----
        // Free beds are counted per night now, so camps are picked through the search (tonight's availability)
        const camps = await lodging.search(String(event._id));
        const freeCamp = camps.find((c) => !c.pricePerNight && c.availableBeds >= 2);
        const b = await lodging.book(freeCamp._id, user, { beds: 2, guestNames: ['A', 'B'] });
        check('Free camp booking has tent and bed numbers', /Bed/.test(b.pass.details.location || ''), b.pass.details.location);
        const assigned = await BedAssignment.countDocuments({ bookingId: b.booking._id });
        check('Two BedAssignment rows created', assigned === 2);
        const authority = await User.findOne({ phone: '9000000002' }).lean();
        const map = await lodging.bedMap(freeCamp._id, { ...authority });
        const mine = map.units.flatMap((u) => u.beds).filter((x) => String(x.bookingId) === String(b.booking._id));
        check('Tent map shows both beds as booked with guest names', mine.length === 2 && mine.every((x) => x.status === 'BOOKED' && x.guest), mine.map((x) => x.guest).join(', '));
        await lodging.cancel(b.booking._id, user);
        check('Cancelling frees the bed numbers', (await BedAssignment.countDocuments({ bookingId: b.booking._id })) === 0);

        // The limit is 5 beds: booking exactly 5 must work (the model once allowed only 4)
        const bigCamp = camps.find((c) => !c.pricePerNight && c.availableBeds >= 5);
        const five = await lodging.book(bigCamp._id, user, { beds: 5, guestNames: ['A', 'B', 'C', 'D', 'E'] });
        check('Booking 5 beds (the limit) works', five.booking.beds === 5 && five.pass.details.bedNumbers.length === 5, five.pass.details.location);
        await expectError('A 6th bed on the same night is refused', () => lodging.book(bigCamp._id, user, { beds: 1 }), 400, /limit/i);

        // ---- 2b. Beds are counted night by night ----
        {
            const { addDays } = require('../utils/time');
            const night = five.booking.checkIn;
            const next = addDays(night, 1);
            const onNight = (await lodging.search(String(event._id), { checkIn: night })).find((c) => String(c._id) === String(bigCamp._id));
            const onNext = (await lodging.search(String(event._id), { checkIn: next })).find((c) => String(c._id) === String(bigCamp._id));
            check('A bed booked for one night is free again the next night', onNext.availableBeds === onNight.availableBeds + 5, `${onNight.availableBeds} tonight, ${onNext.availableBeds} next night`);
            const nextStay = await lodging.book(bigCamp._id, user, { beds: 5, checkIn: next, checkOut: next });
            check('The same account can book 5 more beds for a different night', nextStay.booking.beds === 5);
            check('Next night gets its own bed numbers (same beds may be reused)', nextStay.booking.nights.join() === next);
            await lodging.cancel(nextStay.booking._id, user);
            const event2 = await Event.findById(event._id).lean();
            const lastDay = require('../utils/time').istDate(event2.endDate);
            if (addDays(night, 8) <= lastDay) {
                await expectError('Stays longer than 7 nights are refused', () => lodging.book(bigCamp._id, user, { beds: 1, checkIn: night, checkOut: addDays(night, 8) }), 400, /7 nights/);
            }
        }
        await lodging.cancel(five.booking._id, user);

        // ---- 3. Paid camp must go through checkout ----
        const paidCamp = camps.find((c) => c.pricePerNight > 0 && c.availableBeds >= 2);
        await expectError('Direct booking of a paid camp asks for payment', () => lodging.book(paidCamp._id, user, { beds: 1 }), 402);

        // ---- 4. Order + simulated payment ----
        const bus = await TransitRoute.findOne({ eventId: event._id, fare: { $gt: 0 } }).lean();
        const order = await orders.create(user, [
            { kind: 'LODGING', refId: String(paidCamp._id), input: { beds: 2, guestNames: ['A', 'B'] } },
            { kind: 'TRANSIT', refId: String(bus._id) },
        ]);
        check('Order priced on the server', order.total === paidCamp.pricePerNight * 2 + bus.fare, `total ₹${order.total}`);
        await expectError('UPI fail@upi is declined', () => orders.pay(order._id, user, { method: 'UPI', upiId: 'fail@upi' }), 402);
        const paid = await orders.pay(order._id, user, { method: 'UPI', upiId: 'flow@okaxis' });
        check('Payment approved and both passes issued', paid.status === 'PAID' && paid.passes.length === 2, paid.payment?.reference);
        await expectError('Paying the same order twice is refused', () => orders.pay(order._id, user, { method: 'UPI', upiId: 'flow@okaxis' }), 409);

        // ---- 5. Family meal token ----
        const today = istDate();
        const nowHM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
        const slots = await FoodSlot.find({ eventId: event._id, date: today, remaining: { $gte: 4 } }).lean();
        const slot = slots.find((s) => process.env.PASS_TIME_WINDOWS === 'relaxed' || s.endTime > nowHM);
        if (slot) {
            const m = await food.claim(slot._id, user, { people: 4, names: 'Aai, Baba, Ram, Sita' });
            const after = await FoodSlot.findById(slot._id).lean();
            check('One token feeds 4 people and uses 4 plates', m.pass.details.people === 4 && after.remaining === slot.remaining - 4);
            await expectError('A second token for the same meal is refused', () => food.claim(slot._id, user, { people: 1 }), 409);
        } else {
            console.log('SKIP  family meal token (all of today\'s meal windows are over; run before 10 pm)');
        }

        // ---- 6. Profile ----
        const prof = await auth.updateProfile(user, { email: 'flow.test@example.com', dateOfBirth: '1990-05-14', gender: 'female', city: 'Pune', emergencyContact: { name: 'Raj', phone: '9876543210' } });
        check('Profile saves email, date of birth, gender, city, emergency contact', prof.email === 'flow.test@example.com' && prof.gender === 'FEMALE' && prof.city === 'Pune' && !!prof.dateOfBirth && prof.emergencyContact?.phone === '9876543210');
        await auth.updateProfile(user, { city: '' });
        check('Clearing a field removes it from the database', !(await User.findById(me._id).lean()).city);
        {
            const [ty, tm, td] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()).split('-');
            await expectError('Date of birth under 18 is refused', () => auth.updateProfile(user, { dateOfBirth: `${ty - 17}-${tm}-${td}` }), 400);
            const p18 = await auth.updateProfile(user, { dateOfBirth: `${ty - 18}-${tm}-${td}` });
            check('Turning 18 today is accepted', !!p18.dateOfBirth);
        }

        // ---- 7. Hosting a paid public event ----
        const authorityUser = await User.findOne({ phone: '9000000002' }).lean();
        const host = { ...authorityUser, id: String(authorityUser._id) };
        const start = new Date(Date.now() + 2 * 864e5);
        const base = { kind: 'PUBLIC', title: 'Flow test aarti', category: 'SPIRITUAL', description: 'A test event created by the flow test script to check hosting, the description limits, ticket checkout and the host dashboard. It is deleted automatically when the test run finishes.', venue: 'Test ghat', address: 'Ramkund, Nashik', city: 'Nashik', pincode: '422003', location: { lat: 20.0059, lng: 73.7897 }, startDate: start, endDate: new Date(start.getTime() + 2 * 3600e3), capacity: 5 };
        await expectError('Description over 200 characters (spaces not counted) is refused', () => events.create({ ...base, ticketPrice: 99, description: 'x'.repeat(201) }, host), 400);
        await expectError('Description under 150 characters (spaces not counted) is refused', () => events.create({ ...base, ticketPrice: 99, description: 'too short' }, host), 400);
        await expectError('An event more than a year ahead is refused', () => events.create({ ...base, ticketPrice: 99, startDate: new Date(Date.now() + 400 * 864e5), endDate: new Date(Date.now() + 400 * 864e5 + 3600e3) }, host), 400);
        // Input rules (same as the forms in the browser)
        await expectError('Contact number with letters is refused', () => events.create({ ...base, ticketPrice: 99, contactPhone: '98765abc10' }, host), 400);
        await expectError('Capacity written as 1e5 is refused', () => events.create({ ...base, ticketPrice: 99, capacity: '1e5' }, host), 400);
        await expectError('Negative ticket price is refused', () => events.create({ ...base, ticketPrice: -5 }, host), 400);
        await expectError('PIN code starting with 0 is refused', () => events.create({ ...base, ticketPrice: 99, pincode: '022001' }, host), 400);
        await expectError('City with digits or symbols is refused', () => events.create({ ...base, ticketPrice: 99, city: 'Nashik123!' }, host), 400);
        await expectError('Venue longer than 120 characters is refused', () => events.create({ ...base, ticketPrice: 99, venue: 'v'.repeat(121) }, host), 400);
        const foreignContact = await events.create({ ...base, title: 'Flow test foreign contact', ticketPrice: 99, contactCountryCode: '44', contactPhone: '7700 900123' }, host);
        check('Contact number with a country code is saved as digits', foreignContact.contactCountryCode === '44' && foreignContact.contactPhone === '7700900123');
        await Event.deleteOne({ _id: foreignContact._id });
        await expectError('A name with digits is refused at sign-up', () => auth.register({ name: 'Ram3sh', phone: '6999999991', countryCode: '91', password: 'Test@1234' }), 400, /name/i);
        await expectError('Your own number as emergency contact is refused', () => auth.updateProfile(user, { emergencyContact: { name: 'Me', countryCode: '91', phone: PHONE } }), 400);
        const freeEv = await events.create({ ...base, title: 'Flow test free darshan', ticketPrice: 0 }, host);
        freeId = freeEv._id;
        const freeReg = await events.register(freeId, user);
        check('A ₹0 event registers directly, no payment step', freeReg.pass?.type === 'PUBLIC');
        await expectError('A pilgrim cannot host an event', () => events.create({ ...base, ticketPrice: 99 }, user), 403);
        hostedId = (await events.create({ ...base, ticketPrice: 99, sectors: ['should be dropped'] }, host))._id;
        const stored = await Event.findById(hostedId).lean();
        check('Host event saved with address, map point and price; unrelated fields dropped', stored.ticketPrice === 99 && stored.location?.lat === 20.0059 && stored.sectors === undefined && stored.keyDates === undefined);
        await expectError('Registering without paying asks for payment', () => events.register(hostedId, user), 402);
        const tOrder = await orders.create(user, [{ kind: 'EVENT', refId: String(hostedId) }]);
        const tPaid = await orders.pay(tOrder._id, user, { method: 'CARD', cardNumber: '4242424242424242', expiry: '12/30', cvv: '123' });
        check('Ticket bought at checkout issues an entry pass', tPaid.status === 'PAID' && tPaid.passes[0]?.type === 'PUBLIC', `₹${tPaid.total}`);
        const hosted = await events.hostedEvents(host);
        const mineHosted = hosted.find((e) => String(e._id) === String(hostedId));
        check('Host dashboard shows tickets sold and revenue', mineHosted?.ticketsSold === 1 && mineHosted?.revenue === 99);
        const { hasPermission } = require('../config/roles');
        check('Admins and hosts cannot book (they use their own dashboards)', ['SUPER_ADMIN', 'AUTHORITY', 'CORPORATE_ADMIN', 'NGO_ADMIN', 'VOLUNTEER'].every((r) => !hasPermission(r, 'booking:create')) && hasPermission('USER', 'booking:create'));

        // ---- 8. One personal QR ----
        const { qr } = await passes.myQr(user);
        const staff = await User.findOne({ phone: '9000000002' }).lean(); // authority can scan everywhere
        const scanner = { ...staff, id: String(staff._id) };
        const r1 = await passes.scan(qr, scanner, { service: 'TRANSIT' });
        check('Personal QR at the bus gate redeems the bus pass', r1.result === 'VALID' && r1.pass?.type === 'TRANSIT', r1.message);
        const r2 = await passes.scan(qr, scanner, { service: 'TRANSIT' });
        check('Scanning again at the bus gate finds nothing left', r2.result === 'REJECTED', r2.message);
        await passes.myQr(user, { reset: true });
        const r3 = await passes.scan(qr, scanner, { service: 'LODGING' });
        check('Old personal QR stops working after reset', r3.result === 'REJECTED' && r3.reason === 'REVOKED');

        // ---- 9. Analytics dashboard (reads the seeded demo history) ----
        const analytics = require('../modules/analytics/analytics.service');
        const ov = await analytics.overview({ days: 14 });
        const totalPasses = ov.daily.reduce((s, d) => s + d.lodging + d.meals + d.transit, 0);
        check('Analytics overview covers 14 days with activity', ov.days.length === 14 && ov.daily.length === 14 && totalPasses > 0, `${totalPasses} passes`);
        check('Analytics bed numbers add up', ov.kpis.bedsTotal > 0 && ov.kpis.bedsFree <= ov.kpis.bedsTotal && ov.kpis.occupancyPct >= 0 && ov.kpis.occupancyPct <= 100, `${ov.kpis.occupancyPct}%`);
        check('Analytics heat map is 7 days x 24 hours', ov.heatmap.grid.length === 7 && ov.heatmap.grid.every((r) => r.length === 24));
        const csv = await analytics.exportCsv({ days: 7, report: 'daily' });
        check('CSV export has a header and one row per day', csv.body.replace(/^\uFEFF/, '').trim().split(/\r?\n/).length === 8, csv.filename);
        const ngoAdmin = await User.findOne({ role: 'NGO_ADMIN' }).lean();
        if (ngoAdmin) {
            const ngo = await analytics.ngoOverview({ ...ngoAdmin, id: String(ngoAdmin._id) }, { days: 7 });
            check('NGO analytics shows only their own camps', ngo.camps.length > 0 && ngo.daily.length === 7);
        }

        // ---- 10. Safest route to a ghat ----
        const route = require('../modules/route/route.service');
        const { LaneStatus } = require('../modules/route/lane.model');
        const { SEED_STATUS } = require('../modules/route/network.nashik');
        const flagship = await Event.findOne({ slug: 'simhastha-kumbh-2027' }, '_id').lean();
        // Work on a known set of lane statuses (put back afterwards), whatever the database had
        savedLanes = { eventId: flagship._id, rows: await LaneStatus.find({ eventId: flagship._id }).lean() };
        if (!savedLanes.rows.some((r) => r.laneId === 'procession-route' && r.status === 'CROWDED')) {
            console.log('NOTE  This database has no demo lane statuses: run "npm run seed" before the demo so the safest route has something to avoid.');
        }
        await LaneStatus.deleteMany({ eventId: flagship._id });
        await LaneStatus.insertMany(SEED_STATUS.map((l) => ({ ...l, eventId: flagship._id })));
        const net = await route.network({});
        check('Route network loads with the demo lane statuses', net.nodes.length > 20 && net.lanes.find((l) => l.id === 'procession-route')?.manualStatus === 'CROWDED');
        const plan1 = await route.plan({ from: 'tent-city-a', to: 'ramkund' });
        check('Safest route avoids the crowded procession route', plan1.reachable && !plan1.safest.lanes.some((l) => l.id === 'procession-route') && plan1.algorithms.sameCost, `${plan1.safest.distanceM} m, ${plan1.safest.minutes} min; A* ${plan1.algorithms.astar.visited} vs Dijkstra ${plan1.algorithms.dijkstra.visited} junctions`);
        const controlRoom = await User.findOne({ phone: '9000000002' }).lean();
        await route.setLane(controlRoom, 'ashram-sardar', { status: 'CLOSED', note: 'Flow test' });
        const plan2 = await route.plan({ from: 'tent-city-a', to: 'ramkund' });
        check('Closing a lane changes the safest route straight away', !plan2.safest.lanes.some((l) => l.id === 'ashram-sardar'), plan2.safest.lanes.map((l) => l.name).join(' > '));
        await expectError('Unknown lane is refused', () => route.setLane(controlRoom, 'no-such-lane', { status: 'BUSY' }), 404);
        await expectError('Unknown lane status is refused', () => route.setLane(controlRoom, 'ashram-sardar', { status: 'JAMMED' }), 400);
        await expectError('Route to something that is not a ghat is refused', () => route.plan({ from: 'tent-city-a', to: 'sardar-chowk' }), 400);
        await expectError('"Use my location" far from Nashik is refused', () => route.plan({ from: 'here', lat: '19.07', lng: '72.87', to: 'ramkund' }), 400, /too far/);
        const here = await route.plan({ from: 'here', lat: '20.0088', lng: '73.7956', to: 'ramkund' });
        check('"Use my location" starts from the nearest junction', here.from.id === 'tent-city-a', `${here.from.name}, ${here.from.snappedM} m away`);
        // ---- 11. Missing person report (team notes) ----
        const lostfound = require('../modules/lostfound/lostfound.service');
        const missing = { kind: 'MISSING', personName: 'Kamla Devi', age: '70', lastSeenAt: 'Ramkund Ghat, Gate 2', eventId: String(flagship._id) };
        await expectError('Missing report needs male or female', () => lostfound.create(user, missing), 400, /gender/i);
        await expectError('"Other" gender is not offered for missing reports', () => lostfound.create(user, { ...missing, gender: 'OTHER' }), 400, /male or female/);
        await expectError("A wrong mobile for the missing person is refused", () => lostfound.create(user, { ...missing, gender: 'FEMALE', personPhone: '12345' }), 400, /Missing person/);
        const rep = await lostfound.create(user, { ...missing, gender: 'FEMALE', personPhone: '9876543210', contactPhone: '9123456780' });
        check('Missing report saves approx age, gender, family contact and their own mobile', rep.age === 70 && rep.gender === 'FEMALE' && rep.personPhone === '9876543210' && rep.contactPhone === '9123456780');
        {
            // Photos live in MongoDB; a fake "image" is refused and leaves nothing behind
            const { Photo } = require('../modules/lostfound/photo.model');
            const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
            const withPhoto = await lostfound.create(user, { ...missing, gender: 'MALE', personName: 'Photo Test' }, { buffer: png });
            const stored = await Photo.findOne({ reportId: withPhoto._id }).lean();
            check('Missing-person photo is stored in the database', !!stored && withPhoto.photoUrl === `/api/lost-found/photos/${stored._id}`, withPhoto.photoUrl);
            const before = await Photo.countDocuments({ uploadedBy: me._id });
            await expectError('A file that is not really an image is refused', () => lostfound.create(user, { ...missing, gender: 'MALE' }, { buffer: Buffer.from('<script>alert(1)</script> not an image') }), 400, /JPEG, PNG or WEBP/);
            await expectError('An invalid report saves no photo', () => lostfound.create(user, { ...missing }, { buffer: png }), 400, /gender/i);
            check('No orphan photos after refused reports', (await Photo.countDocuments({ uploadedBy: me._id })) === before);
        }
        const publicView = await lostfound.list(null, { kind: 'MISSING' });
        const shown = publicView.find((r) => String(r._id) === String(rep._id));
        check('Phone numbers are hidden from the public bulletin', shown && !shown.contactPhone && !shown.personPhone);

        // ---- 12. Team notes round 2: limit of 5, group passes, one QR, other yatras ----
        const transit = require('../modules/transit/transit.service');
        const Provider = require('../modules/provider/provider.model');
        const { MAX_PER_ACCOUNT } = require('../utils/limits');
        check('Booking limit is 5 per account everywhere', MAX_PER_ACCOUNT === 5 && lodging.MAX_BEDS_PER_USER === 5 && food.MAX_PEOPLE_PER_TOKEN === 5);
        const groupEv = await events.create({ ...base, title: 'Flow test group darshan', ticketPrice: 0, capacity: 7 }, host);
        groupIds.push(groupEv._id);
        await expectError('6 tickets on one account are refused', () => events.register(groupEv._id, user, { people: 6 }), 400, /1 to 5/);
        const grp = await events.register(groupEv._id, user, { people: 5 });
        const groupAfter = await Event.findById(groupEv._id).lean();
        check('5 tickets on one pass take 5 places', grp.pass.details.people === 5 && groupAfter.attendeesCount === 5, grp.message);
        await expectError('A 6th ticket in a second booking is refused', () => events.register(groupEv._id, user, { people: 1 }), 409, /already have 5 tickets/);
        const splitEv = await events.create({ ...base, title: 'Flow test split booking', ticketPrice: 0, capacity: 20 }, host);
        groupIds.push(splitEv._id);
        const s1 = await events.register(splitEv._id, user, { people: 2 });
        const s2 = await events.register(splitEv._id, user, { people: 3 });
        check('One account can book in two goes (2 + 3 tickets)', s1.pass.details.people === 2 && s2.pass.details.people === 3);
        const count = await events.myTicketCount(splitEv._id, user);
        check('My-tickets count shows 5 held, 0 left', count.held === 5 && count.left === 0, JSON.stringify(count));
        await expectError('More than 5 across bookings is refused', () => events.register(splitEv._id, user, { people: 1 }), 409, /already have 5/);
        await Pass.updateOne({ _id: s1.pass.id || s1.pass._id }, { status: 'CANCELLED' });
        const again = await events.register(splitEv._id, user, { people: 2 });
        check('Cancelled tickets free up the account limit', again.pass.details.people === 2);
        const pilgrim2 = await User.findOne({ phone: '9000000007' }).lean();
        await expectError('A group bigger than the places left is refused', () => events.register(groupEv._id, { ...pilgrim2, id: String(pilgrim2._id) }, { people: 3 }), 409, /Not enough places/);
        const freeBus = await TransitRoute.findOne({ kind: 'SHUTTLE', fare: 0, name: 'E-Shuttle S1' }).lean();
        await Pass.deleteMany({ userId: me._id, type: 'TRANSIT' });
        const groupBus = await transit.boardingPass(freeBus._id, user, { people: 4 });
        check('One bus pass covers 4 people', groupBus.pass.details.people === 4, groupBus.message);
        await expectError('A bus pass for 6 is refused', () => transit.quote(freeBus._id, 6), 400, /1 to 5/);
        // Cancelled pass: the personal QR now says so instead of "no pass"
        await passes.cancelPass(groupBus.pass._id);
        const { qr: qr2 } = await passes.myQr(user);
        const rc = await passes.scan(qr2, scanner, { service: 'TRANSIT' });
        check('Personal QR shows a cancelled bus pass as cancelled', rc.result === 'REJECTED' && rc.reason === 'CANCELLED' && rc.personal === true, rc.message);
        // Other yatras now have services
        const wariEv = await Event.findOne({ slug: 'pandharpur-ashadhi-wari-2027' }).lean();
        const rathEv = await Event.findOne({ slug: 'jagannath-rath-yatra-2027' }).lean();
        const counts = async (ev) => [await Lodging.countDocuments({ eventId: ev._id }), await FoodSlot.countDocuments({ eventId: ev._id }), await TransitRoute.countDocuments({ eventId: ev._id })];
        const [wl, wf, wt] = await counts(wariEv);
        const [rl, rf, rt] = await counts(rathEv);
        check('Wari has camps, meal slots and shuttles', wl >= 3 && wf > 0 && wt >= 2, `${wl} camps, ${wf} slots, ${wt} routes`);
        check('Rath Yatra has camps, meal slots and shuttles', rl >= 3 && rf > 0 && rt >= 2, `${rl} camps, ${rf} slots, ${rt} routes`);
        check('Wari and Rath Yatra have key dates and tips', wariEv.keyDates?.length >= 4 && rathEv.keyDates?.length >= 4 && wariEv.tips?.length && rathEv.tips?.length);
        check('Ashadhi Ekadashi 2027 is on 14 July, Rath Yatra on 5 July', wariEv.keyDates.some((d) => /Ekadashi/.test(d.label) && d.date.toISOString().startsWith('2027-07-1')) && rathEv.keyDates.some((d) => /Rath Yatra/.test(d.label) && d.date.toISOString().startsWith('2027-07-05')));
        const [wariPubs, rathPubs] = await Promise.all([Event.countDocuments({ kind: 'PUBLIC', city: 'Pandharpur' }), Event.countDocuments({ kind: 'PUBLIC', city: 'Puri' })]);
        check('Wari and Rath Yatra have their own public events', wariPubs >= 2 && rathPubs >= 2, `${wariPubs} in Pandharpur, ${rathPubs} in Puri`);
        const wariCamp = await Lodging.findOne({ eventId: wariEv._id, pricePerNight: 0 }).lean();
        const wariBook = await lodging.book(wariCamp._id, user, { beds: 2 });
        check('A Wari camp can be booked (from the yatra start date)', wariBook.booking?.checkIn >= '2027-06-25', `${wariCamp.name}, check-in ${wariBook.booking?.checkIn}`);
        check('Vivekananda Kendra is a verified seva organisation', !!(await Provider.exists({ name: 'Vivekananda Kendra', verificationStatus: 'VERIFIED' })));

        // ---- 13. Cancellation and refunds from the passbook ----
        const cancellation = require('../modules/pass/cancel.service');
        const H = 3600e3;
        const startAt = new Date(Date.now() + 100 * H);
        const r50 = cancellation.refundFor(startAt, 400, new Date(startAt - 50 * H));
        const r30 = cancellation.refundFor(startAt, 400, new Date(startAt - 30 * H));
        const r10 = cancellation.refundFor(startAt, 400, new Date(startAt - 10 * H));
        check('Refund policy: 100% at 48 h+, 50% at 24-48 h, 0% under 24 h', r50.amount === 400 && r30.amount === 200 && r10.amount === 0, `${r50.amount} / ${r30.amount} / ${r10.amount}`);

        const cEv = await events.create({ ...base, title: 'Flow test cancellation', ticketPrice: 0, capacity: 10, startDate: startAt, endDate: new Date(startAt.getTime() + 2 * H) }, host);
        groupIds.push(cEv._id);
        const freeTix = await events.register(cEv._id, user, { people: 3 });
        const freeQuote = await cancellation.quote(freeTix.pass._id, user);
        check('Free ticket: quote says cancellable with no money involved', freeQuote.cancellable && freeQuote.paid === 0 && freeQuote.refund === 0);
        await cancellation.cancel(freeTix.pass._id, user);
        const cEvAfter = await Event.findById(cEv._id).lean();
        const freePass = await Pass.findById(freeTix.pass._id).lean();
        check('Cancelling free tickets gives the 3 places back', cEvAfter.attendeesCount === 0 && freePass.status === 'CANCELLED' && !!freePass.cancelledAt);
        await expectError('A cancelled pass cannot be cancelled again', () => cancellation.cancel(freeTix.pass._id, user), 400, /already cancelled/);

        const paidTix = await events.register(cEv._id, user, { people: 2, paidByOrder: { _id: new mongoose.Types.ObjectId(), amount: 300 } });
        check('Event tickets are valid from 1 hour before the start', Math.round((startAt - new Date(paidTix.pass.validFrom)) / 60000) === 60);
        const paidQuote = await cancellation.quote(paidTix.pass._id, user, new Date(startAt - 30 * H));
        check('Paid ticket 30 h before: quote shows 50% back (₹150 of ₹300)', paidQuote.percent === 50 && paidQuote.refund === 150 && paidQuote.charge === 150, `${paidQuote.percent}% ₹${paidQuote.refund}`);
        const paidCancel = await cancellation.cancel(paidTix.pass._id, user, new Date(startAt - 30 * H));
        check('Cancelling records the refund on the pass', paidCancel.refund === 150 && paidCancel.pass.refund?.amount === 150, paidCancel.message);
        const late = await events.register(cEv._id, user, { people: 1 });
        await expectError('A ticket cannot be cancelled after the event starts', () => cancellation.cancel(late.pass._id, user, new Date(startAt.getTime() + 60000)), 400, /already started/);

        const wariStay = { checkIn: wariBook.booking.checkIn, checkOut: wariBook.booking.checkOut };
        const nightsLib = require('../modules/lodging/nights');
        const [wariBefore] = await nightsLib.attachAvailability([await Lodging.findById(wariCamp._id).lean()], wariStay);
        await cancellation.cancel(wariBook.pass._id, user);
        const [wariAfter] = await nightsLib.attachAvailability([await Lodging.findById(wariCamp._id).lean()], wariStay);
        check('Cancelling a stay from the passbook gives the 2 beds back', wariAfter.availableBeds === wariBefore.availableBeds + 2);

        // ---- Shuttle seats: a day's passes stop at the route's capacity ----
        {
            const transitSvc = require('../modules/transit/transit.service');
            const small = await TransitRoute.create({ eventId: wariEv._id, name: 'Flow test shuttle', kind: 'SHUTTLE', origin: 'A', destination: 'B', fare: 0, seatsPerDay: 3, frequencyMins: 30, firstDeparture: '06:00', lastDeparture: '07:00' });
            try {
                await expectError('A group bigger than the seats left is refused', () => transitSvc.boardingPass(small._id, user, { people: 4 }), 409, /seat/i);
                const bp = await transitSvc.boardingPass(small._id, user, { people: 3 });
                const listed = (await transitSvc.list(String(wariEv._id))).find((r) => String(r._id) === String(small._id));
                check('Shuttle seats are counted per day (3 of 3 taken)', bp.pass.details.people === 3 && listed.seatsLeft === 0, `${listed.seatsLeft} left`);
                await cancellation.cancel(bp.pass._id, user);
                const relisted = (await transitSvc.list(String(wariEv._id))).find((r) => String(r._id) === String(small._id));
                check('Cancelling a bus pass puts its seats back on sale', relisted.seatsLeft === 3, `${relisted.seatsLeft} left`);
            } finally {
                await Promise.all([TransitRoute.deleteOne({ _id: small._id }), TransitRoute.TransitDay.deleteMany({ routeId: small._id }), Pass.deleteMany({ refId: small._id })]);
            }
        }

        const futureSlot = await FoodSlot.findOne({ eventId: wariEv._id, remaining: { $gte: 2 } }).sort({ date: -1 }).lean();
        if (futureSlot) {
            const tok = await food.claim(futureSlot._id, user, { people: 2, names: 'Aai, Baba' });
            await cancellation.cancel(tok.pass._id, user);
            const slotAfter = await FoodSlot.findById(futureSlot._id).lean();
            check('Cancelling a meal token gives the 2 plates back', slotAfter.remaining === futureSlot.remaining, `${slotAfter.remaining} left`);
        }
        const passbook = await passes.listMine(user._id);
        check('Cancelled passes stay in the passbook with their refund', passbook.some((p) => String(p._id) === String(paidTix.pass._id) && p.state === 'CANCELLED' && p.refund?.amount === 150));
        const volunteerish = await Pass.findOne({ type: { $in: ['CORPORATE', 'VOLUNTEER'] } }).lean();
        if (volunteerish) {
            const owner = { _id: volunteerish.userId, name: 'Owner' };
            const vq = await cancellation.quote(volunteerish._id, owner);
            check('Badges and volunteer IDs cannot be cancelled from the passbook', !vq.cancellable);
        }

        check('Only the control room can mark lanes', hasPermission('AUTHORITY', 'route:manage') && !hasPermission('VOLUNTEER', 'route:manage') && !hasPermission('USER', 'route:manage'));
    } finally {
        if (savedLanes) {
            const { LaneStatus } = require('../modules/route/lane.model');
            await LaneStatus.deleteMany({ eventId: savedLanes.eventId });
            if (savedLanes.rows.length) await LaneStatus.insertMany(savedLanes.rows);
        }
        if (me) {
            const myBookings = await LodgingBooking.find({ userId: me._id, status: 'CONFIRMED' }).lean();
            for (const bk of myBookings) await lodging.cancel(bk._id, { ...me });
            const mealPasses = await Pass.find({ userId: me._id, type: 'MEAL' }).lean();
            for (const p of mealPasses) await FoodSlot.updateOne({ _id: p.refId }, { $inc: { remaining: p.details?.people || 1 } });
            await Promise.all([Pass.deleteMany({ userId: me._id }), Order.deleteMany({ userId: me._id }), LodgingBooking.deleteMany({ userId: me._id }), require('../modules/lostfound/lostfound.model').deleteMany({ reportedBy: me._id }), require('../modules/lostfound/photo.model').Photo.deleteMany({ uploadedBy: me._id })]);
            await User.deleteOne({ _id: me._id });
        }
        for (const id of groupIds) {
            await Pass.deleteMany({ eventId: id });
            await Event.deleteOne({ _id: id });
        }
        if (freeId) {
            await Pass.deleteMany({ eventId: freeId });
            await Event.deleteOne({ _id: freeId });
        }
        if (hostedId) {
            await Pass.deleteMany({ eventId: hostedId });
            await Event.deleteOne({ _id: hostedId });
        }
        await mongoose.disconnect();
        console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed. Test data cleaned up.');
        process.exitCode = failed ? 1 : 0;
    }
}

main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
});
