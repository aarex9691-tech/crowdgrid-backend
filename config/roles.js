/**
 * Role-Based Access Control.
 *
 * ROLES are the account types. PERMISSIONS maps each capability from the
 * CrowdGrid access matrix to the roles allowed to use it. Routes check a
 * permission (not a role), so changing who can do what only means editing
 * this file.
 */
const ROLES = Object.freeze({
    SUPER_ADMIN: 'SUPER_ADMIN',
    AUTHORITY: 'AUTHORITY', // District / Government authority
    CORPORATE_ADMIN: 'CORPORATE_ADMIN', // Corporate proxy admin: campus & corporate events
    EVENT_HOST: 'EVENT_HOST', // verified organisation that hosts public events (concerts, aartis, walks)
    ORG_HOST: 'ORG_HOST', // verified organisation that hosts both (colleges, charities...)
    NGO_ADMIN: 'NGO_ADMIN', // NGO / Seva trust manager
    VOLUNTEER: 'VOLUNTEER', // Ground volunteer / marshal
    USER: 'USER', // Pilgrim / Attendee (everyone starts here)
});

const { SUPER_ADMIN, AUTHORITY, CORPORATE_ADMIN, EVENT_HOST, ORG_HOST, NGO_ADMIN, VOLUNTEER, USER } = ROLES;
const ALL = Object.values(ROLES);
// Staff of the yatras (they may see contact numbers on missing-person reports). Organisation hosts
// (corporate admins included, since anyone verified can become one) are not: they run their own
// events and have no business with pilgrims' private details.
const STAFF = [SUPER_ADMIN, AUTHORITY, NGO_ADMIN, VOLUNTEER];
/** Organisations that run their own events (each manages and scans only its own). */
const HOST_ROLES = [CORPORATE_ADMIN, EVENT_HOST, ORG_HOST];

const PERMISSIONS = Object.freeze({
    // Global platform config & approvals
    'platform:manage': [SUPER_ADMIN],
    'platform:audit': [SUPER_ADMIN, AUTHORITY],
    'staff:create': [SUPER_ADMIN],
    // Help desk: look up an account by mobile number and give a temporary password
    'account:reset': [SUPER_ADMIN, AUTHORITY],

    // Verify NGOs & service camps
    'provider:verify': [SUPER_ADMIN, AUTHORITY],
    'provider:apply': [USER],

    // Create the official yatra hubs (never organisation hosts)
    'event:create:yatra': [SUPER_ADMIN, AUTHORITY],
    // Create public event hubs
    'event:create:public': [SUPER_ADMIN, AUTHORITY, EVENT_HOST, ORG_HOST],
    // Create & manage corporate events
    'event:create:corporate': [SUPER_ADMIN, CORPORATE_ADMIN, ORG_HOST],

    // Organisations ask to host events; the Super Admin verifies them
    'host:apply': [USER],
    'host:review': [SUPER_ADMIN],

    // Manage lodging / food inventory (NGO limited to its own NGO in the service)
    'inventory:manage': [SUPER_ADMIN, NGO_ADMIN],
    'inventory:view': [SUPER_ADMIN, AUTHORITY, NGO_ADMIN],

    // Scan QR entry / meal tokens
    'pass:scan': [SUPER_ADMIN, AUTHORITY, CORPORATE_ADMIN, EVENT_HOST, ORG_HOST, NGO_ADMIN, VOLUNTEER],

    // Book lodging / food passes / tickets: pilgrims and attendees only.
    // Admins and hosts run the event; they use their own dashboards and never book.
    'booking:create': [USER],

    // Volunteering
    'volunteer:apply': [USER],
    // The District Control Room approves volunteers and checks their ID; trusts only see who serves with them
    'volunteer:review': [SUPER_ADMIN, AUTHORITY],
    'volunteer:list': [SUPER_ADMIN, AUTHORITY, NGO_ADMIN],
    // District control room: duties, live roster, coverage, broadcasts
    'volunteer:manage': [SUPER_ADMIN, AUTHORITY],
    // A volunteer's own shifts: check in and out
    'duty:self': [VOLUNTEER],

    // SOS: anyone in trouble can raise one; staff see them according to scope
    'sos:create': ALL,
    // Alerts carry names, phone numbers and live locations: only the control room and volunteers list them
    'sos:view': [SUPER_ADMIN, AUTHORITY, VOLUNTEER],
    'sos:manage': [SUPER_ADMIN, AUTHORITY, VOLUNTEER],

    // Missing / found person reports
    'report:missing:create': [USER, SUPER_ADMIN],
    'report:found:create': [SUPER_ADMIN, AUTHORITY, NGO_ADMIN, VOLUNTEER],
    'report:manage': [SUPER_ADMIN, AUTHORITY, NGO_ADMIN],

    // Analytics dashboards (NGO admins only see their own organisation)
    'analytics:view': [SUPER_ADMIN, AUTHORITY],
    'analytics:ngo': [SUPER_ADMIN, NGO_ADMIN],

    // Mark walking lanes busy / crowded / closed (safest route to the ghat)
    'route:manage': [SUPER_ADMIN, AUTHORITY],
});

const hasPermission = (role, permission) => {
    const allowed = PERMISSIONS[permission];
    if (!allowed) throw new Error(`Unknown permission: ${permission}`);
    return allowed.includes(role);
};

module.exports = { ROLES, PERMISSIONS, STAFF, HOST_ROLES, hasPermission };
