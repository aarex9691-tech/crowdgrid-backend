const AuditLog = require('./audit.model');

/**
 * Records an audit entry. Never throws: a logging failure must not break the
 * action being logged, so errors are only printed to the server console.
 */
const record = async ({ actor, action, targetType, targetId, summary, meta }) => {
    try {
        await AuditLog.create({
            actorId: actor?._id,
            actorName: actor?.name,
            actorRole: actor?.role,
            action,
            targetType,
            targetId,
            summary,
            meta,
        });
    } catch (err) {
        console.error('Audit log write failed:', err.message);
    }
};

const recent = async ({ limit = 50, action } = {}) => {
    const filter = action ? { action: String(action) } : {};
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return AuditLog.find(filter).sort({ createdAt: -1 }).limit(n).lean();
};

module.exports = { record, recent };
