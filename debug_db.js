const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'server', 'dashboard.db');
const db = new Database(dbPath, { readonly: true });

console.log('--- Checking Scans ---');
const scans = db.prepare('SELECT * FROM scans ORDER BY timestamp DESC LIMIT 3').all();
console.table(scans);

if (scans.length > 0) {
    const latestScanId = scans[0].id;
    console.log(`\n--- Checking Entries for Scan: ${latestScanId} ---`);

    // Check various statuses
    const stats = db.prepare(`
        SELECT status, count(*) as count 
        FROM scan_entries 
        WHERE scan_id = ? 
        GROUP BY status
    `).all(latestScanId);
    console.table(stats);

    // Get a sample pass entry to check JSON structure
    const sample = db.prepare(`
        SELECT ticker, status, raw_data_json 
        FROM scan_entries 
        WHERE scan_id = ? AND status = 'PASS' 
        LIMIT 1
    `).get(latestScanId);

    if (sample) {
        console.log('\n--- Sample PASS Entry ---');
        console.log('Ticker:', sample.ticker);
        console.log('Raw JSON:', sample.raw_data_json.substring(0, 200) + '...');
        try {
            const parsed = JSON.parse(sample.raw_data_json);
            console.log('Parsed Fields:');
            console.log('  resistDist:', parsed.resistDist);
            console.log('  supportDist:', parsed.supportDist);
            console.log('  momScore:', parsed.momScore);
            console.log('  volSpike:', parsed.volSpike);
        } catch (e) {
            console.error('JSON Parse Error:', e.message);
        }
    } else {
        console.log('\n❌ No PASS entries found for latest scan.');
    }
} else {
    console.log('\n❌ No scans found in DB.');
}
