const db = require('./server/database');

console.log("=== V3 DB HEARTBEAT INSPECTION ===");
const rows = db.prepare(`
    SELECT id, timestamp, trigger 
    FROM scans 
    ORDER BY timestamp DESC 
    LIMIT 20
`).all();

console.table(rows);

const now = new Date();
if (rows.length > 0) {
    const last = new Date(rows[0].timestamp);
    const diff = (now - last) / 1000 / 60;
    console.log(`\nCurrent Server Time: ${now.toISOString()}`);
    console.log(`Last Scan Time:      ${rows[0].timestamp}`);
    console.log(`Time Since Last:     ${diff.toFixed(2)} minutes`);
} else {
    console.log("No scans found.");
}
