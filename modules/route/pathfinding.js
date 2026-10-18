/**
 * Shortest-path search on the walking network.
 *
 * The network is an undirected weighted graph:
 *   nodes  junctions, ghats, camps, kitchens, bus stops ({ id, lat, lng })
 *   edges  walkable lanes between two nodes ({ id, a, b, lengthM })
 *
 * Both searches take a `weight(edge)` function, so the same code finds the
 * shortest route (weight = length in metres) and the safest route
 * (weight = length x crowd factor). A weight of Infinity means the lane is
 * closed and is skipped.
 *
 * Dijkstra  always expands the node with the smallest known cost from the start.
 *           O((V + E) log V) with the binary heap.
 * A*        same, but orders the heap by cost so far + straight-line distance
 *           to the ghat. Straight-line distance never overestimates (every
 *           factor is >= 1), so A* returns the same optimal cost while
 *           expanding fewer nodes.
 */
const MinHeap = require('../../utils/minHeap');

const EARTH_M = 6371000;
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres between two { lat, lng } points. */
const haversine = (p, q) => {
    const dLat = rad(q.lat - p.lat);
    const dLng = rad(q.lng - p.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(p.lat)) * Math.cos(rad(q.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Adjacency list: node id -> [{ to, edge }]. Built once per network. */
const buildAdjacency = (nodes, edges) => {
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const e of edges) {
        if (!adj.has(e.a) || !adj.has(e.b)) throw new Error(`Lane ${e.id} joins an unknown junction`);
        adj.get(e.a).push({ to: e.b, edge: e });
        adj.get(e.b).push({ to: e.a, edge: e });
    }
    return adj;
};

/**
 * Generic best-first search. With heuristic = () => 0 this is Dijkstra.
 * Returns { found, cost, nodes: [ids], edges: [edge], visited } where visited
 * is how many nodes were settled (taken off the heap for the first time).
 */
const search = ({ nodes, adj }, from, to, weight, heuristic = () => 0) => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    if (!byId.has(from) || !byId.has(to)) throw new Error('Unknown start or destination');

    const dist = new Map([[from, 0]]);
    const prev = new Map(); // node id -> { node, edge } it was reached from
    const settled = new Set();
    const heap = new MinHeap();
    heap.push(from, heuristic(byId.get(from)));

    while (!heap.isEmpty()) {
        const { value: u } = heap.pop();
        if (settled.has(u)) continue; // stale heap entry (lazy deletion)
        settled.add(u);
        if (u === to) break;
        for (const { to: v, edge } of adj.get(u)) {
            if (settled.has(v)) continue;
            const w = weight(edge);
            if (!Number.isFinite(w)) continue; // closed lane
            const alt = dist.get(u) + w;
            if (alt < (dist.has(v) ? dist.get(v) : Infinity)) {
                dist.set(v, alt);
                prev.set(v, { node: u, edge });
                heap.push(v, alt + heuristic(byId.get(v)));
            }
        }
    }

    if (!settled.has(to)) return { found: false, cost: Infinity, nodes: [], edges: [], visited: settled.size };
    const path = [to];
    const used = [];
    for (let cur = to; cur !== from; ) {
        const step = prev.get(cur);
        used.push(step.edge);
        path.push(step.node);
        cur = step.node;
    }
    return { found: true, cost: dist.get(to), nodes: path.reverse(), edges: used.reverse(), visited: settled.size };
};

const dijkstra = (graph, from, to, weight) => search(graph, from, to, weight);

const aStar = (graph, from, to, weight) => {
    const goal = graph.nodes.find((n) => n.id === to);
    if (!goal) throw new Error('Unknown start or destination');
    return search(graph, from, to, weight, (n) => haversine(n, goal));
};

module.exports = { haversine, buildAdjacency, dijkstra, aStar, search };
