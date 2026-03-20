const db = require('better-sqlite3')('dashboard_v3.db');
try {
    const rows = db.prepare('SELECT id, ticker, timestamp, price, direction, roc_pct FROM smart_level_events ORDER BY timestamp DESC LIMIT 5').all();
    console.log(JSON.stringify(rows, null, 2));
} catch(e) {
    console.error(e);
}
process.exit(0);
