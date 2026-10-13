const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('./auth.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// Slow down password guessing
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many attempts from this network. Please wait 15 minutes and try again.' },
});

router.post('/register', authLimiter, async (req, res) => {
    const { name, phone, countryCode, email, password } = req.body || {};
    res.status(201).json(await auth.register({ name, phone, countryCode, email, password }));
});

router.post('/login', authLimiter, async (req, res) => {
    res.json(await auth.login(req.body || {}));
});

router.get('/me', requireAuth, async (req, res) => {
    res.json(await auth.me(req.user._id));
});

// Edit profile (email, date of birth, gender, city, emergency contact)
router.patch('/me', requireAuth, async (req, res) => {
    res.json(await auth.updateProfile(req.user, req.body || {}));
});

router.post('/logout-all', requireAuth, async (req, res) => {
    res.json(await auth.logoutAll(req.user));
});

router.post('/staff', requireAuth, requirePermission('staff:create'), async (req, res) => {
    res.status(201).json(await auth.createStaff(req.body || {}, req.user));
});

module.exports = router;
