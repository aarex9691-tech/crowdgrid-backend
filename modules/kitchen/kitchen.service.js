const mongoose = require('mongoose');
const { KitchenApplication, ServiceRequest, ORG_TYPES, ID_TYPES } = require('./kitchen.model');
const User = require('../auth/user.model');
const Event = require('../event/event.model');
const Provider = require('../provider/provider.model');
const { FoodCenter, FoodSlot } = require('../food/food.model');
const { Pass } = require('../pass/pass.model');
const ngo = require('../ngo/ngo.service');
const audit = require('../audit/audit.service');
const orgIds = require('../../utils/orgIds');
const eventWindow = require('../../utils/eventWindow');
const v = require('../../utils/validate');
const { sniffDocument, MAX_DOCUMENT_BYTES } = require('../host/host.service');
const { ROLES } = require('../../config/roles');
const { badRequest, notFound, conflict, forbidden } = require('../../utils/httpError');

/*
 * Kitchen services. Two steps, two verifiers:
 *   1. the Super Admin recognises the organisation once (licence number + certificate)
 *      -> the account becomes a Kitchen Manager
 *   2. for each yatra, that yatra's District Control Room approves it to serve there
 *      -> a verified organisation (Provider, type KITCHEN) at that yatra, so it can run kitchens
 * The kitchen work itself (kitchens, meal quotas) reuses the trusts' kitchen logic in ngo.service.
 */

const FSSAI_RE = /^\d{14}$/;

const pick = (value, list, message) => {
    const s = String(value || '').toUpperCase();
    if (!list.includes(s)) throw badRequest(message);
    return s;
};

/** FSSAI: 14 digits; the others use the shared checks (GSTIN check digit, Darpan, Udyam...). */
const checkId = (idType, raw) => {
    if (idType === 'FSSAI') {
        const n = String(raw || '').replace(/\s+/g, '');
        if (!FSSAI_RE.test(n)) throw badRequest('An FSSAI licence number has 14 digits. Copy it from the licence.');
        return { idNumber: n, status: 'VALID', label: 'FSSAI licence' };
    }
    const idNumber = orgIds.normalise(idType, raw);
    const result = orgIds.check(idType, idNumber);
    if (!idNumber || !/[A-Z0-9]/i.test(idNumber)) throw badRequest('Enter the registration number');
    if (result.status === 'INVALID') throw badRequest(`That ${result.label} is not valid. Copy it exactly from the certificate.`);
    return { idNumber, status: result.status, label: result.label };
};

const withoutFile = (doc) => {
    const out = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
    if (out.document) delete out.document.data;
    delete out.pendingFor;
    delete out.activeIdKey;
    return out;
};

const reasonOrThrow = (decision, reason, who) => {
    if (!['APPROVED', 'REJECTED'].includes(decision)) throw badRequest('decision must be APPROVED or REJECTED');
    if (decision !== 'REJECTED') return undefined;
    if (typeof reason !== 'string' || reason.trim().length < 5) throw badRequest(`Give a reason for rejecting: ${who} sees it`);
    return reason.trim().slice(0, 300);
};

// ---------- 1. Recognition by the Super Admin ----------

const apply = async (user, body = {}, file = null) => {
    if (user.role !== ROLES.USER) throw forbidden('Apply from a personal account (staff accounts cannot apply)');
    const orgName = v.text(body.orgName, 'Organisation name', 'orgName', { required: true });
    const orgType = pick(body.orgType, ORG_TYPES, 'Choose the type of organisation');
    const idType = pick(body.idType, ID_TYPES, 'Choose the licence or registration number you will give');
    const id = checkId(idType, body.idNumber);
    const city = v.text(body.city, 'City', 'city', { required: true });
    const contactName = v.text(body.contactName, 'Contact person', 'personName', { required: true });
    const contact = v.mobile(body.contactCountryCode, body.contactPhone, 'Contact number', { required: true });
    const mealsPerDay = body.mealsPerDay !== undefined && body.mealsPerDay !== '' ? v.int(body.mealsPerDay, 'Meals a day', { min: 1, max: 1000000 }) : undefined;
    const description = v.text(body.description, 'About your kitchen', 'longText');

    if (!file || !file.length) throw badRequest('Upload the licence or registration certificate (a PDF or a clear photo)');
    if (file.length > MAX_DOCUMENT_BYTES) throw badRequest('The certificate is too large. Use a file under 2 MB.');
    const contentType = sniffDocument(file);
    if (!contentType) throw badRequest('The certificate must be a PDF or an image (JPEG, PNG or WEBP)');

    try {
        const app = await KitchenApplication.create({
            applicantId: user._id,
            orgName,
            orgType,
            idType,
            idNumber: id.idNumber,
            idCheck: id.status,
            city,
            contactName,
            contactCountryCode: contact.countryCode,
            contactPhone: contact.phone,
            mealsPerDay,
            description,
            document: { data: file, contentType, size: file.length },
            pendingFor: user._id,
            activeIdKey: `${idType}:${id.idNumber.replace(/[^A-Z0-9]/gi, '').toUpperCase()}`,
        });
        audit.record({ actor: user, action: 'KITCHEN_APPLIED', targetType: 'KitchenApplication', targetId: app._id, summary: `${user.name} asked to register the kitchen service ${orgName}` });
        return withoutFile(app);
    } catch (err) {
        if (err.code !== 11000) throw err;
        if (err.keyPattern?.pendingFor) throw conflict('You already have a request waiting for review');
        throw conflict('A kitchen with this licence or registration number has already applied or is recognised');
    }
};

const mine = async (user) => ({
    recognition: (await KitchenApplication.find({ applicantId: user._id }, '-reviewedBy').sort({ createdAt: -1 }).limit(10).lean()).map(withoutFile),
    yatras: await ServiceRequest.find({ organiserId: user._id }, '-reviewedBy -openKey').populate('eventId', 'title slug startDate endDate').sort({ createdAt: -1 }).limit(50).lean(),
});

/** Super Admin: requests with what to look at. */
const list = async ({ status } = {}) => {
    const filter = ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? { status } : {};
    const rows = await KitchenApplication.find(filter).populate('applicantId', 'name countryCode phone createdAt').sort({ createdAt: -1 }).limit(200).lean();
    const now = Date.now();
    return Promise.all(
        rows.map(async (a) => ({
            ...withoutFile(a),
            checks: {
                idFormat: a.idCheck,
                idLabel: a.idType === 'FSSAI' ? 'FSSAI licence' : orgIds.check(a.idType, a.idNumber).label,
                document: Boolean(a.document?.contentType),
                accountAgeDays: a.applicantId?.createdAt ? Math.floor((now - new Date(a.applicantId.createdAt).getTime()) / 86400000) : null,
                previouslyRejected: await KitchenApplication.countDocuments({ idType: a.idType, idNumber: a.idNumber, status: 'REJECTED', _id: { $ne: a._id } }),
            },
        }))
    );
};

/** The certificate: only the Super Admin and the applicant. */
const document = async (id, viewer) => {
    if (!mongoose.isValidObjectId(id)) throw notFound('Request not found');
    const app = await KitchenApplication.findById(id).select('+document.data document.contentType applicantId').lean();
    if (!app || !app.document?.data || !(viewer.role === ROLES.SUPER_ADMIN || String(app.applicantId) === String(viewer._id))) throw notFound('Request not found');
    const data = Buffer.isBuffer(app.document.data) ? app.document.data : Buffer.from(app.document.data.buffer || app.document.data);
    return { data, contentType: app.document.contentType };
};

/** Super Admin: recognise (the account becomes a Kitchen Manager) or reject with a reason. */
const decide = async (id, reviewer, { decision, reason } = {}) => {
    const rejectionReason = reasonOrThrow(decision, reason, 'the organisation');
    if (!mongoose.isValidObjectId(id)) throw notFound('Request not found');
    const current = await KitchenApplication.findById(id).lean();
    if (!current) throw notFound('Request not found');
    if (current.status !== 'PENDING') throw conflict('This request was already reviewed');
    if (decision === 'APPROVED') {
        // only a plain account becomes a Kitchen Manager (never a staff account)
        const done = await User.updateOne({ _id: current.applicantId, role: ROLES.USER }, { $set: { role: ROLES.KITCHEN_MANAGER, organisationName: current.orgName } });
        if (!done.modifiedCount) throw conflict('This account changed role meanwhile. Refresh and try again.');
    }
    const app = await KitchenApplication.findOneAndUpdate(
        { _id: id, status: 'PENDING' },
        {
            $set: { status: decision, reviewedBy: reviewer._id, reviewedAt: new Date(), ...(rejectionReason ? { rejectionReason } : {}) },
            $unset: decision === 'REJECTED' ? { pendingFor: 1, activeIdKey: 1 } : { pendingFor: 1 },
        },
        { returnDocument: 'after' }
    ).catch(async (err) => {
        if (decision === 'APPROVED') await User.updateOne({ _id: current.applicantId, role: ROLES.KITCHEN_MANAGER }, { $set: { role: ROLES.USER }, $unset: { organisationName: 1 } });
        throw err;
    });
    if (!app) {
        if (decision === 'APPROVED') await User.updateOne({ _id: current.applicantId, role: ROLES.KITCHEN_MANAGER }, { $set: { role: ROLES.USER }, $unset: { organisationName: 1 } });
        throw conflict('This request was already reviewed');
    }
    audit.record({ actor: reviewer, action: decision === 'APPROVED' ? 'KITCHEN_RECOGNISED' : 'KITCHEN_REJECTED', targetType: 'KitchenApplication', targetId: app._id, summary: `${reviewer.name} ${decision === 'APPROVED' ? 'recognised' : 'did not recognise'} the kitchen service ${app.orgName}` });
    return withoutFile(app);
};

// ---------- 2. Serving at a yatra: the District Control Room decides ----------

const yatraOrThrow = async (eventId) => {
    if (!mongoose.isValidObjectId(eventId)) throw notFound('Yatra not found');
    const event = await Event.findById(eventId, 'title kind startDate endDate status').lean();
    if (!event || event.kind !== 'YATRA') throw notFound('Yatra not found');
    return event;
};

const requestService = async (user, body = {}) => {
    const event = await yatraOrThrow(body.eventId);
    eventWindow.assertOpen(event);
    const sector = body.sector ? v.text(body.sector, 'Sector', 'campName') : undefined;
    const mealsPerDay = body.mealsPerDay !== undefined && body.mealsPerDay !== '' ? v.int(body.mealsPerDay, 'Meals a day', { min: 1, max: 1000000 }) : undefined;
    const note = v.text(body.note, 'Note for the control room', 'longText');
    try {
        const req = await ServiceRequest.create({
            organiserId: user._id,
            orgName: user.organisationName || user.name,
            eventId: event._id,
            sector,
            mealsPerDay,
            note,
            openKey: `${user._id}:${event._id}`,
        });
        audit.record({ actor: user, action: 'KITCHEN_SERVICE_REQUESTED', targetType: 'ServiceRequest', targetId: req._id, summary: `${user.organisationName || user.name} asked to serve at ${event.title}` });
        const out = req.toObject();
        delete out.openKey;
        return out;
    } catch (err) {
        if (err.code === 11000) throw conflict('You have already asked to serve at this yatra (waiting or approved)');
        throw err;
    }
};

const listServiceRequests = async (reviewer, { status } = {}) => {
    const filter = ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? { status } : {};
    return ServiceRequest.find(filter, '-openKey')
        .populate('organiserId', 'name countryCode phone organisationName')
        .populate('eventId', 'title slug')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();
};

/** Control room: approve (a verified kitchen organisation at this yatra) or reject with a reason. */
const decideService = async (id, reviewer, { decision, reason } = {}) => {
    const rejectionReason = reasonOrThrow(decision, reason, 'the kitchen');
    if (!mongoose.isValidObjectId(id)) throw notFound('Request not found');
    const current = await ServiceRequest.findOne({ _id: id, status: 'PENDING' }).lean();
    if (!current) throw conflict('This request was already reviewed, or does not exist');
    if (decision === 'APPROVED') eventWindow.assertOpen(await yatraOrThrow(current.eventId)); // not for a yatra that has closed
    const organiser = await User.findById(current.organiserId, 'role organisationName name').lean();
    if (decision === 'APPROVED' && organiser?.role !== ROLES.KITCHEN_MANAGER) throw conflict('This account is no longer a recognised kitchen service');

    let providerId;
    if (decision === 'APPROVED') {
        const provider = await Provider.create({
            name: current.orgName,
            type: 'KITCHEN',
            eventId: current.eventId,
            adminUserId: current.organiserId,
            verificationStatus: 'VERIFIED',
            verifiedBy: reviewer._id,
            verifiedAt: new Date(),
            description: current.note,
        });
        providerId = provider._id;
    }
    const updated = await ServiceRequest.findOneAndUpdate(
        { _id: id, status: 'PENDING' },
        {
            $set: { status: decision, reviewedBy: reviewer._id, reviewedAt: new Date(), ...(providerId ? { providerId } : {}), ...(rejectionReason ? { rejectionReason } : {}) },
            // a rejected kitchen may ask again for the same yatra
            ...(decision === 'REJECTED' ? { $unset: { openKey: 1 } } : {}),
        },
        { returnDocument: 'after' }
    ).lean();
    if (!updated) {
        if (providerId) await Provider.deleteOne({ _id: providerId });
        throw conflict('This request was already reviewed');
    }
    audit.record({ actor: reviewer, action: decision === 'APPROVED' ? 'KITCHEN_SERVICE_APPROVED' : 'KITCHEN_SERVICE_REJECTED', targetType: 'ServiceRequest', targetId: updated._id, summary: `${reviewer.name} ${decision === 'APPROVED' ? 'approved' : 'rejected'} ${updated.orgName} serving at this yatra` });
    delete updated.openKey;
    return updated;
};

// ---------- 3. The kitchen dashboard for one yatra ----------

/** The Kitchen Manager's verified organisation at this yatra, or 403 until the control room approves. */
const providerAt = async (user, eventId) => {
    if (!mongoose.isValidObjectId(eventId)) throw notFound('Yatra not found');
    const provider = await Provider.findOne({ adminUserId: user._id, eventId, type: 'KITCHEN', verificationStatus: 'VERIFIED' }).lean();
    if (!provider) throw forbidden('The District Control Room has not approved your kitchen for this yatra yet');
    return provider;
};

/** The trusts' kitchen logic acts for "the account's organisation": give it this yatra's one. */
const asOrganisation = (user, provider) => ({ ...user, role: ROLES.NGO_ADMIN, providerId: provider._id });

const dashboard = async (user, eventId) => {
    const provider = await providerAt(user, eventId);
    const base = await ngo.dashboard(asOrganisation(user, provider));
    const centers = await FoodCenter.find({ providerId: provider._id }).lean();
    // every meal slot of these kitchens from the shown day on, with tokens served (scanned) per slot
    const slots = await FoodSlot.find({ foodCenterId: { $in: centers.map((c) => c._id) }, date: { $gte: base.today } }).sort({ date: 1 }).lean();
    const served = await Pass.aggregate([
        { $match: { type: 'MEAL', refId: { $in: slots.map((sl) => sl._id) }, status: 'REDEEMED' } },
        { $group: { _id: '$refId', people: { $sum: { $ifNull: ['$details.people', 1] } } } },
    ]);
    const servedBy = new Map(served.map((x) => [String(x._id), x.people]));
    return {
        provider,
        today: base.today,
        prebooking: base.prebooking,
        kitchens: centers.map((c) => ({
            ...c,
            slots: slots.filter((sl) => String(sl.foodCenterId) === String(c._id)).map((sl) => ({ ...sl, issued: sl.capacity - sl.remaining, served: servedBy.get(String(sl._id)) || 0 })),
        })),
    };
};

const addKitchen = async (user, eventId, body = {}) => {
    const provider = await providerAt(user, eventId);
    if ((await FoodCenter.countDocuments({ providerId: provider._id })) >= 30) throw badRequest('A kitchen service can list at most 30 kitchens at one yatra');
    if (!body.sector || typeof body.sector !== 'string') throw badRequest('Choose the sector the kitchen is in');
    return ngo.addFoodCenter(asOrganisation(user, provider), { name: body.name, sector: body.sector.slice(0, 80), menu: body.menu });
};

const setMealQuota = async (user, eventId, centerId, body = {}) => {
    const provider = await providerAt(user, eventId);
    if (!mongoose.isValidObjectId(centerId) || !(await FoodCenter.exists({ _id: centerId, providerId: provider._id }))) throw notFound('Kitchen not found');
    return ngo.setSlot(asOrganisation(user, provider), centerId, { date: body.date, meal: body.meal, capacity: body.capacity });
};

/** Yatras this Kitchen Manager may work at now (approved), for the dashboard's yatra picker. */
const myYatras = async (user) =>
    ServiceRequest.find({ organiserId: user._id, status: 'APPROVED' }, 'eventId providerId').populate('eventId', 'title slug startDate endDate').lean();

module.exports = { apply, mine, list, document, decide, requestService, listServiceRequests, decideService, dashboard, addKitchen, setMealQuota, myYatras };
