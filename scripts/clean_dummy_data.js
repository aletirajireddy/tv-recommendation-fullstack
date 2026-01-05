const Database = require('../server/node_modules/better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../server/dashboard.db');
const db = new Database(dbPath);

console.log("Cleaning Dummy Data...");

// Delete seeded Pulse Events
// Identified by specific ticker 'SOL' and simple payload typical of seed script
const resultPulse = db.prepare(`
    DELETE FROM pulse_events 
    WHERE ticker IN ('SOL', 'ETH', 'BTC') 
    AND (payload_json LIKE '%"price":24.5%' OR payload_json LIKE '%"price":3500%')
`).run();

console.log(`Deleted ${resultPulse.changes} dummy pulse events.`);

// Delete seeded Scans (IDs 1000-1004)
const resultScans = db.prepare(`
    DELETE FROM scans 
    WHERE id LIKE 'scan_100%'
`).run();

console.log(`Deleted ${resultScans.changes} dummy scans.`);
console.log("Done.");
