const mongoose = require('mongoose');
const LostFoundReport = require('./lostfound.model');
const { hasPermission, STAFF } = require('../../config/roles');
const audit = require('../audit/audit.service');
const { badRequest, forbidden, notFound } = require('../../utils/httpError');
const v = require('../../utils/validate');

const FIELDS = ['eventId', 'personName', 'age', 'gender', 'description', 'clothes', 'lastSeenAt', 'currentlyAt'];

const create = async (user, body = {}, photoUrl) => {
    const kind = String(body.kind || '').toUpperCase();
    if (!['MISSING', 'FOUND'].includes(kind)) throw badRequest('kind must be MISSING or FOUND');
    const perm = kind === 'MISSING' ? 'report:missing:create' : 'report:found:create';
    if (!hasPermission(user.role, perm)) {
        throw forbidden(kind === 'FOUND' ? 'Only police, officials and volunteers post found persons' : 'Your role cannot file missing reports');
    }
    const data = Object.fromEntries(FIELDS.filter((k) => body[k] !== undefined && body[k] !== '').map((k) => [k, body[k]]));
    if (data.eventId && !mongoose.isValidObjectId(data.eventId)) delete data.eventId;
    // Same rules as the report form in the browser
    data.personName = v.text(data.personName, "Person's name", 'personName', { required: kind === 'MISSING' });
    data.age = v.int(data.age, 'Age', { min: 0, max: 120 });
    data.description = v.text(data.description, 'Description', 'longText');
    data.clothes = v.text(data.clothes, 'Clothes', 'shortText');
    data.lastSeenAt = v.text(data.lastSeenAt, 'Last seen at', 'venue', { required: kind === 'MISSING' });
    data.currentlyAt = v.text(data.currentlyAt, 'Currently at', 'venue');
    const contact = v.mobile(body.contactCountryCode, body.contactPhone, 'Contact number');
    data.contactCountryCode = contact ? contact.countryCode : user.countryCode || '91';
    data.contactPhone = contact ? contact.phone : user.phone;
    for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
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

const markReunited = async (id, actor) => {
    const report = await LostFoundReport.findByIdAndUpdate(id, { $set: { status: 'REUNITED' } }, { returnDocument: 'after' }).lean();
    if (!report) throw notFound('Report not found');
    audit.record({ actor, action: 'PERSON_REUNITED', targetType: 'LostFoundReport', targetId: report._id, summary: `${actor?.name || 'Staff'} marked ${report.personName || 'a person'} as reunited` });
    return report;
};

module.exports = { create, list, markReunited };
