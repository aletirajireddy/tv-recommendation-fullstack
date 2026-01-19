const Database = require('better-sqlite3');
const db = new Database('dashboard.db');

console.log("=== LATEST SCANS ===");
const scans = db.prepare("SELECT id, timestamp, latency, metadata_json FROM scans ORDER BY timestamp DESC LIMIT 3").all();
console.table(scans);

console.log("\n=== LATEST MARKET STATES ===");
const states = db.prepare("SELECT scan_id, mood_score, trend_sentiment, timestamp FROM market_states ORDER BY timestamp DESC LIMIT 3").all();
console.table(states);

console.log("\n=== LATEST ENTRIES (Sample) ===");
if (scans.length > 0) {
    const entries = db.prepare("SELECT ticker, status, raw_data_json FROM scan_entries WHERE scan_id = ? LIMIT 3").all(scans[0].id);
    entries.forEach(e => {
        console.log(`Ticker: ${e.ticker}, Status: ${e.status}`);
        console.log(`Raw Data Snippet:`, e.raw_data_json.substring(0, 100) + "...");
    });
}
