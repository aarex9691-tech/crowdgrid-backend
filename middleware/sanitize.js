/**
 * Blocks NoSQL operator injection (e.g. {"phone": {"$gt": ""}}) by removing
 * keys that start with "$" or contain "." from the request body and params.
 * (express-mongo-sanitize does not work with Express 5, whose req.query is
 * read-only; handlers cast query values to strings instead.)
 */
const clean = (value) => {
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        for (const key of Object.keys(value)) {
            if (key.startsWith('$') || key.includes('.')) delete value[key];
            else value[key] = clean(value[key]);
        }
    }
    return value;
};

const sanitize = (req, res, next) => {
    if (req.body) clean(req.body);
    if (req.params) clean(req.params);
    next();
};

module.exports = sanitize;
