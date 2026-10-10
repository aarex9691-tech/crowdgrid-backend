const mongoose = require('mongoose');

let supportsTransactions = false;

/** Transactions need a replica set (MongoDB Atlas always is one). */
const detectTransactionSupport = async () => {
    try {
        const hello = await mongoose.connection.db.admin().command({ hello: 1 });
        supportsTransactions = Boolean(hello.setName || hello.msg === 'isdbgrid');
    } catch {
        supportsTransactions = false;
    }
    return supportsTransactions;
};

/**
 * Runs `work(session)` inside a MongoDB transaction when the server supports
 * it, otherwise runs it with `session = null`. Services written against this
 * helper pass `session` to every query and, when it is null, undo their own
 * earlier writes if a later step fails (compensation).
 */
const withTransaction = async (work) => {
    if (!supportsTransactions) return work(null);
    const session = await mongoose.startSession();
    try {
        let result;
        await session.withTransaction(async () => {
            result = await work(session);
        });
        return result;
    } finally {
        await session.endSession();
    }
};

module.exports = { detectTransactionSupport, withTransaction, isTransactional: () => supportsTransactions };
