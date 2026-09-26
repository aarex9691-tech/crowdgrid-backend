const { Pass } = require('./pass.model');
const { Event } = require('../event/event.model');

const generatePass = async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userId = req.user._id;

        const event = await Event.findById(eventId);
        if (!event) {
            return res.status(404).json({ message: 'Event not found' });
        }

        const currentPassCount = await Pass.countDocuments({ eventId });
        if (currentPassCount >= event.maxCapacity) {
            return res.status(400).json({ message: 'Event is completely sold out' });
        }

        const newPass = new Pass({ eventId, userId });
        const savedPass = await newPass.save();

        res.status(201).json({ message: 'Pass generated successfully!', pass: savedPass });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({ message: 'You have already registered for this event.' });
        }
        res.status(500).json({ message: error.message });
    }
};

// NEW: Fetch all passes for the logged-in Attendee
const getUserPasses = async (req, res) => {
    try {
        // Find passes belonging to this user and populate the specific event details
        const passes = await Pass.find({ userId: req.user._id })
            .populate('eventId', 'title date location eventType')
            .sort({ createdAt: -1 }); // Sort by newest first

        res.status(200).json(passes);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = { generatePass, getUserPasses };