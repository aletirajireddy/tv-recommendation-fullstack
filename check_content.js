const db = require('./server/database');

const latestScans = db.prepare('SELECT id, timestamp, trigger_type FROM scans ORDER BY timestamp DESC LIMIT 5').all();

console.log('--- LATEST 5 SCANS ---');
latestScans.forEach(s => {
    const entries = db.prepare('SELECT count(*) as count FROM scan_entries WHERE scan_id = ?').get(s.id);
    const pulses = db.prepare('SELECT count(*) as count FROM pulse_events WHERE scan_id = ?').get(s.id);
    console.log(`Scan ${s.id} (${s.timestamp}): Entries=${entries.count}, Pulses=${pulses.count}, Trigger=${s.trigger_type}`);
});

const recentPulses = db.prepare('SELECT * FROM pulse_events ORDER BY timestamp DESC LIMIT 3').all();
console.log('\n--- RECENT PULSES (Raw) ---');
console.log(recentPulses);
