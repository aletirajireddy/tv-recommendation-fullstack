
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, 'dashboard.db');
console.log(`=== READING DATABASE: ${dbPath} ===`);

const db = new Database(dbPath);

// 1. Check Stats
const scanCount = db.prepare('SELECT count(*) as count FROM scans').get().count;
const oldest = db.prepare('SELECT min(timestamp) as time FROM scans').get().time;
const newest = db.prepare('SELECT max(timestamp) as time FROM scans').get().time;

console.log(`Total Scans: ${scanCount}`);
console.log(`Oldest: ${oldest}`);
console.log(`Newest: ${newest}`);

// 2. Check Auto-Deletion Logic (Simulation)
const RETENTION_HOURS = 98;
const cutoff = new Date(Date.now() - RETENTION_HOURS * 60 * 60 * 1000).toISOString();
console.log(`\nRetention Policy: 98 Hours`);
console.log(`Cutoff Time: ${cutoff}`);

const wouldDelete = db.prepare('SELECT count(*) as count FROM scans WHERE timestamp < ?').get(cutoff).count;
console.log(`Records older than cutoff (subject to deletion): ${wouldDelete}`);

if (scanCount > 0) {
    const recent = db.prepare('SELECT * FROM scans ORDER BY timestamp DESC LIMIT 3').all();
    console.log('\n--- Top 3 Recent Scans ---');
    recent.forEach(r => {
        console.log(`[ID: ${r.id}] Time: ${r.timestamp} | Type: ${r.trigger_type} | Latency: ${r.latency}ms`);
    });
}
