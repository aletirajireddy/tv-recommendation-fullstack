const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.resolve(__dirname, '..', 'dashboard_v3.db');
const db = new Database(dbPath);

console.log("Seeding lifecycles from last scan...");

try {
    const latestScan = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    if (!latestScan) {
        console.log("No scans found to seed from.");
        process.exit(0);
    }

    const scanData = JSON.parse(latestScan.raw_data);
    const results = scanData.results || [];
    const now = new Date().toISOString();

    const insert = db.prepare(`
        INSERT INTO coin_lifecycles (ticker, born_at, last_seen_at, status)
        VALUES (?, ?, ?, 'ACTIVE')
        ON CONFLICT(ticker) DO NOTHING
    `);

    let seededCount = 0;
    db.transaction(() => {
        results.forEach(r => {
            const cleanTicker = r.ticker || (r.data && r.data.ticker);
            if (cleanTicker) {
                insert.run(cleanTicker, now, now);
                seededCount++;
            }
        });
    })();

    console.log(`Successfully seeded ${seededCount} coins into coin_lifecycles.`);
} catch (e) {
    console.error("Seeding Error:", e.message);
}
