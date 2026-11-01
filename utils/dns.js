/**
 * DNS help for MongoDB Atlas.
 *
 * Atlas "mongodb+srv://" addresses need a DNS SRV lookup. Some home routers and
 * Windows setups refuse those lookups ("querySrv ECONNREFUSED"), while some
 * college / office networks block outside DNS servers instead. So:
 *   1. DNS_SERVERS=8.8.8.8,1.1.1.1 in .env  -> always use those servers.
 *   2. Otherwise use the computer's normal DNS, and only if the SRV lookup
 *      fails, retry once with Google + Cloudflare (connectMongo below).
 */
const dns = require('dns');

const PUBLIC_DNS = ['8.8.8.8', '1.1.1.1'];
const envServers = (process.env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (envServers.length) {
    try {
        dns.setServers(envServers);
    } catch {
        console.warn('DNS_SERVERS in .env could not be applied; using the system DNS');
    }
}

const isDnsError = (err) => /querySrv|queryTxt|ENOTFOUND|EAI_AGAIN|ECONNREFUSED.*_mongodb/i.test(err?.message || '');

/** mongoose.connect with one automatic retry through public DNS when the SRV lookup fails. */
const connectMongo = async (mongoose, uri, options) => {
    try {
        return await mongoose.connect(uri, options);
    } catch (err) {
        if (envServers.length || !isDnsError(err)) throw err;
        console.warn('Atlas DNS lookup failed on this network; retrying with public DNS (8.8.8.8, 1.1.1.1)...');
        dns.setServers(PUBLIC_DNS);
        return mongoose.connect(uri, options);
    }
};

/** Friendly hint for the common Atlas connection errors. */
const atlasHint = (message = '') => {
    if (/querySrv|ENOTFOUND|EAI_AGAIN/i.test(message)) return 'Hint: DNS lookup for Atlas failed. Add DNS_SERVERS=8.8.8.8,1.1.1.1 to .env (or change the Wi-Fi DNS to 8.8.8.8) and try again.';
    if (/ETIMEDOUT|Server selection timed out|whitelist|not authorized to access/i.test(message)) return 'Hint: add this computer\'s IP in MongoDB Atlas > Network Access, wait a minute and try again.';
    if (/bad auth|Authentication failed/i.test(message)) return 'Hint: the user name or password in MONGO_URI is wrong.';
    return '';
};

module.exports = { atlasHint, connectMongo };
