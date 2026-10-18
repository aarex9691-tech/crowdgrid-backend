/**
 * Walking network for Panchavati / Ramkund, Nashik (Simhastha Kumbh Mela).
 *
 * A simplified map for the demo: real landmarks at approximately their real
 * positions, joined by the main walkable lanes. Lane lengths are the straight
 * line between the two ends plus 10% for bends, so the A* estimate (straight
 * line) can never be longer than a real route.
 *
 * `places` link a node to camps and kitchens: many QR check-ins there in the
 * last 30 minutes make the lanes around it busy.
 */
const EVENT_SLUG = 'simhastha-kumbh-2027';

// type: GHAT, CAMP, KITCHEN, TEMPLE, BUS, JUNCTION;  start: offered as a starting point
const NODES = [
    // Ghats (destinations)
    { id: 'ramkund', name: 'Ramkund Ghat', type: 'GHAT', lat: 20.0059, lng: 73.7897 },
    { id: 'ganga-ghat', name: 'Ganga Ghat', type: 'GHAT', lat: 20.0061, lng: 73.7913 },
    { id: 'naroshankar', name: 'Naroshankar Ghat', type: 'GHAT', lat: 20.0051, lng: 73.7886 },
    { id: 'kapila', name: 'Kapila Sangam Ghat, Tapovan', type: 'GHAT', lat: 20.0097, lng: 73.8089 },

    // Camps and kitchens
    { id: 'ramkund-dharamshala', name: 'Ramkund Dharamshala', type: 'CAMP', lat: 20.0067, lng: 73.789, start: true, places: ['Ramkund Dharamshala'] },
    { id: 'senior-dorm', name: 'NMC Senior Citizens Dormitory', type: 'CAMP', lat: 20.0046, lng: 73.7877, start: true, places: ['NMC Senior Citizens Dormitory'] },
    { id: 'kalaram-ashram', name: 'Kalaram Ashram Hall', type: 'CAMP', lat: 20.007, lng: 73.793, start: true, places: ['Kalaram Ashram Hall'] },
    { id: 'tent-city-a', name: 'Panchavati Tent City - Block A', type: 'CAMP', lat: 20.0089, lng: 73.7955, start: true, places: ['Panchavati Tent City - Block A'] },
    { id: 'tapovan-camp', name: 'Tapovan Free Seva Camp', type: 'CAMP', lat: 20.011, lng: 73.807, start: true, places: ['Tapovan Free Seva Camp'] },
    { id: 'godavari-langar', name: 'Godavari Langar', type: 'KITCHEN', lat: 20.0067, lng: 73.7906, start: true, places: ['Godavari Langar'] },
    { id: 'ram-seva', name: 'Ram Seva Bhojanalaya', type: 'KITCHEN', lat: 20.0078, lng: 73.7944, start: true, places: ['Ram Seva Bhojanalaya'] },
    { id: 'tapovan-kitchen', name: 'Tapovan Annachhatra', type: 'KITCHEN', lat: 20.0104, lng: 73.806, start: true, places: ['Tapovan Annachhatra'] },

    // Temples, bus stops, junctions
    { id: 'kalaram-mandir', name: 'Kalaram Mandir', type: 'TEMPLE', lat: 20.0074, lng: 73.7939, start: true },
    { id: 'sita-gufa', name: 'Sita Gufa', type: 'TEMPLE', lat: 20.0083, lng: 73.7963, start: true },
    { id: 'karanja', name: 'Panchavati Karanja (bus F4)', type: 'BUS', lat: 20.0081, lng: 73.795, start: true },
    { id: 'nimani', name: 'Nimani Bus Stand', type: 'BUS', lat: 20.0108, lng: 73.7919, start: true },
    { id: 'tapovan-chowk', name: 'Tapovan Chowk (E-shuttle S1)', type: 'BUS', lat: 20.0115, lng: 73.8077, start: true },
    { id: 'raviwar-karanja', name: 'Raviwar Karanja', type: 'BUS', lat: 20.0013, lng: 73.7857, start: true },
    { id: 'ramkund-gate', name: 'Ramkund Gate 2', type: 'JUNCTION', lat: 20.0064, lng: 73.7896 },
    { id: 'sardar-chowk', name: 'Sardar Chowk', type: 'JUNCTION', lat: 20.0072, lng: 73.79 },
    { id: 'gg-chowk', name: 'Ganga Ghat Chowk (ambulance halt)', type: 'JUNCTION', lat: 20.0065, lng: 73.7917 },
    { id: 'panchavati-road', name: 'Panchavati Road junction', type: 'JUNCTION', lat: 20.0094, lng: 73.7941 },
    { id: 'malegaon-jn', name: 'Malegaon Stand junction', type: 'JUNCTION', lat: 20.0096, lng: 73.7904 },
    { id: 'sita-gufa-road', name: 'Sita Gufa Road', type: 'JUNCTION', lat: 20.009, lng: 73.7982 },
    { id: 'kapila-bridge', name: 'Kapila Bridge (water point)', type: 'JUNCTION', lat: 20.0095, lng: 73.8001 },
    { id: 'holkar-n', name: 'Ahilyabai Holkar Bridge (north end)', type: 'JUNCTION', lat: 20.0055, lng: 73.7871 },
    { id: 'holkar-s', name: 'Ahilyabai Holkar Bridge (south end)', type: 'JUNCTION', lat: 20.0037, lng: 73.7866 },
];

// [id, from, to, name]
const LANES = [
    ['ramkund-steps', 'ramkund', 'ramkund-gate', 'Ramkund steps'],
    ['ramkund-gate-lane', 'ramkund-gate', 'sardar-chowk', 'Ramkund Gate lane'],
    ['dharamshala-gate', 'ramkund-dharamshala', 'ramkund-gate', 'Dharamshala gate path'],
    ['dharamshala-lane', 'ramkund-dharamshala', 'sardar-chowk', 'Dharamshala lane'],
    ['riverside-walk', 'ramkund', 'ganga-ghat', 'Riverside walkway (Ramkund - Ganga Ghat)'],
    ['naroshankar-steps', 'ramkund', 'naroshankar', 'Naroshankar steps'],
    ['senior-ramp', 'naroshankar', 'senior-dorm', 'Senior dorm ramp'],
    ['holkar-approach', 'senior-dorm', 'holkar-n', 'Holkar Bridge approach'],
    ['holkar-road', 'holkar-n', 'sardar-chowk', 'Holkar Bridge road'],
    ['holkar-bridge', 'holkar-n', 'holkar-s', 'Ahilyabai Holkar Bridge'],
    ['raviwar-road', 'holkar-s', 'raviwar-karanja', 'Raviwar Karanja road'],
    ['ganga-approach', 'ganga-ghat', 'gg-chowk', 'Ganga Ghat approach'],
    ['langar-lane', 'gg-chowk', 'godavari-langar', 'Langar lane'],
    ['sardar-langar', 'godavari-langar', 'sardar-chowk', 'Sardar Chowk - Langar lane'],
    ['procession-route', 'gg-chowk', 'kalaram-ashram', 'Procession route (Ganga Ghat - Kalaram)'],
    ['mandir-east', 'kalaram-ashram', 'kalaram-mandir', 'Kalaram Mandir east lane'],
    ['bhojanalaya-lane', 'kalaram-mandir', 'ram-seva', 'Bhojanalaya lane'],
    ['karanja-lane', 'ram-seva', 'karanja', 'Karanja lane'],
    ['tent-gate-road', 'karanja', 'tent-city-a', 'Tent City gate road'],
    ['sita-gufa-lane', 'karanja', 'sita-gufa', 'Sita Gufa lane'],
    ['tent-back-lane', 'tent-city-a', 'sita-gufa', 'Tent City back lane'],
    ['sita-gufa-road', 'sita-gufa', 'sita-gufa-road', 'Sita Gufa Road'],
    ['tapovan-road', 'sita-gufa-road', 'kapila-bridge', 'Tapovan Road'],
    ['tapovan-road-east', 'kapila-bridge', 'tapovan-kitchen', 'Tapovan Road (east)'],
    ['sadhugram-lane', 'tapovan-kitchen', 'tapovan-camp', 'Sadhugram lane'],
    ['tapovan-chowk-road', 'tapovan-camp', 'tapovan-chowk', 'Tapovan Chowk road'],
    ['kapila-path', 'tapovan-chowk', 'kapila', 'Kapila Sangam path'],
    ['kapila-riverside', 'tapovan-kitchen', 'kapila', 'Riverside path to Kapila'],
    ['mandir-north', 'kalaram-mandir', 'panchavati-road', 'Kalaram north lane'],
    ['panchavati-road', 'panchavati-road', 'karanja', 'Panchavati Road'],
    ['nimani-road', 'panchavati-road', 'nimani', 'Nimani Road'],
    ['malegaon-road', 'nimani', 'malegaon-jn', 'Malegaon Stand road'],
    ['sardar-road', 'malegaon-jn', 'sardar-chowk', 'Sardar Chowk road'],
    ['mandir-west', 'kalaram-mandir', 'malegaon-jn', 'Kalaram west lane'],
    ['ashram-sardar', 'kalaram-ashram', 'sardar-chowk', 'Ashram lane to Sardar Chowk'],
];

// Lanes the control room has already marked when the database is seeded
const SEED_STATUS = [
    { laneId: 'procession-route', status: 'CROWDED', note: 'Nagar pradakshina procession in progress' },
    { laneId: 'ramkund-gate-lane', status: 'BUSY', note: 'Queue for the morning snan' },
    { laneId: 'kapila-riverside', status: 'CLOSED', note: 'Riverbank closed: high water after the dam release' },
];

module.exports = { EVENT_SLUG, NODES, LANES, SEED_STATUS };
