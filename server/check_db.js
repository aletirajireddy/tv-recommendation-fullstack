const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, 'trading_data.db');
const db = new Database(dbPath);

console.log(`\n=== READING DATABASE: ${dbPath} ===\n`);

// 1. Check Scans
const recentScans = db.prepare('SELECT * FROM scans ORDER BY timestamp DESC LIMIT 3').all();

if (recentScans.length === 0) {
    console.log("No scans found in 'scans' table.");
} else {
    console.log(`Found ${recentScans.length} recent scans:`);
    recentScans.forEach(scan => {
        console.log(`[ID: ${scan.id}] Time: ${scan.timestamp} | Type: ${scan.trigger_type} | Mood: ${scan.mood_score}`);
    });
}

// 2. Check Results for the latest scan
if (recentScans.length > 0) {
    const latestId = recentScans[0].id;
    console.log(`\n--- Detailed Results for Scan ID: ${latestId} ---`);

    const results = db.prepare('SELECT * FROM scan_results WHERE scan_id = ? LIMIT 3').all(latestId);

    if (results.length === 0) {
        console.log("No results found for this scan.");
    } else {
        results.forEach((r, i) => {
            console.log(`\nResult #${i + 1}: ${r.ticker} | Score: ${r.score} | Signal: ${r.recommendation}`);
            try {
                const raw = JSON.parse(r.raw_data);
                console.log("   Raw Data Sample (New Columns?):");
                console.log(`   - Daily Trend: ${raw.dailyTrend}`);
                console.log(`   - Breakout: ${raw.breakout}`);
                console.log(`   - Cluster Scope: ${raw.clusterScopeHighest}`);
                console.log(`   - Pulse Data: ${raw.pulse ? raw.pulse.length + ' alerts' : 'None'}`);
            } catch (e) {
                console.log("   (Could not parse raw_data JSON)");
            }
        });
    }
}

console.log("\n==========================================");
