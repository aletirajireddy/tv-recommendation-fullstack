const db = require('better-sqlite3')('e:/AI/tv_dashboard/dashboard.db');
db.exec('DROP VIEW IF EXISTS unified_alerts;');
db.exec(`
    CREATE VIEW unified_alerts AS
    SELECT 
        id, ticker, timestamp, price, direction, roc_pct as strength, 'TECHNICAL' as origin, raw_data 
    FROM smart_level_events
    UNION ALL
    SELECT 
        id, ticker, timestamp, price, direction, bar_move_pct as strength, 'INSTITUTIONAL' as origin, raw_data 
    FROM institutional_interest_events;
`);
console.log('✅ View rebuilt successfully.');
