/**
 * Mobile numbers are stored as two parts:
 *   countryCode: digits only, e.g. "91"
 *   phone:       the national number, digits only, e.g. "9000000006"
 * so Indian numbers look exactly as before and foreign visitors can register too.
 *
 * Lengths are the national-number lengths for mobiles in each country.
 * Keep this list in sync with crowdgrid-frontend/src/lib/phone.js.
 */
const COUNTRIES = {
    91: { name: 'India', min: 10, max: 10, pattern: /^[6-9]\d{9}$/ },
    977: { name: 'Nepal', min: 10, max: 10 },
    94: { name: 'Sri Lanka', min: 9, max: 9 },
    880: { name: 'Bangladesh', min: 10, max: 10 },
    1: { name: 'USA / Canada', min: 10, max: 10 },
    44: { name: 'United Kingdom', min: 10, max: 10 },
    61: { name: 'Australia', min: 9, max: 9 },
    971: { name: 'UAE', min: 9, max: 9 },
    65: { name: 'Singapore', min: 8, max: 8 },
    49: { name: 'Germany', min: 10, max: 11 },
    33: { name: 'France', min: 9, max: 9 },
    7: { name: 'Russia', min: 10, max: 10 },
    81: { name: 'Japan', min: 10, max: 10 },
    230: { name: 'Mauritius', min: 8, max: 8 },
};

const DEFAULT_CC = '91';
const digits = (v) => String(v ?? '').replace(/\D/g, '');

/** Returns an error message, or null when the number is valid for that country. */
const phoneError = (countryCode, phone) => {
    const cc = digits(countryCode) || DEFAULT_CC;
    const n = digits(phone);
    const rule = COUNTRIES[cc];
    if (!rule) return 'Choose a supported country code';
    if (!n) return 'Mobile number is required';
    const len = rule.min === rule.max ? `${rule.min}` : `${rule.min}-${rule.max}`;
    if (n.length < rule.min) return `Mobile number is too short: ${rule.name} numbers have ${len} digits`;
    if (n.length > rule.max) return `Mobile number is too long: ${rule.name} numbers have ${len} digits`;
    if (rule.pattern && !rule.pattern.test(n)) return 'Indian mobile numbers start with 6, 7, 8 or 9';
    return null;
};

/**
 * Reads what a person typed into a login box. Accepts "9000000006",
 * "+91 90000 00006", "+44 7700 900123" or a separate country code.
 */
const parseLoginPhone = (raw, countryCode) => {
    const text = String(raw ?? '').trim();
    const n = digits(text);
    if (text.startsWith('+')) {
        // longest matching country code first (e.g. 977 before 9)
        const codes = Object.keys(COUNTRIES).sort((a, b) => b.length - a.length);
        const cc = codes.find((c) => n.startsWith(c));
        if (cc) return { countryCode: cc, phone: n.slice(cc.length) };
    }
    return { countryCode: digits(countryCode) || DEFAULT_CC, phone: n };
};

const formatPhone = (countryCode, phone) => `+${countryCode || DEFAULT_CC} ${phone}`;

module.exports = { COUNTRIES, DEFAULT_CC, phoneError, parseLoginPhone, formatPhone, digits };
