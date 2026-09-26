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

const getUserPasses = async (req, res) => {
    try {
        const passes = await Pass.find({ userId: req.user._id })
            .populate('eventId', 'title date location eventType')
            .sort({ createdAt: -1 });

        res.status(200).json(passes);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// NEW: Verify/Scan a Pass (Organizer Only)
const verifyPass = async (req, res) => {
    try {
        const passId = req.params.passId;
        const { hoursLogged } = req.body;

        // 1. Find the pass and populate the event to check ownership
        const pass = await Pass.findById(passId).populate('eventId');

        if (!pass) {
            return res.status(404).json({ message: 'Pass not found' });
        }

        // 2. Security Check: Ensure the logged-in Organizer actually owns this event
        if (pass.eventId.organizerId.toString() !== req.user._id) {
            return res.status(403).json({ message: 'Not authorized to scan passes for this event' });
        }

        // 3. Check if already scanned
        if (pass.status === 'Scanned') {
            return res.status(400).json({ message: 'Pass has already been scanned!' });
        }

        // 4. Update the pass status and log hours if provided
        pass.status = 'Scanned';
        if (hoursLogged) {
            pass.hoursLogged = hoursLogged;
        }

        const updatedPass = await pass.save();

        res.status(200).json({
            message: 'Pass successfully verified!',
            pass: updatedPass
        });

    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = { generatePass, getUserPasses, verifyPass };