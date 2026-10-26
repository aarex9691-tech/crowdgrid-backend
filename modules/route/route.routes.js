const express = require('express');
const route = require('./route.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();
const q = (req) => Object.fromEntries(['eventId', 'from', 'to', 'lat', 'lng'].map((k) => [k, typeof req.query[k] === 'string' ? req.query[k] : undefined]));

// Public: anyone (even without an account) can plan a walk to a ghat
router.get('/network', async (req, res) => {
    res.json(await route.network(q(req)));
});

router.get('/plan', async (req, res) => {
    res.json(await route.plan(q(req)));
});

router.patch('/lanes/:laneId', requireAuth, requirePermission('route:manage'), async (req, res) => {
    res.json(await route.setLane(req.user, req.params.laneId, req.body || {}));
});

module.exports = router;
