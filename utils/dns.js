/**
 * Optional DNS override for MongoDB Atlas.
 *
 * Atlas "mongodb+srv://" addresses need a DNS SRV lookup. Some home routers and
 * Windows setups refuse those lookups ("querySrv ECONNREFUSED"). Setting
 *   DNS_SERVERS=8.8.8.8,1.1.1.1
 * in .env makes Node ask those public DNS servers instead.
 * We also provide standard public DNS servers (Google + Cloudflare) as a default fallback
 * if SRV lookups fail.
 */
const dns = require('dns');

const envServers = (process.env.DNS_SERVERS || '').split(',').map((s) => s.trim()).filter(Boolean);
const servers = envServers.length ? envServers : ['8.8.8.8', '1.1.1.1'];
try {
    dns.setServers(servers);
} catch (e) {
    // ignore if environment prevents custom DNS servers
}

/** Friendly hint for the common Atlas connection errors. */
const atlasHint = (message = '') => {
    if (/querySrv|ENOTFOUND|EAI_AGAIN/i.test(message)) return 'Hint: DNS lookup for Atlas failed. Add DNS_SERVERS=8.8.8.8,1.1.1.1 to .env (or change the Wi-Fi DNS to 8.8.8.8) and try again.';
    if (/ETIMEDOUT|Server selection timed out|whitelist|not authorized to access/i.test(message)) return 'Hint: add this computer\'s IP in MongoDB Atlas > Network Access, wait a minute and try again.';
    if (/bad auth|Authentication failed/i.test(message)) return 'Hint: the user name or password in MONGO_URI is wrong.';
    return '';
};

module.exports = { atlasHint };
