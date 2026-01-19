const db = require('./server/database');

const stats = db.prepare(`
    SELECT 
        (SELECT count(*) FROM scans) as total_scans,
        (SELECT count(*) FROM scan_entries) as total_entries,
        (SELECT count(*) FROM pulse_events) as total_pulses,
        (SELECT min(timestamp) FROM scans) as first_scan,
        (SELECT max(timestamp) FROM scans) as last_scan
`).get();

console.log('--- DATABASE HEALTH REPORT ---');
console.log(`Total Scans: ${stats.total_scans}`);
console.log(`Total Data Points: ${stats.total_entries}`);
console.log(`Total Alerts: ${stats.total_pulses}`);
console.log(`History Range: ${stats.first_scan} to ${stats.last_scan}`);
