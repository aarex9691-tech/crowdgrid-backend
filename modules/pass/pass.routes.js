const express = require('express');
const router = express.Router();
const { generatePass } = require('./pass.controller');
const { requireAuth, authorizeRoles } = require('../auth/auth.middleware');

// Route requires a valid JWT. Attendees and Organizers can generate passes.
router.post('/generate', requireAuth, authorizeRoles('Attendee', 'Organizer'), generatePass);

module.exports = router;