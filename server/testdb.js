const db = require('./database');
try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
            SELECT 
                s.id, 
                s.timestamp, 
                s.trigger,
                json_extract(r.raw_data, '$.market_sentiment.moodScore') as mood,
                json_array_length(json_extract(r.raw_data, '$.results')) as count
            FROM scans s
            LEFT JOIN scan_results r ON s.id = r.scan_id
            WHERE s.timestamp > ? 
            ORDER BY s.timestamp ASC
            LIMIT 5
        `).all(cutoff);
    console.log("SUCCESS:", rows.length, "rows fetched. Row 0:", rows[0]);
} catch(e) {
    console.error("FAILED:", e.message);
}
