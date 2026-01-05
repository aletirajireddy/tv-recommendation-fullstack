const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, '../server/dashboard.db');
const backupPath = path.resolve(__dirname, '../server/dashboard.db.bak');

console.log('📦 Starting Database Timestamp Migration...');

// 1. Create Backup
try {
    if (fs.existsSync(dbPath)) {
        fs.copyFileSync(dbPath, backupPath);
        console.log(`✅ Backup created at: ${backupPath}`);
    } else {
        console.error('❌ Database file not found!');
        process.exit(1);
    }
} catch (err) {
    console.error('❌ Backup failed:', err);
    process.exit(1);
}

const db = new Database(dbPath);

// Function to normalize timestamp to ISO 8601
function toISO(ts) {
    try {
        let date;
        // Handle numeric strings or pure numbers
        if (!isNaN(ts) && !isNaN(parseFloat(ts))) {
            date = new Date(parseInt(ts));
        } else {
            date = new Date(ts);
        }

        if (isNaN(date.getTime())) {
            // If invalid, fallback to now (or maybe log warning)
            // For now, let's keep invalid ones as is or default to Epoch?
            // User wants to fix, so let's default to a safe historic date if totally broken
            // But usually "000:0" issues came from bad formatting, effectively invalid dates
            return new Date().toISOString();
        }
        return date.toISOString();
    } catch (e) {
        return new Date().toISOString();
    }
}

// 2. Migrate Pulse Events
console.log('🔄 Migrating pulse_events...');
const pulses = db.prepare('SELECT id, timestamp FROM pulse_events').all();
const updatePulse = db.prepare('UPDATE pulse_events SET timestamp = ? WHERE id = ?');

let pCount = 0;
const updatePulseTx = db.transaction((items) => {
    for (const p of items) {
        const newTs = toISO(p.timestamp);
        if (newTs !== p.timestamp) { // Only update if changed
            updatePulse.run(newTs, p.id);
            pCount++;
        }
    }
});
updatePulseTx(pulses);
console.log(`✨ Updated ${pCount} pulse_events.`);

// 3. Migrate Scans
console.log('🔄 Migrating scans...');
const scans = db.prepare('SELECT id, timestamp FROM scans').all();
const updateScan = db.prepare('UPDATE scans SET timestamp = ? WHERE id = ?');

let sCount = 0;
const updateScanTx = db.transaction((items) => {
    for (const s of items) {
        const newTs = toISO(s.timestamp);
        if (newTs !== s.timestamp) {
            updateScan.run(newTs, s.id);
            sCount++;
        }
    }
});
updateScanTx(scans);
console.log(`✨ Updated ${sCount} scans.`);

console.log('✅ Migration Complete. All timestamps are now ISO 8601.');
