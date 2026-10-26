/**
 * Live updates over WebSockets (Socket.IO).
 *
 * The server only sends short "something changed" notices; screens then re-read
 * the data through the normal REST API, so every permission check stays in one
 * place and nothing private travels over the socket.
 *
 * Rooms
 *   public            everyone (bed and meal counts on public pages)
 *   control           super admin and authorities (control room, analytics)
 *   volunteers        volunteers (SOS alerts)
 *   provider:<id>     staff of one NGO (their camps and kitchens)
 *   user:<id>         one person (their own SOS status)
 *   lodging:<id>      anyone allowed to watch one camp's tent map
 */
const { Server } = require('socket.io');
const { hasPermission, ROLES } = require('../config/roles');

let io = null;

const roomsFor = (user) => {
    const rooms = ['public'];
    if (!user) return rooms;
    rooms.push(`user:${user.id}`);
    if (user.role === ROLES.SUPER_ADMIN || user.role === ROLES.AUTHORITY) rooms.push('control');
    if (user.role === ROLES.VOLUNTEER) rooms.push('volunteers');
    if (user.role === ROLES.NGO_ADMIN && user.providerId) rooms.push(`provider:${user.providerId}`);
    return rooms;
};

/**
 * Attach Socket.IO to the HTTP server. `authenticate(token)` returns the user
 * or throws; visitors without a token are allowed but only join "public".
 */
const init = (httpServer, { origins = [], origin, authenticate } = {}) => {
    const corsOrigin = origin || origins;
    io = new Server(httpServer, { cors: { origin: corsOrigin, credentials: true }, serveClient: false });
    io.use(async (socket, next) => {
        const token = socket.handshake.auth?.token;
        socket.data.user = null;
        if (token && authenticate) {
            try {
                socket.data.user = await authenticate(token);
            } catch {
                return next(new Error('Session expired. Please log in again.'));
            }
        }
        next();
    });
    io.on('connection', (socket) => {
        const user = socket.data.user;
        socket.join(roomsFor(user));
        // Tent map: staff who may view inventory can follow one camp
        socket.on('watch:lodging', (lodgingId) => {
            if (user && hasPermission(user.role, 'inventory:view') && /^[a-f\d]{24}$/i.test(String(lodgingId))) socket.join(`lodging:${lodgingId}`);
        });
        socket.on('unwatch:lodging', (lodgingId) => socket.leave(`lodging:${lodgingId}`));
    });
    return io;
};

/**
 * Tell rooms that something changed. Safe to call anywhere: does nothing when
 * the socket server is not running (seed script, tests, flow checks).
 */
const notify = (rooms, event, payload = {}) => {
    if (!io) return;
    const list = (Array.isArray(rooms) ? rooms : [rooms]).filter(Boolean).map(String);
    if (!list.length) return;
    io.to(list).emit(event, { ...payload, at: Date.now() });
};

const close = () => new Promise((resolve) => (io ? io.close(() => { io = null; resolve(); }) : resolve()));

module.exports = { init, notify, close, roomsFor };
