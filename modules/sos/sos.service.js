const mongoose = require('mongoose');
const SosIncident = require('./sos.model');
const { ROLES } = require('../../config/roles');
const { badRequest, notFound, forbidden } = require('../../utils/httpError');

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/**
 * 1-tap SOS. If the same person already has an open alert from the last 30
 * minutes, pressing again updates its live location instead of creating a
 * duplicate, so the control room tracks one incident per person.
 */
const raise = async (user, { eventId, lat, lng, accuracy, type, message } = {}) => {
    const location = { lat: num(lat), lng: num(lng), accuracy: num(accuracy) };
    const hasGps = Number.isFinite(location.lat) && Number.isFinite(location.lng);
    if (hasGps && (Math.abs(location.lat) > 90 || Math.abs(location.lng) > 180)) throw badRequest('Invalid coordinates');

    const recent = await SosIncident.findOne({
        userId: user._id,
        status: { $ne: 'RESOLVED' },
        createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) },
    });
    if (recent) {
        if (hasGps) {
            recent.location = location;
            recent.locationHistory.push({ lat: location.lat, lng: location.lng, at: new Date() });
        }
        if (message) recent.message = message;
        await recent.save();
        return { incident: recent.toObject(), updated: true };
    }

    const incident = await SosIncident.create({
        userId: user._id,
        eventId: mongoose.isValidObjectId(eventId) ? eventId : undefined,
        type: type || 'GENERAL',
        message,
        location: hasGps ? location : undefined,
        locationHistory: hasGps ? [{ lat: location.lat, lng: location.lng, at: new Date() }] : [],
    });
    return { incident: incident.toObject(), updated: false };
};

const mine = async (userId) => SosIncident.find({ userId }).sort({ createdAt: -1 }).limit(10).lean();

/** Control room list. Volunteers see only incidents assigned to them. */
const list = async (viewer, { status, eventId } = {}) => {
    const filter = {};
    if (status) filter.status = String(status);
    if (eventId && mongoose.isValidObjectId(eventId)) filter.eventId = eventId;
    if (viewer.role === ROLES.VOLUNTEER) filter.assignedTo = viewer._id;
    return SosIncident.find(filter)
        .populate('userId', 'name phone')
        .populate('assignedTo', 'name phone')
        .sort({ status: 1, createdAt: -1 })
        .limit(200)
        .lean();
};

const update = async (id, viewer, { status, assignedTo } = {}) => {
    const incident = await SosIncident.findById(id);
    if (!incident) throw notFound('Incident not found');
    if (viewer.role === ROLES.VOLUNTEER) {
        if (String(incident.assignedTo) !== String(viewer._id)) throw forbidden('Not assigned to you');
        if (assignedTo !== undefined) throw forbidden('Volunteers cannot reassign incidents');
    }
    if (status) {
        if (!['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].includes(status)) throw badRequest('Invalid status');
        incident.status = status;
        incident.resolvedAt = status === 'RESOLVED' ? new Date() : undefined;
    }
    if (assignedTo !== undefined) incident.assignedTo = assignedTo || undefined;
    await incident.save();
    return incident.toObject();
};

module.exports = { raise, mine, list, update };
