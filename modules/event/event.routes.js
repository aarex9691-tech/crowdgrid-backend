const express = require('express');
const events = require('./event.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

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

router.post('/:id/corporate/verify', requireAuth, async (req, res) => {
    res.json(await events.verifyCorporateCode(req.params.id, req.body && req.body.code));
});

router.post('/:id/corporate/badge', requireAuth, requirePermission('booking:create'), async (req, res) => {
    res.status(201).json(await events.claimCorporateBadge(req.params.id, req.user, req.body || {}));
});

module.exports = router;
