const mongoose = require('mongoose');
const Provider = require('./provider.model');
const Event = require('../event/event.model');
const User = require('../auth/user.model');
const { withTransaction } = require('../../utils/tx');
const { ROLES } = require('../../config/roles');
const { badRequest, notFound, conflict } = require('../../utils/httpError');

/** A USER applies to register their NGO / trust for an event. */
const apply = async (user, { name, type, eventId, registrationNumber, contactPhone, description } = {}) => {
    if (!name) throw badRequest('Organisation name is required');
    if (!mongoose.isValidObjectId(eventId) || !(await Event.exists({ _id: eventId, kind: 'YATRA' }))) {
        throw badRequest('Choose a yatra event to serve at');
    }
    if (await Provider.exists({ adminUserId: user._id, verificationStatus: { $in: ['PENDING', 'VERIFIED'] } })) {
        throw conflict('You already have an organisation registered or awaiting approval');
    }
    const provider = await Provider.create({
        name,
        type: type || 'NGO',
        eventId,
        adminUserId: user._id,
        registrationNumber,
        contactPhone: contactPhone || user.phone,
        description,
    });
    return provider.toObject();
};

const mine = async (userId) => Provider.find({ adminUserId: userId }).populate('eventId', 'title').sort({ createdAt: -1 }).lean();

const list = async ({ status, eventId } = {}) => {
    const filter = {};
    if (status) filter.verificationStatus = String(status);
    if (eventId && mongoose.isValidObjectId(eventId)) filter.eventId = eventId;
    return Provider.find(filter)
        .populate('adminUserId', 'name phone')
        .populate('eventId', 'title')
        .sort({ createdAt: -1 })
        .lean();
};

/** Super Admin / Authority verifies or rejects. Verification promotes the applicant to NGO_ADMIN. */
const decide = async (providerId, reviewer, { decision, reason } = {}) => {
    if (!['VERIFIED', 'REJECTED'].includes(decision)) throw badRequest('decision must be VERIFIED or REJECTED');
    return withTransaction(async (session) => {
        const provider = await Provider.findOneAndUpdate(
            { _id: providerId, verificationStatus: 'PENDING' },
            {
                $set: {
                    verificationStatus: decision,
                    verifiedBy: reviewer._id,
                    verifiedAt: new Date(),
                    rejectionReason: decision === 'REJECTED' ? reason : undefined,
                },
            },
            { returnDocument: 'after', session }
        );
        if (!provider) {
            if (!(await Provider.exists({ _id: providerId }))) throw notFound('Organisation not found');
            throw conflict('This organisation was already reviewed');
        }
        if (decision === 'VERIFIED') {
            await User.updateOne(
                { _id: provider.adminUserId, role: { $in: [ROLES.USER, ROLES.VOLUNTEER] } },
                { $set: { role: ROLES.NGO_ADMIN, providerId: provider._id } },
                { session }
            );
        }
        return provider.toObject();
    });
};

/** Verified organisations for an event (public: used by the seva form). */
const listVerified = async (eventId) => {
    if (!mongoose.isValidObjectId(eventId)) throw badRequest('Invalid event id');
    return Provider.find({ eventId, verificationStatus: 'VERIFIED' }, 'name type description').sort({ name: 1 }).lean();
};

module.exports = { apply, mine, list, listVerified, decide };
