const { Event } = require('./event.model');

const createEvent = async (req, res) => {
    try {
        const newEvent = new Event({
            ...req.body,
            organizerId: req.user._id
        });

        const savedEvent = await newEvent.save();
        res.status(201).json(savedEvent);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const getEvents = async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const skip = (page - 1) * limit;

        const query = { $or: [{ category: 'Public' }] };

        if (req.user) {
            query.$or.push({ organizerId: req.user._id });

            if (req.user.organizationName) {
                query.$or.push({ companyName: req.user.organizationName });
            }
        }

        const events = await Event.find(query).skip(skip).limit(limit);
        const totalEvents = await Event.countDocuments(query);

        res.status(200).json({
            events,
            pagination: {
                totalEvents,
                totalPages: Math.ceil(totalEvents / limit),
                currentPage: page,
                limit
            }
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getEventById = async (req, res) => {
    try {
        const eventId = req.params.id;

        const event = await Event.findById(eventId).populate('organizerId', 'name email');

        if (!event) {
            return res.status(404).json({ message: 'Event not found' });
        }

        res.status(200).json(event);
    } catch (error) {
        if (error.name === 'CastError') {
            return res.status(400).json({ message: 'Invalid Event ID format' });
        }
        res.status(500).json({ message: error.message });
    }
};

const updateEvent = async (req, res) => {
    try {
        const eventId = req.params.id;

        const event = await Event.findById(eventId);
        if (!event) {
            return res.status(404).json({ message: 'Event not found' });
        }

        if (event.organizerId.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Not authorized to edit this event' });
        }

        const updatedEvent = await Event.findByIdAndUpdate(
            eventId,
            { $set: req.body },
            { new: true, runValidators: true }
        );

        res.status(200).json(updatedEvent);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const deleteEvent = async (req, res) => {
    try {
        const eventId = req.params.id;

        const event = await Event.findById(eventId);
        if (!event) {
            return res.status(404).json({ message: 'Event not found' });
        }

        if (event.organizerId.toString() !== req.user._id.toString()) {
            return res.status(403).json({ message: 'Not authorized to delete this event' });
        }

        await Event.findByIdAndDelete(eventId);

        res.status(200).json({ message: 'Event successfully deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const rsvpEvent = async (req, res) => {
    try {
        const eventId = req.params.id;
        const userId = req.user._id || req.user.id;

        const event = await Event.findById(eventId);
        if (!event) {
            return res.status(404).json({ message: 'Event not found' });
        }

        if (!event.attendees) {
            event.attendees = [];
        }

        if (event.attendees.includes(userId)) {
            return res.status(400).json({ message: 'You have already RSVP\'d to this event.' });
        }

        event.attendees.push(userId);
        await event.save();

        res.status(200).json({ message: 'Successfully RSVP\'d for event!', event });
    } catch (err) {
        console.error('RSVP Error:', err);
        res.status(500).json({ message: 'Server error during RSVP' });
    }
};

// Export ALL 6 functions cleanly
module.exports = {
    createEvent,
    getEvents,
    getEventById,
    updateEvent,
    deleteEvent,
    rsvpEvent
};