const mongoose = require('mongoose');

/**
 * One planned walking route: the lanes a pilgrim was sent along, and when.
 * Kept in MongoDB (not in the server's memory) so any number of servers share the same
 * picture of where people are heading. MongoDB deletes each entry by itself after the
 * load window (TTL index), so the collection never grows.
 */
const LOAD_WINDOW_MIN = 15;

const routePlanSchema = new mongoose.Schema({
    laneIds: { type: [String], required: true },
    at: { type: Date, required: true, default: Date.now },
});
// MongoDB's TTL monitor runs about once a minute, so queries still filter on `at` too
routePlanSchema.index({ at: 1 }, { expireAfterSeconds: LOAD_WINDOW_MIN * 60 });

module.exports = { RoutePlan: mongoose.models.RoutePlan || mongoose.model('RoutePlan', routePlanSchema), LOAD_WINDOW_MIN };
