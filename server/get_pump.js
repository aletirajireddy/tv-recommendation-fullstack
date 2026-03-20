const db = require('better-sqlite3')('dashboard_v3.db');
const row = db.prepare("SELECT raw_data FROM smart_level_events WHERE ticker LIKE '%PUMP%' ORDER BY timestamp DESC LIMIT 1").get();
if (row) {
    console.log(JSON.stringify(JSON.parse(row.raw_data), null, 2));
} else {
    console.log("Not found");
}
