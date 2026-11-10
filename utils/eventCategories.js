// Categories of public events. Keep in sync with crowdgrid-frontend/src/lib/format.js (EVENT_CATEGORIES).
// Order is the order hosts and visitors see them in.
const EVENT_CATEGORIES = [
    'SPIRITUAL', // Spiritual
    'HERITAGE_WALK', // Heritage walks
    'MUSIC', // Music & concerts
    'SPORTS', // Sports & fitness
    'FOOD', // Food & markets
    'TECH', // Tech & talks
    'COMEDY_THEATRE', // Comedy & theatre
    'EXHIBITION', // Exhibitions
    'WORKSHOP', // Workshops
    'FESTIVAL', // Festivals
    'KIDS', // Kids & family
    'SEVA', // Community & seva
    'OTHER', // Other
];

// Older events may still carry these; they stay valid but are no longer offered to hosts.
const LEGACY_CATEGORIES = ['CULTURAL'];

module.exports = { EVENT_CATEGORIES, LEGACY_CATEGORIES, ALL_EVENT_CATEGORIES: [...EVENT_CATEGORIES, ...LEGACY_CATEGORIES] };
