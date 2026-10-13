const express = require('express');
const rateLimit = require('express-rate-limit');
const orders = require('./order.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// Slow down card / UPI guessing: 10 payment attempts per user per 15 minutes
const payAttempts = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    keyGenerator: (req) => `user:${req.user?._id}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many payment attempts. Please wait 15 minutes.' },
});

router.use(requireAuth);

// POST /api/orders  { items: [{ kind: 'LODGING'|'TRANSIT', refId, input }] }
router.post('/', requirePermission('booking:create'), async (req, res) => {
    res.status(201).json(await orders.create(req.user, req.body?.items));
});

router.get('/mine', async (req, res) => {
    res.json(await orders.mine(req.user));
});

router.get('/:id', async (req, res) => {
    res.json(await orders.get(req.params.id, req.user));
});

// POST /api/orders/:id/pay  { method: 'UPI', upiId } or { method: 'CARD', cardNumber, expiry, cvv }
router.post('/:id/pay', requirePermission('booking:create'), payAttempts, async (req, res) => {
    res.json(await orders.pay(req.params.id, req.user, req.body || {}));
});

router.post('/:id/cancel', async (req, res) => {
    res.json(await orders.cancel(req.params.id, req.user));
});

module.exports = router;
