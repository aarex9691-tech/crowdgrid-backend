const express = require('express');
const transit = require('./transit.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
    res.json(await transit.list(String(req.query.eventId || ''), { date: req.query.date ? String(req.query.date) : undefined }));
});

router.post('/:id/pass', requireAuth, requirePermission('booking:create'), async (req, res) => {
    res.status(201).json(await transit.boardingPass(req.params.id, req.user, { people: req.body?.people, date: req.body?.date ? String(req.body.date) : undefined }));
});

module.exports = router;
