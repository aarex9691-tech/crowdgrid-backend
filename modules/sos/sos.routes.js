const express = require('express');
const sos = require('./sos.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

router.post('/', requireAuth, requirePermission('sos:create'), async (req, res) => {
    res.status(201).json(await sos.raise(req.user, req.body || {}));
});

router.get('/mine', requireAuth, async (req, res) => {
    res.json(await sos.mine(req.user._id));
});

router.get('/', requireAuth, requirePermission('sos:view'), async (req, res) => {
    res.json(await sos.list(req.user, { status: req.query.status && String(req.query.status), eventId: req.query.eventId && String(req.query.eventId) }));
});

router.patch('/:id', requireAuth, requirePermission('sos:manage'), async (req, res) => {
    res.json(await sos.update(req.params.id, req.user, req.body || {}));
});

module.exports = router;
