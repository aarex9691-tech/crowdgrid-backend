/**
 * Indian organisation ID numbers, checked as far as is possible offline.
 *
 * GSTIN has a published check digit (the 15th character), so a mistyped or made-up GSTIN is
 * caught. CIN, NGO Darpan, AISHE and Udyam numbers have fixed national formats, which are
 * checked. Trust and society registration numbers differ by state, so they are only stored and
 * marked UNCHECKED for the reviewer, who checks the uploaded certificate.
 */

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const gstinCheckDigit = (first14) => {
    let sum = 0;
    for (let i = 0; i < 14; i += 1) {
        const product = CHARS.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
        sum += Math.floor(product / 36) + (product % 36);
    }
    return CHARS[(36 - (sum % 36)) % 36];
};

const TYPES = {
    GSTIN: { label: 'GSTIN', test: (v) => /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v) && gstinCheckDigit(v.slice(0, 14)) === v[14] },
    CIN: { label: 'CIN (company)', test: (v) => /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/.test(v) },
    DARPAN: { label: 'NGO Darpan ID', test: (v) => /^[A-Z]{2}\/\d{4}\/\d{7}$/.test(v) },
    AISHE: { label: 'AISHE code (college / university)', test: (v) => /^[CUS]-\d{3,6}$/.test(v) },
    UDYAM: { label: 'Udyam registration', test: (v) => /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/.test(v) },
    REG: { label: 'Trust / society registration number', test: null },
};

/** Upper case, no spaces (GSTIN, CIN and the codes are written without them). */
const normalise = (type, value) => {
    const v = String(value || '').toUpperCase().trim();
    return type === 'REG' ? v.replace(/\s+/g, ' ').slice(0, 40) : v.replace(/\s+/g, '');
};

/** { status: 'VALID' | 'INVALID' | 'UNCHECKED', label } */
const check = (type, value) => {
    const t = TYPES[type];
    if (!t) return { status: 'INVALID', label: 'Unknown ID type' };
    const v = normalise(type, value);
    if (!t.test) return { status: /^[A-Z0-9][A-Z0-9 ./-]{2,39}$/.test(v) ? 'UNCHECKED' : 'INVALID', label: t.label };
    return { status: t.test(v) ? 'VALID' : 'INVALID', label: t.label };
};

module.exports = { TYPES, check, normalise, gstinCheckDigit };
