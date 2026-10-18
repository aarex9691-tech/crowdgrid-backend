const express = require('express');
const analytics = require('./analytics.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();
const q = (req) => ({ eventId: req.query.eventId && String(req.query.eventId), days: req.query.days && String(req.query.days), report: req.query.report && String(req.query.report), providerId: req.query.providerId && String(req.query.providerId) });

// District control room: bookings, meals, occupancy, revenue, SOS response, busiest scan hours
router.get('/overview', requireAuth, requirePermission('analytics:view'), async (req, res) => {
    res.json(await analytics.overview(q(req)));
});

// Download a report as CSV (opens in Excel / Google Sheets)
router.get('/export', requireAuth, requirePermission('analytics:view'), async (req, res) => {
    const { filename, body } = await analytics.exportCsv(q(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(`﻿${body}`); // BOM so Excel reads ₹ and Indian names correctly
});

// NGO portal: the organisation's own camps and kitchens
router.get('/ngo', requireAuth, requirePermission('analytics:ngo'), async (req, res) => {
    res.json(await analytics.ngoOverview(req.user, q(req)));
});

module.exports = router;
