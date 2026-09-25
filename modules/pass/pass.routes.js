const express = require('express');
const router = express.Router();
// Import the new functions
const { generatePass, getMyPasses, scanPass } = require('./pass.controller');
const { requireAuth, authorizeRoles } = require('../auth/auth.middleware');

// Attendees generate and view their own passes
router.post('/generate', requireAuth, authorizeRoles('Attendee', 'Organizer'), generatePass);
router.get('/my-passes', requireAuth, authorizeRoles('Attendee', 'Organizer'), getMyPasses);

// Only Organizers and Admins can scan/validate passes at the door
router.patch('/scan/:passId', requireAuth, authorizeRoles('Organizer', 'Admin'), scanPass);

module.exports = router;