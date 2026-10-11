const express = require('express');
const rateLimit = require('express-rate-limit');
const events = require('./event.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// Access-code guessing: 5 wrong codes per user per 15 minutes (correct codes don't count)
const codeAttempts = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `user:${req.user.id}`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many wrong access codes. Please wait 15 minutes and try again.' },
});

// Corporate Admin dashboard (declared before /:id so "corporate" is not read as an id)
router.get('/corporate/mine', requireAuth, async (req, res) => {
    res.json(await events.myCorporateEvents(req.user));
});

router.get('/', async (req, res) => {
    res.json(await events.list({ kind: req.query.kind && String(req.query.kind) }));
});

router.get('/:id', async (req, res) => {
    res.json(await events.get(req.params.id));
});

// Kind-specific permission (public vs corporate) is checked inside the service
router.post('/', requireAuth, async (req, res) => {
    res.status(201).json(await events.create(req.body, req.user));
});

router.put('/:id', requireAuth, async (req, res) => {
    res.json(await events.update(req.params.id, req.body, req.user));
});

router.delete('/:id', requireAuth, async (req, res) => {
    res.json(await events.archive(req.params.id, req.user));
});

router.post('/:id/rsvp', requireAuth, requirePermission('booking:create'), async (req, res) => {
    res.status(201).json(await events.rsvp(req.params.id, req.user));
});

router.post('/:id/corporate/verify', requireAuth, codeAttempts, async (req, res) => {
    res.json(await events.verifyCorporateCode(req.params.id, req.body && req.body.code));
});

router.post('/:id/corporate/badge', requireAuth, requirePermission('booking:create'), codeAttempts, async (req, res) => {
    res.status(201).json(await events.claimCorporateBadge(req.params.id, req.user, req.body || {}));
});

router.get('/:id/corporate/code', requireAuth, async (req, res) => {
    res.json(await events.getCorporateCode(req.params.id, req.user));
});

router.post('/:id/corporate/code', requireAuth, async (req, res) => {
    res.json(await events.regenerateCorporateCode(req.params.id, req.user));
});

router.get('/:id/corporate/attendees', requireAuth, async (req, res) => {
    res.json(await events.corporateAttendees(req.params.id, req.user));
});

module.exports = router;
