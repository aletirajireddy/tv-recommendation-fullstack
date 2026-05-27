// 8.5 CASCADE HISTORY (Real-time and Historical Cascade Trends)
app.get('/api/analytics/cascade-history', (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const refTime = req.query.refTime ? new Date(req.query.refTime) : new Date();
        const anchorTime = isNaN(refTime.getTime()) ? new Date() : refTime;
        const cutoffMs = anchorTime.getTime() - hours * 60 * 60 * 1000;
        const bucketMs = 5 * 60 * 1000; // 5 minute buckets

        // Query 1: Get raw metric history
        const rows = db.prepare(`
            SELECT ticker, ts, dist_m1, dist_m5, dist_m15, dist_h1, dist_h4, atr_m15
            FROM coin_metric_history
            WHERE ts > ? AND ts <= ?
            ORDER BY ts ASC
        `).all(cutoffMs, anchorTime.getTime());

        // Query 2: Get volume events for overlays
        // We only care about STREAM_C_ALERT or STREAM_D_RVOL spikes
        const cutoffISO = new Date(cutoffMs).toISOString();
        const anchorISO = anchorTime.toISOString();
        const volRows = db.prepare(`
            SELECT ticker, ts, source, strength
            FROM volume_events
            WHERE ts > ? AND ts <= ?
        `).all(cutoffISO, anchorISO);

        // Group volume events by 5-min bucket and ticker
        const volSpikes = {};
        for (const v of volRows) {
            const vMs = new Date(v.ts).getTime();
            const bMs = Math.floor(vMs / bucketMs) * bucketMs;
            if (!volSpikes[bMs]) volSpikes[bMs] = {};
            volSpikes[bMs][v.ticker] = true;
        }

        // Group metrics into buckets
        const buckets = {};
        for (const r of rows) {
            // Group by bucket (floor to nearest 5 min)
            const bMs = Math.floor(r.ts / bucketMs) * bucketMs;
            if (!buckets[bMs]) buckets[bMs] = {};
            
            // Only keep if we have enough data (at least a few distances)
            if (r.dist_h4 != null || r.dist_h1 != null) {
                buckets[bMs][r.ticker] = {
                    m1: r.dist_m1,
                    m5: r.dist_m5,
                    m15: r.dist_m15,
                    h1: r.dist_h1,
                    h4: r.dist_h4,
                    atr15: r.atr_m15,
                    v: volSpikes[bMs]?.[r.ticker] ? 1 : 0
                };
            }
        }

        const timeline = Object.keys(buckets).sort().map(tsStr => {
            const ts = parseInt(tsStr);
            return {
                ts,
                data: buckets[ts]
            };
        });

        res.json({ timeline });
    } catch (err) {
        console.error('API /analytics/cascade-history Error:', err);
        res.status(500).json({ error: err.message });
    }
});
