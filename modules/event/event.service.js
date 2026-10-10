const crypto = require('crypto');
const mongoose = require('mongoose');
const Event = require('./event.model');
const Provider = require('../provider/provider.model');
const { Lodging } = require('../lodging/lodging.model');
const { Pass } = require('../pass/pass.model');
const { issuePass, toClient } = require('../pass/pass.service');
const { withTransaction } = require('../../utils/tx');
const { hasPermission, ROLES } = require('../../config/roles');
const { badRequest, forbidden, notFound, conflict } = require('../../utils/httpError');

const findEvent = async (idOrSlug, projection) => {
    const query = mongoose.isValidObjectId(idOrSlug) ? { _id: idOrSlug } : { slug: String(idOrSlug).toLowerCase() };
    const event = await Event.findOne(query, projection);
    if (!event) throw notFound('Event not found');
    return event;
};

/** Event cards for the landing page, with live stats for yatra hubs. */
const list = async ({ kind } = {}) => {
    const filter = { status: 'ACTIVE' };
    if (kind) filter.kind = String(kind).toUpperCase();
    const events = await Event.find(filter).sort({ isFlagship: -1, startDate: 1 }).lean();

    const yatraIds = events.filter((e) => e.kind === 'YATRA').map((e) => e._id);
    if (!yatraIds.length) return events;

    const [camps, beds] = await Promise.all([
        Provider.aggregate([
            { $match: { eventId: { $in: yatraIds }, verificationStatus: 'VERIFIED' } },
            { $group: { _id: '$eventId', count: { $sum: 1 } } },
        ]),
        Lodging.aggregate([
            { $match: { eventId: { $in: yatraIds }, isActive: true } },
            { $group: { _id: '$eventId', total: { $sum: '$totalBeds' }, available: { $sum: '$availableBeds' } } },
        ]),
    ]);
    const campMap = new Map(camps.map((c) => [String(c._id), c.count]));
    const bedMap = new Map(beds.map((b) => [String(b._id), b]));
    return events.map((e) =>
        e.kind !== 'YATRA'
            ? e
            : {
                  ...e,
                  stats: {
                      verifiedProviders: campMap.get(String(e._id)) || 0,
                      totalBeds: bedMap.get(String(e._id))?.total || 0,
                      availableBeds: bedMap.get(String(e._id))?.available || 0,
                  },
              }
    );
};

const get = async (idOrSlug) => (await findEvent(idOrSlug)).toObject();

const slugify = (s) =>
    String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 60);

const assertCanManageKind = (user, kind) => {
    const perm = kind === 'CORPORATE' ? 'event:create:corporate' : 'event:create:public';
    if (!hasPermission(user.role, perm)) throw forbidden(`Your role cannot manage ${kind.toLowerCase()} events`);
};

const ALLOWED_FIELDS = [
    'title', 'kind', 'tagline', 'description', 'city', 'state', 'venue', 'startDate', 'endDate', 'coverImage',
    'isFlagship', 'expectedFootfall', 'keyDates', 'sectors', 'capacity', 'companyName', 'accessCode', 'sessions',
];
const pick = (body) => Object.fromEntries(ALLOWED_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

const create = async (body, user) => {
    const data = pick(body || {});
    data.kind = String(data.kind || '').toUpperCase();
    if (!['YATRA', 'PUBLIC', 'CORPORATE'].includes(data.kind)) throw badRequest('kind must be YATRA, PUBLIC or CORPORATE');
    assertCanManageKind(user, data.kind);
    if (data.kind === 'CORPORATE' && !/^\d{6}$/.test(String(data.accessCode || ''))) {
        throw badRequest('Corporate events need a 6-digit access code');
    }
    data.slug = `${slugify(data.title || 'event')}-${crypto.randomBytes(3).toString('hex')}`;
    data.organizerId = user._id;
    const event = await Event.create(data);
    const out = event.toObject();
    delete out.accessCode;
    return out;
};

const assertOwnerOrAdmin = (event, user) => {
    if (user.role === ROLES.SUPER_ADMIN) return;
    if (!event.organizerId || String(event.organizerId) !== String(user._id)) {
        throw forbidden('Only the organiser or a Super Admin can change this event');
    }
};

const update = async (id, body, user) => {
    const event = await findEvent(id);
    assertCanManageKind(user, event.kind);
    assertOwnerOrAdmin(event, user);
    const data = pick(body || {});
    delete data.kind; // kind cannot change
    if (data.capacity !== undefined && Number(data.capacity) < event.attendeesCount) {
        throw badRequest(`Capacity cannot be below the ${event.attendeesCount} people already registered`);
    }
    event.set(data);
    await event.save();
    const out = event.toObject();
    delete out.accessCode;
    return out;
};

const archive = async (id, user) => {
    const event = await findEvent(id);
    assertCanManageKind(user, event.kind);
    assertOwnerOrAdmin(event, user);
    event.status = 'ARCHIVED';
    await event.save();
    return { message: 'Event archived' };
};

/**
 * Public event RSVP.
 * Atomic seat claim: the $expr filter only matches while attendeesCount < capacity,
 * so concurrent RSVPs can never push the headcount past capacity. The pass's
 * unique dedupeKey stops the same user registering twice.
 */
const rsvp = async (eventId, user) => {
    const event = await findEvent(eventId);
    if (event.kind !== 'PUBLIC') throw badRequest('RSVP is only for public events');
    if (event.endDate < new Date()) throw badRequest('This event has already ended');

    const dedupeKey = `PUBLIC:${event._id}:${user._id}`;
    if (await Pass.exists({ dedupeKey })) throw conflict("You have already RSVP'd to this event");

    return withTransaction(async (session) => {
        const claimed = await Event.findOneAndUpdate(
            { _id: event._id, $expr: { $lt: ['$attendeesCount', '$capacity'] } },
            { $inc: { attendeesCount: 1 } },
            { returnDocument: 'after', session }
        );
        if (!claimed) throw conflict('Sorry, this event is full');
        try {
            const pass = await issuePass(
                {
                    type: 'PUBLIC',
                    userId: user._id,
                    eventId: event._id,
                    refId: event._id,
                    title: event.title,
                    subtitle: `${event.venue || event.city} - Entry pass`,
                    details: { venue: event.venue, city: event.city, startsAt: event.startDate },
                    validFrom: new Date(event.startDate.getTime() - 2 * 3600 * 1000),
                    validUntil: event.endDate,
                    dedupeKey,
                },
                session
            );
            return { message: "You're registered!", attendeesCount: claimed.attendeesCount, pass: toClient(pass) };
        } catch (err) {
            if (!session) await Event.updateOne({ _id: event._id }, { $inc: { attendeesCount: -1 } });
            if (err.code === 11000) throw conflict("You have already RSVP'd to this event");
            throw err;
        }
    });
};

const checkCode = async (eventId, code) => {
    const event = await findEvent(eventId, '+accessCode');
    if (event.kind !== 'CORPORATE') throw badRequest('Not a corporate event');
    const a = Buffer.from(String(event.accessCode || ''));
    const b = Buffer.from(String(code || '').trim());
    if (a.length === 0 || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        throw forbidden('Access denied: invalid access code');
    }
    return event;
};

/** Step 1 of the corporate flow: verify the 6-digit code, reveal the session list. */
const verifyCorporateCode = async (eventId, code) => {
    const event = await checkCode(eventId, code);
    return { eventId: event._id, title: event.title, companyName: event.companyName, sessions: event.sessions };
};

/** Step 2: claim the digital badge for the chosen sessions / meals. */
const claimCorporateBadge = async (eventId, user, { code, sessions = [] }) => {
    const event = await checkCode(eventId, code);
    const valid = new Set(event.sessions.map((s) => s.code));
    const chosen = [...new Set((Array.isArray(sessions) ? sessions : []).map(String))].filter((c) => valid.has(c));
    if (!chosen.length) throw badRequest('Pick at least one session');
    try {
        const pass = await issuePass({
            type: 'CORPORATE',
            userId: user._id,
            eventId: event._id,
            refId: event._id,
            title: event.title,
            subtitle: `${event.companyName || 'Corporate'} - Delegate badge`,
            details: {
                company: event.companyName,
                venue: event.venue,
                sessions: event.sessions.filter((s) => chosen.includes(s.code)).map((s) => s.title),
            },
            validFrom: new Date(event.startDate.getTime() - 2 * 3600 * 1000),
            validUntil: event.endDate,
            dedupeKey: `CORPORATE:${event._id}:${user._id}`,
        });
        return { message: 'Badge issued', pass: toClient(pass) };
    } catch (err) {
        if (err.code === 11000) throw conflict('You already have a badge for this event');
        throw err;
    }
};

module.exports = { findEvent, list, get, create, update, archive, rsvp, verifyCorporateCode, claimCorporateBadge };
