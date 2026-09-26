const mongoose = require('mongoose');

// 1. Define Base Options
const baseOptions = {
    discriminatorKey: 'eventType',
    collection: 'events',
    timestamps: true
};

// 2. Base Event Schema (Common fields)
const eventSchema = new mongoose.Schema({
    title: { type: String, required: true },
    description: { type: String },
    date: { type: Date, required: true },
    location: { type: String, required: true },
    category: { type: String, required: true },
    maxCapacity: { type: Number, required: true },
    organizerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, baseOptions);

const Event = mongoose.model('Event', eventSchema);

// 3. Volunteer Event Schema
const VolunteerEvent = Event.discriminator('Volunteer', new mongoose.Schema({
    requiredHours: { type: Number, required: true },
    skillsNeeded: [{ type: String }]
}));

// 4. Corporate Event Schema
const CorporateEvent = Event.discriminator('Corporate', new mongoose.Schema({
    companyName: { type: String, required: true },
    sponsors: [{ type: String }],
    dressCode: { type: String, enum: ['Casual', 'Business Casual', 'Formal'], default: 'Business Casual' }
}));

// 5. Pilgrim Event Schema
const PilgrimEvent = Event.discriminator('Pilgrim', new mongoose.Schema({
    pilgrimageSite: { type: String, required: true },
    accommodationProvided: { type: Boolean, default: false },
    guideName: { type: String }
}));

module.exports = { Event, VolunteerEvent, CorporateEvent, PilgrimEvent };