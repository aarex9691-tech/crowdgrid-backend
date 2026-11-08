/**
 * "Up to N per day" counters with no overselling, shared by shuttles (and usable elsewhere).
 *
 * One document per (thing, day) holds `booked`. A claim is ONE atomic conditional
 * update: $inc only while booked + amount <= capacity. The first claim of a day
 * creates the row (upsert); if two first claims race, or the row exists but is full,
 * the duplicate-key error is caught and the update is tried once without creating.
 */
const claim = async (Model, key, amount, capacity) => {
    if (amount > capacity) return false;
    const filter = { ...key, booked: { $lte: capacity - amount } };
    try {
        return !!(await Model.findOneAndUpdate(filter, { $inc: { booked: amount } }, { upsert: true, returnDocument: 'after' }));
    } catch (err) {
        if (err.code !== 11000) throw err;
        return !!(await Model.findOneAndUpdate(filter, { $inc: { booked: amount } }, { returnDocument: 'after' }));
    }
};

const release = (Model, key, amount, session = null) =>
    Model.updateOne({ ...key, booked: { $gte: amount } }, { $inc: { booked: -amount } }, { session });

const bookedOn = async (Model, key) => (await Model.findOne(key, 'booked').lean())?.booked || 0;

module.exports = { claim, release, bookedOn };
