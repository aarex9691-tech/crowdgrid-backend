/**
 * Seeds realistic demo data for CrowdGrid.
 *   npm run seed
 *
 * WARNING: deletes every CrowdGrid collection in the database in MONGO_URI first.
 *
 * Flagship: Simhastha Kumbh Mela at Nashik-Trimbakeshwar (Dhwajarohan 31 Oct 2026,
 * concludes 24 Jul 2028; Amrut Snan 2 Aug, 31 Aug, 11/12 Sep 2027).
 * Services (camps, kitchens, shuttles) are seeded as already operating from today
 * so every flow can be demonstrated live.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const User = require('../modules/auth/user.model');
const Event = require('../modules/event/event.model');
const Provider = require('../modules/provider/provider.model');
const { Lodging, LodgingBooking } = require('../modules/lodging/lodging.model');
const { FoodCenter, FoodSlot, MEALS } = require('../modules/food/food.model');
const { Pass } = require('../modules/pass/pass.model');
const TransitRoute = require('../modules/transit/transit.model');
const { VolunteerApplication } = require('../modules/volunteer/volunteer.model');
const SosIncident = require('../modules/sos/sos.model');
const LostFoundReport = require('../modules/lostfound/lostfound.model');
const passToken = require('../utils/passToken');
const { istDate, istDateTime, addDays } = require('../utils/time');

const PASSWORD = 'Crowd@123';
const today = istDate();

const SECTORS = {
    RAMKUND: 'Sector 1 - Ramkund Ghat',
    TAPOVAN: 'Sector 2 - Tapovan Sadhugram',
    PANCHAVATI: 'Sector 3 - Panchavati',
    TRIMBAK: 'Sector 4 - Trimbakeshwar',
    NASHIK_ROAD: 'Sector 5 - Nashik Road',
};

async function main() {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI missing in .env');
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected. Clearing CrowdGrid collections...');

    const models = [User, Event, Provider, Lodging, LodgingBooking, FoodCenter, FoodSlot, Pass, TransitRoute, VolunteerApplication, SosIncident, LostFoundReport];
    for (const m of models) {
        await m.deleteMany({});
        await m.syncIndexes();
    }
    // Old v1 collection no longer used
    await mongoose.connection.db.dropCollection('corporates').catch(() => {});

    // ---------- Users (one per role) ----------
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const mk = (name, phone, role, extra = {}) => ({ name, phone, role, passwordHash, ...extra });
    const [superAdmin, authority, ngoAdmin, corporateAdmin, volunteer, pilgrim, pilgrim2, ngoAdmin2, applicant] = await User.insertMany([
        mk('Platform Super Admin', '9000000001', 'SUPER_ADMIN', { email: 'admin@crowdgrid.test' }),
        mk('District Control Room, Nashik', '9000000002', 'AUTHORITY'),
        mk('Sanjay Kulkarni', '9000000003', 'NGO_ADMIN'),
        mk('Priya Menon', '9000000004', 'CORPORATE_ADMIN'),
        mk('Amit Jadhav', '9000000005', 'VOLUNTEER'),
        mk('Ramesh Patil', '9000000006', 'USER'),
        mk('Sunita Deshmukh', '9000000007', 'USER'),
        mk('Meera Iyer', '9000000008', 'NGO_ADMIN'),
        mk('Rahul Pawar', '9000000009', 'USER'),
    ]);

    // ---------- Events ----------
    const simhastha = await Event.create({
        title: 'Simhastha Kumbh Mela 2027',
        slug: 'simhastha-kumbh-2027',
        kind: 'YATRA',
        tagline: 'Nashik - Trimbakeshwar',
        description:
            'The Simhastha Kumbh on the banks of the Godavari at Nashik and Trimbakeshwar. Find verified shelter, langar, shuttles and help in one place.',
        city: 'Nashik',
        state: 'Maharashtra',
        venue: 'Ramkund & Kushavarta Kund',
        startDate: istDateTime('2026-10-31', '06:00'),
        endDate: istDateTime('2028-07-24', '18:00'),
        isFlagship: true,
        expectedFootfall: 50000000,
        keyDates: [
            { label: 'Dhwajarohan (flag hoisting)', date: istDateTime('2026-10-31', '06:00') },
            { label: '1st Amrut Snan', date: istDateTime('2027-08-02', '04:00') },
            { label: '2nd Amrut Snan', date: istDateTime('2027-08-31', '04:00') },
            { label: '3rd Amrut Snan (Nashik)', date: istDateTime('2027-09-11', '04:00') },
        ],
        sectors: Object.values(SECTORS),
        organizerId: authority._id,
    });

    // Secondary yatras: dates are indicative, confirm against the official calendar before presenting
    const wari = await Event.create({
        title: 'Pandharpur Ashadhi Wari 2027',
        slug: 'pandharpur-ashadhi-wari-2027',
        kind: 'YATRA',
        tagline: 'Alandi & Dehu to Pandharpur',
        description: 'The centuries-old palkhi procession of the Warkaris to Lord Vitthal at Pandharpur.',
        city: 'Pandharpur',
        state: 'Maharashtra',
        startDate: istDateTime('2027-06-28', '06:00'),
        endDate: istDateTime('2027-07-18', '20:00'),
        expectedFootfall: 1500000,
        sectors: ['Chandrabhaga Ghat', 'Wakhari Palkhi Tal', 'Temple Precinct'],
        organizerId: authority._id,
    });
    await Event.create({
        title: 'Jagannath Rath Yatra 2027',
        slug: 'jagannath-rath-yatra-2027',
        kind: 'YATRA',
        tagline: 'Puri, Odisha',
        description: 'The chariot festival of Lord Jagannath, Balabhadra and Subhadra along Bada Danda.',
        city: 'Puri',
        state: 'Odisha',
        startDate: istDateTime('2027-07-05', '06:00'),
        endDate: istDateTime('2027-07-15', '20:00'),
        expectedFootfall: 1000000,
        sectors: ['Bada Danda', 'Gundicha Temple', 'Swargadwar'],
        organizerId: authority._id,
    });

    const cleanup = await Event.create({
        title: 'Godavari Ghat Cleanup Drive',
        slug: 'godavari-ghat-cleanup',
        kind: 'PUBLIC',
        description: 'Join citizens and seva groups to clean the ghats ahead of Dhwajarohan. Gloves and bags provided.',
        city: 'Nashik',
        venue: 'Ramkund Ghat',
        startDate: istDateTime(addDays(today, 3), '07:00'),
        endDate: istDateTime(addDays(today, 3), '11:00'),
        capacity: 60,
        organizerId: authority._id,
    });
    await Event.create({
        title: 'Panchavati Heritage Walk',
        slug: 'panchavati-heritage-walk',
        kind: 'PUBLIC',
        description: 'A guided morning walk through Kalaram Mandir, Sita Gufa and the ghats. Small group.',
        city: 'Nashik',
        venue: 'Kalaram Mandir gate',
        startDate: istDateTime(addDays(today, 5), '06:30'),
        endDate: istDateTime(addDays(today, 5), '09:00'),
        capacity: 2,
        organizerId: authority._id,
    });
    await Event.create({
        title: 'Simhastha Infrastructure & CSR Summit',
        slug: 'simhastha-csr-summit',
        kind: 'CORPORATE',
        description: 'Invite-only summit for CSR partners supporting sanitation, water and transit for the Kumbh.',
        city: 'Nashik',
        venue: 'Convention Hall, Gangapur Road',
        companyName: 'Sahyadri Infra Pvt Ltd',
        accessCode: '482913',
        startDate: istDateTime(addDays(today, 7), '09:30'),
        endDate: istDateTime(addDays(today, 7), '18:00'),
        sessions: [
            { code: 'KEYNOTE', title: 'Keynote: Planning for 5 crore pilgrims', kind: 'SESSION', time: '10:00' },
            { code: 'PANEL', title: 'Panel: Water & sanitation at scale', kind: 'SESSION', time: '11:30' },
            { code: 'LUNCH', title: 'Networking lunch', kind: 'MEAL', time: '13:00' },
            { code: 'WORKSHOP', title: 'Workshop: Crowd-flow modelling', kind: 'SESSION', time: '15:00' },
        ],
        organizerId: corporateAdmin._id,
    });

    // ---------- Providers ----------
    const [ramSeva, annadan, nmc] = await Provider.insertMany([
        {
            name: 'Shri Ram Seva Trust', type: 'TRUST', eventId: simhastha._id, adminUserId: ngoAdmin._id,
            registrationNumber: 'MH/NSK/TR/1187', contactPhone: '9000000003', verificationStatus: 'VERIFIED',
            verifiedBy: authority._id, verifiedAt: new Date(), description: 'Dharamshalas and tent camps around Ramkund and Panchavati.',
        },
        {
            name: 'Akhil Bharatiya Annadan Samiti', type: 'NGO', eventId: simhastha._id, adminUserId: ngoAdmin2._id,
            registrationNumber: 'MH/NGO/2290', contactPhone: '9000000008', verificationStatus: 'VERIFIED',
            verifiedBy: authority._id, verifiedAt: new Date(), description: 'Community kitchens serving free langar.',
        },
        {
            name: 'Nashik Municipal Seva Camps', type: 'GOVT', eventId: simhastha._id, adminUserId: superAdmin._id,
            contactPhone: '9000000002', verificationStatus: 'VERIFIED', verifiedBy: superAdmin._id, verifiedAt: new Date(),
            description: 'Government senior dormitories and transit camps.',
        },
    ]);
    await Provider.create({
        name: 'Godavari Yuva Mandal', type: 'NGO', eventId: simhastha._id, adminUserId: applicant._id,
        registrationNumber: 'MH/NGO/4471', contactPhone: '9000000009', description: 'Youth group offering family tents near Tapovan.',
    });
    await User.updateOne({ _id: ngoAdmin._id }, { providerId: ramSeva._id });
    await User.updateOne({ _id: ngoAdmin2._id }, { providerId: annadan._id });
    await User.updateOne({ _id: volunteer._id }, { providerId: ramSeva._id });

    // ---------- Lodging ----------
    const L = (provider, name, sector, category, beds, available, km, amenities, lat, lng, price = 0) => ({
        eventId: simhastha._id, providerId: provider._id, name, sector, category, totalBeds: beds, availableBeds: available,
        distanceToGhatKm: km, amenities, location: { lat, lng }, pricePerNight: price,
    });
    const lodgings = await Lodging.insertMany([
        L(ramSeva, 'Ramkund Dharamshala', SECTORS.RAMKUND, 'DHARAMSHALA', 120, 28, 0.3, ['Drinking Water', 'Western Toilets', 'Luggage Locker'], 20.0059, 73.7897, 100),
        L(ramSeva, 'Panchavati Tent City - Block A', SECTORS.PANCHAVATI, 'FAMILY_TENT', 400, 212, 0.9, ['Drinking Water', 'Bio-Toilets', 'Charging Point'], 20.0081, 73.7951),
        L(ramSeva, 'Kalaram Ashram Hall', SECTORS.PANCHAVATI, 'ASHRAM', 80, 2, 0.6, ['Drinking Water', 'Western Toilets', 'Medical Tent'], 20.0072, 73.7934),
        L(ramSeva, 'Tapovan Free Seva Camp', SECTORS.TAPOVAN, 'FREE_CAMP', 600, 0, 1.4, ['Drinking Water', 'Bio-Toilets'], 20.011, 73.807),
        L(nmc, 'NMC Senior Citizens Dormitory', SECTORS.RAMKUND, 'SENIOR_DORM', 150, 64, 0.5, ['Drinking Water', 'Western Toilets', 'Medical Tent', 'Wheelchair Access'], 20.0049, 73.7881),
        L(nmc, 'Nashik Road Transit Camp', SECTORS.NASHIK_ROAD, 'FREE_CAMP', 800, 545, 7.8, ['Drinking Water', 'Bio-Toilets', 'Luggage Locker'], 19.948, 73.841),
        L(nmc, 'Kushavarta Pilgrim Shelter', SECTORS.TRIMBAK, 'DHARAMSHALA', 200, 37, 0.2, ['Drinking Water', 'Western Toilets'], 19.9322, 73.5309, 50),
        L(nmc, 'Trimbak Family Tents', SECTORS.TRIMBAK, 'FAMILY_TENT', 300, 141, 1.1, ['Drinking Water', 'Bio-Toilets', 'Charging Point'], 19.9365, 73.5274),
    ]);

    // ---------- Food ----------
    const centers = await FoodCenter.insertMany([
        { eventId: simhastha._id, providerId: annadan._id, name: 'Godavari Langar', sector: SECTORS.RAMKUND, menu: ['Poha', 'Dal-Rice', 'Chapati-Bhaji', 'Kheer'], location: { lat: 20.0065, lng: 73.7905 } },
        { eventId: simhastha._id, providerId: annadan._id, name: 'Tapovan Annachhatra', sector: SECTORS.TAPOVAN, menu: ['Upma', 'Khichdi', 'Puri-Bhaji'], location: { lat: 20.0105, lng: 73.806 } },
        { eventId: simhastha._id, providerId: ramSeva._id, name: 'Ram Seva Bhojanalaya', sector: SECTORS.PANCHAVATI, menu: ['Sabudana Khichdi', 'Varan-Bhaat', 'Zunka-Bhakri'], location: { lat: 20.0077, lng: 73.7942 } },
        { eventId: simhastha._id, providerId: nmc._id, name: 'Kushavarta Community Kitchen', sector: SECTORS.TRIMBAK, menu: ['Poha', 'Dal-Rice', 'Chapati'], location: { lat: 19.9318, lng: 73.5315 } },
    ]);
    const slots = [];
    const capacities = { BREAKFAST: 800, LUNCH: 1200, DINNER: 1000 };
    for (let d = 0; d < 7; d++) {
        const date = addDays(today, d);
        for (const c of centers) {
            for (const meal of Object.keys(MEALS)) {
                const capacity = capacities[meal];
                // Today's slots look busy; Godavari Langar lunch shows the "340 / 1200" example
                let remaining = capacity;
                if (d === 0) remaining = c.name === 'Godavari Langar' && meal === 'LUNCH' ? 340 : Math.round(capacity * 0.45);
                if (d === 0 && c.name === 'Tapovan Annachhatra' && meal === 'DINNER') remaining = 0;
                slots.push({ foodCenterId: c._id, eventId: simhastha._id, date, meal, startTime: MEALS[meal].start, endTime: MEALS[meal].end, capacity, remaining });
            }
        }
    }
    await FoodSlot.insertMany(slots);

    // ---------- Transit ----------
    await TransitRoute.insertMany([
        {
            eventId: simhastha._id, name: 'E-Shuttle S1', kind: 'SHUTTLE', origin: 'Adgaon Parking', destination: 'Ramkund Ghat',
            vehicleType: 'Battery E-Rickshaw', frequencyMins: 10, firstDeparture: '04:00', lastDeparture: '23:00', fare: 0, boardingGate: 'Gate A2',
            checkpoints: [
                { name: 'Adgaon Parking', type: 'STOP', lat: 20.034, lng: 73.836 },
                { name: 'Tapovan Chowk', type: 'STOP', lat: 20.0115, lng: 73.8075 },
                { name: 'Water point - Kapila Bridge', type: 'WATER', lat: 20.0095, lng: 73.8 },
                { name: 'Ramkund Ghat', type: 'GHAT', lat: 20.0059, lng: 73.7897 },
            ],
        },
        {
            eventId: simhastha._id, name: 'Govt Feeder Bus F4', kind: 'SHUTTLE', origin: 'Nashik Road Station', destination: 'Panchavati',
            vehicleType: 'Govt Feeder Bus', frequencyMins: 15, firstDeparture: '05:00', lastDeparture: '22:30', fare: 10, boardingGate: 'Platform 1 exit, Bay 3',
            checkpoints: [
                { name: 'Nashik Road Station', type: 'STOP', lat: 19.948, lng: 73.841 },
                { name: 'Dwarka Circle', type: 'STOP', lat: 19.9935, lng: 73.7995 },
                { name: 'Ambulance halt - Dwarka', type: 'AMBULANCE', lat: 19.994, lng: 73.799 },
                { name: 'Panchavati Karanja', type: 'STOP', lat: 20.0081, lng: 73.7951 },
            ],
        },
        {
            eventId: simhastha._id, name: 'Trimbak Ghat Link T2', kind: 'SHUTTLE', origin: 'Trimbak Bus Stand', destination: 'Kushavarta Kund',
            vehicleType: 'Battery E-Rickshaw', frequencyMins: 8, firstDeparture: '03:30', lastDeparture: '23:30', fare: 0, boardingGate: 'Stand gate 2',
            checkpoints: [
                { name: 'Trimbak Bus Stand', type: 'STOP', lat: 19.934, lng: 73.528 },
                { name: 'Bio-toilets block', type: 'TOILET', lat: 19.9332, lng: 73.5295 },
                { name: 'Kushavarta Kund', type: 'GHAT', lat: 19.9322, lng: 73.5309 },
            ],
        },
        {
            eventId: simhastha._id, name: 'Nagar Pradakshina Route', kind: 'PROCESSION', origin: 'Kalaram Mandir', destination: 'Ramkund',
            vehicleType: 'On foot', checkpoints: [
                { name: 'Kalaram Mandir', type: 'STOP', lat: 20.0074, lng: 73.7939 },
                { name: 'Water stall - Sita Gufa', type: 'WATER', lat: 20.0083, lng: 73.7962 },
                { name: 'Ambulance halt - Ganga Ghat', type: 'AMBULANCE', lat: 20.0063, lng: 73.7915 },
                { name: 'Bio-toilets - Ganga Ghat', type: 'TOILET', lat: 20.0061, lng: 73.7909 },
                { name: 'Ramkund', type: 'GHAT', lat: 20.0059, lng: 73.7897 },
            ],
        },
    ]);

    // ---------- Volunteers ----------
    const approvedApp = await VolunteerApplication.create({
        userId: volunteer._id, eventId: simhastha._id, providerId: ramSeva._id, domain: 'CROWD_CONTROL',
        sector: SECTORS.RAMKUND, dates: [today, addDays(today, 1)], status: 'APPROVED', reviewedBy: ngoAdmin._id, reviewedAt: new Date(),
    });
    await VolunteerApplication.create({
        userId: pilgrim2._id, eventId: simhastha._id, providerId: ramSeva._id, domain: 'FIRST_AID',
        sector: SECTORS.PANCHAVATI, dates: [addDays(today, 2)], note: 'Trained in basic first aid (Red Cross certificate).',
    });
    await Pass.create({
        type: 'VOLUNTEER', userId: volunteer._id, eventId: simhastha._id, providerId: ramSeva._id, refId: approvedApp._id,
        title: 'Seva Volunteer - Crowd Marshalling', subtitle: `${simhastha.title} - ${SECTORS.RAMKUND}`,
        details: { name: volunteer.name, domain: 'Crowd Marshalling', sector: SECTORS.RAMKUND, trust: ramSeva.name },
        validFrom: new Date(), validUntil: simhastha.endDate, singleUse: false, nonce: passToken.newNonce(),
        dedupeKey: `VOLUNTEER:${simhastha._id}:${volunteer._id}`,
    });

    // ---------- Safety ----------
    await SosIncident.create({
        userId: pilgrim2._id, eventId: simhastha._id, type: 'MEDICAL', message: 'Elderly man fainted near the steps',
        location: { lat: 20.0062, lng: 73.7902, accuracy: 18 }, locationHistory: [{ lat: 20.0062, lng: 73.7902, at: new Date() }],
        status: 'OPEN',
    });
    await LostFoundReport.insertMany([
        {
            eventId: simhastha._id, kind: 'FOUND', personName: 'Unknown (says name is Gopal)', age: 7, gender: 'MALE',
            description: 'Speaks Marathi, knows his village is near Sinnar', clothes: 'Yellow t-shirt, blue shorts',
            lastSeenAt: 'Ramkund steps', currentlyAt: 'Police help post, Ramkund (Sector 1)', contactPhone: '112', reportedBy: authority._id,
        },
        {
            eventId: simhastha._id, kind: 'FOUND', personName: 'Kamalabai', age: 72, gender: 'FEMALE',
            description: 'Hard of hearing, from Nanded district', clothes: 'Green nauvari saree',
            lastSeenAt: 'Tapovan shuttle stop', currentlyAt: 'NMC Senior Citizens Dormitory, Sector 1', contactPhone: '9000000002', reportedBy: volunteer._id,
        },
        {
            eventId: simhastha._id, kind: 'MISSING', personName: 'Vitthal Shinde', age: 64, gender: 'MALE',
            description: 'Grey beard, walks with a stick', clothes: 'White dhoti-kurta, orange gamcha',
            lastSeenAt: 'Panchavati Karanja bus stop', contactPhone: '9000000006', reportedBy: pilgrim._id,
        },
    ]);

    console.log('\nSeed complete. All demo accounts use the password:', PASSWORD);
    console.table([
        { role: 'SUPER_ADMIN', phone: '9000000001', name: superAdmin.name },
        { role: 'AUTHORITY', phone: '9000000002', name: authority.name },
        { role: 'NGO_ADMIN', phone: '9000000003', name: `${ngoAdmin.name} (Shri Ram Seva Trust)` },
        { role: 'CORPORATE_ADMIN', phone: '9000000004', name: corporateAdmin.name },
        { role: 'VOLUNTEER', phone: '9000000005', name: volunteer.name },
        { role: 'USER', phone: '9000000006', name: pilgrim.name },
        { role: 'USER', phone: '9000000007', name: `${pilgrim2.name} (pending volunteer)` },
        { role: 'NGO_ADMIN', phone: '9000000008', name: `${ngoAdmin2.name} (Annadan Samiti)` },
        { role: 'USER', phone: '9000000009', name: `${applicant.name} (pending NGO)` },
    ]);
    console.log(`Corporate access code for "Simhastha Infrastructure & CSR Summit": 482913`);
    console.log(`Lodgings: ${lodgings.length}, kitchens: ${centers.length}, meal slots: ${slots.length}, public event: ${cleanup.title}, wari: ${wari.title}`);
    await mongoose.disconnect();
}

main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
});
