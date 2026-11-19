const mongoose = require('mongoose');
const { Programme, TYPES } = require('./programme.model');
const Event = require('../event/event.model');
const Provider = require('../provider/provider.model');
const { Pass } = require('../pass/pass.model');
const { issuePass, toClient } = require('../pass/pass.service');
const audit = require('../audit/audit.service');
const realtime = require('../../utils/realtime');
const eventWindow = require('../../utils/eventWindow');
const v = require('../../utils/validate');
const { groupSize } = require('../../utils/limits');
const { istDate, istDateTime } = require('../../utils/time');
const { ROLES } = require('../../config/roles');
const { badRequest, notFound, conflict, forbidden } = require('../../utils/httpError');

/*
 * Programmes for pilgrims inside a yatra. Asked for by a kitchen service approved for that yatra
 * or by an approved event host; approved (or rejected with a reason) by the District Control Room;
 * then listed on the yatra page, where pilgrims reserve free places and get a QR pass.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const masked = (countryCode, phone) => (phone ? `+${countryCode || '91'} ${'•'.repeat(Math.max(String(phone).length - 4, 2))}${String(phone).slice(-4)}` : undefined);
const HOSTS = [ROLES.EVENT_HOST, ROLES.ORG_HOST];

const yatraOrThrow = async (eventId) => {
    if (!mongoose.isValidObjectId(eventId)) throw notFound('Yatra not found');
    const event = await Event.findById(eventId, 'title slug kind startDate endDate status').lean();
    if (!event || event.kind !== 'YATRA') throw notFound('Yatra not found');
    return event;
};

/**
 * Who may hold a programme at this yatra, and under which name:
 *   approved event hosts anywhere; a kitchen service only where the control room approved it;
 *   an NGO or trust only at the yatra the control room verified it for (under the trust's name).
 */
const assertMayHold = async (user, eventId) => {
    if (HOSTS.includes(user.role)) return user.organisationName || user.name;
    if (user.role === ROLES.KITCHEN_MANAGER) {
        if (await Provider.exists({ adminUserId: user._id, eventId, type: 'KITCHEN', verificationStatus: 'VERIFIED' })) return user.organisationName || user.name;
        throw forbidden('The District Control Room has not approved your kitchen for this yatra yet');
    }
    if (user.role === ROLES.NGO_ADMIN) {
        const trust = mongoose.isValidObjectId(user.providerId) ? await Provider.findOne({ _id: user.providerId, eventId, verificationStatus: 'VERIFIED' }, 'name').lean() : null;
        if (trust) return trust.name;
        throw forbidden('Your organisation is verified for another yatra: hold programmes there');
    }
    throw forbidden('Only recognised organisations can hold programmes for pilgrims');
};

const request = async (user, body = {}) => {
    const event = await yatraOrThrow(body.eventId);
    eventWindow.assertOpen(event);
    const organiserName = await assertMayHold(user, event._id);
    const title = v.text(body.title, 'Title', 'title', { required: true });
    const type = String(body.type || '').toUpperCase();
    if (!TYPES.includes(type)) throw badRequest('Choose the kind of programme');
    eventWindow.assertDay(event, body.date); // a day of the yatra that has not passed
    if (typeof body.startTime !== 'string' || typeof body.endTime !== 'string' || !HHMM.test(body.startTime) || !HHMM.test(body.endTime)) throw badRequest('Give the start and end time like 12:00');
    if (body.endTime <= body.startTime) throw badRequest('The programme must end after it starts');
    const venue = v.text(body.venue, 'Place', 'venue', { required: true });
    const sector = body.sector ? v.text(body.sector, 'Sector', 'campName') : undefined;
    const capacity = v.int(body.capacity, 'Places for pilgrims', { min: 1, max: 5000, required: true });
    const description = v.text(body.description, 'About the programme', 'longText');
    // a limit on requests waiting at once, so one account cannot flood the control room
    if ((await Programme.countDocuments({ organiserId: user._id, status: 'PENDING' })) >= 20) throw badRequest('You have 20 programmes waiting for review. Wait for decisions before asking for more.');
    const programme = await Programme.create({
        eventId: event._id,
        organiserId: user._id,
        organiserName,
        title,
        type,
        date: body.date,
        startTime: body.startTime,
        endTime: body.endTime,
        venue,
        sector,
        capacity,
        description,
    });
    audit.record({ actor: user, action: 'PROGRAMME_REQUESTED', targetType: 'Programme', targetId: programme._id, summary: `${programme.organiserName} asked to hold "${title}" at ${event.title} on ${body.date}` });
    realtime.notify(['control'], 'programmes', { action: 'requested' });
    return programme.toObject();
};

/** The organiser's own programmes (all statuses), newest first. */
const mine = async (user) => Programme.find({ organiserId: user._id }, '-reviewedBy').populate('eventId', 'title slug').sort({ date: -1, startTime: -1 }).limit(200).lean();

/** Control room: programmes waiting (or decided) with who asked. */
const listForReview = async ({ status } = {}) => {
    const filter = ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? { status } : {};
    return Programme.find(filter).populate('organiserId', 'name role countryCode phone organisationName').populate('eventId', 'title slug').sort({ date: 1, startTime: 1 }).limit(300).lean();
};

const decide = async (id, reviewer, { decision, reason } = {}) => {
    if (!['APPROVED', 'REJECTED'].includes(decision)) throw badRequest('decision must be APPROVED or REJECTED');
    let rejectionReason;
    if (decision === 'REJECTED') {
        if (typeof reason !== 'string' || reason.trim().length < 5) throw badRequest('Give a reason for rejecting: the organiser sees it');
        rejectionReason = reason.trim().slice(0, 300);
    }
    if (!mongoose.isValidObjectId(id)) throw notFound('Programme not found');
    if (decision === 'APPROVED') {
        // never approve a programme for a yatra that has closed, or a day that has passed
        const pending = await Programme.findById(id, 'eventId date').lean();
        if (pending) {
            const event = await yatraOrThrow(pending.eventId);
            eventWindow.assertOpen(event);
            eventWindow.assertDay(event, pending.date);
        }
    }
    const updated = await Programme.findOneAndUpdate(
        { _id: id, status: 'PENDING' },
        { $set: { status: decision, reviewedBy: reviewer._id, reviewedAt: new Date(), ...(rejectionReason ? { rejectionReason } : {}) } },
        { returnDocument: 'after' }
    ).lean();
    if (!updated) {
        if (!(await Programme.exists({ _id: id }))) throw notFound('Programme not found');
        throw conflict('This programme was already reviewed');
    }
    audit.record({ actor: reviewer, action: decision === 'APPROVED' ? 'PROGRAMME_APPROVED' : 'PROGRAMME_REJECTED', targetType: 'Programme', targetId: updated._id, summary: `${reviewer.name} ${decision === 'APPROVED' ? 'approved' : 'rejected'} "${updated.title}" by ${updated.organiserName}` });
    realtime.notify(['public', 'control', `user:${updated.organiserId}`], 'programmes', { action: decision.toLowerCase() });
    return updated;
};

/** Approved programmes of a yatra from today on, for its page (by id or address name). */
const forYatra = async (eventIdOrSlug) => {
    const key = String(eventIdOrSlug || '');
    const event = mongoose.isValidObjectId(key) ? await Event.findById(key, '_id').lean() : await Event.findOne({ slug: key.toLowerCase().slice(0, 120) }, '_id').lean();
    if (!event) throw notFound('Yatra not found');
    // only what a visitor needs (no account ids or review details)
    const rows = await Programme.find({ eventId: event._id, status: 'APPROVED', date: { $gte: istDate() } }, 'title type date startTime endTime venue sector capacity registered description organiserName eventId').sort({ date: 1, startTime: 1 }).limit(100).lean();
    // today's programmes that have already ended are not offered any more
    const now = new Date();
    return rows.filter((p) => istDateTime(p.date, p.endTime) > now).map((p) => ({ ...p, placesLeft: Math.max(p.capacity - p.registered, 0) }));
};

/** A pilgrim reserves free places (1 to 5) and gets a QR pass. Never more places than the capacity. */
const register = async (id, user, { people } = {}) => {
    if (!mongoose.isValidObjectId(id)) throw notFound('Programme not found');
    const count = groupSize(people, 'places');
    const programme = await Programme.findById(id).lean();
    if (!programme) throw notFound('Programme not found');
    if (programme.status !== 'APPROVED') throw badRequest('This programme is not open for registration');
    const event = await yatraOrThrow(programme.eventId);
    eventWindow.assertDay(event, programme.date); // over: no more registrations
    const until = istDateTime(programme.date, programme.endTime);
    if (until < new Date()) throw badRequest('This programme is over');

    // take the places atomically: only if they are still free
    const taken = await Programme.findOneAndUpdate(
        { _id: id, status: 'APPROVED', $expr: { $lte: [{ $add: ['$registered', count] }, '$capacity'] } },
        { $inc: { registered: count } },
        { returnDocument: 'after' }
    ).lean();
    if (!taken) throw conflict('Sorry, this programme is full (no places left for that many people)');
    try {
        const pass = await issuePass({
            type: 'PROGRAMME',
            userId: user._id,
            eventId: programme.eventId,
            refId: programme._id,
            title: programme.title,
            subtitle: `${programme.venue} - ${programme.date}, ${programme.startTime} to ${programme.endTime}${count > 1 ? ` - ${count} people` : ''}`,
            details: { venue: programme.venue, sector: programme.sector, date: programme.date, startTime: programme.startTime, endTime: programme.endTime, people: count, organiser: programme.organiserName, free: true },
            validFrom: new Date(istDateTime(programme.date, programme.startTime).getTime() - 3600000), // gates open an hour early
            validUntil: until,
            dedupeKey: `PROGRAMME:${programme._id}:${user._id}`,
        });
        realtime.notify(['public', `user:${programme.organiserId}`], 'programmes', { action: 'registered', id: String(programme._id) });
        return { pass: toClient(pass), placesLeft: Math.max(taken.capacity - taken.registered, 0) };
    } catch (err) {
        // give the places back
        await Programme.updateOne({ _id: id }, { $inc: { registered: -count } });
        if (err.code === 11000) throw conflict('You already have a place at this programme (see your passbook)');
        throw err;
    }
};

/** The organiser (or the control room): who registered, phone masked. */
const attendees = async (id, user) => {
    if (!mongoose.isValidObjectId(id)) throw notFound('Programme not found');
    const programme = await Programme.findById(id, 'organiserId').lean();
    if (!programme) throw notFound('Programme not found');
    const staff = [ROLES.SUPER_ADMIN, ROLES.AUTHORITY].includes(user.role);
    if (!staff && String(programme.organiserId) !== String(user._id)) throw forbidden('Only the organiser can see who registered');
    const passes = await Pass.find({ type: 'PROGRAMME', refId: programme._id }).populate('userId', 'name countryCode phone').sort({ createdAt: -1 }).limit(5000).lean();
    return passes.map((p) => ({
        _id: p._id,
        name: p.userId?.name,
        phone: masked(p.userId?.countryCode, p.userId?.phone),
        people: p.details?.people || 1,
        status: p.status === 'CANCELLED' ? 'CANCELLED' : p.status === 'REDEEMED' ? 'CHECKED_IN' : 'BOOKED',
        bookedAt: p.createdAt,
    }));
};

module.exports = { request, mine, listForReview, decide, forYatra, register, attendees, TYPES };
