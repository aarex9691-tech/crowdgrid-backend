const mongoose = require('mongoose');
const LostFoundReport = require('./lostfound.model');
const { hasPermission, STAFF } = require('../../config/roles');
const { badRequest, forbidden, notFound } = require('../../utils/httpError');

const FIELDS = ['eventId', 'personName', 'age', 'gender', 'description', 'clothes', 'lastSeenAt', 'currentlyAt', 'contactPhone'];

const create = async (user, body = {}, photoUrl) => {
    const kind = String(body.kind || '').toUpperCase();
    if (!['MISSING', 'FOUND'].includes(kind)) throw badRequest('kind must be MISSING or FOUND');
    const perm = kind === 'MISSING' ? 'report:missing:create' : 'report:found:create';
    if (!hasPermission(user.role, perm)) {
        throw forbidden(kind === 'FOUND' ? 'Only police, officials and volunteers post found persons' : 'Your role cannot file missing reports');
    }
    const data = Object.fromEntries(FIELDS.filter((k) => body[k] !== undefined && body[k] !== '').map((k) => [k, body[k]]));
    if (data.eventId && !mongoose.isValidObjectId(data.eventId)) delete data.eventId;
    if (kind === 'MISSING' && !data.personName) throw badRequest("Missing person's name is required");
    if (kind === 'MISSING' && !data.contactPhone) data.contactPhone = user.phone;
    const report = await LostFoundReport.create({ ...data, kind, photoUrl, reportedBy: user._id });
    return report.toObject();
};

/** Public bulletin. Contact numbers are only shown to staff and to the reporter. */
const list = async (viewer, { kind, status = 'OPEN', eventId, q } = {}) => {
    const filter = {};
    if (kind) filter.kind = String(kind).toUpperCase();
    if (status && status !== 'ALL') filter.status = String(status);
    if (eventId && mongoose.isValidObjectId(eventId)) filter.eventId = eventId;
    if (q) {
        const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 50), 'i');
        filter.$or = [{ personName: rx }, { description: rx }, { clothes: rx }, { lastSeenAt: rx }, { currentlyAt: rx }];
    }
    const reports = await LostFoundReport.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    const isStaff = viewer && STAFF.includes(viewer.role);
    return reports.map((r) => {
        const own = viewer && String(r.reportedBy) === String(viewer._id);
        if (isStaff || own) return r;
        const { contactPhone, ...rest } = r;
        return rest;
    });
};

const markReunited = async (id) => {
    const report = await LostFoundReport.findByIdAndUpdate(id, { $set: { status: 'REUNITED' } }, { returnDocument: 'after' }).lean();
    if (!report) throw notFound('Report not found');
    return report;
};

module.exports = { create, list, markReunited };
