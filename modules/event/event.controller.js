const { Event } = require('./event.model');

// CHANGED: Declared as a constant so the bottom export works
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

module.exports = { createEvent, getEvents };