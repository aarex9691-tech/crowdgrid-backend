const mongoose = require('mongoose');
const { Lodging } = require('../lodging/lodging.model');
const { FoodSlot } = require('../food/food.model');
const { Pass } = require('../pass/pass.model');
const Provider = require('../provider/provider.model');
const SosIncident = require('../sos/sos.model');
const { VolunteerApplication } = require('../volunteer/volunteer.model');
const LostFoundReport = require('../lostfound/lostfound.model');
const { istDate, istDateTime } = require('../../utils/time');
const nightsLib = require('../lodging/nights');

/** District operations overview: occupancy by sector, meal tokens, scans, alerts. */
const overview = async (eventId) => {
    const match = mongoose.isValidObjectId(eventId) ? { eventId: new mongoose.Types.ObjectId(String(eventId)) } : {};
    const today = istDate();
    const startOfDay = istDateTime(today, '00:00');

    const [occupancy, meals, passesIssued, scansToday, openSos, pendingProviders, pendingVolunteers, openMissing] = await Promise.all([
        // tonight's free beds per sector (availability is counted night by night)
        Lodging.find({ ...match, isActive: true }, 'sector totalBeds heldBeds')
            .lean()
            .then((ls) => nightsLib.attachAvailability(ls, { checkIn: today }))
            .then((ls) => {
                const by = new Map();
                for (const l of ls) {
                    const g = by.get(l.sector) || { _id: l.sector, total: 0, available: 0, camps: 0 };
                    g.total += l.totalBeds || 0;
                    g.available += l.availableBeds;
                    g.camps += 1;
                    by.set(l.sector, g);
                }
                return [...by.values()].sort((a, b) => String(a._id).localeCompare(String(b._id)));
            }),
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
