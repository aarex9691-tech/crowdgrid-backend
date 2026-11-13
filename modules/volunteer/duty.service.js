const mongoose = require('mongoose');
const { Duty, VolunteerBroadcast } = require('./duty.model');
const { VolunteerApplication } = require('./volunteer.model');
const Event = require('../event/event.model');
const User = require('../auth/user.model');
const SosIncident = require('../sos/sos.model');
const { Lodging } = require('../lodging/lodging.model');
const nightsLib = require('../lodging/nights');
const audit = require('../audit/audit.service');
const realtime = require('../../utils/realtime');
const eventWindow = require('../../utils/eventWindow');
const { istDate, istDateTime } = require('../../utils/time');
const { ROLES } = require('../../config/roles');
const { badRequest, notFound, conflict } = require('../../utils/httpError');

/*
 * District control room: volunteer duties, live status, sector coverage and broadcasts.
 * Volunteers: their own duties, check in / check out, and broadcasts meant for them.
 *
 * Status of a volunteer (most urgent first):
 *   BUSY       handling an SOS alert assigned to them
 *   ON_DUTY    checked in to a shift
 *   LATE       a shift has started but they have not checked in
 *   SCHEDULED  a shift later on
 *   OFF        nothing assigned
 */

const MAX_SHIFT_HOURS = 12;
const CHECKIN_EARLY_MS = 30 * 60 * 1000; // check-in opens 30 minutes before a shift
// Coverage target: one volunteer per this many people staying in a sector tonight, and never fewer than MIN_PER_SECTOR
const PILGRIMS_PER_VOLUNTEER = Math.max(Number(process.env.PILGRIMS_PER_VOLUNTEER) || 50, 1);
const MIN_PER_SECTOR = 2;
const HOUR = 3600 * 1000;

const text = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const idOrThrow = (id, what) => {
    if (!mongoose.isValidObjectId(id)) throw notFound(`${what} not found`);
    return String(id);
};
const toDate = (v, what) => {
    const d = new Date(v);
    if (!v || Number.isNaN(d.getTime())) throw badRequest(`Choose a valid ${what}`);
    return d;
};
const notifyDuty = (volunteerId, action) => realtime.notify(['control', `user:${volunteerId}`], 'duty', { action });

/** Sectors of an event: the event's own list, camp sectors and sectors volunteers applied for. */
const sectorsFor = async (eventId) => {
    const event = await Event.findById(eventId, 'sectors').lean();
    if (!event) throw notFound('Event not found');
    const [camps, apps] = await Promise.all([
        Lodging.distinct('sector', { eventId, isActive: true }),
        VolunteerApplication.distinct('sector', { eventId, status: 'APPROVED' }),
    ]);
    return [...new Set([...(event.sectors || []), ...camps, ...apps].filter(Boolean).map(String))].sort();
};

/** Open duties: everyone checked in, plus shifts that have not ended yet. */
const openDutiesFilter = (now) => ({ $or: [{ status: 'ON_DUTY' }, { status: 'SCHEDULED', end: { $gt: now } }] });

const dutyView = (d) =>
    d && { id: String(d._id), sector: d.sector, post: d.post || '', start: d.start, end: d.end, status: d.status, checkedInAt: d.checkedInAt };

/** Everything the control room's volunteer dashboard shows, in one request. */
const dashboard = async (eventId) => {
    idOrThrow(eventId, 'Event');
    const now = new Date();
    const today = istDate();
    const [sectors, apps] = await Promise.all([
        sectorsFor(eventId),
        VolunteerApplication.find({ eventId, status: 'APPROVED' }, 'userId domain sector dates providerId')
            .populate('userId', 'name countryCode phone role isActive')
            .populate('providerId', 'name')
            .lean(),
    ]);
    const people = apps.filter((a) => a.userId && a.userId.isActive !== false && a.userId.role === ROLES.VOLUNTEER);
    const ids = people.map((a) => a.userId._id);

    const [duties, alerts, camps, broadcasts] = await Promise.all([
        Duty.find({ eventId, volunteerId: { $in: ids }, ...openDutiesFilter(now) }).sort({ start: 1 }).lean(),
        SosIncident.find({ eventId, assignedTo: { $in: ids }, status: { $ne: 'RESOLVED' } }, 'assignedTo type status').lean(),
        Lodging.find({ eventId, isActive: true }, 'sector totalBeds heldBeds')
            .lean()
            .then((ls) => nightsLib.attachAvailability(ls, { checkIn: today })),
        VolunteerBroadcast.find({ eventId }).sort({ createdAt: -1 }).limit(8).lean(),
    ]);

    const dutiesBy = new Map();
    for (const d of duties) {
        const k = String(d.volunteerId);
        if (!dutiesBy.has(k)) dutiesBy.set(k, []);
        dutiesBy.get(k).push(d);
    }
    const sosBy = new Map(alerts.map((a) => [String(a.assignedTo), a]));

    const roster = people
        .map((a) => {
            const u = a.userId;
            const mine = dutiesBy.get(String(u._id)) || [];
            const current = mine.find((d) => d.status === 'ON_DUTY');
            const next = mine.find((d) => d.status === 'SCHEDULED');
            const sos = sosBy.get(String(u._id));
            let status = 'OFF';
            if (sos) status = 'BUSY';
            else if (current) status = 'ON_DUTY';
            else if (next && next.start <= now) status = 'LATE';
            else if (next) status = 'SCHEDULED';
            return {
                id: String(u._id),
                name: u.name,
                countryCode: u.countryCode,
                phone: u.phone,
                domain: a.domain,
                homeSector: a.sector || '',
                trust: a.providerId?.name || '',
                servesToday: !a.dates?.length || a.dates.includes(today),
                status,
                duty: dutyView(current || next),
                upcoming: mine.filter((d) => d !== (current || next)).slice(0, 3).map(dutyView),
                sos: sos ? { id: String(sos._id), type: sos.type, status: sos.status } : null,
            };
        })
        .sort((x, y) => x.name.localeCompare(y.name));

    // Coverage: who is on duty in each sector against how many people sleep there tonight
    const staying = new Map();
    for (const c of camps) staying.set(c.sector, (staying.get(c.sector) || 0) + Math.max((c.totalBeds || 0) - (c.availableBeds || 0), 0));
    const coverage = sectors.map((sector) => {
        const here = roster.filter((r) => r.duty && r.duty.sector === sector);
        const onDuty = here.filter((r) => r.duty.status === 'ON_DUTY').length;
        const scheduled = here.filter((r) => r.duty.status === 'SCHEDULED').length;
        const pilgrims = staying.get(sector) || 0;
        const needed = Math.max(MIN_PER_SECTOR, Math.ceil(pilgrims / PILGRIMS_PER_VOLUNTEER));
        return { sector, onDuty, scheduled, staying: pilgrims, needed, gap: Math.max(needed - onDuty, 0) };
    });

    const count = (s) => roster.filter((r) => r.status === s).length;
    return {
        now,
        sectors,
        ratio: PILGRIMS_PER_VOLUNTEER,
        summary: {
            total: roster.length,
            onDuty: count('ON_DUTY'),
            busy: count('BUSY'),
            late: count('LATE'),
            scheduled: count('SCHEDULED'),
            off: count('OFF'),
            sectorsShort: coverage.filter((c) => c.gap > 0).length,
        },
        coverage,
        roster,
        broadcasts,
    };
};

/** No two open shifts of one volunteer may overlap in time. */
const assertNoOverlap = async (volunteerId, start, end, exceptId) => {
    const clash = await Duty.findOne(
        {
            volunteerId,
            status: { $in: ['SCHEDULED', 'ON_DUTY'] },
            start: { $lt: end },
            end: { $gt: start },
            ...(exceptId ? { _id: { $ne: exceptId } } : {}),
        },
        'sector start end'
    ).lean();
    if (clash) {
        const t = (d) => d.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
        throw conflict(`Already on a shift in ${clash.sector} from ${t(clash.start)} to ${t(clash.end)}`);
    }
};

const checkTimes = (start, end, event) => {
    if (end <= start) throw badRequest('The shift must end after it starts');
    if (end - start > MAX_SHIFT_HOURS * HOUR) throw badRequest(`A shift can be at most ${MAX_SHIFT_HOURS} hours`);
    if (end <= new Date()) throw badRequest('That shift is already over. Choose a later time.');
    if (start >= new Date(event.endDate)) throw badRequest('The shift must start before the event ends');
};

/** Control room puts an approved volunteer on a sector post for a shift. */
const assign = async (actor, { eventId, volunteerId, sector, post, start, end } = {}) => {
    idOrThrow(eventId, 'Event');
    idOrThrow(volunteerId, 'Volunteer');
    const event = await Event.findById(eventId, 'title kind status endDate').lean();
    eventWindow.assertOpen(event);
    const approved = await VolunteerApplication.exists({ eventId, userId: volunteerId, status: 'APPROVED' });
    const person = await User.findOne({ _id: volunteerId, role: ROLES.VOLUNTEER, isActive: { $ne: false } }, 'name').lean();
    if (!approved || !person) throw badRequest('Only an approved volunteer of this event can be given a duty');
    const where = text(sector, 80);
    if (!(await sectorsFor(eventId)).includes(where)) throw badRequest('Choose one of the event sectors');
    const from = toDate(start, 'start time');
    const to = toDate(end, 'end time');
    checkTimes(from, to, event);
    // Two control-room desks assigning the same person at the same instant could both pass this
    // check; the roster shows the clash straight away and either shift can be cancelled.
    await assertNoOverlap(volunteerId, from, to);
    const duty = await Duty.create({ volunteerId, eventId, sector: where, post: text(post, 80), start: from, end: to, assignedBy: actor._id });
    audit.record({
        actor,
        action: 'DUTY_ASSIGNED',
        targetType: 'Duty',
        targetId: duty._id,
        summary: `${actor.name} put ${person.name} on duty in ${where}${duty.post ? ` (${duty.post})` : ''}`,
    });
    notifyDuty(volunteerId, 'assigned');
    return duty.toObject();
};

/** Control room moves a duty to another sector / post / time, ends it, or cancels it. */
const update = async (actor, id, { sector, post, start, end, status } = {}) => {
    idOrThrow(id, 'Duty');
    const duty = await Duty.findById(id);
    if (!duty) throw notFound('Duty not found');
    if (!['SCHEDULED', 'ON_DUTY'].includes(duty.status)) throw conflict('This duty has already finished');
    const person = await User.findById(duty.volunteerId, 'name').lean();
    let action = 'DUTY_UPDATED';
    let summary;

    if (status) {
        if (status === 'CANCELLED') {
            duty.status = 'CANCELLED';
            action = 'DUTY_CANCELLED';
            summary = `${actor.name} cancelled the ${duty.sector} duty of ${person?.name || 'a volunteer'}`;
        } else if (status === 'DONE') {
            if (duty.status !== 'ON_DUTY') throw conflict('Only a shift in progress can be ended');
            duty.status = 'DONE';
            duty.checkedOutAt = new Date();
            action = 'DUTY_ENDED';
            summary = `${actor.name} ended the ${duty.sector} shift of ${person?.name || 'a volunteer'}`;
        } else {
            throw badRequest('status must be CANCELLED or DONE');
        }
    } else {
        if (sector !== undefined) {
            const where = text(sector, 80);
            if (!(await sectorsFor(duty.eventId)).includes(where)) throw badRequest('Choose one of the event sectors');
            duty.sector = where;
        }
        if (post !== undefined) duty.post = text(post, 80);
        if (start !== undefined || end !== undefined) {
            const from = start !== undefined ? toDate(start, 'start time') : duty.start;
            const to = end !== undefined ? toDate(end, 'end time') : duty.end;
            const event = await Event.findById(duty.eventId, 'endDate').lean();
            checkTimes(from, to, event);
            await assertNoOverlap(duty.volunteerId, from, to, duty._id);
            duty.start = from;
            duty.end = to;
        }
        summary = `${actor.name} moved ${person?.name || 'a volunteer'} to ${duty.sector}${duty.post ? ` (${duty.post})` : ''}`;
    }
    await duty.save();
    audit.record({ actor, action, targetType: 'Duty', targetId: duty._id, summary });
    notifyDuty(duty.volunteerId, 'updated');
    return duty.toObject();
};

/** A volunteer's own open shifts and the latest messages meant for them. */
const mine = async (user) => {
    const now = new Date();
    const [duties, apps] = await Promise.all([
        Duty.find({ volunteerId: user._id, ...openDutiesFilter(now) }).populate('eventId', 'title').sort({ start: 1 }).limit(10).lean(),
        VolunteerApplication.find({ userId: user._id, status: 'APPROVED' }, 'eventId sector').lean(),
    ]);
    // Messages for their events: to everyone, to their home sector, or to a sector they have a shift in
    const or = apps.map((a) => {
        const sectors = [a.sector, ...duties.filter((d) => String(d.eventId?._id) === String(a.eventId)).map((d) => d.sector)].filter(Boolean);
        return { eventId: a.eventId, $or: [{ sector: { $in: [null, ''] } }, { sector: { $exists: false } }, { sector: { $in: sectors } }] };
    });
    const broadcasts = or.length
        ? await VolunteerBroadcast.find({ $or: or, createdAt: { $gte: new Date(now - 24 * HOUR) } }).sort({ createdAt: -1 }).limit(5).lean()
        : [];
    return {
        now,
        duties: duties.map((d) => ({
            ...dutyView(d),
            event: d.eventId?.title || '',
            canCheckIn: d.status === 'SCHEDULED' && d.start - now <= CHECKIN_EARLY_MS && d.end > now,
        })),
        broadcasts,
    };
};

/** Volunteer starts a shift: only their own, from 30 minutes before it until it ends. */
const checkIn = async (user, id) => {
    idOrThrow(id, 'Duty');
    const now = new Date();
    const duty = await Duty.findOneAndUpdate(
        { _id: id, volunteerId: user._id, status: 'SCHEDULED', start: { $lte: new Date(now.getTime() + CHECKIN_EARLY_MS) }, end: { $gt: now } },
        { $set: { status: 'ON_DUTY', checkedInAt: now } },
        { returnDocument: 'after' }
    );
    if (!duty) {
        const d = await Duty.findOne({ _id: id, volunteerId: user._id }, 'status start end').lean();
        if (!d) throw notFound('Duty not found');
        if (d.status === 'ON_DUTY') throw conflict('You are already checked in');
        if (d.status !== 'SCHEDULED') throw conflict('This duty is no longer open');
        if (d.end <= now) throw conflict('This shift has already ended');
        throw conflict('Check-in opens 30 minutes before your shift');
    }
    // A shift left running by mistake is closed when the next one starts
    await Duty.updateMany({ volunteerId: user._id, status: 'ON_DUTY', _id: { $ne: duty._id } }, { $set: { status: 'DONE', checkedOutAt: now } });
    audit.record({ actor: user, action: 'DUTY_CHECK_IN', targetType: 'Duty', targetId: duty._id, summary: `${user.name} checked in at ${duty.sector}` });
    notifyDuty(user._id, 'check-in');
    return duty.toObject();
};

/** Volunteer ends their shift. */
const checkOut = async (user, id) => {
    idOrThrow(id, 'Duty');
    const duty = await Duty.findOneAndUpdate(
        { _id: id, volunteerId: user._id, status: 'ON_DUTY' },
        { $set: { status: 'DONE', checkedOutAt: new Date() } },
        { returnDocument: 'after' }
    );
    if (!duty) throw conflict('You are not checked in to this duty');
    audit.record({ actor: user, action: 'DUTY_CHECK_OUT', targetType: 'Duty', targetId: duty._id, summary: `${user.name} ended duty at ${duty.sector}` });
    notifyDuty(user._id, 'check-out');
    return duty.toObject();
};

/** Control room message to every volunteer of the event, or to one sector. */
const broadcast = async (actor, { eventId, sector, message } = {}) => {
    idOrThrow(eventId, 'Event');
    const body = text(message, 280);
    if (body.length < 3) throw badRequest('Write a message for the volunteers');
    const where = text(sector, 80);
    if (where && !(await sectorsFor(eventId)).includes(where)) throw badRequest('Choose one of the event sectors');
    const doc = await VolunteerBroadcast.create({ eventId, sector: where || undefined, message: body, sentBy: actor._id, sentByName: actor.name });
    audit.record({
        actor,
        action: 'VOLUNTEER_BROADCAST',
        targetType: 'VolunteerBroadcast',
        targetId: doc._id,
        summary: `${actor.name} messaged volunteers${where ? ` in ${where}` : ''}`,
    });
    // Only a "something new" notice travels over the socket; the text is read through the API
    realtime.notify(['volunteers', 'control'], 'volunteer-broadcast', { id: String(doc._id) });
    return doc.toObject();
};

module.exports = { dashboard, assign, update, mine, checkIn, checkOut, broadcast, sectorsFor };
