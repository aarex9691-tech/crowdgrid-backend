/**
 * Which database the test scripts may use.
 *
 * Tests write and delete data, so by default they refuse to touch the team's shared
 * database. Use one of:
 *   TEST_MONGO_URI=...crowdgrid_test   in .env (recommended; seed it once with
 *                                       MONGO_URI=<that address> npm run seed)
 *   a MONGO_URI whose database name ends in _test or _dev
 *   TESTS_ON_SHARED_DB=yes             to run on the shared database on purpose
 *                                       (e.g. a final check right after the demo seed)
 */
const dbName = (uri = '') => {
    const m = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri);
    return (m && decodeURIComponent(m[1])) || 'test'; // MongoDB's default database is "test"
};

const testDbUri = () => {
    const uri = process.env.TEST_MONGO_URI || process.env.MONGO_URI;
    if (!uri) throw new Error('Set TEST_MONGO_URI (or MONGO_URI) in .env');
    const name = dbName(uri);
    const safe = /_(test|dev)$/i.test(name) || name === 'test';
    if (!safe && process.env.TESTS_ON_SHARED_DB !== 'yes') {
        console.error(
            `Refusing to run tests on the database "${name}": tests create and delete data.\n` +
                'Set TEST_MONGO_URI to a database ending in _test (e.g. .../crowdgrid_test) and seed it once,\n' +
                'or run with TESTS_ON_SHARED_DB=yes if you really mean the shared database.'
        );
        process.exit(1);
    }
    console.log(`Using database "${name}"`);
    return uri;
};

module.exports = { testDbUri, dbName };
