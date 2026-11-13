/**
 * Demo volunteers for the district control room's volunteer dashboard (/volunteers).
 *
 *   npm run seed:volunteers           shared database (MONGO_URI)
 *   npm run seed:volunteers -- --test test database (TEST_MONGO_URI)
 *
 * Adds to the flagship yatra, without wiping anything:
 *   - 24 approved volunteers (mobile 9000020101 to 9000020124, password SEED_PASSWORD)
 *     spread over the event's sectors and the four seva domains
 *   - shifts in every state the dashboard shows: on duty now, late (shift started, not checked in),
 *     later today, and off
 *   - a shift for Amit Jadhav (9000000005) starting in 10 minutes, so check-in can be shown live
 * Run it again at any time: it rebuilds the demo shifts around the current time.
 */
require('dotenv').config();
require('../utils/dns'); // optional DNS_SERVERS override for Atlas
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../modules/auth/user.model');
const Event = require('../modules/event/event.model');
const { VolunteerApplication, DOMAINS } = require('../modules/volunteer/volunteer.model');
const { Duty, VolunteerBroadcast } = require('../modules/volunteer/duty.model');
const { istDate } = require('../utils/time');

const PASSWORD = process.env.SEED_PASSWORD;
const HOUR = 3600 * 1000;
const NAMES = [
    'Aarti Shinde', 'Vikram Bhosale', 'Neha Joshi', 'Sagar More', 'Pooja Kale', 'Rohit Gaikwad',
    'Snehal Pawar', 'Akash Thakur', 'Kavita Sawant', 'Nikhil Chavan', 'Manasi Gokhale', 'Tushar Mane',
    'Rutuja Salunkhe', 'Omkar Jagtap', 'Shraddha Kadam', 'Prasad Wagh', 'Anjali Nikam', 'Swapnil Deore',
    'Harshada Bhagat', 'Ganesh Kolhe', 'Yogita Ahire', 'Mahesh Borse', 'Komal Sonawane', 'Pratik Wankhede',
];
const POSTS = ['Main gate', 'Ghat steps', 'Help booth', 'Langar hall', 'Parking', 'Shuttle stop', 'Medical tent', 'Queue barricade'];

async function main() {
    const uri = process.argv.includes('--test') ? require('./test-db').testDbUri() : process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI missing in .env');
    if (!PASSWORD || PASSWORD.length < 8) throw new Error('Set SEED_PASSWORD in .env: the password for the demo volunteers');
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to add demo data to a production database');
    await require('../utils/dns').connectMongo(mongoose, uri);
    await Promise.all([Duty.syncIndexes(), VolunteerBroadcast.syncIndexes()]);

    const event = (await Event.findOne({ kind: 'YATRA', isFlagship: true })) || (await Event.findOne({ kind: 'YATRA' }));
    if (!event) throw new Error('No yatra found. Run `npm run seed` first.');
    const sectors = event.sectors?.length ? event.sectors : ['Sector 1', 'Sector 2', 'Sector 3'];
    const today = istDate();
    const now = Date.now();
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    const people = [];
    for (let i = 0; i < NAMES.length; i += 1) {
        const phone = `90000201${String(i + 1).padStart(2, '0')}`;
        let user = await User.findOne({ countryCode: '91', phone });
        if (!user) user = await User.create({ name: NAMES[i], phone, countryCode: '91', role: 'VOLUNTEER', passwordHash });
        else if (user.role !== 'VOLUNTEER') {
            // someone real signed up with this number: never change their role
            console.log(`Skipping ${phone}: it belongs to an existing ${user.role} account`);
            continue;
        }
        await VolunteerApplication.updateOne(
            { userId: user._id, eventId: event._id },
            { $set: { domain: DOMAINS[i % DOMAINS.length], sector: sectors[i % sectors.length], dates: [today], status: 'APPROVED', reviewedAt: new Date() } },
            { upsert: true }
        );
        people.push(user);
    }

    // Rebuild the demo shifts around "now"
    const amit = await User.findOne({ countryCode: '91', phone: '9000000005' });
    const demoIds = [...people.map((p) => p._id), ...(amit ? [amit._id] : [])];
    await Duty.deleteMany({ eventId: event._id, volunteerId: { $in: demoIds } });

    const shifts = [];
    people.forEach((p, i) => {
        const sector = sectors[i % sectors.length];
        const post = POSTS[i % POSTS.length];
        if (i < 13) {
            // on duty now: started 1-3 hours ago, checked in
            const start = now - (1 + (i % 3)) * HOUR;
            shifts.push({ volunteerId: p._id, sector, post, start, end: start + 6 * HOUR, status: 'ON_DUTY', checkedInAt: start + 5 * 60000 });
        } else if (i < 15) {
            // late: shift started 20 minutes ago, not checked in
            shifts.push({ volunteerId: p._id, sector, post, start: now - 20 * 60000, end: now + 6 * HOUR, status: 'SCHEDULED' });
        } else if (i < 20) {
            // later today
            const start = now + (2 + (i % 3)) * HOUR;
            shifts.push({ volunteerId: p._id, sector, post, start, end: start + 6 * HOUR, status: 'SCHEDULED' });
        }
        // the rest are off duty
    });
    if (amit) {
        await VolunteerApplication.updateOne({ userId: amit._id, eventId: event._id }, { $set: { status: 'APPROVED' } });
        shifts.push({ volunteerId: amit._id, sector: sectors[0], post: 'Help booth', start: now + 10 * 60000, end: now + 6 * HOUR, status: 'SCHEDULED' });
    }
    await Duty.insertMany(shifts.map((s) => ({ ...s, eventId: event._id, start: new Date(s.start), end: new Date(s.end), checkedInAt: s.checkedInAt && new Date(s.checkedInAt) })));

    console.log(`Event: ${event.title}`);
    console.log(`Volunteers: ${people.length} (mobile 9000020101 to 9000020124, password from SEED_PASSWORD)`);
    console.log(`Shifts: ${shifts.length} (13 on duty, 2 late, 5 later today${amit ? ', 1 for Amit Jadhav in 10 minutes' : ''})`);
    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error(err.message || err);
    await mongoose.disconnect();
    process.exit(1);
});
