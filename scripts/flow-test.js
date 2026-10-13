/**
 * End-to-end check of the new features against your real database.
 *   npm run test:flows
 *
 * Run it right AFTER `npm run seed` (it uses the seeded camps, kitchens and
 * buses). It creates its own test pilgrim and deletes everything it made.
 */
require('dotenv').config();
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
const expectError = async (name, fn, status) => {
    try {
        await fn();
        check(name, false, 'no error');
    } catch (err) {
        check(name, !status || err.status === status, `${err.status} ${err.message}`);
    }
};

async function main() {
    await mongoose.connect(process.env.MONGO_URI);
    await detectTransactionSupport();
    const PHONE = '6999999990';
    await User.deleteMany({ phone: PHONE });
    let me;
    let hostedId;
    let freeId;
    try {
        // ---- 1. Phone numbers ----
        await expectError('Register rejects a 12-digit Indian number', () => auth.register({ name: 'T', phone: '900000000612', password: 'Crowd@123' }), 400);
        await expectError('Register rejects a 5-digit number', () => auth.register({ name: 'T', phone: '90000', password: 'Crowd@123' }), 400);
        const reg = await auth.register({ name: 'Flow Test Pilgrim', phone: PHONE, countryCode: '91', password: 'Crowd@123' });
        me = await User.findById(reg.user._id).lean();
        check('Register with +91 works', !!me && me.countryCode === '91');
        const l1 = await auth.login({ identifier: PHONE, password: 'Crowd@123' });
        const l2 = await auth.login({ identifier: `+91 ${PHONE.slice(0, 5)} ${PHONE.slice(5)}`, password: 'Crowd@123' });
        check('Login with 10 digits and with +91 format', !!l1.token && !!l2.token);
        const demo = await auth.login({ identifier: '9000000006', password: 'Crowd@123' });
        check('Demo pilgrim 9000000006 can still log in', !!demo.token);

        const event = await Event.findOne({ isFlagship: true }).lean();
        const user = { ...me, id: String(me._id) };

        // ---- 2. Free camp gets tent + bed numbers ----
        const freeCamp = await Lodging.findOne({ eventId: event._id, pricePerNight: 0, availableBeds: { $gte: 2 } }).lean();
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

        // ---- 3. Paid camp must go through checkout ----
        const paidCamp = await Lodging.findOne({ eventId: event._id, pricePerNight: { $gt: 0 }, availableBeds: { $gte: 2 } }).lean();
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
    } finally {
        if (me) {
            const myBookings = await LodgingBooking.find({ userId: me._id, status: 'CONFIRMED' }).lean();
            for (const bk of myBookings) await lodging.cancel(bk._id, { ...me });
            const mealPasses = await Pass.find({ userId: me._id, type: 'MEAL' }).lean();
            for (const p of mealPasses) await FoodSlot.updateOne({ _id: p.refId }, { $inc: { remaining: p.details?.people || 1 } });
            await Promise.all([Pass.deleteMany({ userId: me._id }), Order.deleteMany({ userId: me._id }), LodgingBooking.deleteMany({ userId: me._id })]);
            await User.deleteOne({ _id: me._id });
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
