const Database = require('better-sqlite3');
const db = new Database('dashboard_v3.db');

try {
    const lifecycles = db.prepare("SELECT * FROM coin_lifecycles").all();
    console.log("Lifecycles count:", lifecycles.length);
    console.log("Sample:", lifecycles.slice(0, 5));
    
    const settings = db.prepare("SELECT * FROM system_settings").all();
    console.log("Settings:", settings);

    const scans = db.prepare("SELECT COUNT(*) as count FROM scan_results").get();
    console.log("Scan results count:", scans.count);
} catch (e) {
    console.error(e);
}
