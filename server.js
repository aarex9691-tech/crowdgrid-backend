require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const sanitize = require('./middleware/sanitize');
const { notFoundHandler, errorHandler } = require('./middleware/errors');

for (const key of ['MONGO_URI', 'JWT_SECRET']) {
    if (!process.env[key]) {
        console.error(`Missing ${key} in .env (see .env.example)`);
        process.exit(1);
    }
}

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
    cors({
        origin: (process.env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()),
        credentials: true,
    })
);
app.use(express.json({ limit: '100kb' }));
app.use(sanitize);
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 2000, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api/auth', require('./modules/auth/auth.routes'));
app.use('/api/events', require('./modules/event/event.routes'));
app.use('/api/providers', require('./modules/provider/provider.routes'));
app.use('/api/lodgings', require('./modules/lodging/lodging.routes'));
app.use('/api/food', require('./modules/food/food.routes'));
app.use('/api/transit', require('./modules/transit/transit.routes'));
app.use('/api/passes', require('./modules/pass/pass.routes'));
app.use('/api/volunteer', require('./modules/volunteer/volunteer.routes'));
app.use('/api/sos', require('./modules/sos/sos.routes'));
app.use('/api/lost-found', require('./modules/lostfound/lostfound.routes'));
app.use('/api/ngo', require('./modules/ngo/ngo.routes'));
app.use('/api/admin', require('./modules/admin/admin.routes'));

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

if (require.main === module) {
    connectDB().then(() => app.listen(PORT, () => console.log(`CrowdGrid API running on http://localhost:${PORT}`)));
}

module.exports = app;
