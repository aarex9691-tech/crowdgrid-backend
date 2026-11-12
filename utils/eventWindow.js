const { istDate, istDateTime, isDateString } = require('./time');
const { badRequest, notFound } = require('./httpError');

/**
 * One rule for every booking (stay, meal, shuttle, seva): only the days of the event itself,
 * and never a day that has passed. Before an event starts its days can be pre-booked.
 */

const human = (day) => istDateTime(day, '12:00').toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
const wordFor = (event) => (event?.kind === 'YATRA' || !event?.kind ? 'yatra' : 'event');

/** The event's days, and the first one that can still be booked. */
const windowOf = (event, today = istDate()) => {
    const start = istDate(event.startDate);
    const end = istDate(event.endDate);
    return { start, end, today, first: start > today ? start : today, prebooking: today < start };
};

/** Throws 400 unless the event still takes bookings (not closed by staff, not over). */
const closed = (message) => Object.assign(badRequest(message), { code: 'EVENT_CLOSED' }); // callers can tell "over" from a bad input

const assertOpen = (event) => {
    if (!event) throw notFound('Event not found');
    const word = wordFor(event);
    if (event.status === 'ARCHIVED') throw closed(`This ${word} is closed and no longer open for bookings`);
    if (istDate(event.endDate) < istDate()) throw closed(`This ${word} has ended. Bookings are closed.`);
};

/** Throws 400 unless `day` (YYYY-MM-DD) is a day of the event; past days too unless allowPast. */
const assertDay = (event, day, { allowPast = false } = {}) => {
    if (!isDateString(String(day))) throw badRequest('Choose a valid date');
    const w = windowOf(event);
    if (!allowPast && day < w.today) throw badRequest('That day has passed. Choose today or a later day.');
    if (day < w.start || day > w.end) throw badRequest(`Choose a day of the ${wordFor(event)} (${human(w.start)} to ${human(w.end)})`);
    return String(day);
};

module.exports = { windowOf, assertOpen, assertDay, human };
