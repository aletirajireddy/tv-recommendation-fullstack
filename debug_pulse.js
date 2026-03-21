const db = require('better-sqlite3')('e:/AI/tv_dashboard/dashboard.db');
const rows = db.prepare(`
    SELECT 
        MAX(timestamp) as batch_time, 
        MIN(timestamp) as min_time, 
        SUM(CASE WHEN origin = 'INSTITUTIONAL' THEN 1 ELSE 0 END) as inst_count, 
        SUM(CASE WHEN origin = 'TECHNICAL' THEN 1 ELSE 0 END) as tech_count, 
        AVG(strength) as avg_mom 
    FROM unified_alerts 
    GROUP BY strftime('%Y-%m-%d %H:%M', timestamp) 
    ORDER BY batch_time DESC 
    LIMIT 5
`).all();
console.log(JSON.stringify(rows, null, 2));
