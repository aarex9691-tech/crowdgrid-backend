const express = require('express');
const multer = require('multer');
const mongoose = require('mongoose');
const lostfound = require('./lostfound.service');
const { Photo } = require('./photo.model');
const sanitize = require('../../middleware/sanitize');
const { requireAuth, optionalAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// Photos are kept in memory, checked, and saved to MongoDB only once the report is valid
// (nothing is written to the server's disk, which Render wipes on every restart).
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 3 * 1024 * 1024, files: 1 },
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

// The photo itself (public, like the bulletin; ids are random and unguessable)
router.get('/photos/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Photo not found' });
    const photo = await Photo.findById(req.params.id); // not lean: `data` comes back as a Node Buffer
    if (!photo) return res.status(404).json({ message: 'Photo not found' });
    res.set({ 'Content-Type': photo.contentType, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.send(Buffer.from(photo.data));
});

// multipart/form-data with an optional "photo" file
router.post('/', requireAuth, upload.single('photo'), sanitize, async (req, res) => {
    const photo = req.file ? { buffer: req.file.buffer } : null;
    res.status(201).json(await lostfound.create(req.user, req.body || {}, photo));
});

router.patch('/:id/reunited', requireAuth, requirePermission('report:manage'), async (req, res) => {
    res.json(await lostfound.markReunited(req.params.id, req.user));
});

module.exports = router;
