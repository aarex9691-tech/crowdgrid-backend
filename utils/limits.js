/**
 * Booking limits, the same for every service: one account can book for at most
 * 5 people (5 beds per yatra, a meal token for up to 5, a bus pass for up to 5,
 * up to 5 tickets per event).
 */
const { badRequest } = require('./httpError');

const MAX_PER_ACCOUNT = 5;

/** Group size from user input: a whole number 1..MAX_PER_ACCOUNT (default 1). */
const groupSize = (value, what = 'people') => {
    const n = value === undefined || value === null || value === '' ? 1 : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PER_ACCOUNT) {
        throw badRequest(`You can book 1 to ${MAX_PER_ACCOUNT} ${what} per account`);
    }
    return n;
};

module.exports = { MAX_PER_ACCOUNT, groupSize };
