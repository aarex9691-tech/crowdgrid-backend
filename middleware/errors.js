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
    console.error(err);
    res.status(500).json({ message: 'Something went wrong on the server' });
};

module.exports = { notFoundHandler, errorHandler };
