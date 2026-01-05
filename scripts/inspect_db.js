const Database = require('../server/node_modules/better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../server/dashboard.db');
const db = new Database(dbPath);

console.log("--- TABLES ---");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log(tables);

// console.log("--- SCANS SUMMARY ---");
// const scans = db.prepare('SELECT id, timestamp, count(*) as c FROM scans GROUP BY id ORDER BY timestamp DESC LIMIT 20').all();
// console.log(scans);

console.log("\n--- PULSE EVENTS SUMMARY ---");
const pulses = db.prepare('SELECT ticker, count(*) as count, min(timestamp) as start, max(timestamp) as end FROM pulse_events GROUP BY ticker ORDER BY count DESC LIMIT 20').all();
console.log(pulses);

console.log("\n--- PAYLOAD SAMPLES ---");
const sample = db.prepare('SELECT payload_json FROM pulse_events LIMIT 5').all();
sample.forEach(s => console.log(s.payload_json));
