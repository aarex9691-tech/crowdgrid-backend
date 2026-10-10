const express = require('express');
const lodging = require('./lodging.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// GET /api/lodgings?eventId=...&sector=...&category=...&minBeds=...
router.get('/', async (req, res) => {
    const q = req.query;
    res.json(
        await lodging.search(String(q.eventId || ''), {
            sector: q.sector && String(q.sector),
            category: q.category && String(q.category),
            minBeds: q.minBeds && String(q.minBeds),
        })
    );
});

router.get('/bookings/mine', requireAuth, async (req, res) => {
    res.json(await lodging.mine(req.user._id));
});

router.post('/:id/book', requireAuth, requirePermission('booking:create'), async (req, res) => {
    res.status(201).json(await lodging.book(req.params.id, req.user, req.body || {}));
});

router.post('/bookings/:id/cancel', requireAuth, async (req, res) => {
    res.json(await lodging.cancel(req.params.id, req.user));
});

module.exports = router;
