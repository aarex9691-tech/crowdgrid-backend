const express = require('express');
const multer = require('multer');
const hosts = require('./host.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// The registration certificate comes as a file upload (field "document"); the other fields as text
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: hosts.MAX_DOCUMENT_BYTES, files: 1, fields: 20 } });
const oneDocument = (req, res, next) =>
    upload.single('document')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'The certificate is too large. Use a file under 2 MB.' });
        if (err) return res.status(400).json({ message: 'Could not read that file. Try a PDF or a photo.' });
        return next();
    });

router.post('/apply', requireAuth, requirePermission('host:apply'), oneDocument, async (req, res) => {
    res.status(201).json(await hosts.apply(req.user, req.body || {}, req.file?.buffer));
});

router.get('/mine', requireAuth, async (req, res) => {
    res.json(await hosts.mine(req.user));
});

router.get('/', requireAuth, requirePermission('host:review'), async (req, res) => {
    res.json(await hosts.list({ status: req.query.status ? String(req.query.status) : undefined }));
});

// The certificate: shown inline to the applicant or the Super Admin, never cached, never sniffed
router.get('/:id/document', requireAuth, async (req, res) => {
    const { data, contentType } = await hosts.document(req.params.id, req.user);
    res.set({
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="certificate.${contentType === 'application/pdf' ? 'pdf' : contentType.split('/')[1]}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
    res.send(data);
});

router.post('/:id/decision', requireAuth, requirePermission('host:review'), async (req, res) => {
    const { decision, note, reason } = req.body || {};
    res.json(await hosts.decide(req.params.id, req.user, { decision, note, reason }));
});

module.exports = router;
