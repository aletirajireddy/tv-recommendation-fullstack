const db = require('./server/database');

const lastScan = db.prepare('SELECT id, timestamp FROM scans ORDER BY id DESC LIMIT 1').get();

if (lastScan) {
    const d = new Date(lastScan.timestamp);
    console.log(`Last Scan ID: ${lastScan.id}`);
    console.log(`Last Scan Time: ${d.toLocaleString()}`);
    console.log(`Gap: ${((Date.now() - lastScan.timestamp) / 1000 / 60).toFixed(1)} minutes`);
} else {
    console.log('No scans found.');
}
