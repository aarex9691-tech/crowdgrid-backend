const crypto = require('crypto');
const mongoose = require('mongoose');
const Event = require('./event.model');
const Provider = require('../provider/provider.model');
const { groupSize, MAX_PER_ACCOUNT } = require('../../utils/limits');
const nightsLib = require('../lodging/nights');
const { Lodging } = require('../lodging/lodging.model');
const { Pass } = require('../pass/pass.model');
const { issuePass, toClient } = require('../pass/pass.service');
const { hasPermission, ROLES, HOST_ROLES } = require('../../config/roles');
const User = require('../auth/user.model');
const audit = require('../audit/audit.service');
const { HttpError, badRequest, forbidden, notFound, conflict } = require('../../utils/httpError');
const realtime = require('../../utils/realtime');
const v = require('../../utils/validate');

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
        // free beds on each yatra's next night (today, or its first night if it has not started)
        Lodging.find({ eventId: { $in: yatraIds }, isActive: true }, 'eventId totalBeds heldBeds').lean().then(async (ls) => {
            const by = new Map();
            for (const e of events.filter((x) => x.kind === 'YATRA')) {
                const mineL = ls.filter((l) => String(l.eventId) === String(e._id));
                await nightsLib.attachAvailability(mineL, { checkIn: nightsLib.defaultNight(e) });
                by.set(String(e._id), { _id: e._id, total: mineL.reduce((s, l) => s + (l.totalBeds || 0), 0), available: mineL.reduce((s, l) => s + l.availableBeds, 0) });
            }
            return [...by.values()];
        }),
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

/**
 * How many people are registered for an event, shown to pilgrims and visitors.
 *   PUBLIC / CORPORATE: tickets issued (attendeesCount, kept exact when tickets are issued)
 *   YATRA: accounts holding at least one stay, meal or shuttle pass that is not cancelled
 *          (volunteer badges are not counted). Cached for a minute per event, so a busy yatra
 *          page does not re-count every pass on every visit.
 */
const REGISTERED_TTL_MS = 60 * 1000;
const registeredCache = new Map(); // eventId -> { n, at }
const registeredCount = async (event) => {
    if (event.kind !== 'YATRA') return event.attendeesCount || 0;
    const key = String(event._id);
    const hit = registeredCache.get(key);
    if (hit && Date.now() - hit.at < REGISTERED_TTL_MS) return hit.n;
    const [row] = await Pass.aggregate([
        { $match: { eventId: event._id, status: { $ne: 'CANCELLED' }, type: { $ne: 'VOLUNTEER' } } },
        { $group: { _id: '$userId' } },
        { $count: 'n' },
    ]);
    const n = row?.n || 0;
    registeredCache.set(key, { n, at: Date.now() });
    return n;
};

const get = async (idOrSlug) => {
    const event = (await findEvent(idOrSlug)).toObject();
    return { ...event, registered: await registeredCount(event) };
};

const slugify = (s) =>
    String(s)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '')
        .slice(0, 60);

const assertCanManageKind = (user, kind) => {
    // Yatra hubs are official: only the platform's own staff create them, never an organisation host
    const perm = kind === 'CORPORATE' ? 'event:create:corporate' : kind === 'YATRA' ? 'event:create:yatra' : 'event:create:public';
    if (!hasPermission(user.role, perm)) throw forbidden(`Your role cannot manage ${kind.toLowerCase()} events`);
};

// Only the fields that belong to each kind of event are ever stored
const COMMON_FIELDS = ['title', 'kind', 'description', 'city', 'state', 'venue', 'startDate', 'endDate'];
const KIND_FIELDS = {
    YATRA: ['tagline', 'isFlagship', 'expectedFootfall', 'keyDates', 'sectors'],
    PUBLIC: ['category', 'address', 'pincode', 'location', 'ticketPrice', 'minAge', 'hostName', 'contactCountryCode', 'contactPhone', 'capacity'],
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
const { EVENT_CATEGORIES: PUBLIC_CATEGORIES } = require('../../utils/eventCategories');

/** Checks a paid public event before it is saved; returns the cleaned data. */
const validatePublic = (data, user) => {
    // Same rules as the host form in the browser (utils/validate.js)
    data.title = v.text(data.title, 'Title', 'title', { required: true });
    if (data.description === undefined || data.description === '') throw badRequest('Description is required');
    data.venue = v.text(data.venue, 'Venue name', 'venue', { required: true });
    data.address = v.text(data.address, 'Street / landmark', 'address', { required: true });
    data.city = v.text(data.city, 'City', 'city', { required: true });
    if (!data.startDate) throw badRequest('Start date and time is required');
    if (!data.endDate) throw badRequest('End date and time is required');
    const desc = String(data.description);
    // Counted without spaces, so padding with spaces cannot meet or dodge the limit
    const letters = desc.replace(/\s/g, '').length;
    if (letters < DESC_MIN) throw badRequest(`Description needs at least ${DESC_MIN} characters (not counting spaces); it has ${letters}`);
    if (letters > DESC_MAX) throw badRequest(`Description can have at most ${DESC_MAX} characters (not counting spaces); it has ${letters}`);
    data.category = String(data.category || '').toUpperCase();
    if (!PUBLIC_CATEGORIES.includes(data.category)) throw badRequest('Choose a category from the list');
    data.pincode = v.pincode(data.pincode);
    // ₹0 = free entry: registration is confirmed straight away, no payment step
    data.ticketPrice = v.int(data.ticketPrice ?? 0, 'Ticket price (₹)', { min: 0, max: 100000, required: true });
    data.capacity = v.int(data.capacity, 'Capacity', { min: 1, max: 100000, required: true });
    data.minAge = v.int(data.minAge, 'Minimum age', { min: 0, max: 100 }) || undefined;
    const contact = v.mobile(data.contactCountryCode, data.contactPhone, 'Contact number');
    data.contactCountryCode = contact?.countryCode;
    data.contactPhone = contact?.phone;
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
        validateCorporate(data);
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
    // An approved host's events show its organisation and a "Verified organiser" badge
    if (HOST_ROLES.includes(user.role)) {
        const org = (await User.findById(user._id, 'organisationName').lean())?.organisationName;
        if (org) {
            data.organiserName = org;
            data.organiserVerified = true;
        }
    }
    const event = await Event.create(data);
    const out = event.toObject();
    audit.record({ actor: user, action: 'EVENT_CREATED', targetType: 'Event', targetId: event._id, summary: `${user.name} created ${data.kind.toLowerCase()} event "${event.title}"` });
    // The organiser sees the generated code once here; later via GET /:id/corporate/code
    if (data.kind !== 'CORPORATE') delete out.accessCode;
    return out;
};

/** Campus & Corporate events: same field rules as the create form. */
const validateCorporate = (data) => {
    data.title = v.text(data.title, 'Event title', 'title', { required: true });
    data.companyName = v.text(data.companyName, 'Organisation name', 'orgName', { required: true });
    data.venue = v.text(data.venue, 'Venue', 'venue', { required: true });
    data.city = v.text(data.city, 'City', 'city', { required: true });
    data.description = v.text(data.description, 'Description', 'longText');
    if (data.capacity !== undefined) data.capacity = v.int(data.capacity, 'Capacity', { min: 1, max: 100000 });
    return data;
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
        for (const k of [...COMMON_FIELDS, ...KIND_FIELDS.PUBLIC]) if (data[k] !== undefined) data[k] = merged[k];
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

/**
 * Tickets this account already holds for a public event (cancelled passes do not count).
 * An account can book in several goes (e.g. 2 now, 3 later) up to MAX_PER_ACCOUNT tickets.
 * Each booking gets its own slot key PUBLIC:<event>:<user>[:<n>], so two bookings sent at
 * the same moment cannot both take the same slot (unique index on dedupeKey).
 */
const myTickets = async (eventId, userId) => {
    const passes = await Pass.find({ type: 'PUBLIC', eventId, userId }).select('status details.people').lean();
    const held = passes.filter((p) => p.status !== 'CANCELLED').reduce((n, p) => n + (p.details?.people || 1), 0);
    return { held, bookings: passes.length, left: Math.max(0, MAX_PER_ACCOUNT - held) };
};
const ticketKey = (eventId, userId, bookings) => `PUBLIC:${eventId}:${userId}${bookings ? `:${bookings + 1}` : ''}`;
const limitMessage = (held) =>
    held >= MAX_PER_ACCOUNT
        ? `You already have ${MAX_PER_ACCOUNT} tickets for this event, the most one account can book`
        : `You already have ${held} ${held === 1 ? 'ticket' : 'tickets'}; you can book ${MAX_PER_ACCOUNT - held} more for this event`;

/** Price check for the cart: tickets for 1 to 5 people on one pass. */
const quote = async (eventId, user, people = 1) => {
    people = groupSize(people, 'tickets');
    const event = await findEvent(eventId);
    if (event.kind !== 'PUBLIC' || event.status !== 'ACTIVE') throw badRequest('Tickets are only sold for public events');
    if (event.endDate < new Date()) throw badRequest('This event has already ended');
    const left = event.capacity - (event.attendeesCount || 0);
    if (left <= 0) throw conflict('Sorry, this event is full');
    if (people > left) throw conflict(`Only ${left} ${left === 1 ? 'place is' : 'places are'} left`);
    if (user) {
        const mine = await myTickets(event._id, user._id);
        if (people > mine.left) throw conflict(limitMessage(mine.held));
    }
    const when = event.startDate.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return { event, label: event.title, detail: `${people} ${people === 1 ? 'ticket' : 'tickets'} - ${when} - ${event.venue}, ${event.city}`, amount: (event.ticketPrice || 0) * people };
};

/**
 * Registration for a public event (paid at checkout).
 * Atomic seat claim: the $expr filter only matches while attendeesCount < capacity,
 * so concurrent registrations can never push the headcount past capacity. The
 * per-account limit (5 tickets, in one or more bookings) is checked with myTickets.
 */
const register = async (eventId, user, { paidByOrder = null, people = 1 } = {}) => {
    people = groupSize(people, 'tickets');
    const event = await findEvent(eventId);
    if (event.kind !== 'PUBLIC') throw badRequest('Registration is only for public events');
    if (event.status !== 'ACTIVE') throw badRequest('This event is no longer open for registration');
    if (event.endDate < new Date()) throw badRequest('This event has already ended');
    if ((event.ticketPrice || 0) > 0 && !paidByOrder) {
        throw new HttpError(402, `Tickets cost ₹${event.ticketPrice}. Add the event to your cart and pay at checkout.`);
    }

    const mine = await myTickets(event._id, user._id);
    if (people > mine.left) throw conflict(limitMessage(mine.held));
    const dedupeKey = ticketKey(event._id, user._id, mine.bookings);

    // Claim a seat atomically, outside any transaction
    const claimed = await Event.findOneAndUpdate(
        // room for the whole group: attendeesCount + people <= capacity
        { _id: event._id, $expr: { $lte: [{ $add: [{ $ifNull: ['$attendeesCount', 0] }, people] }, '$capacity'] } },
        { $inc: { attendeesCount: people } },
        { returnDocument: 'after' }
    );
    if (!claimed) throw conflict(people > 1 ? `Not enough places left for ${people} people` : 'Sorry, this event is full');
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
                people,
                ...(paidByOrder ? { paid: paidByOrder.amount, orderId: String(paidByOrder._id) } : {}),
            },
            validFrom: new Date(event.startDate.getTime() - 1 * 3600 * 1000), // gates open an hour before
            validUntil: event.endDate,
            dedupeKey,
        });
        realtime.notify(['public', 'control'], 'tickets', { eventId: String(claimed._id) });
        return { message: people > 1 ? `You're registered with ${people} tickets!` : "You're registered!", attendeesCount: claimed.attendeesCount, pass: toClient(pass) };
    } catch (err) {
        await Event.updateOne({ _id: event._id }, { $inc: { attendeesCount: -people } });
        if (err.code === 11000) throw conflict('Another booking for this event is in progress on your account. Please try again.');
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
        { $match: { type: 'PUBLIC', eventId: { $in: events.map((e) => e._id) } } },
        // a pass can cover a group: count people, not passes
        {
            $group: {
                _id: '$eventId',
                sold: { $sum: { $cond: [{ $ne: ['$status', 'CANCELLED'] }, { $ifNull: ['$details.people', 1] }, 0] } },
                checkedIn: { $sum: { $cond: [{ $eq: ['$status', 'REDEEMED'] }, { $ifNull: ['$details.people', 1] }, 0] } },
                // cancelled tickets: the part of the price that was NOT refunded is still revenue
                keptOnCancel: { $sum: { $cond: [{ $eq: ['$status', 'CANCELLED'] }, { $subtract: [{ $ifNull: ['$details.paid', 0] }, { $ifNull: ['$refund.amount', 0] }] }, 0] } },
                refunded: { $sum: { $ifNull: ['$refund.amount', 0] } },
            },
        },
    ]);
    const byEvent = new Map(counts.map((c) => [String(c._id), c]));
    return events.map((e) => {
        const c = byEvent.get(String(e._id));
        const sold = e.attendeesCount || 0; // includes tickets sold at the counter
        // attendeesCount already drops cancelled tickets; add back what was kept from them
        return { ...e, ticketsSold: sold, onlineTickets: c?.sold || 0, checkedIn: c?.checkedIn || 0, refunded: c?.refunded || 0, revenue: sold * (e.ticketPrice || 0) + (c?.keptOnCancel || 0) };
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
            validFrom: new Date(event.startDate.getTime() - 1 * 3600 * 1000), // gates open an hour before
            validUntil: event.endDate,
            dedupeKey: `CORPORATE:${event._id}:${user._id}`,
        });
        return { message: 'Badge issued', pass: toClient(pass) };
    } catch (err) {
        if (err.code === 11000) throw conflict('You already have a badge for this event');
        throw err;
    }
};

/** How many tickets this account holds for an event and how many more it can book. */
const myTicketCount = async (eventId, user) => {
    const event = await findEvent(eventId);
    const mine = await myTickets(event._id, user._id);
    return { held: mine.held, left: mine.left, max: MAX_PER_ACCOUNT };
};

module.exports = {
    quote,
    myTicketCount,
    register,
    hostedEvents,
    findEvent, list, get, create, update, archive,
    verifyCorporateCode, claimCorporateBadge, getCorporateCode, regenerateCorporateCode, generateAccessCode,
    myCorporateEvents, corporateAttendees, findByAccessCode,
};
