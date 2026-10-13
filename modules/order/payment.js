const crypto = require('crypto');

/**
 * Payment gateway layer.
 *
 * CrowdGrid ships with a SIMULATED gateway so the whole book -> pay -> QR flow
 * can be demonstrated without real money. To go live, add a provider with the
 * same charge() signature (e.g. Razorpay: create an order, verify the payment
 * signature with the key secret) and select it with PAYMENT_PROVIDER.
 *
 * Test inputs for the demo:
 *   UPI  : any id like name@okaxis succeeds;  fail@upi is declined
 *   Card : any valid 16-digit number succeeds; 4000 0000 0000 0002 is declined
 */
const UPI_RE = /^[a-z0-9._-]{2,64}@[a-z]{2,32}$/i;

const luhnOk = (num) => {
    let sum = 0;
    let dbl = false;
    for (let i = num.length - 1; i >= 0; i--) {
        let d = Number(num[i]);
        if (dbl) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
        dbl = !dbl;
    }
    return sum % 10 === 0;
};

const fail = (message) => ({ ok: false, message });

const simulated = {
    name: 'SIMULATED',
    async charge({ amount, method, upiId, cardNumber, expiry, cvv }) {
        if (!(amount > 0)) return fail('Nothing to pay');
        // A short pause, like a real gateway round trip
        await new Promise((r) => setTimeout(r, 900));

        if (method === 'UPI') {
            const id = String(upiId || '').trim().toLowerCase();
            if (!UPI_RE.test(id)) return fail('Enter a valid UPI ID, e.g. name@okaxis');
            if (id === 'fail@upi') return fail('Payment declined by the bank (test UPI ID)');
            return { ok: true, account: id, reference: `SIMUPI${crypto.randomBytes(5).toString('hex').toUpperCase()}` };
        }
        if (method === 'CARD') {
            const num = String(cardNumber || '').replace(/\D/g, '');
            if (num.length !== 16 || !luhnOk(num)) return fail('Card number is not valid');
            const m = /^(\d{2})\s*\/\s*(\d{2})$/.exec(String(expiry || ''));
            if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return fail('Expiry must be MM/YY');
            const expEnd = new Date(2000 + Number(m[2]), Number(m[1]), 1);
            if (expEnd <= new Date()) return fail('This card has expired');
            if (!/^\d{3}$/.test(String(cvv || ''))) return fail('CVV must be 3 digits');
            if (num === '4000000000000002') return fail('Card declined by the bank (test card)');
            return { ok: true, account: `**** ${num.slice(-4)}`, reference: `SIMCARD${crypto.randomBytes(5).toString('hex').toUpperCase()}` };
        }
        return fail('Choose UPI or card');
    },
    async refund({ amount }) {
        return { ok: true, reference: `SIMREFUND${crypto.randomBytes(4).toString('hex').toUpperCase()}`, amount };
    },
};

const providers = { SIMULATED: simulated };

const gateway = () => providers[process.env.PAYMENT_PROVIDER || 'SIMULATED'] || simulated;

module.exports = { gateway, luhnOk };
