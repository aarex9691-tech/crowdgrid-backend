/**
 * Cancelling a pass from the passbook, with the refund policy.
 *
 *   48 h or more before it starts  -> 100% refund
 *   24 to 48 h before              ->  50% refund
 *   less than 24 h before          ->   0% (can still cancel to free the place)
 *   started, used or expired       ->  cannot cancel
 *
 * Free passes can be cancelled until they start; the bed, plate or seat goes
 * straight back to other pilgrims. Corporate badges and volunteer IDs are not
 * cancelled here (they are managed by the host / NGO).
 */
const mongoose = require('mongoose');
const { Pass } = require('./pass.model');
const { toClient } = require('./pass.service');
const Order = require('../order/order.model');
const { gateway } = require('../order/payment');
const Event = require('../event/event.model');
const { FoodSlot } = require('../food/food.model');
const lodging = require('../lodging/lodging.service');
const audit = require('../audit/audit.service');
const realtime = require('../../utils/realtime');
const { badRequest, notFound, conflict } = require('../../utils/httpError');

const HOUR = 3600 * 1000;
const POLICY = [
    { hours: 48, percent: 100 },
    { hours: 24, percent: 50 },
    { hours: 0, percent: 0 },
];
const CANCELLABLE = ['LODGING', 'MEAL', 'TRANSIT', 'PUBLIC'];
const WORD = { LODGING: 'stay', MEAL: 'meal token', TRANSIT: 'bus pass', PUBLIC: 'event ticket' };

/** When the thing on the pass begins (check-in day, meal slot, travel day, event start). */
const startOf = (pass) => new Date(pass.type === 'PUBLIC' && pass.details?.startsAt ? pass.details.startsAt : pass.validFrom);

/** Pure refund rule: percent and rupees back for a cancellation at `now`. */
const refundFor = (startsAt, paid, now = new Date()) => {
    const hoursLeft = (new Date(startsAt).getTime() - now.getTime()) / HOUR;
    const tier = POLICY.find((t) => hoursLeft >= t.hours) || POLICY[POLICY.length - 1];
    const percent = paid > 0 ? tier.percent : 0;
    return { hoursLeft, percent, amount: Math.round((paid * percent) / 100) };
};

/** Why this pass cannot be cancelled now, or null if it can. */
const blocker = (pass, now) => {
    if (!CANCELLABLE.includes(pass.type)) return 'This pass is managed by the organiser and cannot be cancelled here';
    if (pass.status === 'CANCELLED') return 'This pass is already cancelled';
    if (pass.status === 'REDEEMED') return 'This pass has already been used';
    if (now >= startOf(pass)) return `This ${WORD[pass.type]} has already started, so it can no longer be cancelled`;
    return null;
};

const findMine = async (passId, user) => {
    if (!mongoose.isValidObjectId(passId)) throw notFound('Pass not found');
    const pass = await Pass.findOne({ _id: passId, userId: user._id });
    if (!pass) throw notFound('Pass not found');
    return pass;
};

/** What the pop-up shows before the pilgrim confirms. */
const quote = async (passId, user, now = new Date()) => {
    const pass = await findMine(passId, user);
    const startsAt = startOf(pass);
    const paid = pass.details?.paid || 0;
    const why = blocker(pass, now);
    const r = refundFor(startsAt, paid, now);
    return {
        passId: String(pass._id),
        type: pass.type,
        title: pass.title,
        cancellable: !why,
        reason: why,
        startsAt,
        paid,
        refund: why ? 0 : r.amount,
        percent: why ? 0 : r.percent,
        charge: why ? 0 : paid - r.amount,
        fullRefundUntil: paid > 0 ? new Date(startsAt.getTime() - 48 * HOUR) : null,
        halfRefundUntil: paid > 0 ? new Date(startsAt.getTime() - 24 * HOUR) : null,
        policy: paid > 0 ? 'Full refund up to 48 hours before it starts, 50% up to 24 hours before, no refund after that.' : 'This is free. Cancelling gives your place to another pilgrim.',
    };
};

/** Gives the bed / plates / seats back. Lodging also frees the exact beds in the tent map. */
const release = async (pass, user) => {
    const people = pass.details?.people || 1;
    if (pass.type === 'MEAL') {
        await FoodSlot.updateOne({ _id: pass.refId }, { $inc: { remaining: people } });
        realtime.notify(['public', 'control', `provider:${pass.providerId}`], 'meals', { slotId: String(pass.refId) });
    } else if (pass.type === 'PUBLIC') {
        await Event.updateOne({ _id: pass.eventId, attendeesCount: { $gte: people } }, { $inc: { attendeesCount: -people } });
        realtime.notify(['public', 'control'], 'tickets', { eventId: String(pass.eventId) });
    }
    // TRANSIT: shuttles have no seat count, nothing to give back
};

/** Cancels the pass, frees the place and refunds by the policy. */
const cancel = async (passId, user, now = new Date()) => {
    const q = await quote(passId, user, now);
    if (!q.cancellable) throw badRequest(q.reason);
    const pass = await findMine(passId, user);
    // Written in the SAME update that cancels the pass, so a crash can never leave a
    // cancelled pass without its refund record (the gateway reference is added after)
    const cancelFields = { cancelledAt: now, refund: { amount: q.refund, percent: q.percent } };

    if (pass.type === 'LODGING') {
        // the lodging service cancels the booking, frees the beds and voids the pass in one transaction
        await lodging.cancel(pass.refId, user, { passUpdate: cancelFields });
    } else {
        // atomic: only one cancel can flip an active pass, and never after it starts
        const flipped = await Pass.findOneAndUpdate(
            { _id: pass._id, status: 'ACTIVE' },
            { $set: { status: 'CANCELLED', ...cancelFields }, $unset: { dedupeKey: 1 } },
            { returnDocument: 'after' }
        );
        if (!flipped) throw conflict('This pass was just used or cancelled');
        await release(pass, user);
    }

    if (q.refund > 0) {
        const orderId = pass.details?.orderId && mongoose.isValidObjectId(pass.details.orderId) ? pass.details.orderId : null;
        const order = orderId ? await Order.findById(orderId, 'payment.reference').lean() : null;
        const r = await gateway().refund({ amount: q.refund, reference: order?.payment?.reference });
        await Pass.updateOne({ _id: pass._id }, { $set: { 'refund.reference': r.reference } });
        if (orderId) await Order.updateOne({ _id: orderId }, { $inc: { refunded: q.refund } });
    }
    const done = await Pass.findById(pass._id).lean();

    audit.record({
        actor: user,
        action: 'PASS_CANCELLED',
        targetType: 'Pass',
        targetId: pass._id,
        summary: `${user.name} cancelled a ${WORD[pass.type]} (${pass.title})${q.paid ? `, refund ₹${q.refund} of ₹${q.paid}` : ''}`,
    });
    realtime.notify([`user:${user._id}`], 'passes', { passId: String(pass._id) });

    const message = q.paid
        ? q.refund > 0
            ? `Cancelled. ₹${q.refund} (${q.percent}%) will be refunded to your original payment method in 5 to 7 working days.`
            : 'Cancelled. No refund is due as it was less than 24 hours before the start.'
        : 'Cancelled. Your place has been given back for other pilgrims.';
    return { message, refund: q.refund, percent: q.percent, pass: toClient(done) };
};

module.exports = { quote, cancel, refundFor, startOf, POLICY, CANCELLABLE };
