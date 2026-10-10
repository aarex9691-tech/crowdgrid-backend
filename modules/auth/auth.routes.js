const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('./auth.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// Slow down password guessing
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false });

router.post('/register', authLimiter, async (req, res) => {
    const { name, phone, email, password } = req.body || {};
    res.status(201).json(await auth.register({ name, phone, email, password }));
});

router.post('/login', authLimiter, async (req, res) => {
    res.json(await auth.login(req.body || {}));
});

router.get('/me', requireAuth, async (req, res) => {
    res.json(await auth.me(req.user._id));
});

router.post('/staff', requireAuth, requirePermission('staff:create'), async (req, res) => {
    res.status(201).json(await auth.createStaff(req.body || {}));
});

module.exports = router;
