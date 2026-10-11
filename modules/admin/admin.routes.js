const express = require('express');
const admin = require('./admin.service');
const audit = require('../audit/audit.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

router.get('/overview', requireAuth, requirePermission('platform:audit'), async (req, res) => {
    res.json(await admin.overview(req.query.eventId && String(req.query.eventId)));
});

// Recent audit trail for the control room
router.get('/audit', requireAuth, requirePermission('platform:audit'), async (req, res) => {
    res.json(await audit.recent({ limit: req.query.limit && String(req.query.limit), action: req.query.action && String(req.query.action) }));
});

module.exports = router;
