const mongoose = require('mongoose');
const { Lodging } = require('../lodging/lodging.model');
const { FoodSlot } = require('../food/food.model');
const { Pass } = require('../pass/pass.model');
const Provider = require('../provider/provider.model');
const SosIncident = require('../sos/sos.model');
const { VolunteerApplication } = require('../volunteer/volunteer.model');
const LostFoundReport = require('../lostfound/lostfound.model');
const { istDate, istDateTime } = require('../../utils/time');

/** District operations overview: occupancy by sector, meal tokens, scans, alerts. */
const overview = async (eventId) => {
    const match = mongoose.isValidObjectId(eventId) ? { eventId: new mongoose.Types.ObjectId(String(eventId)) } : {};
    const today = istDate();
    const startOfDay = istDateTime(today, '00:00');

    const [occupancy, meals, passesIssued, scansToday, openSos, pendingProviders, pendingVolunteers, openMissing] = await Promise.all([
        Lodging.aggregate([
            { $match: { ...match, isActive: true } },
            { $group: { _id: '$sector', total: { $sum: '$totalBeds' }, available: { $sum: '$availableBeds' }, camps: { $sum: 1 } } },
            { $sort: { _id: 1 } },
        ]),
        FoodSlot.aggregate([
            { $match: { ...match, date: today } },
            { $group: { _id: '$meal', capacity: { $sum: '$capacity' }, remaining: { $sum: '$remaining' } } },
        ]),
        Pass.aggregate([{ $match: { ...match, status: { $ne: 'CANCELLED' } } }, { $group: { _id: '$type', count: { $sum: 1 } } }]),
        Pass.countDocuments({ ...match, status: 'REDEEMED', redeemedAt: { $gte: startOfDay } }),
        SosIncident.countDocuments({ ...match, status: { $ne: 'RESOLVED' } }),
        Provider.countDocuments({ ...match, verificationStatus: 'PENDING' }),
        VolunteerApplication.countDocuments({ ...match, status: 'PENDING' }),
        LostFoundReport.countDocuments({ ...match, kind: 'MISSING', status: 'OPEN' }),
    ]);

    const sectors = occupancy.map((s) => ({
        sector: s._id,
        camps: s.camps,
        totalBeds: s.total,
        availableBeds: s.available,
        occupancyPct: s.total ? Math.round(((s.total - s.available) / s.total) * 100) : 0,
    }));
    const totalBeds = sectors.reduce((a, s) => a + s.totalBeds, 0);
    const availableBeds = sectors.reduce((a, s) => a + s.availableBeds, 0);

    return {
        date: today,
        beds: { total: totalBeds, available: availableBeds, occupancyPct: totalBeds ? Math.round(((totalBeds - availableBeds) / totalBeds) * 100) : 0 },
        sectors,
        meals: meals.map((m) => ({ meal: m._id, capacity: m.capacity, issued: m.capacity - m.remaining })),
        passesByType: Object.fromEntries(passesIssued.map((p) => [p._id, p.count])),
        scansToday,
        alerts: { openSos, pendingProviders, pendingVolunteers, openMissing },
    };
};

module.exports = { overview };
