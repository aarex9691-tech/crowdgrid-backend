const mongoose = require('mongoose');
const { VolunteerApplication, DOMAINS, ID_TYPES } = require('./volunteer.model');
const Event = require('../event/event.model');
const eventWindow = require('../../utils/eventWindow');
const Provider = require('../provider/provider.model');
const User = require('../auth/user.model');
const { issuePass, toClient } = require('../pass/pass.service');
const { withTransaction } = require('../../utils/tx');
const audit = require('../audit/audit.service');
const realtime = require('../../utils/realtime');
const { ROLES } = require('../../config/roles');
const { badRequest, notFound, conflict, forbidden } = require('../../utils/httpError');
const { sniffDocument } = require('../host/host.service');

const MAX_ID_BYTES = 2 * 1024 * 1024;

/** The application as sent to people: never the ID photo itself. */
const withoutCard = (doc) => {
    const out = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
    if (out.idDocument) delete out.idDocument.data;
    return out;
};

/** The yatra by id; if the page held an old id (the data was seeded again), by its name in the address. */
const findEventFor = async (eventId, eventSlug) => {
    const fields = 'kind startDate endDate status slug';
    if (mongoose.isValidObjectId(eventId)) {
        const byId = await Event.findById(eventId, fields).lean();
        if (byId) return byId;
    }
    if (eventSlug && typeof eventSlug === 'string') return Event.findOne({ slug: eventSlug.toLowerCase().slice(0, 120) }, fields).lean();
    return null;
};

const DOMAIN_LABELS = {
    CROWD_CONTROL: 'Crowd Marshalling',
    LANGAR_SERVING: 'Langar Food Serving',
    SENIOR_ESCORT: 'Senior Citizen Escort',
    FIRST_AID: 'First-Aid Assistance',
};

const apply = async (user, body = {}, file = null) => {
    const { eventId, eventSlug, providerId, domain, sector, note, idType, idLast4 } = body;
    let { dates } = body;
    if (!DOMAINS.includes(domain)) throw badRequest(`Choose a seva domain: ${DOMAINS.join(', ')}`);
    const event = await findEventFor(eventId, eventSlug);
    eventWindow.assertOpen(event); // 404 if missing; no new seva once the event is closed or over
    // The days offered must be real days of the event that have not passed (at most 30, no repeats).
    // A form upload sends them as "2026-11-15,2026-11-16".
    if (typeof dates === 'string') dates = dates.split(',').filter(Boolean);
    if (dates !== undefined && !Array.isArray(dates)) throw badRequest('Choose the days you can serve');
    const days = [...new Set((dates || []).map((d) => String(d)))].slice(0, 30);
    for (const d of days) eventWindow.assertDay(event, d);
    days.sort();
    if (providerId && !(await Provider.exists({ _id: providerId, eventId: event._id, verificationStatus: 'VERIFIED' }))) {
        throw badRequest('Choose a verified trust for this event');
    }
    // Photo ID: the type, the last 4 characters only, and a photo of the card
    if (!ID_TYPES[idType]) throw badRequest('Choose the ID you will show (Aadhaar, voter ID, driving licence...)');
    const last4 = String(idLast4 ?? '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(last4)) throw badRequest('Enter only the last 4 characters of your ID number');
    if (!file || !file.length) throw badRequest('Add a photo of your ID card');
    if (file.length > MAX_ID_BYTES) throw badRequest('The ID photo is too large. Use a file under 2 MB.');
    const contentType = sniffDocument(file);
    if (!contentType) throw badRequest('The ID card must be a photo (JPEG, PNG or WEBP) or a PDF');
    try {
        const application = await VolunteerApplication.create({
            userId: user._id,
            eventId: event._id,
            providerId: providerId || undefined,
            domain,
            sector: sector ? String(sector).slice(0, 80) : undefined,
            dates: days,
            note: note ? String(note).slice(0, 500) : undefined,
            idType,
            idLast4: last4,
            idDocument: { data: file, contentType, size: file.length },
        });
        return withoutCard(application);
    } catch (err) {
        if (err.code === 11000) throw conflict('You have already applied for seva at this event');
        throw err;
    }
};

const mine = async (userId) =>
    VolunteerApplication.find({ userId }).populate('eventId', 'title city').populate('providerId', 'name').sort({ createdAt: -1 }).lean();

/** Review queue. NGO admins only see applications made to their own trust. */
const listForReview = async (reviewer, { status, eventId } = {}) => {
    const filter = {};
    if (status) filter.status = String(status);
    if (eventId && mongoose.isValidObjectId(eventId)) filter.eventId = eventId;
    if (reviewer.role === ROLES.NGO_ADMIN) {
        if (!reviewer.providerId) return [];
        filter.providerId = reviewer.providerId;
    }
    const rows = await VolunteerApplication.find(filter)
        .populate('userId', 'name countryCode phone photoKey createdAt')
        .populate('eventId', 'title')
        .populate('providerId', 'name')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();
    const now = Date.now();
    return rows.map((a) => ({
        ...withoutCard(a),
        // what the control room should look at before approving
        checks: {
            idType: ID_TYPES[a.idType] || null,
            idLast4: a.idLast4 || null,
            idDocument: Boolean(a.idDocument?.contentType),
            photo: Boolean(a.userId?.photoKey),
            accountAgeDays: a.userId?.createdAt ? Math.floor((now - new Date(a.userId.createdAt).getTime()) / 86400000) : null,
            idVerified: Boolean(a.idVerifiedAt),
        },
    }));
};

/** The ID card photo: only the control room, the Super Admin and the volunteer themself. */
const idDocument = async (id, viewer) => {
    if (!mongoose.isValidObjectId(id)) throw notFound('Application not found');
    const app = await VolunteerApplication.findById(id).select('+idDocument.data idDocument.contentType userId').lean();
    const staff = [ROLES.SUPER_ADMIN, ROLES.AUTHORITY].includes(viewer.role);
    if (!app || !app.idDocument?.data || !(staff || String(app.userId) === String(viewer._id))) throw notFound('Application not found');
    const data = Buffer.isBuffer(app.idDocument.data) ? app.idDocument.data : Buffer.from(app.idDocument.data.buffer || app.idDocument.data);
    return { data, contentType: app.idDocument.contentType };
};

/** A control-room officer has seen the volunteer's ID card in person (once, after approval). */
const verifyId = async (id, officer) => {
    if (!mongoose.isValidObjectId(id)) throw notFound('Application not found');
    const app = await VolunteerApplication.findOneAndUpdate(
        { _id: id, status: 'APPROVED', idVerifiedAt: null },
        { $set: { idVerifiedAt: new Date(), idVerifiedBy: officer._id } },
        { returnDocument: 'after' }
    ).populate('userId', 'name');
    if (!app) {
        const current = await VolunteerApplication.findById(id, 'status idVerifiedAt').lean();
        if (!current) throw notFound('Application not found');
        if (current.idVerifiedAt) throw conflict('Their ID was already checked');
        throw conflict('Approve the application before checking the ID');
    }
    audit.record({ actor: officer, action: 'VOLUNTEER_ID_CHECKED', targetType: 'VolunteerApplication', targetId: app._id, summary: `${officer.name} checked the ID of ${app.userId?.name || 'a volunteer'} in person` });
    realtime.notify([`user:${app.userId?._id}`, 'control'], 'duty', { action: 'id-checked' });
    return withoutCard(app);
};

/**
 * Approve / reject. Approval promotes the user USER -> VOLUNTEER (never demotes
 * a higher role) and issues the Volunteer Digital ID badge (a verify-only pass).
 */
const review = async (applicationId, reviewer, { decision, reason } = {}) => {
    if (!['APPROVED', 'REJECTED'].includes(decision)) throw badRequest('decision must be APPROVED or REJECTED');
    const app = await VolunteerApplication.findById(applicationId);
    if (!app) throw notFound('Application not found');
    if (reviewer.role === ROLES.NGO_ADMIN && String(app.providerId) !== String(reviewer.providerId)) {
        throw forbidden('This application was made to another trust');
    }

    const result = await withTransaction(async (session) => {
        const updated = await VolunteerApplication.findOneAndUpdate(
            { _id: app._id, status: 'PENDING' },
            { $set: { status: decision, reviewedBy: reviewer._id, reviewedAt: new Date(), rejectionReason: reason } },
            { returnDocument: 'after', session }
        );
        if (!updated) throw conflict('Application was already reviewed');
        if (decision === 'REJECTED') return { application: withoutCard(updated) };

        const event = await Event.findById(app.eventId).session(session).lean();
        await User.updateOne(
            { _id: app.userId, role: ROLES.USER },
            { $set: { role: ROLES.VOLUNTEER, providerId: app.providerId || null } },
            { session }
        );
        const holder = await User.findById(app.userId).session(session).lean();
        const provider = app.providerId ? await Provider.findById(app.providerId).session(session).lean() : null;
        const badge = await issuePass(
            {
                type: 'VOLUNTEER',
                userId: app.userId,
                eventId: app.eventId,
                providerId: app.providerId,
                refId: app._id,
                title: `Seva Volunteer - ${DOMAIN_LABELS[app.domain]}`,
                subtitle: `${event.title}${app.sector ? ` - ${app.sector}` : ''}`,
                details: { name: holder.name, domain: DOMAIN_LABELS[app.domain], sector: app.sector, trust: provider?.name, dates: app.dates },
                validFrom: new Date(),
                validUntil: event.endDate,
                singleUse: false,
                dedupeKey: `VOLUNTEER:${app.eventId}:${app.userId}`,
            },
            session
        );
        return { application: withoutCard(updated), badge: toClient(badge) };
    });
    // Logged only after the transaction has committed
    const holderName = (await User.findById(app.userId, 'name').lean())?.name || 'applicant';
    audit.record({
        actor: reviewer,
        action: decision === 'APPROVED' ? 'VOLUNTEER_APPROVED' : 'VOLUNTEER_REJECTED',
        targetType: 'VolunteerApplication',
        targetId: app._id,
        summary: `${reviewer.name} ${decision === 'APPROVED' ? 'approved' : 'rejected'} seva application of ${holderName}`,
    });
    return result;
};

module.exports = { apply, mine, listForReview, review, idDocument, verifyId, DOMAIN_LABELS, MAX_ID_BYTES };
