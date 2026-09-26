const mongoose = require('mongoose');

const passSchema = new mongoose.Schema({
    eventId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Event',
        required: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    status: {
        type: String,
        enum: ['Valid', 'Scanned', 'Cancelled'],
        default: 'Valid'
    },
    // Useful for Volunteer events to track their hours after the event
    hoursLogged: {
        type: Number,
        default: 0
    }
}, { timestamps: true });

// Prevent a user from registering for the exact same event twice
passSchema.index({ eventId: 1, userId: 1 }, { unique: true });

const Pass = mongoose.model('Pass', passSchema);
module.exports = { Pass };