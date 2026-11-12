require('dotenv').config();
require('./utils/dns'); // optional DNS_SERVERS override for Atlas (querySrv errors)

const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const sanitize = require('./middleware/sanitize');
const { notFoundHandler, errorHandler } = require('./middleware/errors');
const realtime = require('./utils/realtime');
const { loadUser } = require('./middleware/auth');

// QR_SECRET is required too: without it QR codes would silently be signed with the login secret
for (const key of ['MONGO_URI', 'JWT_SECRET', 'QR_SECRET']) {
    if (!process.env[key]) {
        console.error(`Missing ${key} in .env (see .env.example)`);
        process.exit(1);
    }
}

const ORIGINS = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const VERCEL_PROJECT = (process.env.VERCEL_PROJECT || 'crowdgrid-frontend').toLowerCase().replace(/[^a-z0-9-]/g, '');
const VERCEL_PREVIEW = new RegExp(`^https://${VERCEL_PROJECT}(-[a-z0-9-]+)?\\.vercel\\.app$`, 'i');

const isAllowedOrigin = (origin) => {
    if (!origin) return true;
    if (ORIGINS.includes(origin) || ORIGINS.includes('*')) return true;
    // Allow any localhost / 127.0.0.1 on any port
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
    // Our own Vercel deployments only (production + previews of the project named
    // VERCEL_PROJECT, default "crowdgrid-frontend"), not every site hosted on Vercel
    if (VERCEL_PREVIEW.test(origin)) return true;
    return false;
};

const app = express();
// Render sits one proxy hop in front: trust it there so req.ip is the pilgrim's address and each person gets their
// own rate limit. Anywhere else (a laptop, no proxy) trust nothing, or a fake X-Forwarded-For header would dodge the limit.
// Render sets RENDER=true by itself; TRUST_PROXY_HOPS overrides for other hosts.
const proxyHops = () => {
    const v = Number(process.env.TRUST_PROXY_HOPS);
    if (process.env.TRUST_PROXY_HOPS !== undefined && Number.isInteger(v) && v >= 0) return v;
    return process.env.RENDER ? 1 : 0;
};
app.set('trust proxy', proxyHops());

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
    cors({
        origin: (origin, callback) => {
            if (isAllowedOrigin(origin)) {
                return callback(null, true);
            }
            console.warn(`[CORS] Blocked origin: ${origin} (add it to CLIENT_ORIGIN in .env)`);
            return callback(null, false);
        },
        credentials: true,
    })
);
app.use(express.json({ limit: '100kb' }));
app.use(sanitize);
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 2000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests. Please wait a few minutes and try again.' },
});
app.use('/api', apiLimiter);

// /health (always 200, shows the database state) and /health/ready (503 when the database is down)
require('./utils/health').mount(app, require('mongoose'));
// Old photos saved on disk before they moved into MongoDB (new ones: /api/lost-found/photos/:id)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes mounted with /api prefix
app.use('/api/auth', require('./modules/auth/auth.routes'));
app.use('/api/events', require('./modules/event/event.routes'));
app.use('/api/providers', require('./modules/provider/provider.routes'));
app.use('/api/lodgings', require('./modules/lodging/lodging.routes'));
app.use('/api/food', require('./modules/food/food.routes'));
app.use('/api/transit', require('./modules/transit/transit.routes'));
app.use('/api/passes', require('./modules/pass/pass.routes'));
app.use('/api/volunteer', require('./modules/volunteer/volunteer.routes'));
app.use('/api/sos', require('./modules/sos/sos.routes'));
app.use('/api/route', require('./modules/route/route.routes'));
app.use('/api/lost-found', require('./modules/lostfound/lostfound.routes'));
app.use('/api/ngo', require('./modules/ngo/ngo.routes'));
app.use('/api/admin', require('./modules/admin/admin.routes'));
app.use('/api/orders', require('./modules/order/order.routes'));
app.use('/api/analytics', require('./modules/analytics/analytics.routes'));

// Route aliases without the /api prefix (safety net for older frontend builds); same rate limit as /api
app.use('/events', apiLimiter, require('./modules/event/event.routes'));
app.use('/auth', apiLimiter, require('./modules/auth/auth.routes'));
app.use('/providers', apiLimiter, require('./modules/provider/provider.routes'));
app.use('/lodgings', apiLimiter, require('./modules/lodging/lodging.routes'));
app.use('/food', apiLimiter, require('./modules/food/food.routes'));
app.use('/transit', apiLimiter, require('./modules/transit/transit.routes'));
app.use('/passes', apiLimiter, require('./modules/pass/pass.routes'));
app.use('/volunteer', apiLimiter, require('./modules/volunteer/volunteer.routes'));
app.use('/sos', apiLimiter, require('./modules/sos/sos.routes'));
app.use('/route', apiLimiter, require('./modules/route/route.routes'));
app.use('/lost-found', apiLimiter, require('./modules/lostfound/lostfound.routes'));
app.use('/ngo', apiLimiter, require('./modules/ngo/ngo.routes'));
app.use('/admin', apiLimiter, require('./modules/admin/admin.routes'));
app.use('/orders', apiLimiter, require('./modules/order/order.routes'));
app.use('/analytics', apiLimiter, require('./modules/analytics/analytics.routes'));

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

if (require.main === module) {
    // One HTTP server carries both the REST API and the live-update WebSocket
    const server = http.createServer(app);
    realtime.init(server, { origin: (origin, cb) => cb(null, isAllowedOrigin(origin)), origins: ORIGINS, authenticate: loadUser });
    connectDB().then(() => {
        server.listen(PORT, () => console.log(`CrowdGrid API running on http://localhost:${PORT} (live updates on)`));
        // Every 5 minutes: expire unpaid orders, recover payments interrupted by a crash
        const { sweep } = require('./modules/order/order.service');
        const tick = () => sweep().then((r) => (r.expired || r.unstuck || r.finished) && console.log(`[orders] expired ${r.expired}, recovered ${r.unstuck}, finished ${r.finished}`)).catch((e) => console.warn(`[orders] sweep failed: ${e.message}`));
        tick();
        setInterval(tick, 5 * 60000).unref();
    });
}

module.exports = app;
