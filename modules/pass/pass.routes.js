const express = require('express');
const router = express.Router();
const { generatePass } = require('./pass.controller');
const { requireAuth, authorizeRoles } = require('../auth/auth.middleware');

// POST /api/passes/:eventId/register
router.post('/:eventId/register', requireAuth, authorizeRoles('Attendee'), generatePass);

module.exports = router;