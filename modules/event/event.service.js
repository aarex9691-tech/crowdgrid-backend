const crypto = require('crypto');
const mongoose = require('mongoose');
const Event = require('./event.model');
const Provider = require('../provider/provider.model');
const { Lodging } = require('../lodging/lodging.model');
const { Pass } = require('../pass/pass.model');
const { issuePass, toClient } = require('../pass/pass.service');
const { hasPermission, ROLES } = require('../../config/roles');
const audit = require('../audit/audit.service');
const { HttpError, badRequest, forbidden, notFound, conflict } = require('../../utils/httpError');

const findEvent = async (idOrSlug, projection) => {
    const query = mongoose.isValidObjectId(idOrSlug) ? { _id: idOrSlug } : { slug: String(idOrSlug).toLowerCase() };
    const event = await Event.findOne(query, projection);
    if (!event) throw notFound('Event not found');
    return event;
};

/** Event cards for the landing page, with live stats for yatra hubs. */
const list = async ({ kind } = {}) => {
    const filter = { status: 'ACTIVE' };
    // Corporate events are invite-only: never listed publicly. Invitees reach them
    // through their invitation link or by entering their access code.
    filter.kind = kind && String(kind).toUpperCase() !== 'CORPORATE' ? String(kind).toUpperCase() : { $ne: 'CORPORATE' };
    // Public events disappear from listings once they are over
    filter.$or = [{ kind: { $ne: 'PUBLIC' } }, { endDate: { $gte: new Date() } }];
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

// Only the fields that belong to each kind of event are ever stored
const COMMON_FIELDS = ['title', 'kind', 'description', 'city', 'state', 'venue', 'startDate', 'endDate'];
const KIND_FIELDS = {
    YATRA: ['tagline', 'isFlagship', 'expectedFootfall', 'keyDates', 'sectors'],
    PUBLIC: ['category', 'address', 'pincode', 'location', 'ticketPrice', 'minAge', 'hostName', 'contactPhone', 'capacity'],
    CORPORATE: ['companyName', 'sessions', 'capacity'],
};
const pick = (body, kind) => {
    const fields = [...COMMON_FIELDS, ...(KIND_FIELDS[kind] || [])];
    return Object.fromEntries(
        fields.filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== '').map((k) => [k, typeof body[k] === 'string' ? body[k].trim() : body[k]])
    );
};

/**
 * Hosted events (public and corporate) share one date rule: a single sitting
 * that starts in the future, at most a year ahead, lasting 30 minutes to 12 hours.
 */
const HOSTED_MAX_DAYS_AHEAD = 365;
const assertHostedWindow = (startDate, endDate) => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw badRequest('Choose a valid date, start time and end time');
    const now = Date.now();
    if (start.getTime() < now) throw badRequest('The event must start in the future');
    if (start.getTime() > now + HOSTED_MAX_DAYS_AHEAD * 86400000) throw badRequest('Events can be scheduled at most one year ahead');
    const minutes = (end - start) / 60000;
    if (minutes < 30) throw badRequest('The event must end at least 30 minutes after it starts');
    if (minutes > 12 * 60) throw badRequest('An event can last at most 12 hours');
};

const DESC_MIN = 150;
const DESC_MAX = 200;
const PUBLIC_CATEGORIES = ['SPIRITUAL', 'CULTURAL', 'HERITAGE_WALK', 'SEVA', 'WORKSHOP', 'OTHER'];

/** Checks a paid public event before it is saved; returns the cleaned data. */
const validatePublic = (data, user) => {
    const need = (k, label) => {
        if (data[k] === undefined || data[k] === '') throw badRequest(`${label} is required`);
    };
    need('title', 'Title');
    need('description', 'Description');
    need('venue', 'Venue');
    need('address', 'Address');
    need('city', 'City');
    need('startDate', 'Start date and time');
    need('endDate', 'End date and time');
    if (String(data.title).length > 100) throw badRequest('Title can be at most 100 characters');
    const desc = String(data.description);
    // Counted without spaces, so padding with spaces cannot meet or dodge the limit
    const letters = desc.replace(/\s/g, '').length;
    if (letters < DESC_MIN) throw badRequest(`Description needs at least ${DESC_MIN} characters (not counting spaces); it has ${letters}`);
    if (letters > DESC_MAX) throw badRequest(`Description can have at most ${DESC_MAX} characters (not counting spaces); it has ${letters}`);
    data.category = String(data.category || '').toUpperCase();
    if (!PUBLIC_CATEGORIES.includes(data.category)) throw badRequest(`Category must be one of ${PUBLIC_CATEGORIES.join(', ')}`);
    if (data.pincode !== undefined && !/^\d{6}$/.test(String(data.pincode))) throw badRequest('Pincode must be 6 digits');
    // ₹0 = free entry: registration is confirmed straight away, no payment step
    const price = Number(data.ticketPrice ?? 0);
    if (!Number.isInteger(price) || price < 0 || price > 100000) throw badRequest('Ticket price must be between ₹0 (free) and ₹1,00,000');
    data.ticketPrice = price;
    const cap = Number(data.capacity);
    if (!Number.isInteger(cap) || cap < 1 || cap > 100000) throw badRequest('Capacity must be between 1 and 1,00,000 people');
    data.capacity = cap;
    if (data.minAge !== undefined) {
        const a = Number(data.minAge);
        if (!Number.isInteger(a) || a < 0 || a > 100) throw badRequest('Minimum age must be between 0 and 100');
        data.minAge = a || undefined;
    }
    if (data.contactPhone !== undefined) {
        data.contactPhone = String(data.contactPhone).replace(/\D/g, '');
        if (!/^[6-9]\d{9}$/.test(data.contactPhone)) throw badRequest('Contact number must be a 10-digit Indian mobile number');
    }
    if (data.location !== undefined) {
        const lat = Number(data.location?.lat);
        const lng = Number(data.location?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw badRequest('Map location is not valid');
        data.location = { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
    }
    data.hostName = data.hostName ? String(data.hostName).slice(0, 80) : user.name;
    data.attendeesCount = 0;
    return data;
};

const create = async (body, user) => {
    const kind = String(body?.kind || '').toUpperCase();
    if (!['YATRA', 'PUBLIC', 'CORPORATE'].includes(kind)) throw badRequest('kind must be YATRA, PUBLIC or CORPORATE');
    const data = pick(body || {}, kind);
    data.kind = kind;
    assertCanManageKind(user, data.kind);
    if (data.kind === 'PUBLIC') validatePublic(data, user);
    if (data.kind === 'CORPORATE') {
        data.attendeesCount = 0;
        // Corporate access codes are always generated by the server (never chosen by people)
        data.accessCode = await uniqueAccessCode();
        if (!data.companyName) throw badRequest('Company name is required for corporate events');
        data.sessions = normaliseSessions(data.sessions);
        if (!data.sessions.length) throw badRequest('Add at least one session or meal');
    }
    if (data.kind === 'PUBLIC' || data.kind === 'CORPORATE') {
        assertHostedWindow(data.startDate, data.endDate);
    } else if (data.startDate && data.endDate && new Date(data.endDate) < new Date(data.startDate)) {
        throw badRequest('The event must end after it starts');
    }
    data.slug = `${slugify(data.title || 'event')}-${crypto.randomBytes(3).toString('hex')}`;
    data.organizerId = user._id;
    const event = await Event.create(data);
    const out = event.toObject();
    audit.record({ actor: user, action: 'EVENT_CREATED', targetType: 'Event', targetId: event._id, summary: `${user.name} created ${data.kind.toLowerCase()} event "${event.title}"` });
    // The organiser sees the generated code once here; later via GET /:id/corporate/code
    if (data.kind !== 'CORPORATE') delete out.accessCode;
    return out;
};

/** Cleans the session list from the create form; gives each session a stable code. */
const normaliseSessions = (sessions) =>
    (Array.isArray(sessions) ? sessions : [])
        .filter((s) => s && String(s.title || '').trim())
        .slice(0, 20)
        .map((s, i) => ({
            code: `S${i + 1}`,
            title: String(s.title).trim().slice(0, 120),
            kind: s.kind === 'MEAL' ? 'MEAL' : 'SESSION',
            time: s.time ? String(s.time).slice(0, 10) : undefined,
        }));

/**
 * Corporate Admin dashboard: the organiser's corporate events (all of them for
 * a Super Admin) with the access code and how many badges have been claimed.
 */
const myCorporateEvents = async (user) => {
    if (!hasPermission(user.role, 'event:create:corporate')) throw forbidden('Only corporate admins can manage corporate events');
    const filter = { kind: 'CORPORATE', status: 'ACTIVE' };
    if (user.role !== ROLES.SUPER_ADMIN) filter.organizerId = user._id;
    const events = await Event.find(filter).select('+accessCode').sort({ startDate: 1 }).lean();
    const counts = await Pass.aggregate([
        { $match: { type: 'CORPORATE', eventId: { $in: events.map((e) => e._id) }, status: { $ne: 'CANCELLED' } } },
        { $group: { _id: '$eventId', claimed: { $sum: 1 }, checkedIn: { $sum: { $cond: [{ $eq: ['$status', 'REDEEMED'] }, 1, 0] } } } },
    ]);
    const byEvent = new Map(counts.map((c) => [String(c._id), c]));
    return events.map((e) => ({
        ...e,
        badgesClaimed: byEvent.get(String(e._id))?.claimed || 0,
        checkedIn: byEvent.get(String(e._id))?.checkedIn || 0,
    }));
};

/** Organiser or Super Admin: who has claimed a badge, their sessions, and whether they checked in. */
const corporateAttendees = async (eventId, user) => {
    const event = await findEvent(eventId);
    if (event.kind !== 'CORPORATE') throw badRequest('Not a corporate event');
    assertCanManageKind(user, event.kind);
    assertOwnerOrAdmin(event, user);
    const passes = await Pass.find({ eventId: event._id, type: 'CORPORATE', status: { $ne: 'CANCELLED' } })
        .populate('userId', 'name countryCode phone')
        .sort({ createdAt: -1 })
        .lean();
    return passes.map((p) => ({
        _id: p._id,
        name: p.userId?.name,
        phone: p.userId?.phone && `+${p.userId.countryCode || '91'} ${p.userId.phone}`,
        sessions: p.details?.sessions || [],
        claimedAt: p.createdAt,
        checkedIn: p.status === 'REDEEMED',
        checkedInAt: p.redeemedAt,
    }));
};

/** Random 6-digit code from a cryptographically secure generator. */
const generateAccessCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/** A code no other live corporate event is using, so a code alone identifies one event. */
const uniqueAccessCode = async () => {
    for (let i = 0; i < 10; i++) {
        const code = generateAccessCode();
        if (!(await Event.exists({ kind: 'CORPORATE', status: 'ACTIVE', accessCode: code }))) return code;
    }
    throw new Error('Could not generate a unique access code');
};

const assertNotEnded = (event) => {
    if (event.status !== 'ACTIVE' || new Date(event.endDate) < new Date()) {
        throw badRequest('This event has already ended');
    }
};

/**
 * "Have an invitation code?" on the home page: finds the live corporate event
 * that uses this code. Wrong guesses count towards the per-user attempt limit.
 */
const findByAccessCode = async (rawCode) => {
    const code = String(rawCode || '').replace(/\D/g, '');
    if (code.length !== 6) throw badRequest('Enter the 6-digit code from your invitation');
    const event = await Event.findOne({ kind: 'CORPORATE', status: 'ACTIVE', accessCode: code }).lean();
    if (!event) throw forbidden('No invitation matches this code');
    assertNotEnded(event);
    return { eventId: event._id, slug: event.slug, title: event.title, companyName: event.companyName };
};

/** Organiser or Super Admin: read the current access code. */
const getCorporateCode = async (eventId, user) => {
    const event = await findEvent(eventId, '+accessCode');
    if (event.kind !== 'CORPORATE') throw badRequest('Not a corporate event');
    assertCanManageKind(user, event.kind);
    assertOwnerOrAdmin(event, user);
    return { accessCode: event.accessCode };
};

/** Organiser or Super Admin: replace the code (e.g. if it leaked). Old code stops working at once. */
const regenerateCorporateCode = async (eventId, user) => {
    const event = await findEvent(eventId, '+accessCode');
    if (event.kind !== 'CORPORATE') throw badRequest('Not a corporate event');
    assertCanManageKind(user, event.kind);
    assertOwnerOrAdmin(event, user);
    event.accessCode = await uniqueAccessCode();
    await event.save();
    audit.record({ actor: user, action: 'ACCESS_CODE_REGENERATED', targetType: 'Event', targetId: event._id, summary: `${user.name} regenerated the access code for "${event.title}"` });
    return { accessCode: event.accessCode };
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
    const data = pick(body || {}, event.kind);
    delete data.kind; // kind cannot change
    if (event.kind === 'PUBLIC') {
        const merged = validatePublic({ ...event.toObject(), ...data }, user);
        for (const k of KIND_FIELDS.PUBLIC) if (data[k] !== undefined) data[k] = merged[k];
        delete data.attendeesCount;
    }
    if ((data.startDate || data.endDate) && ['PUBLIC', 'CORPORATE'].includes(event.kind)) {
        assertHostedWindow(data.startDate ?? event.startDate, data.endDate ?? event.endDate);
    }
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
    audit.record({ actor: user, action: 'EVENT_ARCHIVED', targetType: 'Event', targetId: event._id, summary: `${user.name} archived "${event.title}"` });
    return { message: 'Event archived' };
};

/** Price check for the cart: one paid ticket for one person. */
const quote = async (eventId, user) => {
    const event = await findEvent(eventId);
    if (event.kind !== 'PUBLIC' || event.status !== 'ACTIVE') throw badRequest('Tickets are only sold for public events');
    if (event.endDate < new Date()) throw badRequest('This event has already ended');
    if ((event.attendeesCount || 0) >= event.capacity) throw conflict('Sorry, this event is full');
    if (user && (await Pass.exists({ dedupeKey: `PUBLIC:${event._id}:${user._id}` }))) throw conflict('You are already registered for this event');
    const when = event.startDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return { event, label: event.title, detail: `1 ticket - ${when} - ${event.venue}, ${event.city}`, amount: event.ticketPrice || 0 };
};

/**
 * Registration for a public event (paid at checkout).
 * Atomic seat claim: the $expr filter only matches while attendeesCount < capacity,
 * so concurrent registrations can never push the headcount past capacity. The
 * pass's unique dedupeKey stops the same person registering twice.
 */
const register = async (eventId, user, { paidByOrder = null } = {}) => {
    const event = await findEvent(eventId);
    if (event.kind !== 'PUBLIC') throw badRequest('Registration is only for public events');
    if (event.endDate < new Date()) throw badRequest('This event has already ended');
    if ((event.ticketPrice || 0) > 0 && !paidByOrder) {
        throw new HttpError(402, `Tickets cost ₹${event.ticketPrice}. Add the event to your cart and pay at checkout.`);
    }

    const dedupeKey = `PUBLIC:${event._id}:${user._id}`;
    if (await Pass.exists({ dedupeKey })) throw conflict('You are already registered for this event');

    // Claim a seat atomically, outside any transaction
    const claimed = await Event.findOneAndUpdate(
        { _id: event._id, $expr: { $lt: [{ $ifNull: ['$attendeesCount', 0] }, '$capacity'] } },
        { $inc: { attendeesCount: 1 } },
        { returnDocument: 'after' }
    );
    if (!claimed) throw conflict('Sorry, this event is full');
    try {
        const pass = await issuePass({
            type: 'PUBLIC',
            userId: user._id,
            eventId: event._id,
            refId: event._id,
            title: event.title,
            subtitle: `${event.venue}, ${event.city} - Entry ticket`,
            details: {
                venue: event.venue,
                address: event.address,
                city: event.city,
                startsAt: event.startDate,
                ...(paidByOrder ? { paid: paidByOrder.amount, orderId: String(paidByOrder._id) } : {}),
            },
            validFrom: new Date(event.startDate.getTime() - 2 * 3600 * 1000),
            validUntil: event.endDate,
            dedupeKey,
        });
        return { message: "You're registered!", attendeesCount: claimed.attendeesCount, pass: toClient(pass) };
    } catch (err) {
        await Event.updateOne({ _id: event._id }, { $inc: { attendeesCount: -1 } });
        if (err.code === 11000) throw conflict('You are already registered for this event');
        throw err;
    }
};

/** Public events hosted by this admin (all of them for a Super Admin), with sales. */
const hostedEvents = async (user) => {
    if (!hasPermission(user.role, 'event:create:public')) throw forbidden('Only authorised hosts can manage public events');
    const filter = { kind: 'PUBLIC' };
    if (user.role !== ROLES.SUPER_ADMIN) filter.organizerId = user._id;
    const events = await Event.find(filter).sort({ startDate: -1 }).lean();
    const counts = await Pass.aggregate([
        { $match: { type: 'PUBLIC', eventId: { $in: events.map((e) => e._id) }, status: { $ne: 'CANCELLED' } } },
        { $group: { _id: '$eventId', sold: { $sum: 1 }, checkedIn: { $sum: { $cond: [{ $eq: ['$status', 'REDEEMED'] }, 1, 0] } } } },
    ]);
    const byEvent = new Map(counts.map((c) => [String(c._id), c]));
    return events.map((e) => {
        const c = byEvent.get(String(e._id));
        const sold = e.attendeesCount || 0; // includes tickets sold at the counter
        return { ...e, ticketsSold: sold, onlineTickets: c?.sold || 0, checkedIn: c?.checkedIn || 0, revenue: sold * (e.ticketPrice || 0) };
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
    assertNotEnded(event);
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

module.exports = {
    quote,
    register,
    hostedEvents,
    findEvent, list, get, create, update, archive,
    verifyCorporateCode, claimCorporateBadge, getCorporateCode, regenerateCorporateCode, generateAccessCode,
    myCorporateEvents, corporateAttendees, findByAccessCode,
};
