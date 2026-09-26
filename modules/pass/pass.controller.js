const { Pass } = require('./pass.model');
const { Event } = require('../event/event.model');

const generatePass = async (req, res) => {
    try {
        const eventId = req.params.eventId;
        const userId = req.user._id;

        // 1. Verify the event actually exists
        const event = await Event.findById(eventId);
        if (!event) {
            return res.status(404).json({ message: 'Event not found' });
        }

        // 2. Check Capacity limits
        const currentPassCount = await Pass.countDocuments({ eventId });
        if (currentPassCount >= event.maxCapacity) {
            return res.status(400).json({ message: 'Event is completely sold out' });
        }

        // 3. Generate the Pass
        const newPass = new Pass({
            eventId,
            userId
        });

        const savedPass = await newPass.save();
        res.status(201).json({ message: 'Pass generated successfully!', pass: savedPass });

    } catch (error) {
        // Error code 11000 is MongoDB's way of saying our Unique Index was violated
        if (error.code === 11000) {
            return res.status(400).json({ message: 'You have already registered for this event.' });
        }
        res.status(500).json({ message: error.message });
    }
};

module.exports = { generatePass };