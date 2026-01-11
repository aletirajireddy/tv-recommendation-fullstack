const Database = require('better-sqlite3');
const path = require('path');

const db = new Database('dashboard.db', { readonly: true });

console.log('Testing SQLite Date Time conversion...');

const testTime = '2026-01-07T15:19:02.000Z'; // The one from check_last_alert
console.log(`Input Timestamp: ${testTime}`);

const stmt = db.prepare(`
    SELECT 
        strftime('%Y-%m-%d %H:%M', ?) as raw_fmt,
        strftime('%Y-%m-%d %H:%M', ?, 'localtime') as local_fmt,
        datetime(?, 'localtime') as full_local
`);

const result = stmt.get(testTime, testTime, testTime);

console.log('Result:', result);

// Also check the ACTUAL last row in pulse_events to match the query used in index.js
const lastRow = db.prepare(`
    SELECT 
        timestamp,
        strftime('%Y-%m-%d %H:%M', timestamp) as db_raw_fmt,
        strftime('%Y-%m-%d %H:%M', timestamp, 'localtime') as db_local_fmt
    FROM pulse_events 
    ORDER BY timestamp DESC 
    LIMIT 1
`).get();

console.log('Last DB Row:', lastRow);
