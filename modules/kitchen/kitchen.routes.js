const express = require('express');
const multer = require('multer');
const kitchens = require('./kitchen.service');
const { MAX_DOCUMENT_BYTES } = require('../host/host.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// The licence / certificate comes as a file upload (field "document"); the other fields as text
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_DOCUMENT_BYTES, files: 1, fields: 20, fieldSize: 10 * 1024, parts: 25 } });
const oneDocument = (req, res, next) =>
    upload.single('document')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'The certificate is too large. Use a file under 2 MB.' });
        if (err) return res.status(400).json({ message: 'Could not read that file. Try a PDF or a photo.' });
        return next();
    });
const status = (req) => (req.query.status ? String(req.query.status) : undefined);

// 1. Recognition by the Super Admin
router.post('/apply', requireAuth, requirePermission('kitchen:apply'), oneDocument, async (req, res) => {
    res.status(201).json(await kitchens.apply(req.user, req.body || {}, req.file?.buffer));
});

router.get('/mine', requireAuth, async (req, res) => {
    res.json(await kitchens.mine(req.user));
});

router.get('/applications', requireAuth, requirePermission('kitchen:review'), async (req, res) => {
    res.json(await kitchens.list({ status: status(req) }));
});

router.get('/applications/:id/document', requireAuth, async (req, res) => {
    const { data, contentType } = await kitchens.document(req.params.id, req.user);
    res.set({
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="certificate.${contentType === 'application/pdf' ? 'pdf' : contentType.split('/')[1]}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
    res.send(data);
});

router.post('/applications/:id/decision', requireAuth, requirePermission('kitchen:review'), async (req, res) => {
    const { decision, reason } = req.body || {};
    res.json(await kitchens.decide(req.params.id, req.user, { decision, reason }));
});

// 2. Serving at a yatra: asked by the Kitchen Manager, decided by the District Control Room
router.post('/service-requests', requireAuth, requirePermission('kitchen:serve'), async (req, res) => {
    res.status(201).json(await kitchens.requestService(req.user, req.body || {}));
});

router.get('/service-requests', requireAuth, requirePermission('service:review'), async (req, res) => {
    res.json(await kitchens.listServiceRequests(req.user, { status: status(req) }));
});

router.post('/service-requests/:id/decision', requireAuth, requirePermission('service:review'), async (req, res) => {
    const { decision, reason } = req.body || {};
    res.json(await kitchens.decideService(req.params.id, req.user, { decision, reason }));
});

// 3. The kitchen dashboard for one approved yatra
router.get('/yatras', requireAuth, requirePermission('kitchen:serve'), async (req, res) => {
    res.json(await kitchens.myYatras(req.user));
});

router.get('/yatras/:eventId/dashboard', requireAuth, requirePermission('kitchen:serve'), async (req, res) => {
    res.json(await kitchens.dashboard(req.user, req.params.eventId));
});

router.post('/yatras/:eventId/kitchens', requireAuth, requirePermission('kitchen:serve'), async (req, res) => {
    res.status(201).json(await kitchens.addKitchen(req.user, req.params.eventId, req.body || {}));
});

router.put('/yatras/:eventId/kitchens/:centerId/meals', requireAuth, requirePermission('kitchen:serve'), async (req, res) => {
    res.json(await kitchens.setMealQuota(req.user, req.params.eventId, req.params.centerId, req.body || {}));
});

module.exports = router;
