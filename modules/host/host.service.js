const mongoose = require('mongoose');
const { HostApplication, KINDS, ORG_TYPES, ID_TYPES } = require('./host.model');
const User = require('../auth/user.model');
const audit = require('../audit/audit.service');
const orgIds = require('../../utils/orgIds');
const v = require('../../utils/validate');
const { withTransaction } = require('../../utils/tx');
const { sniffImage } = require('../lostfound/photo.model');
const { ROLES } = require('../../config/roles');
const { badRequest, notFound, conflict, forbidden } = require('../../utils/httpError');

/*
 * Organisations that want to run their own events (concerts, aartis, college fests, summits)
 * apply here. The Super Admin checks them before anything goes live:
 *   - the ID number (GSTIN with its check digit, CIN, NGO Darpan, AISHE, Udyam; trust and
 *     society numbers are only stored), and no other organisation may use the same number
 *   - the registration certificate the organisation uploads
 *   - a checklist: ID format, certificate, website matching the email, age of the account
 * Approval turns the applicant's account into the matching host role.
 */

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const ROLE_FOR = { PUBLIC: ROLES.EVENT_HOST, CORPORATE: ROLES.CORPORATE_ADMIN, BOTH: ROLES.ORG_HOST };
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;

/** PDF by its "%PDF-" header, or a JPEG / PNG / WEBP photo; null for anything else. */
const sniffDocument = (buf) => {
    if (!Buffer.isBuffer(buf) || buf.length < 5) return null;
    if (buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
    return sniffImage(buf);
};

/** The site's domain without "www.", or null. */
const domainOf = (website) => {
    try {
        return new URL(website).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return null;
    }
};

const cleanWebsite = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return undefined;
    const url = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const host = domainOf(url);
    if (s.length > 200 || !host || !host.includes('.') || /\s/.test(s)) throw badRequest('Enter the website like www.example.org, or leave it empty');
    return url;
};

const pick = (value, list, message) => {
    const v2 = String(value || '').toUpperCase();
    if (!list.includes(v2)) throw badRequest(message);
    return v2;
};

const withoutFile = (doc) => {
    const out = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
    if (out.document) delete out.document.data;
    delete out.pendingFor;
    delete out.activeIdKey;
    return out;
};

/** A pilgrim account applies on behalf of its organisation (with the registration certificate). */
const apply = async (user, body = {}, file = null) => {
    if (user.role !== ROLES.USER) throw forbidden('Apply from a personal account (staff accounts cannot apply)');
    const kind = pick(body.kind, KINDS, 'Choose public events, campus & corporate events, or both');
    const orgName = v.text(body.orgName, 'Organisation name', 'orgName', { required: true });
    const orgType = pick(body.orgType, ORG_TYPES, 'Choose the type of organisation');
    const idType = pick(body.idType, ID_TYPES, 'Choose the type of registration number');
    const idNumber = orgIds.normalise(idType, body.idNumber);
    const idCheck = orgIds.check(idType, idNumber);
    if (!idNumber || !/[A-Z0-9]/i.test(idNumber)) throw badRequest('Enter the registration number');
    if (idCheck.status === 'INVALID') throw badRequest(`That ${idCheck.label} is not valid. Copy it exactly from the certificate.`);
    const city = v.text(body.city, 'City', 'city', { required: true });
    const contactName = v.text(body.contactName, 'Contact person', 'personName', { required: true });
    const contact = v.mobile(body.contactCountryCode, body.contactPhone, 'Contact number', { required: true });
    const contactEmail = String(body.contactEmail || '').trim().toLowerCase() || undefined;
    if (contactEmail && (contactEmail.length > 120 || !EMAIL_RE.test(contactEmail))) throw badRequest('Enter a valid email address, or leave it empty');
    const website = cleanWebsite(body.website);
    const expectedSize = body.expectedSize !== undefined && body.expectedSize !== '' ? v.int(body.expectedSize, 'Expected number of people', { min: 1, max: 10000000 }) : undefined;
    const description = v.text(body.description, 'About your events', 'longText');

    if (!file || !file.length) throw badRequest('Upload the registration certificate (a PDF or a clear photo)');
    if (file.length > MAX_DOCUMENT_BYTES) throw badRequest('The certificate is too large. Use a file under 2 MB.');
    const contentType = sniffDocument(file);
    if (!contentType) throw badRequest('The certificate must be a PDF or an image (JPEG, PNG or WEBP)');

    try {
        const app = await HostApplication.create({
            applicantId: user._id,
            kind,
            orgName,
            orgType,
            idType,
            idNumber,
            idCheck: idCheck.status,
            city,
            contactName,
            contactCountryCode: contact.countryCode,
            contactPhone: contact.phone,
            contactEmail,
            website,
            expectedSize,
            description,
            document: { data: file, contentType, size: file.length },
            pendingFor: user._id,
            // the same number counts once, whatever type or punctuation it was sent with
            activeIdKey: idNumber.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
        });
        audit.record({ actor: user, action: 'HOST_APPLIED', targetType: 'HostApplication', targetId: app._id, summary: `${user.name} asked to host ${kind === 'BOTH' ? 'public and campus' : kind.toLowerCase()} events for ${orgName}` });
        return withoutFile(app);
    } catch (err) {
        if (err.code !== 11000) throw err;
        if (err.keyPattern?.pendingFor) throw conflict('You already have a request waiting for review');
        throw conflict('An organisation with this registration number has already applied or is approved');
    }
};

/** The applicant's own requests, newest first (status, and the reason if rejected). */
// The applicant sees the decision and a rejection's reason; the reviewer's note and name stay internal
const mine = async (user) =>
    (await HostApplication.find({ applicantId: user._id }, '-reviewNote -reviewedBy').sort({ createdAt: -1 }).limit(20).lean()).map(withoutFile);

/** What the reviewer should look at, worked out from the request. */
const checksFor = async (app, applicant) => {
    const emailDomain = app.contactEmail ? app.contactEmail.split('@')[1] : null;
    const siteDomain = app.website ? domainOf(app.website) : null;
    const previouslyRejected = await HostApplication.countDocuments({ _id: { $ne: app._id }, idType: app.idType, idNumber: app.idNumber, status: 'REJECTED' });
    return {
        idFormat: app.idCheck, // VALID (format and, for GSTIN, the check digit) or UNCHECKED (trust / society numbers)
        idLabel: orgIds.TYPES[app.idType]?.label,
        document: !!app.document?.contentType,
        // a free email (gmail...) never matches a website: the reviewer should call the contact number
        websiteMatchesEmail: emailDomain && siteDomain ? emailDomain === siteDomain || emailDomain.endsWith(`.${siteDomain}`) : null,
        accountAgeDays: applicant?.createdAt ? Math.floor((Date.now() - new Date(applicant.createdAt)) / 864e5) : null,
        previouslyRejected,
    };
};

/** Review queue for the Super Admin (the certificate itself is opened separately). */
const list = async ({ status } = {}) => {
    const filter = {};
    if (status && ['PENDING', 'APPROVED', 'REJECTED'].includes(String(status))) filter.status = String(status);
    const apps = await HostApplication.find(filter).populate('applicantId', 'name countryCode phone createdAt role').sort({ createdAt: -1 }).limit(200).lean();
    return Promise.all(apps.map(async (a) => ({ ...withoutFile(a), checks: await checksFor(a, a.applicantId) })));
};

/** The certificate file: for the applicant and the Super Admin only (404 for anyone else). */
const document = async (id, user) => {
    if (!mongoose.isValidObjectId(id)) throw notFound('Request not found');
    const app = await HostApplication.findById(id).select('+document.data applicantId document.contentType').lean();
    const allowed = app && (user.role === ROLES.SUPER_ADMIN || String(app.applicantId) === String(user._id));
    if (!allowed || !app.document?.data) throw notFound('Request not found');
    const data = Buffer.isBuffer(app.document.data) ? app.document.data : Buffer.from(app.document.data.buffer || app.document.data);
    return { data, contentType: app.document.contentType };
};

/** Approve (the account becomes the matching host) or reject with a reason the organisation sees. */
const decide = async (id, reviewer, { decision, note, reason } = {}) => {
    if (!mongoose.isValidObjectId(id)) throw notFound('Request not found');
    if (!['APPROVED', 'REJECTED'].includes(decision)) throw badRequest('decision must be APPROVED or REJECTED');
    const reviewNote = v.text(note, 'Note', 'shortText');
    const rejectionReason = decision === 'REJECTED' ? v.text(reason, 'Reason', 'shortText') : undefined;
    if (decision === 'REJECTED' && (!rejectionReason || rejectionReason.length < 5)) throw badRequest('Give a reason for rejecting: the organisation sees it');

    const current = await HostApplication.findById(id).lean();
    if (!current) throw notFound('Request not found');
    if (current.status !== 'PENDING') throw conflict('This request was already reviewed');
    if (decision === 'APPROVED') {
        const applicant = await User.findById(current.applicantId, 'role').lean();
        if (!applicant) throw conflict('The applicant\'s account no longer exists');
        if (applicant.role !== ROLES.USER) throw conflict('This account already has a staff role. Ask the organisation to apply from a separate account.');
    }

    const result = await withTransaction(async (session) => {
        // The account changes first, and only if it is still a plain pilgrim account; then the request
        // is closed. Without transactions (a standalone database) a failed second step undoes the first,
        // so a request is never left approved for an account that did not become a host.
        if (decision === 'APPROVED') {
            const done = await User.updateOne(
                { _id: current.applicantId, role: ROLES.USER },
                { $set: { role: ROLE_FOR[current.kind], organisationName: current.orgName } },
                { session }
            );
            if (!done.modifiedCount) throw conflict('This account changed role meanwhile. Refresh and try again.');
        }
        // On a standalone database the account change above is undone if closing the request fails in any way
        const undoPromotion = async () => {
            if (decision !== 'APPROVED' || session) return;
            await User.updateOne({ _id: current.applicantId, role: ROLE_FOR[current.kind] }, { $set: { role: ROLES.USER }, $unset: { organisationName: 1 } }).catch((undoErr) =>
                console.error(`[hosts] could not undo the host role for user ${current.applicantId} after a failed approval:`, undoErr.message)
            );
        };
        let app;
        try {
            app = await HostApplication.findOneAndUpdate(
                { _id: id, status: 'PENDING' },
                {
                    $set: { status: decision, reviewedBy: reviewer._id, reviewedAt: new Date(), ...(reviewNote ? { reviewNote } : {}), ...(rejectionReason ? { rejectionReason } : {}) },
                    // a rejected organisation may apply again (same number); an approved one keeps its number
                    $unset: decision === 'REJECTED' ? { pendingFor: 1, activeIdKey: 1 } : { pendingFor: 1 },
                },
                { returnDocument: 'after', session }
            );
        } catch (err) {
            await undoPromotion();
            throw err;
        }
        if (!app) {
            await undoPromotion();
            throw conflict('This request was already reviewed');
        }
        return app.toObject();
    });
    audit.record({
        actor: reviewer,
        action: decision === 'APPROVED' ? 'HOST_APPROVED' : 'HOST_REJECTED',
        targetType: 'HostApplication',
        targetId: result._id,
        summary: `${reviewer.name} ${decision === 'APPROVED' ? 'approved' : 'rejected'} ${result.orgName} as a host (${result.kind.toLowerCase()} events)${rejectionReason ? `: ${rejectionReason}` : ''}`,
    });
    return withoutFile(result);
};

module.exports = { apply, mine, list, document, decide, MAX_DOCUMENT_BYTES, ROLE_FOR, sniffDocument };
