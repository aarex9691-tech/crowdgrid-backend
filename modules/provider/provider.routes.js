const express = require('express');
const providers = require('./provider.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

router.post('/apply', requireAuth, requirePermission('provider:apply'), async (req, res) => {
    res.status(201).json(await providers.apply(req.user, req.body || {}));
});

router.get('/verified', async (req, res) => {
    res.json(await providers.listVerified(String(req.query.eventId || '')));
});

router.get('/mine', requireAuth, async (req, res) => {
    res.json(await providers.mine(req.user._id));
});

router.get('/', requireAuth, requirePermission('provider:verify'), async (req, res) => {
    res.json(await providers.list({ status: req.query.status && String(req.query.status), eventId: req.query.eventId && String(req.query.eventId) }));
});

router.post('/:id/decision', requireAuth, requirePermission('provider:verify'), async (req, res) => {
    res.json(await providers.decide(req.params.id, req.user, req.body || {}));
});

module.exports = router;
