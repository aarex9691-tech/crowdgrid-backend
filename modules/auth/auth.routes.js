const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const auth = require('./auth.service');
const avatar = require('./avatar');
const { requireAuth, requirePermission } = require('../../middleware/auth');

const router = express.Router();

// Slow down password guessing
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many attempts from this network. Please wait 15 minutes and try again.' },
});

// Sign-up step 1: a 6-digit code for the mobile number (simulated SMS in the demo)
router.post('/otp', authLimiter, async (req, res) => {
    const { phone, countryCode } = req.body || {};
    res.json(await auth.requestOtp({ phone, countryCode }));
});

// Sign-up step 2: details + the code
router.post('/register', authLimiter, async (req, res) => {
    const { name, phone, countryCode, password, otp } = req.body || {}; // mobile number only (email is added in the profile)
    res.status(201).json(await auth.register({ name, phone, countryCode, password, otp }));
});

router.post('/login', authLimiter, async (req, res) => {
    // ip (Render's proxy is trusted) lets a lockout pause only the device that guessed wrong
    res.json(await auth.login({ ...(req.body || {}), ip: req.ip }));
});

router.get('/me', requireAuth, async (req, res) => {
    res.json(await auth.me(req.user._id));
});

// Edit profile (email, date of birth, gender, city, emergency contact)
router.patch('/me', requireAuth, async (req, res) => {
    res.json(await auth.updateProfile(req.user, req.body || {}));
});

// Profile picture: shrunk in the browser, checked here, kept in MongoDB
const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: avatar.MAX_BYTES, files: 1 },
});
const onePhoto = (req, res, next) =>
    photoUpload.single('photo')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'The photo is too large. Use one under 1 MB.' });
        if (err) return res.status(400).json({ message: 'Could not read that photo. Try another one.' });
        return next();
    });

router.put('/me/photo', requireAuth, onePhoto, async (req, res) => {
    res.json(await avatar.setPhoto(req.user, req.file?.buffer));
});

router.delete('/me/photo', requireAuth, async (req, res) => {
    res.json(await avatar.removePhoto(req.user));
});

router.get('/photo/:key', async (req, res) => {
    const photo = await avatar.find(req.params.key);
    if (!photo) return res.status(404).json({ message: 'Photo not found' });
    // private: browsers may keep it, shared caches may not; the key changes when the picture does
    res.set({ 'Content-Type': photo.contentType, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
    res.send(Buffer.from(photo.data));
});

// Set a new password (required after a help desk reset); logs out other devices
router.post('/password', requireAuth, authLimiter, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    res.json(await auth.changePassword(req.user, { currentPassword, newPassword }));
});

router.post('/logout-all', requireAuth, async (req, res) => {
    res.json(await auth.logoutAll(req.user));
});

router.post('/staff', requireAuth, requirePermission('staff:create'), async (req, res) => {
    res.status(201).json(await auth.createStaff(req.body || {}, req.user));
});

module.exports = router;
