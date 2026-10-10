/**
 * Role-Based Access Control.
 *
 * ROLES are the six account types. PERMISSIONS maps each capability from the
 * CrowdGrid access matrix to the roles allowed to use it. Routes check a
 * permission (not a role), so changing who can do what only means editing
 * this file.
 */
const ROLES = Object.freeze({
    SUPER_ADMIN: 'SUPER_ADMIN',
    AUTHORITY: 'AUTHORITY', // District / Government authority
    CORPORATE_ADMIN: 'CORPORATE_ADMIN', // Corporate proxy admin
    NGO_ADMIN: 'NGO_ADMIN', // NGO / Seva trust manager
    VOLUNTEER: 'VOLUNTEER', // Ground volunteer / marshal
    USER: 'USER', // Pilgrim / Attendee (everyone starts here)
});

const { SUPER_ADMIN, AUTHORITY, CORPORATE_ADMIN, NGO_ADMIN, VOLUNTEER, USER } = ROLES;
const ALL = Object.values(ROLES);
const STAFF = [SUPER_ADMIN, AUTHORITY, CORPORATE_ADMIN, NGO_ADMIN, VOLUNTEER];

const PERMISSIONS = Object.freeze({
    // Global platform config & approvals
    'platform:manage': [SUPER_ADMIN],
    'platform:audit': [SUPER_ADMIN, AUTHORITY],
    'staff:create': [SUPER_ADMIN],

    // Verify NGOs & service camps
    'provider:verify': [SUPER_ADMIN, AUTHORITY],
    'provider:apply': [USER],

    // Create public / religious event hubs
    'event:create:public': [SUPER_ADMIN, AUTHORITY],
    // Create & manage corporate events
    'event:create:corporate': [SUPER_ADMIN, CORPORATE_ADMIN],

    // Manage lodging / food inventory (NGO limited to its own NGO in the service)
    'inventory:manage': [SUPER_ADMIN, NGO_ADMIN],
    'inventory:view': [SUPER_ADMIN, AUTHORITY, NGO_ADMIN],

    // Scan QR entry / meal tokens
    'pass:scan': [SUPER_ADMIN, AUTHORITY, CORPORATE_ADMIN, NGO_ADMIN, VOLUNTEER],

    // Book lodging / food passes / tickets (Super Admin = test mode, Corporate = attendee mode)
    'booking:create': [SUPER_ADMIN, CORPORATE_ADMIN, USER],

    // Volunteering
    'volunteer:apply': [USER],
    'volunteer:review': [SUPER_ADMIN, AUTHORITY, NGO_ADMIN],

    // SOS: anyone in trouble can raise one; staff see them according to scope
    'sos:create': ALL,
    'sos:view': STAFF,
    'sos:manage': [SUPER_ADMIN, AUTHORITY, VOLUNTEER],

    // Missing / found person reports
    'report:missing:create': [USER, SUPER_ADMIN],
    'report:found:create': [SUPER_ADMIN, AUTHORITY, NGO_ADMIN, VOLUNTEER],
    'report:manage': [SUPER_ADMIN, AUTHORITY, NGO_ADMIN],
});

const hasPermission = (role, permission) => {
    const allowed = PERMISSIONS[permission];
    if (!allowed) throw new Error(`Unknown permission: ${permission}`);
    return allowed.includes(role);
};

module.exports = { ROLES, PERMISSIONS, STAFF, hasPermission };
