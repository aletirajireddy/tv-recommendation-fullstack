const db = require('better-sqlite3')('../dashboard_v3.db');
try {
    const row = db.prepare('SELECT raw_data FROM smart_level_events ORDER BY timestamp DESC LIMIT 1').get();
    if (row && row.raw_data) {
        console.log(JSON.stringify(JSON.parse(row.raw_data), null, 2));
    } else {
        console.log("No data found in smart_level_events");
    }
} catch(e) {
    console.error(e);
}
process.exit(0);
