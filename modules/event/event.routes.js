const express = require('express');
const router = express.Router();
const { createEvent, getEvents } = require('./event.controller');
const { requireAuth, authorizeRoles } = require('../auth/auth.middleware');

// The Routes
router.post('/', requireAuth, authorizeRoles('Organizer', 'Admin'), createEvent);
router.get('/', getEvents);

module.exports = router;