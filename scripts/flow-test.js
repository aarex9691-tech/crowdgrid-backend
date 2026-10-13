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

        // ---- 6. One personal QR ----
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
