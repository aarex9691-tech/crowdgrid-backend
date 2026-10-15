/**
 * Shared input rules for every form. The frontend mirrors these in
 * crowdgrid-frontend/src/lib/validate.js, so a field is checked the same way
 * in the browser (instant feedback) and here (so the rule cannot be bypassed).
 */
const { badRequest } = require('./httpError');
const { phoneError, digits, DEFAULT_CC } = require('./phone');

/** Allowed characters per kind of text field. */
const KINDS = {
    // People and city names: letters in any script, spaces, . ' -
    name: { re: /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u, hint: "letters, spaces and . ' - only" },
    // Venues, addresses, organisations: letters, digits and common punctuation
    place: { re: /^[\p{L}\p{M}\d][\p{L}\p{M}\d .,'&()/#:-]*$/u, hint: 'letters, numbers, spaces and , . - / # & ( ) only' },
    // Registration numbers and similar codes
    code: { re: /^[A-Za-z0-9][A-Za-z0-9 ./-]*$/, hint: 'letters, numbers and / . - only' },
    // Free text (titles, descriptions): anything printable, no control characters
    text: { re: /^[^\p{Cc}]*$/su, hint: 'no control characters' },
};

/** Field limits, one place for every form (keep in sync with the frontend). */
const LIMITS = {
    personName: { min: 2, max: 80, kind: 'name' },
    city: { min: 2, max: 60, kind: 'name' },
    title: { min: 3, max: 100, kind: 'text' },
    venue: { min: 2, max: 120, kind: 'place' },
    address: { min: 5, max: 200, kind: 'place' },
    orgName: { min: 2, max: 120, kind: 'place' },
    campName: { min: 2, max: 120, kind: 'place' },
    regNumber: { min: 2, max: 40, kind: 'code' },
    shortText: { min: 0, max: 120, kind: 'text' },
    longText: { min: 0, max: 500, kind: 'text' },
};

const squash = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Checks a text value. Returns the cleaned string, or undefined when the field
 * is optional and empty. Throws 400 with a readable message otherwise.
 */
const text = (value, label, rule, { required = false } = {}) => {
    const r = typeof rule === 'string' ? LIMITS[rule] : rule;
    const kind = KINDS[r.kind || 'text'];
    if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number') throw badRequest(`${label} must be text`);
    const raw = value === undefined || value === null ? '' : String(value);
    const v = r.kind === 'text' ? raw.trim() : squash(raw);
    if (!v) {
        if (required) throw badRequest(`${label} is required`);
        return undefined;
    }
    if (v.length < (r.min || 0)) throw badRequest(`${label} needs at least ${r.min} characters`);
    if (v.length > r.max) throw badRequest(`${label} can be at most ${r.max} characters`);
    if (!kind.re.test(v)) throw badRequest(`${label} can contain ${kind.hint}`);
    return v;
};

/** Whole number in [min, max]. Accepts numbers or digit-only strings; rejects 1e5, 2.5, "12abc". */
const int = (value, label, { min, max, required = false } = {}) => {
    if (value === undefined || value === null || value === '') {
        if (required) throw badRequest(`${label} is required`);
        return undefined;
    }
    const s = String(value).trim();
    if (!/^-?\d+$/.test(s)) throw badRequest(`${label} must be a whole number`);
    const n = Number(s);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw badRequest(`${label} must be between ${min.toLocaleString('en-IN')} and ${max.toLocaleString('en-IN')}`);
    return n;
};

/** Indian PIN code: 6 digits, not starting with 0. */
const pincode = (value, { required = false } = {}) => {
    const v = String(value ?? '').trim();
    if (!v) {
        if (required) throw badRequest('PIN code is required');
        return undefined;
    }
    if (!/^[1-9]\d{5}$/.test(v)) throw badRequest('PIN code must be 6 digits and cannot start with 0');
    return v;
};

/** Mobile number with country code. Returns { countryCode, phone } or undefined when optional and empty. */
const mobile = (countryCode, value, label, { required = false } = {}) => {
    const n = digits(value);
    if (!n) {
        if (required) throw badRequest(`${label} is required`);
        return undefined;
    }
    if (/[^\d\s()+-]/.test(String(value))) throw badRequest(`${label} can contain digits only`);
    const cc = digits(countryCode) || DEFAULT_CC;
    const err = phoneError(cc, n);
    if (err) throw badRequest(`${label}: ${err.replace(/^Mobile number /, '').replace(/^is /, '')}`);
    return { countryCode: cc, phone: n };
};

module.exports = { KINDS, LIMITS, text, int, pincode, mobile };
