const mongoose = require('mongoose');
const SosIncident = require('./sos.model');
const { ROLES } = require('../../config/roles');
const audit = require('../audit/audit.service');
const { badRequest, notFound, forbidden } = require('../../utils/httpError');
const realtime = require('../../utils/realtime');

const MAX_HISTORY = 50;
const User = require('../auth/user.model');

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/**
 * 1-tap SOS. If the same person already has an open alert from the last 30
 * minutes, pressing again updates its live location instead of creating a
 * duplicate, so the control room tracks one incident per person.
 */
const cleanType = (type) => {
    if (type === undefined || type === null || type === '') return undefined;
    const t = String(type).toUpperCase();
    if (!SosIncident.SOS_TYPES.includes(t)) throw badRequest('Choose what kind of help you need');
    return t;
};
const cleanMessage = (message) => {
    if (message === undefined || message === null) return undefined;
    const m = String(message).trim();
    if (m.length > 300) throw badRequest('Keep the message under 300 characters');
    return m || undefined;
};

const MAX_SOS_PER_WINDOW = 5;
const SOS_WINDOW_MIN = 10;

const raise = async (user, { eventId, lat, lng, accuracy, type: rawType, message: rawMessage } = {}) => {
    const type = cleanType(rawType);
    const message = cleanMessage(rawMessage);
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
            // keep only the latest points so repeated presses cannot grow the document forever
            if (recent.locationHistory.length > MAX_HISTORY) recent.locationHistory.splice(0, recent.locationHistory.length - MAX_HISTORY);
        }
        if (message) recent.message = message;
        if (type) recent.type = type; // the pilgrim can correct what kind of help they need
        await recent.save();
        realtime.notify(['control', 'volunteers'], 'sos', { action: 'location', id: String(recent._id) });
        return { incident: recent.toObject(), updated: true };
    }

    // A real emergency stays one open alert (updated above). Opening and closing alerts in a loop would
    // flood the control room, so new alerts are capped per person (more presses reopen the latest one).
    const lastTen = await SosIncident.countDocuments({ userId: user._id, createdAt: { $gte: new Date(Date.now() - SOS_WINDOW_MIN * 60000) } });
    if (lastTen >= MAX_SOS_PER_WINDOW) {
        // Never refuse an alert: it may be the real one. Reopen the person's latest alert with the new details instead.
        const latest = await SosIncident.findOne({ userId: user._id }).sort({ createdAt: -1 });
        latest.status = 'OPEN';
        latest.resolvedAt = undefined;
        latest.closedByUser = false;
        if (type) latest.type = type;
        if (message) latest.message = message;
        if (hasGps) {
            latest.location = location;
            latest.locationHistory.push({ lat: location.lat, lng: location.lng, at: new Date() });
            if (latest.locationHistory.length > MAX_HISTORY) latest.locationHistory.splice(0, latest.locationHistory.length - MAX_HISTORY);
        }
        await latest.save();
        realtime.notify(['control', 'volunteers'], 'sos', { action: 'raised', id: String(latest._id), type: latest.type });
        if (hasGps) realtime.notify(['public'], 'route', {});
        return { incident: latest.toObject(), updated: true, reopened: true };
    }

    const incident = await SosIncident.create({
        userId: user._id,
        eventId: mongoose.isValidObjectId(eventId) ? eventId : undefined,
        type: type || 'GENERAL',
        message,
        location: hasGps ? location : undefined,
        locationHistory: hasGps ? [{ lat: location.lat, lng: location.lng, at: new Date() }] : [],
    });
    realtime.notify(['control', 'volunteers'], 'sos', { action: 'raised', id: String(incident._id), type: incident.type });
    if (hasGps) realtime.notify(['public'], 'route', {}); // open route maps re-plan around the alert
    return { incident: incident.toObject(), updated: false };
};

/** The pilgrim's own alerts, newest first, with the volunteer's name once one is assigned. */
const mine = async (userId) =>
    SosIncident.find({ userId }, '-locationHistory').populate('assignedTo', 'name').sort({ createdAt: -1 }).limit(10).lean();

/** "I'm safe now": the pilgrim closes their own open alert. */
const closeMine = async (id, user) => {
    if (!mongoose.isValidObjectId(id)) throw notFound('Alert not found');
    const incident = await SosIncident.findOneAndUpdate(
        { _id: id, userId: user._id, status: { $ne: 'RESOLVED' } },
        { $set: { status: 'RESOLVED', resolvedAt: new Date(), closedByUser: true } },
        { returnDocument: 'after' }
    ).lean();
    if (!incident) throw notFound('No open alert to close');
    audit.record({ actor: user, action: 'SOS_CLOSED_BY_USER', targetType: 'SosIncident', targetId: incident._id, summary: `${user.name} said they are safe now` });
    realtime.notify(['control', 'volunteers', `user:${user._id}`], 'sos', { action: 'updated', id: String(incident._id), status: 'RESOLVED' });
    if (incident.location?.lat !== undefined) realtime.notify(['public'], 'route', {});
    return incident;
};

/** Control room list. Volunteers see only incidents assigned to them. */
const list = async (viewer, { status, eventId } = {}) => {
    const filter = {};
    if (status) filter.status = String(status);
    if (eventId && mongoose.isValidObjectId(eventId)) filter.eventId = eventId;
    if (viewer.role === ROLES.VOLUNTEER) filter.assignedTo = viewer._id;
    return SosIncident.find(filter)
        .populate('userId', 'name countryCode phone')
        .populate('assignedTo', 'name countryCode phone')
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
        // First response time is kept for the analytics dashboard
        if (status !== 'OPEN' && !incident.acknowledgedAt) incident.acknowledgedAt = new Date();
        incident.status = status;
        incident.resolvedAt = status === 'RESOLVED' ? new Date() : undefined;
    }
    if (assignedTo !== undefined) {
        if (assignedTo) {
            // only an active volunteer can be given an incident
            if (!mongoose.isValidObjectId(assignedTo)) throw badRequest('Choose a volunteer to assign');
            const responder = await User.findOne({ _id: assignedTo, role: ROLES.VOLUNTEER, isActive: true }, '_id').lean();
            if (!responder) throw badRequest('SOS alerts can only be assigned to an active volunteer');
        }
        incident.assignedTo = assignedTo || undefined;
    }
    await incident.save();
    audit.record({
        actor: viewer,
        action: `SOS_${incident.status}`,
        targetType: 'SosIncident',
        targetId: incident._id,
        summary: `${viewer.name} marked an SOS alert ${incident.status.toLowerCase()}${assignedTo ? ' and assigned it' : ''}`,
    });
    realtime.notify(['control', 'volunteers', `user:${incident.userId}`], 'sos', { action: 'updated', id: String(incident._id), status: incident.status });
    if (incident.location?.lat !== undefined) realtime.notify(['public'], 'route', {});
    return incident.toObject();
};

/** Volunteers the control room can send to an alert. */
const responders = async () => User.find({ role: ROLES.VOLUNTEER, isActive: true }, 'name').sort({ name: 1 }).limit(200).lean();

module.exports = { raise, mine, closeMine, list, update, responders };
