const Database = require('../server/node_modules/better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, '../server/dashboard.db');
const db = new Database(dbPath);

console.log("--- UNIQUE CATEGORIES ---");
const events = db.prepare('SELECT payload_json FROM pulse_events').all();

const categories = new Set();
events.forEach(e => {
    try {
        const p = JSON.parse(e.payload_json);
        if (p.signal && p.signal.category) {
            categories.add(p.signal.category);
        }
    } catch (err) { }
});

console.log(Array.from(categories));
