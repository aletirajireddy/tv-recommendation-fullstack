const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const db = require('./database'); // V3 Database Module

// --- SERVICES ---
// Telegram service kept for notifications (optional integration later)
const TelegramService = require('./services/telegram');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ============================================================================
// V3 ROUTES
// ============================================================================

// 1. HEALTH CHECK
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: 'v3-fresh-start', timestamp: new Date() });
});

// 2. SCAN REPORT (Stream A - Macro)
app.post('/scan-report', (req, res) => {
    const payload = req.body;
    // console.log(`[MACRO] 📡 Incoming Scan: ${payload.results.length} results`);

    try {
        // --- V3 WRITE PATH ---
        const scanId = payload.id;
        const timestamp = payload.timestamp || new Date().toISOString();
        const trigger = payload.trigger || 'manual';

        // A. Insert Scan Record
        db.prepare('INSERT INTO scans (id, timestamp, trigger) VALUES (?, ?, ?)')
            .run(scanId, timestamp, trigger);

        // B. Insert Scan Results (JSON Blob)
        db.prepare('INSERT INTO scan_results (scan_id, raw_data) VALUES (?, ?)')
            .run(scanId, JSON.stringify(payload));

        // C. Process Buffered Alerts (if any)
        const alerts = payload.institutional_pulse?.alerts || [];
        if (alerts.length > 0) {
            console.log(`[PULSE] ❤️ Processing ${alerts.length} alerts from batch`);
            const insertStmt = db.prepare(`
                INSERT INTO pulse_events (scan_id, timestamp, ticker, type, payload_json)
                VALUES (?, ?, ?, ?, ?)
            `);

            // Transaction for performance
            const processBatch = db.transaction((batch) => {
                for (const alert of batch) {
                    // Try to extract a "Real" Execution Time from the alert signal if available
                    // Fallback to Scan Timestamp if not
                    let realTime = timestamp;
                    if (alert.signal && alert.signal.date && alert.signal.timestamp) {
                        // Attempt parse: "Fri Jan 16 2026" + "01:32:00 am"
                        try {
                            // Simple heuristic, or just trust the Date.parse if format is standard
                            const composite = `${alert.signal.date} ${alert.signal.timestamp}`;
                            const parsed = new Date(composite);
                            if (!isNaN(parsed.getTime())) {
                                realTime = parsed.toISOString();
                            }
                        } catch (e) { }
                    }

                    insertStmt.run(scanId, realTime, alert.asset?.ticker || 'UNKNOWN', 'ALERT', JSON.stringify(alert));
                }
            });
            processBatch(alerts);
        }

        // D. EMIT SOCKET UPDATE (Live)
        // Send a lightweight notification to frontend
        io.emit('scan-update', {
            type: 'NEW_SCAN',
            id: payload.id,
            timestamp: payload.timestamp, // Critical for header sync
            mood: payload.market_sentiment?.moodScore,
            count: payload.results.length
        });

        // E. PROACTIVE AI ENGINE (Section 9 RFC)
        analyzeProactiveStrategies(payload);

        res.json({ success: true, id: payload.id });

    } catch (e) {
        console.error("V3 Ingest Error:", e);
        // SQLite constraint error usually means duplicate scan ID (which is fine, idempotency)
        if (e.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
            return res.status(409).json({ error: 'Duplicate Scan ID' });
        }
        res.status(500).json({ error: e.message });
    }
});

// Initialize Telegram Logs Table
db.prepare(`
    CREATE TABLE IF NOT EXISTS telegram_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        level TEXT DEFAULT 'INFO',
        message TEXT,
        meta_json TEXT
    )
`).run();

/**
 * 🦅 PROACTIVE AI STRATEGY ENGINE
 * Detects patterns in the 26-column data and syncs with Telegram
 */
function analyzeProactiveStrategies(payload) {
    if (!payload.results) return;

    const results = payload.results;
    const strategies = [];

    // 1. SILENT BREAKOUTS
    const breakouts = results.filter(item => {
        const d = item.data || item;
        return d.breakout === 1; // Explicit Breakout Flag
    }).map(item => ({ ticker: item.ticker, bias: 'Confirming' }));

    if (breakouts.length > 0) {
        strategies.push({
            id: 'breakout_burst',
            type: 'opportunity',
            title: '🦅 BREAKOUT BURST',
            description: `Detected ${breakouts.length} coins attempting to break key structures.`,
            tickers: breakouts
        });
    }

    // 2. MOMENTUM STARS (High Mom + Vol Spike)
    const momMovers = results.filter(item => {
        const d = item.data || item;
        return d.momScore >= 2 && d.volSpike === 1;
    }).map(item => ({ ticker: item.ticker, bias: `Score: ${item.data?.momScore || 0}` }));

    if (momMovers.length > 0) {
        strategies.push({
            id: 'momentum_flow',
            type: 'trend',
            title: '🌊 MOMENTUM INJECTION',
            description: `High momentum signatures detected with volume confirmation.`,
            tickers: momMovers
        });
    }

    // 3. RUNWAY SETUPS (Near Support/Resist + Good Range)
    // Heuristic: Logic Support Distance < 5% OR Logic Resist Distance < 5% AND Daily Range > 70%
    const runway = results.filter(item => {
        const d = item.data || item;
        // Check near support (bullish setup) that hasn't broken out yet
        const nearSupport = d.logicSupportDist > 0 && d.logicSupportDist < 5;
        // Check near resist (bearish/breakout setup)
        const nearResist = d.logicResistDist > 0 && d.logicResistDist < 5;
        // Ensure "Room to Run" (Daily Range not exhausted?)
        // [AUDIT FIX]: Tighten criteria. Must have some life (MomScore >= 1) to be worth watching.
        return (nearSupport || nearResist) && d.breakout === 0 && d.momScore >= 1;
    }).map(item => ({ ticker: item.ticker, desc: 'Near Key Level' }));

    if (runway.length > 0) {
        strategies.push({
            id: 'runway_focus',
            type: 'risk',
            title: '🛫 RUNWAY WATCH',
            description: `Coins testing key levels (Support/Resistance) with room to move.`,
            tickers: runway
        });
    }

    // [AUDIT FIX]: Telegram showing -92% (Legacy) vs Frontend +37% (Genie).
    // The payload.market_sentiment comes from the client scanner's legacy logic.
    // We must RE-CALCULATE the "Genie Score" here to ensure Telegram matches the Dashboard.

    let geniemood = { mood: 'NEUTRAL', moodScore: 0, bullish: 0, bearish: 0 };

    // Symmetric Calculation (Same as GenieSmart.js)
    if (results && results.length > 0) {
        let bulls = 0;
        let bears = 0;
        results.forEach(item => {
            const d = item.data || item;
            const pCode = d.positionCode || 0;
            if (pCode >= 300) bulls++; // 3xx, 5xx
            if (pCode >= 100 && pCode < 200) bears++; // 1xx
        });

        const total = results.length;
        // Score = (Net Flow / Total) * 100
        const rawScore = ((bulls - bears) / total) * 100;
        const moodScore = Math.round(rawScore);

        let label = 'NEUTRAL';
        if (moodScore >= 20) label = 'BULLISH';
        if (moodScore <= -20) label = 'BEARISH';

        geniemood = { mood: label, moodScore, bullish: bulls, bearish: bears, neutral: total - bulls - bears };
        console.log(`[GENIE SERVER] Re-calc Sentiment: ${moodScore}% (${label}) vs Payload: ${payload.market_sentiment?.moodScore}%`);
    }

    // Sync to Telegram Service (Handles Throttling & Logging)
    // Pass the RE-CALCULATED 'geniemood' which syncs with Frontend
    TelegramService.syncStrategies(
        strategies,
        geniemood,
        { marketCheck: { mood: geniemood.mood, score: geniemood.moodScore } }
    );
}

// 3. QUALIFIED PICK (Stream B - Micro)
// Writes to 'qualified_picks'
app.post('/qualified-pick', (req, res) => {
    const { ticker, price, type, move, direction, total_market_count } = req.body;
    console.log(`[PICKER] 🎯 V3 Pick: ${ticker} (${type})`);

    try {
        const now = new Date().toISOString();

        db.prepare(`
            INSERT INTO qualified_picks (ticker, price, timestamp, raw_data)
            VALUES (?, ?, ?, ?)
        `).run(ticker, price, now, JSON.stringify(req.body));

        io.emit('ledger-update', { ticker, price, signal: type });

        res.json({ message: "Saved", ai_suggestion: "TRACKING" });
    } catch (e) {
        console.error("Pick Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 4. SCAN DETAIL (Replay)
// Reads from 'scan_results' JSON blob
app.get('/api/scan/:id', (req, res) => {
    try {
        const { id } = req.params;
        const row = db.prepare('SELECT raw_data FROM scan_results WHERE scan_id = ?').get(id);

        if (!row) return res.status(404).json({ error: 'Scan not found' });

        const payload = JSON.parse(row.raw_data);
        res.json(payload);
    } catch (e) {
        console.error("Read Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 5. HISTORY TIMELINE (Stream A)
// Used by useTimeStore to build the "DVR" slider
app.get('/api/ai/history', (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        // Optimized for slider (Lightweight)
        const rows = db.prepare(`
            SELECT id, timestamp, trigger 
            FROM scans 
            WHERE timestamp > ? 
            ORDER BY timestamp ASC
        `).all(cutoff);

        res.json(rows);
    } catch (e) {
        console.error("History Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 6. NOTIFICATIONS STUB (Optional)
app.get('/api/notifications', (req, res) => {
    res.json([]);
});

// 7. SETTINGS STUB (Telegram)
app.get('/api/settings/telegram', (req, res) => {
    res.json({ enabled: TelegramService.enabled });
});
app.post('/api/settings/telegram', (req, res) => {
    TelegramService.enabled = !!req.body.enabled;
    res.json({ enabled: TelegramService.enabled });
});

// 8. ANALYTICS PULSE (Real V3 Aggregation)
app.get('/api/analytics/pulse', (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        // A. Multi-Widget Aggregation (One Pass)
        // Group by Scan ID for Time Spread, but also aggregate overall stats
        const spreadRows = db.prepare(`
            SELECT 
                MAX(timestamp) as batch_time,
                count(*) as count,
                AVG(
                    CASE 
                        WHEN COALESCE(json_extract(payload_json, '$.signal.d'), json_extract(payload_json, '$.signal.di')) > 0 THEN 1.0 
                        WHEN COALESCE(json_extract(payload_json, '$.signal.d'), json_extract(payload_json, '$.signal.di')) < 0 THEN -1.0 
                        ELSE 0 
                    END
                ) as avg_bias,
                AVG(json_extract(payload_json, '$.signal.mom')) as avg_mom,
                AVG(json_extract(payload_json, '$.signal.score')) as avg_score,
                SUM(CASE WHEN COALESCE(json_extract(payload_json, '$.signal.d'), json_extract(payload_json, '$.signal.di')) > 0 THEN 1 ELSE 0 END) as bull_count,
                SUM(CASE WHEN COALESCE(json_extract(payload_json, '$.signal.d'), json_extract(payload_json, '$.signal.di')) < 0 THEN 1 ELSE 0 END) as bear_count,
                group_concat(DISTINCT ticker) as tickers
            FROM pulse_events 
            WHERE timestamp > ? 
            GROUP BY scan_id
            ORDER BY batch_time DESC
            LIMIT 20
        `).all(cutoff);

        // 1. Time Spread & Flow Chart Data
        const time_spread = spreadRows.map(r => {
            const count = r.count;
            const tickers = r.tickers ? r.tickers.split(',') : [];
            const avgBias = r.avg_bias || 0;

            let biasLabel = 'NEUTRAL';
            if (avgBias >= 0.5) biasLabel = 'BULLISH';
            else if (avgBias <= -1.0) biasLabel = 'BEARISH';
            if (count > 5) { // Context boost
                if (avgBias > 0.2) biasLabel = 'STRONG BULL';
                else if (avgBias < -0.2) biasLabel = 'STRONG BEAR';
            }

            return {
                time: r.batch_time,
                count: count,
                unique_coins: tickers.length,
                spread: count > 3 ? "Wide" : "Narrow",
                density: (count / 5).toFixed(2),
                cluster: count > 5 ? 'BURST' : 'STEADY',
                bias: biasLabel,
                si: (r.avg_score || 0).toFixed(0), // Now 'Avg Score' instead of static S/I
                mon_pct: (r.avg_mom || 0).toFixed(1),
                wave_type: count > 7 ? 'Burst Cluster' : 'Broad Flow',
                timeline: tickers.slice(0, 3).join(', ') + (tickers.length > 3 ? '...' : ''),
                full_timeline: tickers.join(', '),

                // For Flow Chart
                bullish: r.bull_count,
                bearish: r.bear_count,
                mood_score: Math.round(avgBias * 100)
            };
        });

        // 2. Volume Intent (Aggregated from rows)
        const total_alerts = spreadRows.reduce((acc, r) => acc + r.count, 0);
        const volume_intent = {
            bullish: spreadRows.reduce((acc, r) => acc + r.bull_count, 0),
            bearish: spreadRows.reduce((acc, r) => acc + r.bear_count, 0)
        };

        // 3. Market Structure (Live Snapshot from Latest Scan)
        // Groups assets by their EMA Position Code (Col 26)
        const latestScan = db.prepare('SELECT id FROM scans ORDER BY timestamp DESC LIMIT 1').get();
        const market_structure = {
            bearish_structure: [],  // 3xx or 403
            choppy_structure: [],   // 2xx
            bullish_structure: [],  // 1xx or 231
            testing_support: [],    // 4xx
            mega_spot: []           // 5xx
        };

        if (latestScan) {
            if (latestScan) {
                const row = db.prepare('SELECT raw_data FROM scan_results WHERE scan_id = ?').get(latestScan.id);

                if (row && row.raw_data) {
                    const payload = JSON.parse(row.raw_data);
                    const results = payload.results || [];

                    results.forEach(r => {
                        const d = r.data || r;
                        const c = d.positionCode || 0;
                        const ticker = r.ticker;

                        // Classification based on Script Rules:
                        if (c >= 500) market_structure.mega_spot.push(ticker);
                        else if (c >= 400) market_structure.testing_support.push(ticker);
                        else if (c >= 300) market_structure.bullish_structure.push(ticker); // 3xx is BULLISH (Price > EMAs)
                        else if (c >= 200) market_structure.choppy_structure.push(ticker);
                        else if (c >= 100) market_structure.bearish_structure.push(ticker); // 1xx is BEARISH (Price < EMAs)
                    });
                }
            }
        }

        // 4. Signals (Alpha Quadrant)
        const signalRows = db.prepare(`
            SELECT 
                ticker,
                json_extract(payload_json, '$.signal.mom') as mom,
                json_extract(payload_json, '$.signal.score') as score,
                COALESCE(json_extract(payload_json, '$.signal.d'), json_extract(payload_json, '$.signal.di')) as bias_val,
                json_extract(payload_json, '$.volSpike') as volSpike
            FROM pulse_events
            WHERE timestamp > ?
            ORDER BY timestamp DESC
            LIMIT 50
        `).all(cutoff);

        const signals = signalRows.map(r => {
            const biasVal = r.bias_val || 0;
            return {
                ticker: r.ticker,
                x: parseFloat(r.mom || 0),
                y: parseFloat(r.score || 50),
                bias: biasVal > 0 ? 'BULLISH' : (biasVal < 0 ? 'BEARISH' : 'NEUTRAL'),
                volSpike: !!r.volSpike
            };
        });

        res.json({
            total_alerts,
            volume_intent,
            market_structure,
            time_spread,
            signals, // New Field
            predictions: [],
            insights: total_alerts > 0 ? [`${total_alerts} events in last ${hours}h`] : ["No recent activity"]
        });

    } catch (e) {
        console.error("Pulse Analytics Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 4b. SCENARIO PLANNING (Plan A vs Plan B)
app.get('/api/analytics/scenarios', (req, res) => {
    try {
        const hours = parseFloat(req.query.hours) || 1;

        // 1. Get Latest Scan
        const latestScan = db.prepare('SELECT id, timestamp FROM scans ORDER BY timestamp DESC LIMIT 1').get();
        if (!latestScan) return res.json({ planA: [], planB: [], marketCheck: null });

        // 2. Fetch/Parse Payload
        const row = db.prepare('SELECT raw_data FROM scan_results WHERE scan_id = ?').get(latestScan.id);
        if (!row || !row.raw_data) return res.json({ planA: [], planB: [], marketCheck: null });

        const payload = JSON.parse(row.raw_data);
        const results = payload.results || [];
        const marketMood = payload.market_sentiment || { moodScore: 0, mood: 'NEUTRAL' };

        const planA = [];
        const planB = [];

        // 3. Categorize Candidates
        results.forEach(r => {
            const d = r.data || r; // Normalize
            const code = d.positionCode || 0;
            const mom = d.momScore || 0;
            const vol = d.volSpike || 0;
            const ticker = d.ticker;

            // PLAN A: Bullish Scenarios
            // Criteria: Mega Spot (5xx), Bullish Trend (3xx), or Strong Momentum Breakout
            if (code >= 500) {
                planA.push({ ticker, price: d.close, trigger: 'Mega Spot Support', scope: 'Institutional', heat: 3, vol: vol });
            } else if (code >= 300 && code < 400 && mom > 20) {
                planA.push({ ticker, price: d.close, trigger: 'Trend Continuation', scope: 'Mid-Term', heat: 1, vol: vol });
            } else if (d.breakout) {
                planA.push({ ticker, price: d.close, trigger: 'Volatility Breakout', scope: 'Scalp', heat: 2, vol: 1 });
            }

            // PLAN B: Bearish Scenarios
            // Criteria: Bearish Trend (1xx) with Momentum, or Failed Support (Testing 4xx with low Mom)
            if (code >= 100 && code < 200 && mom < -10) {
                planB.push({ ticker, price: d.close, trigger: 'Trend Breakdown', scope: 'Mid-Term', heat: 1, vol: vol });
            } else if (code >= 400 && code < 500 && mom < -20) {
                planB.push({ ticker, price: d.close, trigger: 'Support Failure', scope: 'Reversal', heat: 2, vol: vol });
            }
        });

        // 4. Sort by Heat/Priority
        planA.sort((a, b) => b.heat - a.heat);
        planB.sort((a, b) => b.heat - a.heat);

        res.json({
            planA: planA.slice(0, 10),
            planB: planB.slice(0, 10),
            marketCheck: {
                mood: marketMood.mood || 'NEUTRAL',
                score: marketMood.moodScore || 0
            }
        });

    } catch (e) {
        console.error("Scenario Analytics Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 8b. STRATEGY LOGS (TLogs)
app.get('/api/strategy/logs', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const logs = TelegramService.getLogs(limit);
        res.json(logs);
    } catch (e) {
        console.error('Failed to fetch TLogs:', e);
        res.status(500).json({ error: e.message });
    }
});

// 9. RESEARCH (Real V3 Aggregation)
app.get('/api/analytics/research', (req, res) => {
    try {
        const hours = parseFloat(req.query.hours) || 24;
        const refTime = req.query.refTime ? new Date(req.query.refTime) : new Date();
        const anchorTime = isNaN(refTime.getTime()) ? new Date() : refTime;

        // Time Window: [Anchor - Hours, Anchor]
        const cutoff = new Date(anchorTime.getTime() - hours * 60 * 60 * 1000).toISOString();
        const anchorStr = anchorTime.toISOString();

        // A. Velocity (Count per minute)
        // CORRECTION: We need the *latest* 20 minutes in the window, not the oldest.
        // Derived Table strategy: Get Top 20 DESC, then Sort ASC.
        // [AUDIT FIX 2]: Order by timeSlot to resolve potential SQLite ambiguity.
        const velocityRows = db.prepare(`
            SELECT * FROM (
                SELECT strftime('%Y-%m-%dT%H:%M:00.000Z', timestamp) as timeSlot, count(*) as count
                FROM pulse_events
                WHERE timestamp > ? AND timestamp <= ?
                GROUP BY timeSlot
                ORDER BY timeSlot DESC
                LIMIT 20
            ) ORDER BY timeSlot ASC
        `).all(cutoff, anchorStr);

        const velocity = velocityRows.map(r => ({ time: r.timeSlot, count: r.count }));

        // B. Persistence (Top Active Tickers)
        const persistenceRows = db.prepare(`
            SELECT ticker, count(*) as scans
            FROM pulse_events
            WHERE timestamp > ? AND timestamp <= ?
            GROUP BY ticker
            ORDER BY scans DESC
            LIMIT 5
        `).all(cutoff, anchorStr);


        // C. Rejections (Proxy: Bearish Bias vs Bullish Bias distribution)
        // In a real 'Rejection' system, we'd check for specific 'rejected' event types.
        const sentimentRows = db.prepare(`
            SELECT 
                SUM(CASE WHEN COALESCE(json_extract(payload_json, '$.signal.d'), json_extract(payload_json, '$.signal.di')) > 0 THEN 1 ELSE 0 END) as bulls,
                SUM(CASE WHEN COALESCE(json_extract(payload_json, '$.signal.d'), json_extract(payload_json, '$.signal.di')) < 0 THEN 1 ELSE 0 END) as bears
            FROM pulse_events
            WHERE timestamp > ? AND timestamp <= ?
        `).get(cutoff, anchorStr);

        const rejections = [
            { name: "Bearish (Trend)", value: (sentimentRows ? sentimentRows.bears : 0) || 0 },
            { name: "Bullish (Mom)", value: (sentimentRows ? sentimentRows.bulls : 0) || 0 }
        ];

        // D. Mood Score (From Latest Scan Metadata in Window)
        // JOIN scan_results with scans to get timestamp
        const latestScan = db.prepare(`
            SELECT s.timestamp, json_extract(sr.raw_data, '$.market_sentiment.moodScore') as mood
            FROM scan_results sr
            JOIN scans s ON sr.scan_id = s.id
            WHERE s.timestamp <= ?
            ORDER BY s.timestamp DESC 
            LIMIT 1
        `).get(anchorStr);

        const moodScore = latestScan ? (latestScan.mood || 50) : 50;

        // E. Latency (Gap between last scan in window and server time OR anchor time)
        let latency = 0;
        if (latestScan && latestScan.timestamp) {
            latency = new Date(anchorStr).getTime() - new Date(latestScan.timestamp).getTime();
        }

        res.json({
            velocity,
            persistence: persistenceRows,
            rejections,
            moodScore,
            latency
        });
    } catch (e) {
        console.error("Research Analytics Error:", e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 V3 Server running on port ${PORT}`);
});


