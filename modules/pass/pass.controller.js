const Pass = require('./pass.model');
const { Event } = require('../event/event.model');

const generatePass = async (req, res) => {
    try {
        const { eventId } = req.body;
        const attendeeId = req.user._id;

        const event = await Event.findById(eventId);
        if (!event) return res.status(404).json({ message: 'Event not found' });

        if (event.maxCapacity !== undefined && event.maxCapacity <= 0) {
            return res.status(400).json({ message: 'Event is completely sold out' });
        }

        const existingPass = await Pass.findOne({ attendeeId, eventId });
        if (existingPass) {
            return res.status(400).json({ message: 'You already have a pass for this event' });
        }

        const newPass = await Pass.create({
            attendeeId,
            eventId,
            status: 'Valid'
        });

        if (event.maxCapacity !== undefined) {
            event.maxCapacity -= 1;
            await event.save();
        }

        res.status(201).json({
            message: 'Pass generated successfully!',
            pass: newPass
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = { generatePass };