const express = require('express');
const passes = require('./pass.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// My Yatra Passbook: every pass the user holds, each with its signed QR payload
router.get('/mine', requireAuth, async (req, res) => {
    res.json(await passes.listMine(req.user._id));
});

// One personal QR for all of my passes. POST with { reset: true } to issue a new one.
router.get('/my-qr', requireAuth, async (req, res) => {
    res.json(await passes.myQr(req.user));
});
router.post('/my-qr/reset', requireAuth, async (req, res) => {
    res.json(await passes.myQr(req.user, { reset: true }));
});

// Ground staff QR scanner. Body: { qr, service?: ANY|FOOD|LODGING|TRANSIT|ENTRY|VOLUNTEER, passId? }
router.post('/scan', requireAuth, requirePermission('pass:scan'), async (req, res) => {
    const qr = passes.requireQr(req.body && req.body.qr);
    const service = String(req.body?.service || 'ANY').toUpperCase();
    const passId = req.body?.passId ? String(req.body.passId) : undefined;
    res.json(await passes.scan(qr, req.user, { service: passes.SERVICE_TYPES[service] !== undefined ? service : 'ANY', passId }));
});

module.exports = router;
