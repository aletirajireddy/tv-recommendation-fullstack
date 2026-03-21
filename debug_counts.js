const db = require('better-sqlite3')('server/dashboard_v3.db');
const rows = db.prepare(`
    SELECT 
        strftime('%Y-%m-%d %H:%M', timestamp) as minute,
        count(*) as count,
        SUM(CASE WHEN origin = 'INSTITUTIONAL' THEN 1 ELSE 0 END) as inst,
        SUM(CASE WHEN origin = 'TECHNICAL' THEN 1 ELSE 0 END) as tech
    FROM unified_alerts 
    GROUP BY minute 
    ORDER BY minute DESC 
    LIMIT 5
`).all();
console.log(JSON.stringify(rows, null, 2));
