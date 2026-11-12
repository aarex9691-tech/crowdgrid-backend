const mongoose = require('mongoose');
const { badRequest } = require('../../utils/httpError');

/**
 * Beds one person holds on one night of one yatra, as an atomic counter.
 *
 * The limit of 5 beds a night used to be checked by reading the person's bookings and then
 * booking: two requests in the same second could both read "0 held" and take 5 beds each.
 * Claiming "+beds only while the total stays within 5" in one database operation closes that gap,
 * the same way LodgingNight protects a camp's capacity.
 */
const personNightSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
    date: { type: String, required: true }, // YYYY-MM-DD (IST)
    beds: { type: Number, default: 0, min: 0 },
});
personNightSchema.index({ userId: 1, eventId: 1, date: 1 }, { unique: true });
const PersonNight = mongoose.models.PersonNight || mongoose.model('PersonNight', personNightSchema);

/** One night: "+beds while it stays within max". True if claimed. */
const claimOne = async (key, beds, max) => {
    const filter = { ...key, beds: { $lte: max - beds } };
    try {
        return !!(await PersonNight.findOneAndUpdate(filter, { $inc: { beds } }, { upsert: true, returnDocument: 'after' }));
    } catch (err) {
        if (err.code !== 11000) throw err;
        // the row exists but is too full to match, or two first claims raced to create it
        return !!(await PersonNight.findOneAndUpdate(filter, { $inc: { beds } }, { returnDocument: 'after' }));
    }
};

const release = async (userId, eventId, dates, beds, session = null) => {
    if (!dates.length || !beds) return;
    await PersonNight.updateMany({ userId, eventId, date: { $in: dates }, beds: { $gte: beds } }, { $inc: { beds: -beds } }, { session });
};

/** Claims `beds` for this person on every night, or none; throws 400 naming the limit. */
const claim = async (userId, eventId, dates, beds, max) => {
    const taken = [];
    for (const date of dates) {
        let ok;
        try {
            ok = await claimOne({ userId, eventId, date }, beds, max);
        } catch (err) {
            // a database error part-way: give back the nights already claimed, then report the error
            await release(userId, eventId, taken, beds).catch((e) => console.error(`[lodging] could not release the person cap for ${userId}: ${e.message}`));
            throw err;
        }
        if (ok) {
            taken.push(date);
            continue;
        }
        await release(userId, eventId, taken, beds);
        throw badRequest(`Limit is ${max} beds per person on any night. You already hold beds on ${date}.`);
    }
};

module.exports = { PersonNight, claim, release };
