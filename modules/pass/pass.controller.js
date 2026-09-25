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

// Get all passes for the logged-in user
const getMyPasses = async (req, res) => {
    try {
        // Find passes belonging to this user and pull in the event details (title, date, location)
        const passes = await Pass.find({ attendeeId: req.user._id })
            .populate('eventId', 'title date location');

        res.status(200).json(passes);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Organizer scans a pass at the door
const scanPass = async (req, res) => {
    try {
        const { passId } = req.params;

        const pass = await Pass.findById(passId);
        if (!pass) return res.status(404).json({ message: 'Pass not found' });

        // Security checks
        if (pass.status === 'Scanned') {
            return res.status(400).json({ message: 'Pass has already been scanned!' });
        }
        if (pass.status === 'Revoked') {
            return res.status(400).json({ message: 'This pass is no longer valid.' });
        }

        // Update status to prevent reuse
        pass.status = 'Scanned';
        await pass.save();

        res.status(200).json({ message: 'Pass scanned successfully!', pass });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// Don't forget to export the new functions at the bottom!
module.exports = { generatePass, getMyPasses, scanPass };