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

// Help desk: find an account by mobile number, then give it a temporary password
const mongoose = require('mongoose');
const helpdesk = require('../auth/helpdesk');
router.get('/accounts/lookup', requireAuth, requirePermission('account:reset'), async (req, res) => {
    res.json(await helpdesk.lookup(req.user, { countryCode: req.query.countryCode && String(req.query.countryCode), phone: req.query.phone && String(req.query.phone) }));
});
router.post('/accounts/:id/reset-password', requireAuth, requirePermission('account:reset'), async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Account not found' });
    res.json(await helpdesk.reset(req.user, req.params.id));
});

module.exports = router;
