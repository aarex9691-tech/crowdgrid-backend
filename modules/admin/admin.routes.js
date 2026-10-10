const express = require('express');
const admin = require('./admin.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

router.get('/overview', requireAuth, requirePermission('platform:audit'), async (req, res) => {
    res.json(await admin.overview(req.query.eventId && String(req.query.eventId)));
});

module.exports = router;
