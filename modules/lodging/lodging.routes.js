const express = require('express');
const lodging = require('./lodging.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// GET /api/lodgings?eventId=...&sector=...&category=...&minBeds=...&checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD
// availableBeds = beds free on every night of that stay (default: the next night)
router.get('/', async (req, res) => {
    const q = req.query;
    res.json(
        await lodging.search(String(q.eventId || ''), {
            sector: q.sector && String(q.sector),
            category: q.category && String(q.category),
            minBeds: q.minBeds && String(q.minBeds),
            checkIn: typeof q.checkIn === 'string' ? q.checkIn : undefined,
            checkOut: typeof q.checkOut === 'string' ? q.checkOut : undefined,
        })
    );
});

// Theatre-style tent / bed map for one night (?date=YYYY-MM-DD; camp staff and authorities)
router.get('/:id/bed-map', requireAuth, requirePermission('inventory:view'), async (req, res) => {
    res.json(await lodging.bedMap(req.params.id, req.user, { date: typeof req.query.date === 'string' ? req.query.date : undefined }));
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
