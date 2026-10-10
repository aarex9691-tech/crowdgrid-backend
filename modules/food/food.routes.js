const express = require('express');
const food = require('./food.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// GET /api/food?eventId=...&sector=...&date=YYYY-MM-DD
router.get('/', async (req, res) => {
    const q = req.query;
    res.json(await food.listCenters(String(q.eventId || ''), { sector: q.sector && String(q.sector), date: q.date && String(q.date) }));
});

router.post('/slots/:id/claim', requireAuth, requirePermission('booking:create'), async (req, res) => {
    res.status(201).json(await food.claim(req.params.id, req.user));
});

module.exports = router;
