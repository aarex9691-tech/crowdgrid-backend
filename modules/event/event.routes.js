const express = require('express');
const router = express.Router();

// Import all controller functions including rsvpEvent
const {
    createEvent,
    getEvents,
    getEventById,
    updateEvent,
    deleteEvent,
    rsvpEvent
} = require('./event.controller');

const { requireAuth, authorizeRoles } = require('../auth/auth.middleware');

// Public and General Retrieval Routes
router.get('/', getEvents);
router.get('/:id', getEventById);

// RSVP Route: Accessible to any logged-in user (Attendees & Organizers)
router.post('/:id/rsvp', requireAuth, rsvpEvent);

// Organizer-Only Management Routes
router.post('/', requireAuth, authorizeRoles('Organizer'), createEvent);
router.put('/:id', requireAuth, authorizeRoles('Organizer'), updateEvent);
router.delete('/:id', requireAuth, authorizeRoles('Organizer'), deleteEvent);

module.exports = router;