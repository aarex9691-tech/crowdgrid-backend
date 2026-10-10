class HttpError extends Error {
    constructor(status, message, extra = {}) {
        super(message);
        this.status = status;
        this.extra = extra;
    }
}

const badRequest = (msg, extra) => new HttpError(400, msg, extra);
const unauthorized = (msg = 'Not authorized') => new HttpError(401, msg);
const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const conflict = (msg, extra) => new HttpError(409, msg, extra);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
