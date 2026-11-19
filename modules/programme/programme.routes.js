const express = require('express');
const programmes = require('./programme.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();
const status = (req) => (req.query.status ? String(req.query.status) : undefined);

// Pilgrims: approved programmes of a yatra (by id or its address name), and a free place with a QR
router.get('/yatra/:idOrSlug', async (req, res) => {
    res.json(await programmes.forYatra(req.params.idOrSlug));
});

router.post('/:id/register', requireAuth, requirePermission('booking:create'), async (req, res) => {
    res.status(201).json(await programmes.register(req.params.id, req.user, req.body || {}));
});

// Organisations: ask to hold a programme; see their own and who registered
router.post('/', requireAuth, requirePermission('programme:request'), async (req, res) => {
    res.status(201).json(await programmes.request(req.user, req.body || {}));
});

router.get('/mine', requireAuth, requirePermission('programme:request'), async (req, res) => {
    res.json(await programmes.mine(req.user));
});

router.get('/:id/attendees', requireAuth, async (req, res) => {
    res.json(await programmes.attendees(req.params.id, req.user));
});

// District Control Room: approve or reject with a reason
router.get('/', requireAuth, requirePermission('programme:review'), async (req, res) => {
    res.json(await programmes.listForReview({ status: status(req) }));
});

router.post('/:id/decision', requireAuth, requirePermission('programme:review'), async (req, res) => {
    const { decision, reason } = req.body || {};
    res.json(await programmes.decide(req.params.id, req.user, { decision, reason }));
});

module.exports = router;
