const { HttpError } = require('../utils/httpError');

const notFoundHandler = (req, res) => {
    res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
};

// Express 5 forwards errors thrown in async handlers here automatically.
// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
    if (err instanceof HttpError) {
        return res.status(err.status).json({ message: err.message, ...err.extra });
    }
    if (err.name === 'ValidationError') {
        const message = Object.values(err.errors).map((e) => e.message).join(', ');
        return res.status(400).json({ message });
    }
    if (err.name === 'CastError') {
        return res.status(400).json({ message: `Invalid ${err.path}` });
    }
    if (err.code === 11000) {
        return res.status(409).json({ message: 'This record already exists' });
    }
    if (err.name === 'MulterError') {
        return res.status(400).json({ message: err.message });
    }
    // The link to MongoDB Atlas dropped (unstable Wi-Fi, VPN, antivirus HTTPS scanning...).
    // Say so plainly instead of a generic 500; the next request usually works.
    if (/^Mongo(Network|ServerSelection|NetworkTimeout|PoolCleared)Error$/.test(err.name) || ['ECONNRESET', 'ETIMEDOUT', 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC'].includes(err.code || err.cause?.code)) {
        console.warn(`[db] ${req.method} ${req.originalUrl}: lost the database connection (${err.code || err.cause?.code || err.name})`);
        return res.status(503).json({ message: 'Lost the connection to the database for a moment. Please try again in a few seconds.', retry: true });
    }
    console.error(err);
    res.status(500).json({ message: 'Something went wrong on the server' });
};

module.exports = { notFoundHandler, errorHandler };
