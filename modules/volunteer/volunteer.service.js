const mongoose = require('mongoose');
const { VolunteerApplication, DOMAINS } = require('./volunteer.model');
const Event = require('../event/event.model');
const Provider = require('../provider/provider.model');
const User = require('../auth/user.model');
const { issuePass, toClient } = require('../pass/pass.service');
const { withTransaction } = require('../../utils/tx');
const { ROLES } = require('../../config/roles');
const { badRequest, notFound, conflict, forbidden } = require('../../utils/httpError');

const DOMAIN_LABELS = {
    CROWD_CONTROL: 'Crowd Marshalling',
    LANGAR_SERVING: 'Langar Food Serving',
    SENIOR_ESCORT: 'Senior Citizen Escort',
    FIRST_AID: 'First-Aid Assistance',
};

const apply = async (user, { eventId, providerId, domain, sector, dates, note } = {}) => {
    if (!DOMAINS.includes(domain)) throw badRequest(`Choose a seva domain: ${DOMAINS.join(', ')}`);
    if (!mongoose.isValidObjectId(eventId) || !(await Event.exists({ _id: eventId }))) throw notFound('Event not found');
    if (providerId && !(await Provider.exists({ _id: providerId, eventId, verificationStatus: 'VERIFIED' }))) {
        throw badRequest('Choose a verified trust for this event');
    }
    try {
        const application = await VolunteerApplication.create({
            userId: user._id,
            eventId,
            providerId: providerId || undefined,
            domain,
            sector,
            dates: Array.isArray(dates) ? dates.slice(0, 30) : [],
            note,
        });
        return application.toObject();
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
    return VolunteerApplication.find(filter)
        .populate('userId', 'name phone')
        .populate('eventId', 'title')
        .populate('providerId', 'name')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean();
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

    return withTransaction(async (session) => {
        const updated = await VolunteerApplication.findOneAndUpdate(
            { _id: app._id, status: 'PENDING' },
            { $set: { status: decision, reviewedBy: reviewer._id, reviewedAt: new Date(), rejectionReason: reason } },
            { returnDocument: 'after', session }
        );
        if (!updated) throw conflict('Application was already reviewed');
        if (decision === 'REJECTED') return { application: updated.toObject() };

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
        return { application: updated.toObject(), badge: toClient(badge) };
    });
};

module.exports = { apply, mine, listForReview, review, DOMAIN_LABELS };
