const db = require('./server/database');

// Find scans where timestamp is NOT like a date string (i.e. does not contain 'T')
// ISO strings have 'T' (2026-01-14T...). Numbers do not.
const badScans = db.prepare("SELECT * FROM scans WHERE timestamp NOT LIKE '%T%'").all();
console.log(`Found ${badScans.length} scans with invalid timestamp format (Numeric?).`);
console.log(badScans);

if (badScans.length > 0) {
    const info = db.prepare("DELETE FROM scans WHERE timestamp NOT LIKE '%T%'").run();
    console.log(`Deleted ${info.changes} invalid scans.`);
}

const allScans = db.prepare('SELECT id, timestamp FROM scans ORDER BY timestamp DESC LIMIT 5').all();
console.log('--- CLEAN STATE (Latest 5) ---');
console.log(allScans);
