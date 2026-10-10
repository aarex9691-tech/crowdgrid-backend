/** All event operations run on Indian Standard Time (UTC+05:30). */
const IST_OFFSET = '+05:30';

/** 'YYYY-MM-DD' for the given instant, as seen in IST. */
const istDate = (date = new Date()) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);

/** Date for a 'YYYY-MM-DD' + 'HH:MM' wall-clock time in IST. */
const istDateTime = (dateStr, hhmm = '00:00') => new Date(`${dateStr}T${hhmm}:00${IST_OFFSET}`);

const isDateString = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** 'YYYY-MM-DD' n days after the given IST date string. */
const addDays = (dateStr, n) => istDate(new Date(istDateTime(dateStr, '12:00').getTime() + n * 86400000));

module.exports = { istDate, istDateTime, isDateString, addDays };
