/**
 * Health check that looks at the database, not only at the web server.
 *
 *   GET /health        always 200 while the server runs; says whether the database answers
 *                      (safe for Render's health check: a database blip does not restart the server)
 *   GET /health/ready  503 when the database is not reachable, so a monitor can alert on it
 */
const STATES = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
const PING_TIMEOUT_MS = 3000;

const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms).unref?.())]);

/** `connection` is mongoose.connection (passed in so it can be tested without a database). */
const check = async (connection, { now = Date.now, startedAt = now() } = {}) => {
    const state = STATES[connection?.readyState] || 'unknown';
    const database = { state };
    if (state === 'connected' && connection.db) {
        const t0 = now();
        try {
            await withTimeout(connection.db.admin().command({ ping: 1 }), PING_TIMEOUT_MS);
            database.pingMs = Math.round(now() - t0);
        } catch (e) {
            database.state = 'not answering';
            database.error = e.message;
        }
    }
    const ok = database.state === 'connected';
    return {
        ok,
        body: {
            status: ok ? 'ok' : 'database unavailable',
            database,
            uptimeSec: Math.round((now() - startedAt) / 1000),
            time: new Date(now()).toISOString(),
        },
    };
};

const mount = (app, mongoose) => {
    const startedAt = Date.now();
    app.get('/health', async (req, res) => {
        const { body } = await check(mongoose.connection, { startedAt });
        res.set('Cache-Control', 'no-store').json(body);
    });
    app.get('/health/ready', async (req, res) => {
        const { ok, body } = await check(mongoose.connection, { startedAt });
        res.set('Cache-Control', 'no-store').status(ok ? 200 : 503).json(body);
    });
};

module.exports = { check, mount, STATES, PING_TIMEOUT_MS };
