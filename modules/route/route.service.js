const mongoose = require('mongoose');
const Event = require('../event/event.model');
const SosIncident = require('../sos/sos.model');
const { Pass } = require('../pass/pass.model');
const { LaneStatus, LANE_STATUS } = require('./lane.model');
const { EVENT_SLUG, NODES, LANES } = require('./network.nashik');
const { haversine, buildAdjacency, dijkstra, aStar } = require('./pathfinding');
const audit = require('../audit/audit.service');
const realtime = require('../../utils/realtime');
const { badRequest, notFound } = require('../../utils/httpError');

/**
 * Safest walking route to a ghat.
 *
 * Every lane gets a crowd status. The control room sets it by hand
 * (NORMAL / BUSY / CROWDED / CLOSED) and the server raises it automatically when
 *   - an open "crowd" SOS is within 150 m of the lane (CROWDED),
 *   - any other open SOS is within 60 m (BUSY: responders on the lane),
 *   - a camp or kitchen at either end had many QR check-ins in the last 30 min.
 * Shortest route: weight = length. Safest route: weight = length x crowd factor.
 */
const FACTOR = { NORMAL: 1, BUSY: 1.6, CROWDED: 4, CLOSED: Infinity };
const SPEED_M_PER_MIN = { NORMAL: 75, BUSY: 50, CROWDED: 25 }; // 4.5, 3 and 1.5 km/h on foot
const RANK = { NORMAL: 0, BUSY: 1, CROWDED: 2, CLOSED: 3 };
const SCAN_WINDOW_MIN = 30;
const SCANS_BUSY = 15;
const SCANS_CROWDED = 40;
const SOS_CROWD_RADIUS_M = 150;
const SOS_OTHER_RADIUS_M = 60;
const NEAREST_LIMIT_M = 1500;
const DETOUR = 1.1; // lanes bend: 10% longer than the straight line

// Load-aware routing: every planned route is remembered for LOAD_WINDOW_MIN. A lane that
// many pilgrims were just sent down costs more, so later pilgrims are spread over other
// lanes instead of everyone being sent down the same "safest" route.
//   safest cost = length x crowd factor x (1 + recent plans on the lane / LANE_PLAN_CAPACITY)
const { LOAD_WINDOW_MIN } = require('./routePlan.model');
const LANE_PLAN_CAPACITY = Number(process.env.ROUTE_LANE_CAPACITY) || 40; // plans per lane per window before its cost doubles

// ---------- The graph (built once; it never changes while the server runs) ----------
const nodeById = new Map(NODES.map((n) => [n.id, n]));
const EDGES = LANES.map(([id, a, b, name]) => ({ id, a, b, name, lengthM: Math.round(haversine(nodeById.get(a), nodeById.get(b)) * DETOUR) }));
const GRAPH = { nodes: NODES, edges: EDGES, adj: buildAdjacency(NODES, EDGES) };
const laneIds = new Set(EDGES.map((e) => e.id));

// ---------- Pure helpers (unit tested) ----------

/** Distance in metres from point p to the lane a-b (flat-earth approximation, fine within a few km). */
const distanceToLane = (p, a, b) => {
    const mPerLat = 111320;
    const mPerLng = 111320 * Math.cos((p.lat * Math.PI) / 180);
    const ax = (a.lng - p.lng) * mPerLng;
    const ay = (a.lat - p.lat) * mPerLat;
    const bx = (b.lng - p.lng) * mPerLng;
    const by = (b.lat - p.lat) * mPerLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
};

/**
 * Which SOS alerts may change lane status. A single unconfirmed alert could be a prank
 * (or a fake account) steering everyone's route, so an OPEN alert only counts when staff
 * have acknowledged it, or when another person raised an OPEN alert within 150 m.
 * Alerts without a status (tests, older data) are treated as confirmed.
 */
const trustedSos = (sos = []) => {
    const open = sos.filter((s) => s.status === 'OPEN' && s.location && typeof s.location.lat === 'number');
    return sos.filter((s) => {
        if (s.status !== 'OPEN') return true;
        if (!s.location || typeof s.location.lat !== 'number') return false;
        return open.some((o) => o !== s && String(o.userId) !== String(s.userId) && haversine(o.location, s.location) <= SOS_CROWD_RADIUS_M);
    });
};

const raise = (cur, status, reason, out) => {
    out.reasons.push(reason);
    if (RANK[status] > RANK[cur.status]) cur.status = status;
};

/**
 * Combines the control room's settings with live signals.
 *   manual: Map laneId -> { status, note, updatedAt }
 *   sos:    [{ type, location: { lat, lng } }] open or acknowledged alerts
 *   scans:  Map node id (or, for older passes, place name) -> people checked in during the last 30 minutes
 * Returns Map laneId -> { status, manualStatus, note, reasons[] }.
 */
const laneConditions = ({ manual = new Map(), sos = [], scans = new Map() } = {}) => {
    const out = new Map();
    for (const e of EDGES) {
        const m = manual.get(e.id);
        const info = { status: m?.status || 'NORMAL', manualStatus: m?.status || 'NORMAL', note: m?.note || '', updatedAt: m?.updatedAt || null, reasons: [] };
        if (m && m.status !== 'NORMAL') info.reasons.push(`Control room: ${m.status.toLowerCase()}${m.note ? ` (${m.note})` : ''}`);
        if (info.status !== 'CLOSED') {
            const a = nodeById.get(e.a);
            const b = nodeById.get(e.b);
            for (const s of sos) {
                if (!s.location || typeof s.location.lat !== 'number') continue;
                const d = distanceToLane(s.location, a, b);
                if (s.type === 'CROWD' && d <= SOS_CROWD_RADIUS_M) raise(info, 'CROWDED', `Crowd SOS ${Math.round(d)} m away`, info);
                else if (d <= SOS_OTHER_RADIUS_M) raise(info, 'BUSY', `${s.type.toLowerCase()} SOS on this lane`, info);
            }
            for (const n of [a, b]) {
                // people checked in at the camp / kitchen on this junction (linked by node id; names only for older passes)
                const count = (scans.get(n.id) || 0) + (n.places || []).reduce((s, place) => s + (scans.get(place) || 0), 0);
                if (!count) continue;
                const where = (n.places || [])[0] || n.name;
                if (count >= SCANS_CROWDED) raise(info, 'CROWDED', `${count} check-ins at ${where} in ${SCAN_WINDOW_MIN} min`, info);
                else if (count >= SCANS_BUSY) raise(info, 'BUSY', `${count} check-ins at ${where} in ${SCAN_WINDOW_MIN} min`, info);
            }
        }
        out.set(e.id, info);
    }
    return out;
};

/** Turns a search result into what the map needs. */
const describe = (result, conditions) => {
    if (!result.found) return null;
    let minutes = 0;
    let distanceM = 0;
    const lanes = result.edges.map((e) => {
        const status = conditions.get(e.id).status;
        distanceM += e.lengthM;
        minutes += e.lengthM / SPEED_M_PER_MIN[status];
        return { id: e.id, name: e.name, status, lengthM: e.lengthM };
    });
    return {
        nodes: result.nodes,
        coords: result.nodes.map((id) => [nodeById.get(id).lat, nodeById.get(id).lng]),
        lanes,
        distanceM,
        minutes: Math.max(1, Math.round(minutes)),
        busyLanes: lanes.filter((l) => l.status === 'BUSY' || l.status === 'CROWDED').length,
        cost: Math.round(result.cost),
        visited: result.visited,
    };
};

/**
 * Plans both routes on a given set of lane conditions (pure, unit tested).
 * `load` = Map laneId -> routes recently planned along it (see recordPlan).
 */
const planOn = (conditions, from, to, { load = new Map() } = {}) => {
    const status = (e) => conditions.get(e.id).status;
    const shortestW = (e) => (status(e) === 'CLOSED' ? Infinity : e.lengthM);
    // every multiplier is >= 1, so the straight-line A* estimate still never overestimates
    const safestW = (e) => e.lengthM * FACTOR[status(e)] * (1 + (load.get(e.id) || 0) / LANE_PLAN_CAPACITY);

    const shortest = dijkstra(GRAPH, from, to, shortestW);
    const safest = dijkstra(GRAPH, from, to, safestW);
    const safestAStar = aStar(GRAPH, from, to, safestW);
    const s = describe(shortest, conditions);
    const f = describe(safest, conditions);
    const fLaneIds = new Set(f ? f.lanes.map((l) => l.id) : []);
    return {
        reachable: !!f,
        shortest: s,
        safest: f,
        same: !!s && !!f && s.nodes.join() === f.nodes.join(),
        avoided: s ? s.lanes.filter((l) => !fLaneIds.has(l.id) && l.status !== 'NORMAL') : [],
        algorithms: {
            graph: { junctions: NODES.length, lanes: EDGES.length },
            dijkstra: { visited: safest.visited, cost: Math.round(safest.cost) },
            astar: { visited: safestAStar.visited, cost: Math.round(safestAStar.cost) },
            sameCost: safest.found === safestAStar.found && (!safest.found || Math.abs(safest.cost - safestAStar.cost) < 1e-6),
            loadAware: { windowMin: LOAD_WINDOW_MIN, laneCapacity: LANE_PLAN_CAPACITY, lanesWithLoad: [...load.values()].filter(Boolean).length },
        },
    };
};

// ---------- Recent plans (shared in MongoDB; in memory only when there is no database, e.g. unit tests) ----------
const { RoutePlan } = require('./routePlan.model');
const memoryPlans = []; // { laneIds, at } fallback
const useDb = () => mongoose.connection.readyState === 1;

/** How many routes were planned along each lane in the last LOAD_WINDOW_MIN minutes. */
const laneLoad = async (now = Date.now()) => {
    const since = new Date(now - LOAD_WINDOW_MIN * 60000);
    const out = new Map();
    if (useDb()) {
        try {
            const rows = await RoutePlan.aggregate([
                { $match: { at: { $gte: since } } },
                { $unwind: '$laneIds' },
                { $group: { _id: '$laneIds', n: { $sum: 1 } } },
            ]);
            for (const r of rows) out.set(r._id, r.n);
        } catch (e) {
            console.warn(`[route] lane load unavailable: ${e.message}`); // plan without load rather than fail
        }
        return out;
    }
    while (memoryPlans.length && memoryPlans[0].at < since) memoryPlans.shift();
    for (const p of memoryPlans) for (const id of p.laneIds) out.set(id, (out.get(id) || 0) + 1);
    return out;
};

/** Remember that a pilgrim was just sent along these lanes. */
const recordPlan = async (laneIdsUsed, now = Date.now()) => {
    if (!laneIdsUsed?.length) return;
    const entry = { laneIds: [...laneIdsUsed], at: new Date(now) };
    if (useDb()) {
        try {
            await RoutePlan.create(entry);
        } catch (e) {
            console.warn(`[route] could not record plan: ${e.message}`); // the route is still returned
        }
        return;
    }
    memoryPlans.push(entry);
    memoryPlans.sort((x, y) => x.at - y.at);
};
const resetLoad = async () => {
    memoryPlans.length = 0;
    if (useDb()) await RoutePlan.deleteMany({});
};

const nearestNode = (p) => {
    let best = null;
    for (const n of NODES) {
        const d = haversine(p, n);
        if (!best || d < best.d) best = { node: n, d };
    }
    return best;
};

// ---------- Database-backed ----------

const routeEvent = async (eventId) => {
    const event = eventId && mongoose.isValidObjectId(eventId) ? await Event.findById(eventId, 'title slug').lean() : await Event.findOne({ slug: EVENT_SLUG }, 'title slug').lean();
    if (!event) throw notFound('Yatra not found');
    if (event.slug !== EVENT_SLUG) throw notFound('Walking routes are mapped for Simhastha Kumbh Mela (Nashik) so far');
    return event;
};

const loadConditions = async (event) => {
    const since = new Date(Date.now() - SCAN_WINDOW_MIN * 60000);
    const [rows, sos, scanRows] = await Promise.all([
        LaneStatus.find({ eventId: event._id }, 'laneId status note updatedAt').lean(),
        SosIncident.find({ eventId: event._id, status: { $in: ['OPEN', 'ACKNOWLEDGED'] }, 'location.lat': { $type: 'number' } }, 'type location status userId').lean(),
        Pass.aggregate([
            { $match: { eventId: event._id, redeemedAt: { $gte: since }, type: { $in: ['LODGING', 'MEAL'] } } },
            {
                $group: {
                    // the map junction stored on the pass; older passes fall back to the camp / kitchen name
                    _id: { $ifNull: ['$details.routeNode', { $cond: [{ $eq: ['$type', 'MEAL'] }, '$details.kitchen', '$title'] }] },
                    // a family pass brings several people through the gate
                    count: { $sum: { $ifNull: ['$details.people', { $ifNull: ['$details.beds', 1] }] } },
                },
            },
        ]),
    ]);
    return laneConditions({
        manual: new Map(rows.map((r) => [r.laneId, r])),
        sos: trustedSos(sos),
        scans: new Map(scanRows.map((r) => [r._id, r.count])),
    });
};

/** The map: junctions, lanes with their current status, and which nodes can be start / destination. */
const network = async ({ eventId } = {}) => {
    const event = await routeEvent(eventId);
    const conditions = await loadConditions(event);
    const load = await laneLoad();
    return {
        event,
        nodes: NODES.map(({ places, ...n }) => n),
        lanes: EDGES.map((e) => ({ ...e, ...conditions.get(e.id), recentPlans: load.get(e.id) || 0 })),
        loadWindowMin: LOAD_WINDOW_MIN,
        factors: FACTOR,
        generatedAt: new Date(),
    };
};

const plan = async ({ eventId, from, to, lat, lng } = {}) => {
    const event = await routeEvent(eventId);
    const dest = nodeById.get(String(to || ''));
    if (!dest || dest.type !== 'GHAT') throw badRequest('Choose a ghat to walk to');

    let start = from === 'here' ? null : nodeById.get(String(from || ''));
    let snappedM = null;
    if (from === 'here') {
        const p = { lat: Number(lat), lng: Number(lng) };
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) throw badRequest('Your location could not be read');
        const near = nearestNode(p);
        if (near.d > NEAREST_LIMIT_M) throw badRequest('You are too far from Panchavati to plan a walking route. Choose a starting point instead.');
        start = near.node;
        snappedM = Math.round(near.d);
    }
    if (!start) throw badRequest('Choose where you are starting from');
    if (start.id === dest.id) throw badRequest('You are already at this ghat');

    const conditions = await loadConditions(event);
    const result = planOn(conditions, start.id, dest.id, { load: await laneLoad() });
    if (result.safest) await recordPlan(result.safest.lanes.map((l) => l.id)); // this pilgrim will walk it
    return { from: { id: start.id, name: start.name, snappedM }, to: { id: dest.id, name: dest.name }, ...result, generatedAt: new Date() };
};

/** Control room marks a lane busy, crowded, closed or back to normal. */
const setLane = async (user, laneId, { status, note } = {}) => {
    if (!laneIds.has(String(laneId))) throw notFound('Lane not found');
    if (!LANE_STATUS.includes(status)) throw badRequest(`Status must be one of ${LANE_STATUS.join(', ')}`);
    const cleanNote = typeof note === 'string' ? note.trim().replace(/\s+/g, ' ') : '';
    if (cleanNote.length > 120) throw badRequest('Note can be at most 120 characters');
    const event = await routeEvent();
    const row = await LaneStatus.findOneAndUpdate(
        { eventId: event._id, laneId },
        { $set: { status, note: status === 'NORMAL' ? '' : cleanNote, updatedBy: user._id } },
        { upsert: true, returnDocument: 'after', runValidators: true }
    ).lean();
    const lane = EDGES.find((e) => e.id === laneId);
    audit.record({ actor: user, action: 'ROUTE_LANE', targetType: 'Lane', summary: `${lane.name}: ${status.toLowerCase()}${cleanNote ? ` (${cleanNote})` : ''}` });
    realtime.notify(['public'], 'route', { laneId, status });
    return row;
};

/** Called when something on the ground changes (an SOS) so open route maps re-plan. */
const conditionsChanged = () => realtime.notify(['public'], 'route', {});

module.exports = { network, plan, setLane, conditionsChanged, laneConditions, planOn, distanceToLane, nearestNode, trustedSos, laneLoad, recordPlan, resetLoad, GRAPH, FACTOR, SPEED_M_PER_MIN, LANE_PLAN_CAPACITY };
