const mongoose = require('mongoose');
const Order = require('./order.model');
const { gateway } = require('./payment');
const lodging = require('../lodging/lodging.service');
const transit = require('../transit/transit.service');
const events = require('../event/event.service');
const { Pass } = require('../pass/pass.model');
const { toClient } = require('../pass/pass.service');
const audit = require('../audit/audit.service');
const { HttpError, badRequest, notFound, conflict } = require('../../utils/httpError');
const realtime = require('../../utils/realtime');

const MAX_ITEMS = 10;

/** Prices one cart line on the server (the browser's price is never trusted). */
const priceItem = async (raw, user) => {
    const kind = String(raw?.kind || '').toUpperCase();
    const refId = String(raw?.refId || '');
    if (!mongoose.isValidObjectId(refId)) throw badRequest('Invalid item in cart');
    if (kind === 'LODGING') {
        const input = {
            beds: Number(raw.input?.beds),
            checkIn: raw.input?.checkIn && String(raw.input.checkIn),
            checkOut: raw.input?.checkOut && String(raw.input.checkOut),
            guestNames: Array.isArray(raw.input?.guestNames) ? raw.input.guestNames.map((n) => String(n).slice(0, 60)).slice(0, 4) : [],
        };
        const q = await lodging.quote(refId, input);
        return { kind, refId, input: { ...input, ...q.stay }, label: q.label, detail: q.detail, amount: q.amount };
    }
    if (kind === 'TRANSIT') {
        const q = await transit.quote(refId);
        return { kind, refId, label: q.label, detail: q.detail, amount: q.amount };
    }
    if (kind === 'EVENT') {
        const q = await events.quote(refId, user);
        return { kind, refId, label: q.label, detail: q.detail, amount: q.amount };
    }
    throw badRequest('Only paid camps, bus passes and event tickets go through checkout');
};

const toView = (order, passes = []) => {
    const o = order.toObject ? order.toObject() : order;
    return { ...o, passes: passes.map(toClient) };
};

/** Creates a PENDING order from the cart, priced on the server. */
const create = async (user, items) => {
    if (!Array.isArray(items) || items.length === 0) throw badRequest('Your cart is empty');
    if (items.length > MAX_ITEMS) throw badRequest(`At most ${MAX_ITEMS} items per order`);
    const priced = [];
    for (const raw of items) {
        try {
            priced.push(await priceItem(raw, user));
        } catch (err) {
            throw new HttpError(err.status || 400, `${raw?.label || 'An item'}: ${err.message}`);
        }
    }
    const total = priced.reduce((s, i) => s + i.amount, 0);
    const order = await Order.create({ userId: user._id, items: priced, total });
    return toView(order);
};

const findMine = async (orderId, user) => {
    if (!mongoose.isValidObjectId(orderId)) throw notFound('Order not found');
    const order = await Order.findOne({ _id: orderId, userId: user._id });
    if (!order) throw notFound('Order not found');
    return order;
};

/** Issues the passes for a paid order; anything that can no longer be issued is refunded. */
const fulfil = async (order, user) => {
    for (const item of order.items) {
        if (item.status !== 'PENDING') continue;
        const paidByOrder = { _id: order._id, amount: item.amount };
        try {
            const res =
                item.kind === 'LODGING'
                    ? await lodging.book(item.refId, user, item.input || {}, { paidByOrder })
                    : item.kind === 'EVENT'
                      ? await events.register(item.refId, user, { paidByOrder })
                      : await transit.boardingPass(item.refId, user, { paidByOrder });
            if (res.existing) throw new Error('You already had a pass for this today');
            item.status = 'ISSUED';
            item.passId = res.pass._id;
        } catch (err) {
            item.status = 'FAILED';
            item.error = err.message;
            order.refunded += item.amount;
        }
    }
    if (order.refunded > 0) await gateway().refund({ amount: order.refunded, reference: order.payment.reference });
};

/**
 * Pays an order through the payment gateway (simulated by default).
 * The PENDING -> PROCESSING switch is atomic, so a double tap on "Pay"
 * can never charge twice or issue passes twice.
 */
const pay = async (orderId, user, body = {}) => {
    const order = await findMine(orderId, user);
    const locked = await Order.findOneAndUpdate(
        { _id: order._id, status: 'PENDING' },
        { $set: { status: 'PROCESSING' } },
        { returnDocument: 'after' }
    );
    if (!locked) {
        if (order.status === 'PAID') throw conflict('This order is already paid');
        throw conflict('Payment is already in progress for this order');
    }

    const method = locked.total === 0 ? 'FREE' : String(body.method || '').toUpperCase();
    // A ₹0 order (free items only) is confirmed without going to the payment gateway
    const result =
        locked.total === 0
            ? { ok: true, account: '-', reference: `FREE${String(locked._id).slice(-8).toUpperCase()}` }
            : await gateway().charge({
                  amount: locked.total,
                  method,
                  upiId: body.upiId,
                  cardNumber: body.cardNumber,
                  expiry: body.expiry,
                  cvv: body.cvv,
              });
    if (!result.ok) {
        await Order.updateOne({ _id: locked._id }, { $set: { status: 'PENDING', 'payment.lastError': result.message } });
        throw new HttpError(402, result.message);
    }

    locked.status = 'PAID';
    locked.payment = { provider: locked.total === 0 ? 'NONE' : gateway().name, method, account: result.account, reference: result.reference, paidAt: new Date() };
    await fulfil(locked, user);
    await locked.save();

    audit.record({
        actor: user,
        action: 'PAYMENT',
        targetType: 'Order',
        targetId: locked._id,
        summary: `${user.name} paid ₹${locked.total} (${method}, ${result.reference})${locked.refunded ? `, ₹${locked.refunded} refunded` : ''}`,
    });
    realtime.notify('control', 'sales', { orderId: String(locked._id) });
    const passes = await Pass.find({ _id: { $in: locked.items.map((i) => i.passId).filter(Boolean) } });
    return toView(locked, passes);
};

const get = async (orderId, user) => {
    const order = await findMine(orderId, user);
    const passes = await Pass.find({ _id: { $in: order.items.map((i) => i.passId).filter(Boolean) } });
    return toView(order, passes);
};

const mine = async (user) => Order.find({ userId: user._id }).sort({ createdAt: -1 }).limit(50).lean();

const cancel = async (orderId, user) => {
    const order = await Order.findOneAndUpdate(
        { _id: orderId, userId: user._id, status: 'PENDING' },
        { $set: { status: 'CANCELLED' } },
        { returnDocument: 'after' }
    );
    if (!order) throw conflict('Only unpaid orders can be cancelled');
    return { message: 'Order cancelled' };
};

module.exports = { create, pay, get, mine, cancel };
