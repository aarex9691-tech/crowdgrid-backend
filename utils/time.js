/** All event operations run on Indian Standard Time (UTC+05:30). */
const IST_OFFSET = '+05:30';

/** 'YYYY-MM-DD' for the given instant, as seen in IST. */
const istDate = (date = new Date()) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);

/** Date for a 'YYYY-MM-DD' + 'HH:MM' wall-clock time in IST. */
const istDateTime = (dateStr, hhmm = '00:00') => new Date(`${dateStr}T${hhmm}:00${IST_OFFSET}`);

/** A real calendar date in 'YYYY-MM-DD' form: '2026-02-31' or month 13 are refused, not rolled over. */
const isDateString = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** 'YYYY-MM-DD' n days after the given IST date string. */
const addDays = (dateStr, n) => istDate(new Date(istDateTime(dateStr, '12:00').getTime() + n * 86400000));

module.exports = { istDate, istDateTime, isDateString, addDays };
