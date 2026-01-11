const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, 'dashboard.db');
const db = new Database(dbPath);

const row = db.prepare('SELECT timestamp, ticker, type FROM pulse_events ORDER BY timestamp DESC LIMIT 1').get();

if (row) {
    console.log(`Last Alert:`);
    console.log(`Time: ${row.timestamp}`);
    console.log(`Ticker: ${row.ticker}`);
    console.log(`Type: ${row.type}`);

    // Convert to local time string for convenience (Script runs in user's timezone environment usually)
    const localTime = new Date(row.timestamp).toLocaleString();
    console.log(`Local Time: ${localTime}`);
} else {
    console.log('No alerts found in pulse_events table.');
}
