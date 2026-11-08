/**
 * Proves the zero double-booking guarantee (NFR 4.2) against your real database.
 *   npm run test:concurrency
 *
 * 1. 200 different pilgrims try to book 1 bed each at a camp with 10 beds, all at once.
 *    Expected: exactly 10 succeed, the camp ends at 0 beds, never negative.
 * 2. One pilgrim fires 20 simultaneous claims for the same lunch.
 *    Expected: exactly 1 meal token.
 * Everything it creates is tagged and deleted at the end.
 */
require('dotenv').config();
require('../utils/dns'); // optional DNS_SERVERS override for Atlas
const mongoose = require('mongoose');
const User = require('../modules/auth/user.model');
const Event = require('../modules/event/event.model');
const Provider = require('../modules/provider/provider.model');
const { Lodging, LodgingBooking } = require('../modules/lodging/lodging.model');
const { BedAssignment } = require('../modules/lodging/beds');
const nightsLib = require('../modules/lodging/nights');
const { FoodCenter, FoodSlot } = require('../modules/food/food.model');
const { Pass } = require('../modules/pass/pass.model');
const lodgingService = require('../modules/lodging/lodging.service');
const foodService = require('../modules/food/food.service');
const { detectTransactionSupport } = require('../utils/tx');
const { istDate, addDays, istDateTime } = require('../utils/time');

const PILGRIMS = 200;
const BEDS = 10;
const TAG = `cgtest-${Date.now()}`;

async function main() {
    await require('../utils/dns').connectMongo(mongoose, require('./test-db').testDbUri());
    const tx = await detectTransactionSupport();
    console.log(`Connected (${tx ? 'transactions on' : 'standalone, compensation mode'})\n`);
    const today = istDate();

    const event = await Event.create({
        title: TAG, slug: TAG, kind: 'YATRA', city: 'Test',
        startDate: istDateTime(today, '00:00'), endDate: istDateTime(addDays(today, 5), '23:59'),
    });
    const owner = await User.create({ name: TAG, phone: '6000000000', passwordHash: 'x', role: 'NGO_ADMIN' }).catch(async () =>
        User.findOne({ phone: '6000000000' })
    );
    const provider = await Provider.create({ name: TAG, eventId: event._id, adminUserId: owner._id, verificationStatus: 'VERIFIED' });
    const lodging = await Lodging.create({
        eventId: event._id, providerId: provider._id, name: `${TAG} camp`, sector: 'Test', category: 'FREE_CAMP',
        totalBeds: BEDS, heldBeds: 0,
    });

    const pilgrims = await User.insertMany(
        Array.from({ length: PILGRIMS }, (_, i) => ({ name: `${TAG}-${i}`, phone: `6${String(100000000 + i)}`, passwordHash: 'x' }))
    );

    try {
        // ---- Test 1: 200 pilgrims, 10 beds ----
        console.log(`Test 1: ${PILGRIMS} pilgrims book 1 bed each at a camp with ${BEDS} beds, simultaneously...`);
        const t0 = Date.now();
        const results = await Promise.allSettled(pilgrims.map((p) => lodgingService.book(lodging._id, p, { beds: 1 })));
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const soldOut = results.filter((r) => r.status === 'rejected' && r.reason.status === 409).length;
        const other = results.filter((r) => r.status === 'rejected' && r.reason.status !== 409);
        const [after] = await nightsLib.attachAvailability([await Lodging.findById(lodging._id).lean()], { checkIn: today });
        const bookings = await LodgingBooking.countDocuments({ lodgingId: lodging._id, status: 'CONFIRMED' });
        console.log(`  finished in ${Date.now() - t0} ms`);
        console.log(`  successful bookings : ${ok}`);
        console.log(`  rejected (sold out) : ${soldOut}`);
        if (other.length) console.log(`  other errors        : ${other.length} (first: ${other[0].reason.message})`);
        console.log(`  beds left tonight   : ${after.availableBeds}`);
        console.log(`  bookings in DB      : ${bookings}`);
        const assigned = await BedAssignment.find({ lodgingId: lodging._id }).lean();
        const distinctBeds = new Set(assigned.map((a) => a.bedNo)).size;
        console.log(`  bed numbers given   : ${assigned.length} (${distinctBeds} different)`);
        const pass1 = ok === BEDS && after.availableBeds === 0 && bookings === BEDS && other.length === 0 && assigned.length === BEDS && distinctBeds === BEDS;
        console.log(pass1 ? '  PASS - no double booking\n' : '  FAIL\n');

        // ---- Test 1b: the same camp, the NEXT night ----
        // Tonight is sold out, but beds are counted per night, so tomorrow is free again.
        const tomorrow = addDays(today, 1);
        console.log(`Test 1b: ${PILGRIMS} more pilgrims race for the ${BEDS} beds of the next night (${tomorrow})...`);
        const results2 = await Promise.allSettled(pilgrims.map((p) => lodgingService.book(lodging._id, p, { beds: 1, checkIn: tomorrow, checkOut: tomorrow })));
        const ok2 = results2.filter((r) => r.status === 'fulfilled').length;
        const other2 = results2.filter((r) => r.status === 'rejected' && r.reason.status !== 409);
        const night2 = await nightsLib.LodgingNight.findOne({ lodgingId: lodging._id, date: tomorrow }).lean();
        const beds2 = await BedAssignment.find({ lodgingId: lodging._id, date: tomorrow }).lean();
        console.log(`  successful bookings : ${ok2}`);
        if (other2.length) console.log(`  other errors        : ${other2.length} (first: ${other2[0].reason.message})`);
        console.log(`  booked that night   : ${night2?.booked}`);
        console.log(`  bed numbers given   : ${beds2.length} (${new Set(beds2.map((a) => a.bedNo)).size} different)`);
        const pass1b = ok2 === BEDS && night2?.booked === BEDS && other2.length === 0 && new Set(beds2.map((a) => a.bedNo)).size === BEDS;
        console.log(pass1b ? '  PASS - each night is counted on its own, still no double booking\n' : '  FAIL\n');

        // ---- Test 2: one pilgrim, 20 simultaneous lunch claims ----
        const center = await FoodCenter.create({ eventId: event._id, providerId: provider._id, name: `${TAG} kitchen`, sector: 'Test' });
        const slot = await FoodSlot.create({
            foodCenterId: center._id, eventId: event._id, date: addDays(today, 1), meal: 'LUNCH',
            startTime: '12:00', endTime: '15:00', capacity: 100, remaining: 100,
        });
        console.log('Test 2: one pilgrim sends 20 lunch-token claims at the same instant...');
        const claims = await Promise.allSettled(Array.from({ length: 20 }, () => foodService.claim(slot._id, pilgrims[0])));
        const tokens = await Pass.countDocuments({ refId: slot._id, type: 'MEAL' });
        const slotAfter = await FoodSlot.findById(slot._id).lean();
        console.log(`  tokens issued       : ${tokens}`);
        console.log(`  claims rejected     : ${claims.filter((r) => r.status === 'rejected').length}`);
        console.log(`  quota remaining     : ${slotAfter.remaining} / 100`);
        const pass2 = tokens === 1 && slotAfter.remaining === 99;
        console.log(pass2 ? '  PASS - one token per person per meal\n' : '  FAIL\n');

        process.exitCode = pass1 && pass1b && pass2 ? 0 : 1;
    } finally {
        const ids = pilgrims.map((p) => p._id);
        await Promise.all([
            Pass.deleteMany({ eventId: event._id }),
            BedAssignment.deleteMany({ lodgingId: lodging._id }),
            nightsLib.LodgingNight.deleteMany({ lodgingId: lodging._id }),
            LodgingBooking.deleteMany({ eventId: event._id }),
            FoodSlot.deleteMany({ eventId: event._id }),
            FoodCenter.deleteMany({ eventId: event._id }),
            Lodging.deleteMany({ eventId: event._id }),
            Provider.deleteMany({ eventId: event._id }),
            User.deleteMany({ $or: [{ _id: { $in: ids } }, { _id: owner._id }] }),
            Event.deleteOne({ _id: event._id }),
        ]);
        await mongoose.disconnect();
        console.log('Test data cleaned up.');
    }
}

main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
});
