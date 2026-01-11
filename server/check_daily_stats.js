
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, 'dashboard.db');
const db = new Database(dbPath);

console.log('=== DATA HEALTH CHECK ===');
console.log(`Database Size: ${(require('fs').statSync(dbPath).size / 1024 / 1024).toFixed(2)} MB`);

// Group by Date (UTC)
const dailyCounts = db.prepare(`
    SELECT 
        substr(timestamp, 1, 10) as date, 
        count(*) as count 
    FROM scans 
    GROUP BY date 
    ORDER BY date DESC
`).all();

console.log('\n--- Scans per Day (UTC) ---');
console.table(dailyCounts);

// Check today's specific timestamps
const today = new Date().toISOString().split('T')[0];
const todayStats = db.prepare(`
    SELECT min(timestamp) as start, max(timestamp) as end 
    FROM scans 
    WHERE timestamp LIKE ?
`).get(`${today}%`);

console.log(`\nToday's Range (${today}):`);
console.log(`Start: ${todayStats.start}`);
console.log(`End:   ${todayStats.end}`);
