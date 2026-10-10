const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const lostfound = require('./lostfound.service');
const sanitize = require('../../middleware/sanitize');
const { requireAuth, optionalAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads', 'lostfound');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
    storage: multer.diskStorage({
        destination: UPLOAD_DIR,
        filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${{ 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '.jpg'}`),
    }),
    limits: { fileSize: 3 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)),
});

router.get('/', optionalAuth, async (req, res) => {
    const q = req.query;
    res.json(
        await lostfound.list(req.user, {
            kind: q.kind && String(q.kind),
            status: q.status && String(q.status),
            eventId: q.eventId && String(q.eventId),
            q: q.q && String(q.q),
        })
    );
});

// multipart/form-data with an optional "photo" file
router.post('/', requireAuth, upload.single('photo'), sanitize, async (req, res) => {
    const photoUrl = req.file ? `/uploads/lostfound/${req.file.filename}` : undefined;
    res.status(201).json(await lostfound.create(req.user, req.body || {}, photoUrl));
});

router.patch('/:id/reunited', requireAuth, requirePermission('report:manage'), async (req, res) => {
    res.json(await lostfound.markReunited(req.params.id));
});

module.exports = router;
