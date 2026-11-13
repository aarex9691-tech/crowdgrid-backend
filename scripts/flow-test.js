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
const { FoodSlot, FoodCenter } = require('../modules/food/food.model');
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
    await require('../utils/dns').connectMongo(mongoose, require('./test-db').testDbUri());
    await detectTransactionSupport();
    const PHONE = '6999999990';
    const PHONE_NO_CODE = '6999999991';
    await User.deleteMany({ phone: { $in: [PHONE, PHONE_NO_CODE] } });
    const { OtpCode } = require('../modules/auth/otp');
    await OtpCode.deleteMany({ phone: PHONE });
    let me;
    let savedLanes; // lane statuses before the route checks, put back afterwards
    let hostedId;
    let freeId;
    const groupIds = []; // events created by the group-ticket checks
    let finished = false; // false if a step threw before the end
    try {
        // ---- 1. Phone numbers ----
        await expectError('Register rejects a 12-digit Indian number', () => auth.register({ name: 'Test Pilgrim', phone: '900000000612', password: 'Crowd@123' }), 400, /mobile number/i);
        await expectError('Register rejects a 5-digit number', () => auth.register({ name: 'Test Pilgrim', phone: '90000', password: 'Crowd@123' }), 400, /mobile number/i);
        // By default sign-up needs no code (the screen has no code step)
        const savedOtpSetting = process.env.OTP_REQUIRED;
        delete process.env.OTP_REQUIRED;
        // Registration is by mobile number only: an email sent with the sign-up is not stored
        const plain = await auth.register({ name: 'Flow Test Pilgrim Two', phone: PHONE_NO_CODE, countryCode: '91', password: 'Crowd@123', email: 'signup.only@example.com' });
        check('Sign-up is by mobile number only (an email in the sign-up is not saved)', !(await User.findOne({ phone: PHONE_NO_CODE }).lean())?.email && !(await User.exists({ email: 'signup.only@example.com' })));
        check('Sign-up works without a code (OTP is off by default)', !!plain.token && plain.user.role === 'USER');
        await User.deleteOne({ phone: PHONE_NO_CODE });

        // With OTP_REQUIRED=true, sign-up needs the one-time code sent to the number (simulated SMS returns it)
        process.env.OTP_REQUIRED = 'true';
        await expectError('Sign-up without the SMS code is refused', () => auth.register({ name: 'Flow Test Pilgrim', phone: PHONE, countryCode: '91', password: 'Crowd@123' }), 400, /6-digit code/);
        const sent = await auth.requestOtp({ phone: PHONE, countryCode: '91' });
        check('A 6-digit code is issued for sign-up (simulated SMS)', /^\d{6}$/.test(sent.devCode || ''));
        const wrong = sent.devCode === '000000' ? '111111' : '000000';
        await expectError('A wrong code is refused', () => auth.register({ name: 'Flow Test Pilgrim', phone: PHONE, countryCode: '91', password: 'Crowd@123', otp: wrong }), 400, /not right/);
        const reg = await auth.register({ name: 'Flow Test Pilgrim', phone: PHONE, countryCode: '91', password: 'Crowd@123', otp: sent.devCode });
        check('The code works once only', (await OtpCode.countDocuments({ phone: PHONE, usedAt: { $ne: null } })) === 1);
        if (savedOtpSetting === undefined) delete process.env.OTP_REQUIRED;
        else process.env.OTP_REQUIRED = savedOtpSetting;
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
        const b = await lodging.book(freeCamp._id, user, { beds: 2, guestNames: ['Asha Patil', 'Ravi Patil'] });
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
        const five = await lodging.book(bigCamp._id, user, { beds: 5, guestNames: ['Asha Patil', 'Ravi Patil', 'Meena Patil', 'Om Patil', 'Gita Patil'] });
        check('Booking 5 beds (the limit) works', five.booking.beds === 5 && five.pass.details.bedNumbers.length === 5, five.pass.details.location);
        await expectError('A 6th bed on the same night is refused', () => lodging.book(bigCamp._id, user, { beds: 1 }), 400, /limit/i);
        {
            // Regression: the cart must refuse it too, before the pilgrim pays (not book-then-refund)
            const anyPaid = camps.find((c) => c.pricePerNight > 0);
            {
                // Regression: two camp items in one cart (3 + 3 beds on the same night) must not each pass on their own
                const { addDays } = require('../utils/time');
                const night3 = addDays(five.booking.checkIn, 3);
                const three = ['Kiran Patil', 'Sona Patil', 'Raju Patil'];
                await expectError('One cart cannot hold more than 5 beds for the same night', () => orders.create(user, [
                    { kind: 'LODGING', refId: String(anyPaid._id), input: { beds: 3, guestNames: three, checkIn: night3, checkOut: night3 } },
                    { kind: 'LODGING', refId: String(anyPaid._id), input: { beds: 3, guestNames: three, checkIn: night3, checkOut: night3 } },
                ]), 400, /limit/i);
            }
            await expectError('The cart refuses a 6th bed on the same night before payment', () => orders.create(user, [{ kind: 'LODGING', refId: String(anyPaid._id), input: { beds: 1, guestNames: ['Kiran Patil'], checkIn: five.booking.checkIn, checkOut: five.booking.checkIn } }]), 400, /limit/i);
        }

        {
            // Regression: a database error part-way through claiming nights must give back the nights already claimed
            const pn = require('../modules/lodging/personNights');
            const ghostUser = new mongoose.Types.ObjectId();
            const ghostEvent = new mongoose.Types.ObjectId();
            const realFind = pn.PersonNight.findOneAndUpdate;
            let calls = 0;
            pn.PersonNight.findOneAndUpdate = function (...args) {
                calls += 1;
                if (calls === 2) throw new Error('connection reset');
                return realFind.apply(this, args);
            };
            const claimErr = await pn.claim(ghostUser, ghostEvent, ['2030-01-01', '2030-01-02'], 2, 5).catch((e) => e);
            pn.PersonNight.findOneAndUpdate = realFind;
            const leftRows = await pn.PersonNight.find({ userId: ghostUser }).lean();
            check('A failed claim gives back the nights it already took', claimErr?.message === 'connection reset' && leftRows.every((r) => r.beds === 0), leftRows.map((r) => `${r.date}:${r.beds}`).join(', '));
            await pn.PersonNight.deleteMany({ userId: ghostUser });
        }

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
            if (addDays(night, 6) <= lastDay) {
                await expectError('Stays longer than 5 nights are refused', () => lodging.book(bigCamp._id, user, { beds: 1, checkIn: night, checkOut: addDays(night, 6) }), 400, /5 nights/);
            }
        }
        await lodging.cancel(five.booking._id, user);

        // ---- 2c. Pilgrims choose their own tent and beds (5 people per tent) ----
        {
            const { addDays } = require('../utils/time');
            const night = addDays(five.booking.checkIn, 2);
            const map = await lodging.stayMap(String(bigCamp._id), { checkIn: night, checkOut: night });
            check('Stay map shows tents of 5 beds', map.unit.size === 5 && map.units.every((u) => u.beds.length <= 5), `${map.units.length} ${map.unit.label.toLowerCase()}s`);
            const tent = map.units.find((u) => u.free >= 2);
            const pick = tent.beds.filter((b) => b.free).slice(0, 2).map((b) => b.bedNo);
            const mine = await lodging.book(bigCamp._id, user, { beds: 2, bedNos: pick, guestNames: ['Asha Patil', 'Ravi Patil'], checkIn: night, checkOut: night }, { requireNames: true });
            check('The chosen beds are exactly the ones booked', mine.booking.bedNos.join() === [...pick].sort((a, b) => a - b).join(), mine.booking.bedLabel);
            const after = await lodging.stayMap(String(bigCamp._id), { checkIn: night, checkOut: night });
            check('Chosen beds now show as taken on the map', pick.every((n) => after.units.flatMap((u) => u.beds).find((b) => b.bedNo === n).free === false));
            const other = await User.findOne({ phone: '9000000007' }).lean();
            await expectError('Someone else choosing the same bed that night is refused', () => lodging.book(bigCamp._id, { ...other, id: String(other._id) }, { beds: 1, bedNos: [pick[0]], guestNames: ['Sunita D'], checkIn: night, checkOut: night }), 409, /just taken|already taken/);
            const nextNight = addDays(night, 1);
            const sameBedNext = await lodging.book(bigCamp._id, { ...other, id: String(other._id) }, { beds: 1, bedNos: [pick[0]], guestNames: ['Sunita D'], checkIn: nextNight, checkOut: nextNight });
            check('The same bed can be chosen for the next night', sameBedNext.booking.bedNos[0] === pick[0]);
            await expectError('Booking from the app needs a name for every person', () => lodging.book(bigCamp._id, user, { beds: 2, guestNames: ['Only One'], checkIn: night, checkOut: night }, { requireNames: true }), 400, /name of each person/);
            await expectError('Choosing a bed number that does not exist is refused', () => lodging.book(bigCamp._id, user, { beds: 1, bedNos: [999999], guestNames: ['X Y'], checkIn: night, checkOut: night }), 400, /different bed/);
            await lodging.cancel(mine.booking._id, user);
            await lodging.cancel(sameBedNext.booking._id, { ...other, id: String(other._id) });
        }

        // ---- 3. Paid camp must go through checkout ----
        const paidCamp = camps.find((c) => c.pricePerNight > 0 && c.availableBeds >= 2);
        await expectError('Direct booking of a paid camp asks for payment', () => lodging.book(paidCamp._id, user, { beds: 1 }), 402);

        // Regression: if a step AFTER the booking is saved fails (e.g. the database drops while re-reading
        // availability), the confirmed booking must keep its beds and its night count.
        {
            const nights = require('../modules/lodging/nights');
            const night2 = require('../utils/time').addDays(five.booking.checkIn, 5);
            const realAttach = nights.attachAvailability;
            nights.attachAvailability = async () => {
                throw new Error('connection reset');
            };
            let kept;
            try {
                kept = await lodging.book(bigCamp._id, user, { beds: 1, guestNames: ['Kiran Patil'], checkIn: night2, checkOut: night2 });
            } catch {
                kept = null;
            } finally {
                nights.attachAvailability = realAttach;
            }
            const keptBooking = await LodgingBooking.findOne({ userId: me._id, lodgingId: bigCamp._id, checkIn: night2, guestNames: 'Kiran Patil' }).lean();
            const keptBeds = keptBooking ? await BedAssignment.countDocuments({ bookingId: keptBooking._id }) : 0;
            check('A confirmed booking keeps its bed when a later step fails', !!keptBooking && keptBooking.status === 'CONFIRMED' && keptBeds === 1, kept ? 'booked' : 'error shown');
            if (keptBooking) await lodging.cancel(keptBooking._id, user);
        }

        // ---- 4. Order + simulated payment ----
        const bus = await TransitRoute.findOne({ eventId: event._id, fare: { $gt: 0 } }).lean();
        const order = await orders.create(user, [
            { kind: 'LODGING', refId: String(paidCamp._id), input: { beds: 2, guestNames: ['Asha Patil', 'Ravi Patil'] } },
            { kind: 'TRANSIT', refId: String(bus._id) },
        ]);
        check('Order priced on the server', order.total === paidCamp.pricePerNight * 2 + bus.fare, `total ₹${order.total}`);
        await expectError('UPI fail@upi is declined', () => orders.pay(order._id, user, { method: 'UPI', upiId: 'fail@upi' }), 402);
        const paid = await orders.pay(order._id, user, { method: 'UPI', upiId: 'flow@okaxis' });
        check('Payment approved and both passes issued', paid.status === 'PAID' && paid.passes.length === 2, paid.payment?.reference);
        await expectError('Paying the same order twice is refused', () => orders.pay(order._id, user, { method: 'UPI', upiId: 'flow@okaxis' }), 409);

        // ---- 4b. Unpaid orders expire; interrupted payments recover ----
        {
            const lapsed = await orders.create(user, [{ kind: 'TRANSIT', refId: String(bus._id) }]);
            await Order.updateOne({ _id: lapsed._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
            await expectError('An order left unpaid for 15 minutes cannot be paid', () => orders.pay(lapsed._id, user, { method: 'UPI', upiId: 'flow@okaxis' }), 410, /expired/i);
            check('The expired order is marked cancelled', (await Order.findById(lapsed._id).lean()).status === 'CANCELLED');
            const stuck = await orders.create(user, [{ kind: 'TRANSIT', refId: String(bus._id) }]);
            await Order.updateOne({ _id: stuck._id }, { $set: { status: 'PROCESSING', processingAt: new Date(Date.now() - 10 * 60000) } });
            const swept = await orders.sweep();
            check('A payment stuck for 5+ minutes goes back to "unpaid" so it can be retried', (await Order.findById(stuck._id).lean()).status === 'PENDING' && swept.unstuck >= 1);
            await orders.cancel(stuck._id, user);

            // Regression: the charge succeeded but the refund for an item that could not be issued failed.
            // The order must stay PAID (so it can never be paid again), with the refund recorded as pending.
            const pg = require('../modules/order/payment').gateway();
            const realRefund = pg.refund;
            const dup = await orders.create(user, [{ kind: 'TRANSIT', refId: String(bus._id) }]); // user already holds today's bus pass, so this item fails
            pg.refund = async () => {
                throw new Error('gateway unreachable');
            };
            try {
                await orders.pay(dup._id, user, { method: 'UPI', upiId: 'flow@okaxis' });
            } catch {
                /* checked below */
            } finally {
                pg.refund = realRefund;
            }
            const dupQueued = await Order.findById(dup._id).lean();
            check('The failed refund is recorded so it can be retried', dupQueued.payment?.refundPending === true && dupQueued.refunded === bus.fare && dupQueued.payment?.refundPendingAmount === bus.fare, `owed ${dupQueued.payment?.refundPendingAmount}`);
            await orders.sweep(new Date(Date.now() + 30 * 60000)); // an old enough "stuck" order would be reset here
            const dupAfter = await Order.findById(dup._id).lean();
            check('A paid order stays paid when its refund fails (it can never be charged twice)', dupAfter.status === 'PAID' && !!dupAfter.payment?.paidAt, dupAfter.status);

            // Regression: the server stopped right after saving PAID, before issuing the pass. The sweep finishes it.
            {
                const halfDone = await orders.create(user, [{ kind: 'LODGING', refId: String(paidCamp._id), input: { beds: 1, guestNames: ['Kiran Patil'] } }]);
                await Order.updateOne(
                    { _id: halfDone._id },
                    { $set: { status: 'PAID', payment: { provider: 'SIMULATED', method: 'UPI', reference: 'SIMTESTCRASH', paidAt: new Date(Date.now() - 10 * 60000) } } }
                );
                const swept2 = await orders.sweep();
                const finishedOrder = await Order.findById(halfDone._id).lean();
                check('A paid order left without its pass (server stopped) is finished by the sweep', finishedOrder.items[0].status === 'ISSUED' && !!finishedOrder.items[0].passId && swept2.finished >= 1, finishedOrder.items[0].status);
                if (finishedOrder.items[0].passId) await require('../modules/pass/cancel.service').cancel(finishedOrder.items[0].passId, user).catch(() => {});
            }
            // Regression: another pass of the same order was cancelled and refunded on its own meanwhile.
            // The order retry must send only the refund it still owes, not that pass's money a second time.
            await Order.updateOne({ _id: dup._id }, { $inc: { refunded: 77 }, $set: { 'payment.refundPending': true, 'payment.refundPendingAmount': bus.fare, 'payment.refundKey': dupQueued.payment?.refundKey }, $unset: { 'payment.refundReference': 1 } });
            const sentAmounts = [];
            const sentKeys = [];
            pg.refund = async (args) => {
                sentAmounts.push(args.amount);
                sentKeys.push(args.idempotencyKey);
                return realRefund.call(pg, args);
            };
            try {
                await orders.sweep();
            } finally {
                pg.refund = realRefund;
            }
            const dupRetried = await Order.findById(dup._id).lean();
            check('The queued order refund is sent by the sweep', !dupRetried.payment?.refundPending && !!dupRetried.payment?.refundReference);
            check("The order retry sends only what it still owes (never another pass's refund again)", sentAmounts.includes(bus.fare) && !sentAmounts.includes(bus.fare + 77), `sent ${sentAmounts.join(', ')}`);
            check('The retry uses the same refund key as the first attempt (the gateway can spot a repeat)', !!dupQueued.payment?.refundKey && sentKeys.includes(dupQueued.payment.refundKey), `${dupQueued.payment?.refundKey} vs ${sentKeys.join(', ')}`);
        }

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

            // Regression: a corporate check-in desk must not be able to use up a pilgrim's meal token
            const corpDesk = await User.findOne({ phone: '9000000004' }).lean();
            const corpScan = await passes.scan(m.pass.qr, { ...corpDesk, id: String(corpDesk._id) });
            check('A corporate desk cannot redeem a pilgrim\'s meal token', corpScan.result === 'REJECTED' && corpScan.reason === 'WRONG_SERVICE' && (await Pass.findById(m.pass._id).lean()).status === 'ACTIVE', corpScan.reason);

            // Regression: a closed kitchen hands out no tokens, and no plate is lost trying
            const other = slots.find((s2) => String(s2._id) !== String(slot._id) && String(s2.foodCenterId) !== String(slot.foodCenterId) && s2.meal !== slot.meal);
            if (other) {
                await FoodCenter.updateOne({ _id: other.foodCenterId }, { $set: { isActive: false } });
                try {
                    const before = (await FoodSlot.findById(other._id).lean()).remaining;
                    await expectError('A closed kitchen hands out no meal tokens', () => food.claim(other._id, user, { people: 1 }), 404, /kitchen/i);
                    check('No plate is lost when a closed kitchen refuses a token', (await FoodSlot.findById(other._id).lean()).remaining === before);
                } finally {
                    await FoodCenter.updateOne({ _id: other.foodCenterId }, { $set: { isActive: true } });
                }
            } else {
                console.log('SKIP  closed-kitchen check (needs a second kitchen with a different meal open today)');
            }
        } else {
            console.log('SKIP  family meal token (all of today\'s meal windows are over; run before 10 pm)');
        }

        // ---- 6. Profile ----
        const prof = await auth.updateProfile(user, { email: 'flow.test@example.com', dateOfBirth: '1990-05-14', gender: 'female', city: 'Pune', emergencyContact: { name: 'Raj', phone: '9876543210' } });
        check('Profile saves email, date of birth, gender, city, emergency contact', prof.email === 'flow.test@example.com' && prof.gender === 'FEMALE' && prof.city === 'Pune' && !!prof.dateOfBirth && prof.emergencyContact?.phone === '9876543210');
        {
            // Log in with the email added in the profile (any capitals, spaces around it)
            const byMail = await auth.login({ identifier: '  Flow.Test@Example.COM ', password: 'Crowd@123', ip: '192.0.2.60' }).catch((e) => e);
            check('A pilgrim can log in with the email in their profile', String(byMail.user?._id || byMail.user?.id) === String(me._id), byMail.message);
            const wrongPw = await auth.login({ identifier: 'flow.test@example.com', password: 'Wrong-0000', ip: '192.0.2.61' }).catch((e) => e);
            const noSuch = await auth.login({ identifier: 'nobody.here@example.com', password: 'Crowd@123', ip: '192.0.2.61' }).catch((e) => e);
            check('A wrong password and an unknown email get the same answer (no hint which emails exist)', wrongPw.status === 401 && noSuch.status === 401 && wrongPw.message === noSuch.message, `${wrongPw.message} / ${noSuch.message}`);
            check('The login error mentions email too', /email/i.test(noSuch.message || ''), noSuch.message);
            await expectError('Another account cannot take an email that is already used', async () => {
                const ramesh = await User.findOne({ phone: '9000000006' }).lean();
                return auth.updateProfile({ ...ramesh, id: String(ramesh._id) }, { email: 'FLOW.TEST@example.com' });
            }, 409);
            await auth.login({ identifier: PHONE, password: 'Crowd@123', ip: '192.0.2.61' }); // clears the wrong-password count
            // The lockout must not tell real accounts from made-up ones: both are paused after 5 wrong tries
            const ghostIp = '198.51.100.77';
            await auth.LoginGuard.deleteMany({ client: ghostIp });
            let ghostLast;
            for (let i = 0; i < 6; i += 1) ghostLast = await auth.login({ identifier: 'nobody.ghost@example.com', password: 'Wrong-0000', ip: ghostIp }).catch((e) => e);
            check('An email with no account is paused after 5 tries too (the lockout reveals nothing)', ghostLast.status === 429 && /this device/.test(ghostLast.message), `${ghostLast.status} ${ghostLast.message}`);
            await auth.LoginGuard.deleteMany({ client: ghostIp });
            // Changing the profile email is limited, so it cannot be used to test which emails are registered
            let limited = null;
            let changes = 0;
            for (let i = 0; i < 7 && !limited; i += 1) {
                try {
                    await auth.updateProfile(user, { email: `flow.test+${i}@example.com` });
                    changes += 1;
                } catch (e) {
                    limited = e;
                }
            }
            check('The profile email can be changed at most 5 times a day', limited?.status === 429 && changes === 4, `${changes} more changes, then ${limited?.status} ${limited?.message}`);
            const tooLong = await auth.login({ identifier: PHONE, password: 'x'.repeat(5000), ip: '192.0.2.62' }).catch((e) => e);
            check('A very long password is just a wrong password (no slow hashing of huge input)', tooLong.status === 401, `${tooLong.status}`);
            await auth.login({ identifier: PHONE, password: 'Crowd@123', ip: '192.0.2.62' });
        }
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
        // Public event categories: the full list is offered, older ones are no longer accepted for new events
        const music = await events.create({ ...base, title: 'Flow test concert', category: 'music', ticketPrice: 99 }, host);
        check('A host can list a Music & concerts event', music.category === 'MUSIC');
        await Event.deleteOne({ _id: music._id });
        await expectError('An unknown category is refused', () => events.create({ ...base, ticketPrice: 99, category: 'PARTY' }, host), 400, /category/i);
        await expectError('The old "Cultural" category is not offered for new events', () => events.create({ ...base, ticketPrice: 99, category: 'CULTURAL' }, host), 400, /category/i);
        const { EVENT_CATEGORIES } = require('../utils/eventCategories');
        const seededCats = await Event.distinct('category', { kind: 'PUBLIC', status: 'ACTIVE' });
        const missingCats = EVENT_CATEGORIES.filter((c) => c !== 'OTHER' && !seededCats.includes(c));
        check('Every event category has at least one public event on', !missingCats.length, missingCats.length ? `missing: ${missingCats.join(', ')}` : `${seededCats.length} categories`);
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
        // Profile picture: checked, stored, replaced, shown to gate staff, removed
        const avatar = require('../modules/auth/avatar');
        // smallest valid JPEG header bytes (the server checks the real file type, not the name)
        const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1), Buffer.from([0xff, 0xd9])]);
        await expectError('A file that is not an image is refused as a profile photo', () => avatar.setPhoto(user, Buffer.from('this is not a picture at all, just text')), 400, /JPEG, PNG or WEBP/);
        await expectError('A profile photo over 1 MB is refused', () => avatar.setPhoto(user, Buffer.concat([jpeg, Buffer.alloc(avatar.MAX_BYTES)])), 400, /too large/);
        const p1 = await avatar.setPhoto(user, jpeg);
        const key1 = p1.photoUrl.split('/').pop();
        check('A profile photo is saved and has a private link', /^\/api\/auth\/photo\/[a-f0-9]{32}$/.test(p1.photoUrl) && !!(await avatar.find(key1)));
        const p2 = await avatar.setPhoto(user, jpeg);
        check('A new photo replaces the old one (old link stops working)', p2.photoUrl !== p1.photoUrl && !(await avatar.find(key1)) && (await avatar.Avatar.countDocuments({ userId: me._id })) === 1);
        check('The account shows the photo link', (await User.findById(me._id)).toPublic().photoUrl === p2.photoUrl);
        const { qr } = await passes.myQr(user);
        const staff = await User.findOne({ phone: '9000000002' }).lean(); // authority can scan everywhere
        const scanner = { ...staff, id: String(staff._id) };
        const r1 = await passes.scan(qr, scanner, { service: 'TRANSIT' });
        check('Personal QR at the bus gate redeems the bus pass', r1.result === 'VALID' && r1.pass?.type === 'TRANSIT', r1.message);
        check('Gate staff see the pilgrim\'s photo when they scan', r1.holder?.photoUrl === p2.photoUrl);
        await avatar.removePhoto(user);
        check('Removing the photo deletes it', !(await User.findById(me._id).lean()).photoKey && !(await avatar.Avatar.countDocuments({ userId: me._id })));
        const r2 = await passes.scan(qr, scanner, { service: 'TRANSIT' });
        check('Scanning again at the bus gate finds nothing left', r2.result === 'REJECTED', r2.message);
        await passes.myQr(user, { reset: true });
        const r3 = await passes.scan(qr, scanner, { service: 'LODGING' });
        check('Old personal QR stops working after reset', r3.result === 'REJECTED' && r3.reason === 'REVOKED');

        // Live personal QR: changes every 30 s, made on the phone from the key in /my-qr
        {
            const passToken = require('../utils/passToken');
            const mine = await passes.myQr(user);
            check('My QR also gives the phone a live key (30-second codes)', !!mine.live?.key && mine.live.periodS === 30);
            const w = passToken.currentWindow();
            const liveQr = `CGL.${mine.live.userId}.${w}.${passToken.liveCode(mine.live.key, w)}`;
            const lv = await passes.scan(liveQr, scanner, { service: 'LODGING' });
            check('A fresh live QR is accepted (finds or explains the pass)', !['FAKE', 'REVOKED', 'OLD_SCREENSHOT'].includes(lv.reason) && lv.personal === true, lv.message);
            const old = `CGL.${mine.live.userId}.${w - 5}.${passToken.liveCode(mine.live.key, w - 5)}`;
            const ov = await passes.scan(old, scanner, { service: 'LODGING' });
            check('A live QR older than a minute (a screenshot) is refused', ov.reason === 'OLD_SCREENSHOT', ov.message);
        }

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
        const { RoutePlan } = require('../modules/route/routePlan.model');
        const plansBefore = await RoutePlan.countDocuments();
        const plan1 = await route.plan({ from: 'tent-city-a', to: 'ramkund' });
        const savedPlan = await RoutePlan.findOne().sort({ at: -1 }).lean();
        check('Each planned route is shared in MongoDB (not kept in one server\'s memory)', (await RoutePlan.countDocuments()) === plansBefore + 1 && savedPlan.laneIds.join() === plan1.safest.lanes.map((l) => l.id).join());
        await RoutePlan.init(); // waits until MongoDB has built the TTL index
        const ttl = (await RoutePlan.collection.indexes()).find((i) => i.expireAfterSeconds !== undefined);
        check('Old route plans delete themselves after 15 minutes', ttl?.expireAfterSeconds === 15 * 60);
        const netAfter = await route.network({});
        check('The map shows how many people were just sent along each lane', plan1.safest.lanes.every((l) => (netAfter.lanes.find((x) => x.id === l.id)?.recentPlans || 0) >= 1));
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
        {
            // SOS: the pilgrim picks the kind of help, sees who is coming, and can say "I'm safe now"
            const sosSvc = require('../modules/sos/sos.service');
            const SosIncident = require('../modules/sos/sos.model');
            await SosIncident.deleteMany({ userId: me._id });
            await expectError('An unknown SOS type is refused', () => sosSvc.raise(user, { eventId: String(event._id), type: 'ALIENS' }), 400, /kind of help/);
            const s1 = await sosSvc.raise(user, { eventId: String(event._id), type: 'medical', message: 'Father fainted', lat: 19.95, lng: 73.84 });
            check('SOS keeps the chosen type and message', s1.incident.type === 'MEDICAL' && s1.incident.message === 'Father fainted');
            const s2 = await sosSvc.raise(user, { eventId: String(event._id), type: 'CROWD' });
            check('Pressing again updates the same alert and can change its type', s2.updated && String(s2.incident._id) === String(s1.incident._id) && s2.incident.type === 'CROWD');
            const authority = await User.findOne({ role: 'AUTHORITY' }).lean();
            const vol = await User.findOne({ role: 'VOLUNTEER', isActive: true }).lean();
            await sosSvc.update(String(s1.incident._id), authority, { status: 'ACKNOWLEDGED', assignedTo: String(vol._id) });
            const [mineNow] = await sosSvc.mine(me._id);
            check('My SOS shows it was seen and who is coming', mineNow.status === 'ACKNOWLEDGED' && !!mineNow.acknowledgedAt && mineNow.assignedTo?.name === vol.name, mineNow.assignedTo?.name);
            const closed = await sosSvc.closeMine(String(s1.incident._id), user);
            check('"I\'m safe now" closes the alert', closed.status === 'RESOLVED' && closed.closedByUser === true);
            await expectError('A closed alert cannot be closed again', () => sosSvc.closeMine(String(s1.incident._id), user), 404);
            // Regression: raising and cancelling alerts in a loop floods the control room
            // but a real emergency after that must still reach the control room (never refused)
            await SosIncident.deleteMany({ userId: me._id });
            let refused = null;
            let last = null;
            for (let i = 0; i < 8 && !refused; i += 1) {
                try {
                    last = await sosSvc.raise(user, { eventId: String(event._id), type: 'MEDICAL', message: `press ${i}` });
                    if (i < 7) await sosSvc.closeMine(String(last.incident._id), user);
                } catch (e) {
                    refused = e;
                }
            }
            const sosRows = await SosIncident.countDocuments({ userId: me._id });
            check('Alerts sent in a loop do not flood the control room (at most 5 new ones in 10 minutes)', sosRows === 5, `${sosRows} alerts`);
            check('An alert after that is never refused: the latest one is reopened with the new details', !refused && last?.incident?.status === 'OPEN' && last.incident.message === 'press 7', refused?.message || last?.incident?.status);
            await SosIncident.deleteMany({ userId: me._id });
        }
        const publicView = await lostfound.list(null, { kind: 'MISSING' });
        const shown = publicView.find((r) => String(r._id) === String(rep._id));
        check('Phone numbers are hidden from the public bulletin', shown && !shown.contactPhone && !shown.personPhone);

        // ---- 12. Team notes round 2: limit of 5, group passes, one QR, other yatras ----
        const transit = require('../modules/transit/transit.service');
        {
            // Regression: shuttle seats cannot be sold after the yatra has ended
            const freeBus = await TransitRoute.findOne({ eventId: event._id, kind: 'SHUTTLE', isActive: true, fare: 0 }).lean();
            const realEnd = (await Event.findById(event._id, 'endDate').lean()).endDate;
            await Event.updateOne({ _id: event._id }, { $set: { endDate: new Date(Date.now() - 2 * 86400000) } });
            try {
                await expectError('No bus pass once the yatra has ended', () => transit.boardingPass(freeBus._id, user, { people: 1 }), 400, /ended/i);
                const endedList = await transit.list(String(event._id)).catch((e) => e);
                check('The bus list still opens after the yatra ends (with no seats left)', Array.isArray(endedList) && endedList.filter((r) => r.kind === 'SHUTTLE').every((r) => r.seatsLeft === 0), endedList?.message);
            } finally {
                await Event.updateOne({ _id: event._id }, { $set: { endDate: realEnd } });
            }
            // Regression: an archived event takes no more registrations
            const archivedEv = await events.create({ ...base, title: 'Flow test archived event', ticketPrice: 0, capacity: 5 }, host);
            groupIds.push(archivedEv._id);
            await Event.updateOne({ _id: archivedEv._id }, { $set: { status: 'ARCHIVED' } });
            await expectError('An archived event takes no registrations', () => events.register(archivedEv._id, user, { people: 1 }), 400, /no longer open/i);
        }
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
        {
            // ---- 12b. Pre-booking before a yatra starts ----
            const { addDays } = require('../utils/time');
            const wariStart = istDate(wariEv.startDate);
            const day3 = addDays(wariStart, 2);
            check('A camp booked before the yatra starts is marked as pre-booked', wariBook.pass.details?.prebooked === true, JSON.stringify(wariBook.pass.details?.prebooked));
            const wariBus = await TransitRoute.findOne({ eventId: wariEv._id, kind: 'SHUTTLE', isActive: true, fare: 0 }).lean();
            const wariList = await transit.list(String(wariEv._id), { date: day3 });
            const listed = wariList.find((r) => String(r._id) === String(wariBus._id));
            check('Bus seats can be checked for a chosen day of a yatra that has not started', listed?.travelDay === day3, listed?.travelDay);
            const pre = await transit.boardingPass(wariBus._id, user, { people: 2, date: day3 }).catch((e) => e);
            check('A bus pass can be pre-booked for a chosen day (not only day 1)', pre.pass?.details?.date === day3 && pre.pass?.details?.prebooked === true, pre.message);
            await expectError('A bus pass cannot be pre-booked for a day after the yatra', () => transit.boardingPass(wariBus._id, user, { date: addDays(istDate(wariEv.endDate), 1) }), 400, /day of the yatra/i);
            await expectError('A bus pass cannot be booked for a day that has passed', () => transit.boardingPass(wariBus._id, user, { date: addDays(istDate(), -1) }), 400, /passed|day of the yatra/i);
            await expectError('A made-up date is refused', () => transit.quote(wariBus._id, 1, '2027-02-30'), 400);
            const wariPaid = await TransitRoute.findOne({ eventId: wariEv._id, kind: 'SHUTTLE', isActive: true, fare: { $gt: 0 } }).lean();
            if (wariPaid) {
                const preOrder = await orders.create(user, [{ kind: 'TRANSIT', refId: String(wariPaid._id), input: { people: 1, date: day3 } }]);
                check('The cart keeps the chosen travel day', preOrder.items[0].input?.date === day3 && preOrder.items[0].detail.includes(day3), preOrder.items[0].detail);
                const paidPre = await orders.pay(preOrder._id, user, { method: 'UPI', upiId: 'flow@okaxis' });
                const prePass = paidPre.passes?.[0];
                check('A paid bus pass is issued for the chosen day', prePass?.details?.date === day3 && prePass?.details?.prebooked === true, prePass?.details?.date);
            } else console.log('SKIP  Paid pre-booked bus pass (no paid Wari shuttle in the seed)');
            const runningBus = await TransitRoute.findOne({ eventId: event._id, kind: 'SHUTTLE', isActive: true, fare: 0 }).lean();
            const runningEvent = await Event.findById(event._id, 'startDate').lean();
            if (istDate(runningEvent.startDate) <= istDate()) {
                const today2 = await transit.list(String(event._id));
                check('A yatra that is on does not say pre-booking', today2.find((r) => String(r._id) === String(runningBus._id))?.prebooking !== true);
            }
            const wariSlot = await FoodSlot.findOne({ eventId: wariEv._id, date: { $gte: wariStart } }).lean();
            const preMeal = await food.claim(wariSlot._id, user, { people: 1 }).catch((e) => e);
            check('A meal token can be pre-booked for a day of the yatra, and is marked so', preMeal.pass?.details?.prebooked === true, preMeal.message);
        }
        {
            // ---- 12c. Every booking stays within the yatra's own days ----
            const { addDays } = require('../utils/time');
            const wariStart = istDate(wariEv.startDate);
            const wariEnd = istDate(wariEv.endDate);
            const before = addDays(wariStart, -10);
            // Stay
            await expectError('A camp cannot be booked for a night before the yatra starts', () => lodging.book(wariCamp._id, user, { beds: 1, checkIn: before, checkOut: addDays(before, 1) }), 400, /day of the yatra|starts on/i);
            await expectError('The cart refuses a stay before the yatra starts', () => lodging.quote(wariCamp._id, { beds: 1, checkIn: before, checkOut: addDays(before, 1) }), 400, /day of the yatra|starts on/i);
            const fiveNights = await lodging.book(wariCamp._id, user, { beds: 1, checkIn: wariStart, checkOut: addDays(wariStart, 5) }).catch((e) => e);
            check('A 5-night stay is allowed', fiveNights.booking?.nights?.length === 5, fiveNights.message);
            if (fiveNights.booking) await lodging.cancel(fiveNights.booking._id, user);
            await expectError('A 6-night stay is refused (5 nights at most)', () => lodging.book(wariCamp._id, user, { beds: 1, checkIn: wariStart, checkOut: addDays(wariStart, 6) }), 400, /5 nights/);
            // Meals
            const wariCenter = await FoodCenter.findOne({ eventId: wariEv._id }).lean();
            const strayLunch = await FoodSlot.create({ foodCenterId: wariCenter._id, eventId: wariEv._id, date: addDays(wariStart, -3), meal: 'LUNCH', startTime: '11:30', endTime: '14:30', capacity: 10, remaining: 10 });
            try {
                await expectError('A meal token cannot be taken for a day outside the yatra', () => food.claim(strayLunch._id, user, { people: 1 }), 400, /day of the yatra|starts on/i);
            } finally {
                await FoodSlot.deleteOne({ _id: strayLunch._id });
            }
            const ngoSvc = require('../modules/ngo/ngo.service');
            const superAdmin = await User.findOne({ role: 'SUPER_ADMIN' }).lean();
            const sa = { ...superAdmin, id: String(superAdmin._id) };
            await expectError('A kitchen cannot open meal slots before the yatra starts', () => ngoSvc.setSlot(sa, wariCenter._id, { date: addDays(wariStart, -3), meal: 'LUNCH', capacity: 50 }), 400, /day of the yatra|starts on/i);
            await expectError('A kitchen cannot open meal slots after the yatra ends', () => ngoSvc.setSlot(sa, wariCenter._id, { date: addDays(wariEnd, 1), meal: 'LUNCH', capacity: 50 }), 400, /day of the yatra|ended/i);
            const runningCenter = await FoodCenter.findOne({ eventId: event._id, isActive: { $ne: false } }).lean();
            await expectError('A kitchen cannot open meal slots for a day that has passed', () => ngoSvc.setSlot(sa, runningCenter._id, { date: addDays(istDate(), -1), meal: 'LUNCH', capacity: 50 }), 400, /passed/i);
            // Seva
            const volunteers = require('../modules/volunteer/volunteer.service');
            await expectError('Seva days must be days of the yatra', () => volunteers.apply(user, { eventId: String(wariEv._id), domain: 'CROWD_CONTROL', dates: [addDays(wariStart, -5)] }), 400, /day of the yatra|starts on/i);
            await expectError('Seva days must be real dates', () => volunteers.apply(user, { eventId: String(wariEv._id), domain: 'CROWD_CONTROL', dates: ['someday'] }), 400);
            const archivedYatra = await Event.findOne({ _id: { $in: groupIds }, status: 'ARCHIVED' }).lean();
            if (archivedYatra) await expectError('No seva applications for a closed event', () => volunteers.apply(user, { eventId: String(archivedYatra._id), domain: 'CROWD_CONTROL', dates: [] }), 400, /no longer open|ended/i);
            // A yatra that has been closed takes no stays or meal tokens
            await Event.updateOne({ _id: wariEv._id }, { $set: { status: 'ARCHIVED' } });
            try {
                await expectError('A closed yatra takes no camp bookings', () => lodging.quote(wariCamp._id, { beds: 1, checkIn: wariStart, checkOut: wariStart }), 400, /no longer open|closed/i);
                const anySlot = await FoodSlot.findOne({ eventId: wariEv._id, date: { $gte: wariStart } }).lean();
                await expectError('A closed yatra gives no meal tokens', () => food.claim(anySlot._id, user, { people: 1 }), 400, /no longer open|closed/i);
            } finally {
                await Event.updateOne({ _id: wariEv._id }, { $set: { status: 'ACTIVE' } });
            }
        }
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
        {
            // Regression: the refund gateway is down when a paid ticket is cancelled
            const pg2 = require('../modules/order/payment').gateway();
            const realRefund2 = pg2.refund;
            const paidTix2 = await events.register(cEv._id, user, { people: 1, paidByOrder: { _id: new mongoose.Types.ObjectId(), amount: 150 } });
            pg2.refund = async () => {
                throw new Error('gateway unreachable');
            };
            let cancelErr = null;
            try {
                await cancellation.cancel(paidTix2.pass._id, user, new Date(startAt - 72 * H));
            } catch (e) {
                cancelErr = e;
            } finally {
                pg2.refund = realRefund2;
            }
            const queued = await Pass.findById(paidTix2.pass._id).lean();
            check('Cancelling works while the refund gateway is down (refund queued)', !cancelErr && queued.status === 'CANCELLED' && queued.refund?.pending === true, cancelErr?.message);
            await orders.sweep();
            const sent = await Pass.findById(paidTix2.pass._id).lean();
            check('The queued pass refund is sent by the sweep', !sent.refund?.pending && !!sent.refund?.reference);
        }
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

        // Regression: wrong passwords from one device must not lock the pilgrim out on their own phone
        {
            for (let i = 0; i < 5; i += 1) await auth.login({ identifier: PHONE, password: 'Wrong-0000', ip: '203.0.113.7' }).catch(() => {});
            await expectError('After 5 wrong passwords that device is locked out', () => auth.login({ identifier: PHONE, password: 'Crowd@123', ip: '203.0.113.7' }), 429);
            const ownPhone = await auth.login({ identifier: PHONE, password: 'Crowd@123', ip: '198.51.100.20' }).catch((e) => e);
            check('The pilgrim can still log in from their own phone', !!ownPhone.token, ownPhone.message);
            // Regression: the account-wide count is a fixed 15-minute window, not pushed out by every wrong password
            await auth.login({ identifier: PHONE, password: 'Wrong-0000', ip: '192.0.2.44' }).catch(() => {});
            const firstWindow = (await auth.LoginGuard.findOne({ userId: ownPhone.user?._id || ownPhone.user?.id, client: '*' }).lean())?.expireAt;
            await new Promise((r) => setTimeout(r, 20));
            await auth.login({ identifier: PHONE, password: 'Wrong-0000', ip: '192.0.2.44' }).catch(() => {});
            const secondWindow = (await auth.LoginGuard.findOne({ userId: ownPhone.user?._id || ownPhone.user?.id, client: '*' }).lean())?.expireAt;
            check('The account-wide count of wrong passwords keeps its first 15-minute window', !!firstWindow && +firstWindow === +secondWindow, `${firstWindow?.toISOString()} then ${secondWindow?.toISOString()}`);
            // ...and once that window is over, a new wrong password starts a new count (even before the row is cleaned up)
            const meId = ownPhone.user?._id || ownPhone.user?.id;
            await auth.LoginGuard.updateOne({ userId: meId, client: '*' }, { $set: { failed: 29, expireAt: new Date(Date.now() - 1000) } });
            const afterWindow = await auth.login({ identifier: PHONE, password: 'Wrong-0000', ip: '192.0.2.45' }).catch((e) => e);
            const freshRow = await auth.LoginGuard.findOne({ userId: meId, client: '*' }).lean();
            check('An expired wrong-password window starts again from 1 (no early account lock)', afterWindow.status === 401 && freshRow?.failed === 1, `${afterWindow.status} ${freshRow?.failed}`);
            await auth.login({ identifier: PHONE, password: 'Crowd@123', ip: '192.0.2.44' }); // clears the counters
        }

        // ---- Help desk password reset (last: it changes the test pilgrim's password) ----
        const helpdesk = require('../modules/auth/helpdesk');
        const { requireAuth } = require('../middleware/auth');
        const deskUser = await User.findOne({ phone: '9000000002' }).lean();
        const deskStaff = { ...deskUser, id: String(deskUser._id) };
        const found = await helpdesk.lookup(deskStaff, { countryCode: '91', phone: PHONE });
        check('Help desk finds the account by mobile number (number partly hidden)', String(found._id) === String(me._id) && found.canReset && /\*{6}\d{4}$/.test(found.phone));
        const volunteerUser = await User.findOne({ phone: '9000000005' }).lean();
        await expectError('Authority cannot reset a staff account at the help desk', () => helpdesk.reset(deskStaff, volunteerUser._id), 403, /pilgrim/);
        await expectError('Staff cannot reset their own password at the help desk', () => helpdesk.reset(deskStaff, deskUser._id), 403);
        check('Only the control room and volunteers can list SOS alerts (not NGO or corporate admins)', hasPermission('AUTHORITY', 'sos:view') && hasPermission('VOLUNTEER', 'sos:view') && !hasPermission('NGO_ADMIN', 'sos:view') && !hasPermission('CORPORATE_ADMIN', 'sos:view'));
        {
            // ---- Volunteer duties (control room) ----
            const duties = require('../modules/volunteer/duty.service');
            const { Duty } = require('../modules/volunteer/duty.model');
            const amitRow = await User.findOne({ phone: '9000000005' }).lean();
            const authRow = await User.findOne({ phone: '9000000002' }).lean();
            const amit = { ...amitRow, id: String(amitRow._id) };
            const desk = { ...authRow, id: String(authRow._id) };
            const H = 3600000;
            const sector = (await duties.sectorsFor(event._id))[0];
            try {
                await expectError('A shift cannot be given a start time hours in the past (a mistyped date)', () => duties.assign(desk, { eventId: String(event._id), volunteerId: String(amitRow._id), sector, post: 'flow-test', start: new Date(Date.now() - 3 * H).toISOString(), end: new Date(Date.now() + 2 * H).toISOString() }), 400, /past|already/i);
                // a volunteer who never checked out: the shift ended hours ago
                await Duty.create({ volunteerId: amitRow._id, eventId: event._id, sector, post: 'flow-test', start: new Date(Date.now() - 10 * H), end: new Date(Date.now() - 5 * H), status: 'ON_DUTY', checkedInAt: new Date(Date.now() - 10 * H) });
                const my = await duties.mine(amit);
                check('A shift that ended hours ago no longer shows as on duty', !my.duties.some((d) => d.post === 'flow-test'), my.duties.map((d) => `${d.post}:${d.status}`).join(', '));
                const board = await duties.dashboard(String(event._id));
                const amitOnBoard = (board.roster || board.volunteers || []).find((r) => r.id === String(amitRow._id));
                check('The roster does not count them as on duty', amitOnBoard?.duty?.post !== 'flow-test', amitOnBoard?.status);
            } finally {
                await Duty.deleteMany({ volunteerId: amitRow._id, post: 'flow-test' });
            }
        }
        check('Only Authority and Super Admin can reset passwords', hasPermission('AUTHORITY', 'account:reset') && hasPermission('SUPER_ADMIN', 'account:reset') && !hasPermission('USER', 'account:reset') && !hasPermission('VOLUNTEER', 'account:reset'));
        const tokenBefore = (await auth.login({ identifier: PHONE, password: 'Crowd@123' })).token;
        const given = await helpdesk.reset(deskStaff, me._id);
        check('Help desk gives a readable temporary password', /^[A-HJ-NP-Z]{4}-[2-9]{4}$/.test(given.tempPassword), given.tempPassword);
        await expectError('The old password stops working after a reset', () => auth.login({ identifier: PHONE, password: 'Crowd@123' }), 401);
        const runGate = async (token, url) => {
            const req = { headers: { authorization: `Bearer ${token}` }, originalUrl: url };
            await requireAuth(req, {}, () => {});
            return req.user;
        };
        await expectError('Old sessions are logged out by the reset', () => runGate(tokenBefore, '/api/auth/me'), 401);
        const tempLogin = await auth.login({ identifier: PHONE, password: given.tempPassword });
        check('Temporary password logs in and asks for a new password', !!tempLogin.token && tempLogin.user.mustChangePassword === true);
        await expectError('Until a new password is set, other pages are blocked', () => runGate(tempLogin.token, '/api/passes/mine'), 403, /new password/);
        check('Setting the new password is allowed with the temporary one', !!(await runGate(tempLogin.token, '/api/auth/password')));
        await expectError('A wrong temporary password is refused when setting a new one', () => auth.changePassword(user, { currentPassword: 'WRONG-0000', newPassword: 'NewPass456' }), 400, /temporary password/);
        await expectError('The temporary password cannot be kept as the new one', () => auth.changePassword(user, { currentPassword: given.tempPassword, newPassword: given.tempPassword }), 400);
        const changed = await auth.changePassword(user, { currentPassword: given.tempPassword, newPassword: 'NewPass456' });
        check('New password saved; the account is unlocked from the gate', !!changed.token && !changed.user.mustChangePassword && !!(await runGate(changed.token, '/api/passes/mine')));
        check('The new password logs in', !!(await auth.login({ identifier: PHONE, password: 'NewPass456' })).token);
        check('The reset is in the audit log', !!(await require('../modules/audit/audit.model').findOne({ action: 'PASSWORD_RESET_BY_STAFF', targetId: me._id }).lean()));
        finished = true;
    } finally {
        await OtpCode.deleteMany({ phone: PHONE });
        await User.deleteMany({ phone: PHONE_NO_CODE });
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
            await Promise.all([Pass.deleteMany({ userId: me._id }), Order.deleteMany({ userId: me._id }), LodgingBooking.deleteMany({ userId: me._id }), require('../modules/lodging/personNights').PersonNight.deleteMany({ userId: me._id }), auth.LoginGuard.deleteMany({ userId: me._id }), require('../modules/lostfound/lostfound.model').deleteMany({ reportedBy: me._id }), require('../modules/volunteer/volunteer.model').VolunteerApplication.deleteMany({ userId: me._id }), require('../modules/lostfound/photo.model').Photo.deleteMany({ uploadedBy: me._id })]);
            await require('../modules/auth/avatar').Avatar.deleteMany({ userId: me._id });
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
        if (!finished) console.log('\nStopped early: a step threw an error (shown below). Test data cleaned up.');
        else console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed. Test data cleaned up.');
        process.exitCode = failed || !finished ? 1 : 0;
    }
}

main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
});
