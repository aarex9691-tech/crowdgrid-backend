const express = require('express');
const volunteer = require('./volunteer.service');
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

module.exports = router;
