const express = require('express');
const passes = require('./pass.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// My Yatra Passbook: every pass the user holds, each with its signed QR payload
router.get('/mine', requireAuth, async (req, res) => {
    res.json(await passes.listMine(req.user._id));
});

// Ground staff QR scanner
router.post('/scan', requireAuth, requirePermission('pass:scan'), async (req, res) => {
    const qr = passes.requireQr(req.body && req.body.qr);
    res.json(await passes.scan(qr, req.user));
});

module.exports = router;
