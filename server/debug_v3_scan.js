const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, 'dashboard_v3.db');
const db = new Database(dbPath, { readonly: true });

console.log(`🔎 Inspecting V3 DB: ${dbPath}`);

// 1. Get Last 10 Scans
const scans = db.prepare('SELECT * FROM scans ORDER BY timestamp DESC LIMIT 10').all();

if (scans.length === 0) {
    console.log('❌ No Scans found.');
    process.exit(0);
}

console.log(`\n--- 1. RECENT SCANS (Found ${scans.length}) ---`);
console.table(scans.map(s => ({
    id: s.id,
    time: s.timestamp,
    trigger: s.trigger_type
})));

const scan = scans[0]; // Keep logic for detailing the *latest* one below


// 2. Get Blob
const blob = db.prepare('SELECT * FROM scan_results WHERE scan_id = ?').get(scan.id);
console.log('\n--- 2. SCAN RESULT BLOB (Source of Truth) ---');
if (blob) {
    console.log(`Scan ID: ${blob.scan_id}`);
    try {
        const json = JSON.parse(blob.raw_data);
        console.log(`Keys: ${Object.keys(json).join(', ')}`);
        console.log(`Results Count: ${json.results?.length}`);
        if (json.results?.length > 0) {
            console.log(`Sample Ticker: ${json.results[0].ticker}`);
            console.log(`Sample Data Keys: ${Object.keys(json.results[0].data || {}).join(', ')}`);
        }
    } catch (e) {
        console.log('Error parsing JSON blob:', e.message);
    }
} else {
    console.log('❌ Missing Blob!');
}

// 3. Get Pulse Events
const events = db.prepare('SELECT * FROM pulse_events WHERE scan_id = ?').all(scan.id);
console.log(`\n--- 3. PULSE EVENTS (Count: ${events.length}) ---`);
events.forEach(e => {
    console.log(`[${e.timestamp}] ${e.ticker} - ${e.type}`);
});

console.log('\n✅ Verification Logic Complete.');
