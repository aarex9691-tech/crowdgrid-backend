const express = require('express');
const router = express.Router();
const { generatePass, getUserPasses, verifyPass } = require('./pass.controller');
const { requireAuth, authorizeRoles } = require('../auth/auth.middleware');

// GET: Retrieve all passes for the logged-in Attendee
router.get('/my-passes', requireAuth, authorizeRoles('Attendee'), getUserPasses);

// POST: Register for a specific event
router.post('/:eventId/register', requireAuth, authorizeRoles('Attendee'), generatePass);

// PATCH: Organizer scans and verifies a pass
router.patch('/:passId/verify', requireAuth, authorizeRoles('Organizer'), verifyPass);

module.exports = router;