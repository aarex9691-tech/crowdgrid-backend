/**
 * Dijkstra vs A* on big walking grids (no database needed).
 *   npm run bench:route            100 x 100 grids (10,000 junctions)
 *   npm run bench:route -- 200     200 x 200 grids (40,000 junctions)
 *
 * Both searches must always find the same best cost. How many fewer junctions A*
 * looks at depends on how good its guess (straight-line distance) is:
 *   1. Square grid, no diagonals: walking distance is "city block" distance, far from
 *      the straight line, so A* gains almost nothing.
 *   2. Grid with diagonal lanes (closer to real streets): the straight line is a good
 *      guess and A* skips most of the map.
 *   3. Same grid with crowd factors 1 / 1.6 / 4: crowded lanes make true costs much
 *      bigger than the straight line, so the guess is weaker and A* saves less.
 */
const pf = require('../modules/route/pathfinding');

const N = Math.max(10, Math.min(400, Number(process.argv[2]) || 100));
const STEP = 1e-4; // ~11 m between junctions
const FACTORS = [1, 1, 1, 1.6, 4];

const makeGrid = (diagonals) => {
    const nodes = [];
    const edges = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) nodes.push({ id: `${i}_${j}`, lat: 20 + i * STEP, lng: 73.78 + j * STEP });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31; // fixed seed: same grid every run
    const lane = (a, b) => edges.push({ id: `${a}-${b}`, a, b, lengthM: pf.haversine(byId.get(a), byId.get(b)) * 1.1, factor: FACTORS[Math.floor(rand() * FACTORS.length)] });
    for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
            if (i + 1 < N) lane(`${i}_${j}`, `${i + 1}_${j}`);
            if (j + 1 < N) lane(`${i}_${j}`, `${i}_${j + 1}`);
            if (diagonals && i + 1 < N && j + 1 < N) lane(`${i}_${j}`, `${i + 1}_${j + 1}`);
            if (diagonals && i + 1 < N && j > 0) lane(`${i}_${j}`, `${i + 1}_${j - 1}`);
        }
    return { nodes, edges, graph: { nodes, adj: pf.buildAdjacency(nodes, edges) } };
};

const time = (fn) => {
    const t = process.hrtime.bigint();
    const r = fn();
    return { ...r, ms: Number(process.hrtime.bigint() - t) / 1e6 };
};

const run = (label, grid, weight) => {
    const from = '0_0';
    const to = `${N - 1}_${N - 1}`;
    const d = time(() => pf.dijkstra(grid.graph, from, to, weight));
    const a = time(() => pf.aStar(grid.graph, from, to, weight));
    const same = Math.abs(d.cost - a.cost) < 1e-6;
    const saved = Math.round((1 - a.visited / d.visited) * 100);
    console.log(`\n${label}  (${grid.nodes.length.toLocaleString('en-IN')} junctions, ${grid.edges.length.toLocaleString('en-IN')} lanes)`);
    console.log(`  Dijkstra : cost ${d.cost.toFixed(1)}, looked at ${d.visited.toLocaleString('en-IN')} junctions, ${d.ms.toFixed(1)} ms`);
    console.log(`  A*       : cost ${a.cost.toFixed(1)}, looked at ${a.visited.toLocaleString('en-IN')} junctions, ${a.ms.toFixed(1)} ms`);
    console.log(`  same best cost: ${same ? 'yes' : 'NO'} | A* looked at ${saved}% fewer junctions`);
    return same;
};

const square = makeGrid(false);
const streets = makeGrid(true);
const results = [
    run('1. Square grid, all lanes normal', square, (e) => e.lengthM),
    run('2. Grid with diagonal lanes, all normal', streets, (e) => e.lengthM),
    run('3. Grid with diagonal lanes, crowd factors 1 / 1.6 / 4 (safest route)', streets, (e) => e.lengthM * e.factor),
];
process.exit(results.every(Boolean) ? 0 : 1);
