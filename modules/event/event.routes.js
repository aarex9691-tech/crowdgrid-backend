const express = require('express');
const router = express.Router();
const { createEvent, getEvents, getEventById, updateEvent, deleteEvent } = require('./event.controller');
const { requireAuth, authorizeRoles } = require('../auth/auth.middleware');

router.get('/', getEvents);
router.get('/:id', getEventById);
router.post('/', requireAuth, authorizeRoles('Organizer'), createEvent);

// Make sure these two lines are here!
router.put('/:id', requireAuth, authorizeRoles('Organizer'), updateEvent);
router.delete('/:id', requireAuth, authorizeRoles('Organizer'), deleteEvent);

module.exports = router;