const express = require('express');
const multer = require('multer');
const volunteer = require('./volunteer.service');
const duty = require('./duty.service');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// The application comes as a form upload: the details as fields, the photo of the ID card as "idCard"
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: volunteer.MAX_ID_BYTES, files: 1, fields: 20, fieldSize: 10 * 1024, parts: 25 } });
const oneIdCard = (req, res, next) =>
    upload.single('idCard')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'The ID photo is too large. Use a file under 2 MB.' });
        if (err) return res.status(400).json({ message: 'Could not read that file. Try a photo or a PDF.' });
        return next();
    });

router.post('/apply', requireAuth, requirePermission('volunteer:apply'), oneIdCard, async (req, res) => {
    res.status(201).json(await volunteer.apply(req.user, req.body || {}, req.file?.buffer || null));
});

router.get('/mine', requireAuth, async (req, res) => {
    res.json(await volunteer.mine(req.user._id));
});

router.get('/applications', requireAuth, requirePermission('volunteer:list'), async (req, res) => {
    res.json(
        await volunteer.listForReview(req.user, {
            status: req.query.status && String(req.query.status),
            eventId: req.query.eventId && String(req.query.eventId),
            idVerified: req.query.idVerified && String(req.query.idVerified),
        })
    );
});

router.post('/applications/:id/review', requireAuth, requirePermission('volunteer:review'), async (req, res) => {
    res.json(await volunteer.review(req.params.id, req.user, req.body || {}));
});

// The ID card photo (control room, Super Admin, or the volunteer), served so a browser never runs it
router.get('/applications/:id/id-card', requireAuth, async (req, res) => {
    const { data, contentType } = await volunteer.idDocument(req.params.id, req.user);
    res.set({
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="id-card.${contentType === 'application/pdf' ? 'pdf' : contentType.split('/')[1]}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    });
    res.send(data);
});

// An officer has seen the ID card in person: the volunteer may now start duties
router.post('/applications/:id/verify-id', requireAuth, requirePermission('volunteer:review'), async (req, res) => {
    res.json(await volunteer.verifyId(req.params.id, req.user));
});

// ---------- District control room: duties, live roster, coverage, broadcasts ----------
router.get('/control', requireAuth, requirePermission('volunteer:manage'), async (req, res) => {
    res.json(await duty.dashboard(req.query.eventId && String(req.query.eventId)));
});

router.post('/duties', requireAuth, requirePermission('volunteer:manage'), async (req, res) => {
    res.status(201).json(await duty.assign(req.user, req.body || {}));
});

router.patch('/duties/:id', requireAuth, requirePermission('volunteer:manage'), async (req, res) => {
    res.json(await duty.update(req.user, req.params.id, req.body || {}));
});

router.post('/broadcasts', requireAuth, requirePermission('volunteer:manage'), async (req, res) => {
    res.status(201).json(await duty.broadcast(req.user, req.body || {}));
});

// ---------- Volunteers: own duties and check-in ----------
router.get('/my-duty', requireAuth, requirePermission('duty:self'), async (req, res) => {
    res.json(await duty.mine(req.user));
});

router.post('/duties/:id/check-in', requireAuth, requirePermission('duty:self'), async (req, res) => {
    res.json(await duty.checkIn(req.user, req.params.id));
});

router.post('/duties/:id/check-out', requireAuth, requirePermission('duty:self'), async (req, res) => {
    res.json(await duty.checkOut(req.user, req.params.id));
});

module.exports = router;
