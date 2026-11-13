const express = require('express');
const volunteer = require('./volunteer.service');
const duty = require('./duty.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

router.post('/apply', requireAuth, requirePermission('volunteer:apply'), async (req, res) => {
    res.status(201).json(await volunteer.apply(req.user, req.body || {}));
});

router.get('/mine', requireAuth, async (req, res) => {
    res.json(await volunteer.mine(req.user._id));
});

router.get('/applications', requireAuth, requirePermission('volunteer:review'), async (req, res) => {
    res.json(
        await volunteer.listForReview(req.user, {
            status: req.query.status && String(req.query.status),
            eventId: req.query.eventId && String(req.query.eventId),
        })
    );
});

router.post('/applications/:id/review', requireAuth, requirePermission('volunteer:review'), async (req, res) => {
    res.json(await volunteer.review(req.params.id, req.user, req.body || {}));
});

// ---------- District control room: duties, live roster, coverage, broadcasts ----------
router.get('/control', requireAuth, requirePermission('volunteer:manage'), async (req, res) => {
    res.json(await duty.dashboard(req.query.eventId && String(req.query.eventId)));
});

router.post('/duties', requireAuth, requirePermission('volunteer:manage'), async (req, res) => {
    res.status(201).json(await duty.assign(req.user, req.body || {}));
});

router.patch('/duties/:id', requireAuth, requirePermission('volunteer:manage'), async (req, res) => {
    res.json(await duty.update(req.user, req.params.id, req.body || {}));
});

router.post('/broadcasts', requireAuth, requirePermission('volunteer:manage'), async (req, res) => {
    res.status(201).json(await duty.broadcast(req.user, req.body || {}));
});

// ---------- Volunteers: own duties and check-in ----------
router.get('/my-duty', requireAuth, requirePermission('duty:self'), async (req, res) => {
    res.json(await duty.mine(req.user));
});

router.post('/duties/:id/check-in', requireAuth, requirePermission('duty:self'), async (req, res) => {
    res.json(await duty.checkIn(req.user, req.params.id));
});

router.post('/duties/:id/check-out', requireAuth, requirePermission('duty:self'), async (req, res) => {
    res.json(await duty.checkOut(req.user, req.params.id));
});

module.exports = router;
