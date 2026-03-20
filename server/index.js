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

        // [AUDIT]: Preserve Raw Browser Sentiment (Before Overwrite)
        if (payload.market_sentiment) {
            db.prepare(`
                INSERT INTO raw_market_sentiment_log 
                (scan_id, timestamp, raw_mood_score, raw_label, raw_bullish, raw_bearish)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                scanId,
                timestamp,
                payload.market_sentiment.moodScore || 0,
                payload.market_sentiment.mood || 'UNKNOWN',
                payload.market_sentiment.bullish || 0,
                payload.market_sentiment.bearish || 0
            );
        }

        // [INSTITUTIONAL GRADE]: Ingress Sanitization
        // We do NOT trust the Scanner's pre-calculated scores.
        // We re-derive everything here so the Database contains the "Genie Truth".
        if (payload.results && Array.isArray(payload.results)) {
            let bulls = 0, bears = 0, neutral = 0;

            payload.results.forEach(item => {
                const d = item.data || item;

                // 1. Force Recalculate Score
                const genieScore = calculateGenieScore(d);

                // 2. Overwrite Payload
                if (item.data) item.data.score = genieScore;
                item.score = genieScore;

                // 3. Track Breadth for Mood
                const code = d.positionCode || 0;
                if (code >= 300) bulls++;
                else if (code >= 100 && code < 200) bears++;
                else neutral++;
            });

            // 4. Force Recalculate Market Sentiment (Net Flow)
            const total = payload.results.length;
            const flowScore = total > 0 ? ((bulls - bears) / total) * 100 : 0;
            const moodScore = Math.round(flowScore);

            let label = 'NEUTRAL';
            if (moodScore >= 20) label = 'BULLISH';
            if (moodScore >= 60) label = 'EUPHORIC';
            if (moodScore <= -20) label = 'BEARISH';
            if (moodScore <= -60) label = 'PANIC';

            payload.market_sentiment = {
                mood: label,
                moodScore: moodScore,
                bullish: bulls,
                bearish: bears,
                neutral: neutral
            };

            console.log(`[INGRESS] Sanitized Scan: ${moodScore}% (${label}) | Overwrote Scores`);
        }

        // B. Insert Scan Results (Sanitized JSON Blob)
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

// Initialize Area 1 Scout Logs
// Stores momentum coins vetted by Stream B independently from Stream A logs
db.prepare(`
    CREATE TABLE IF NOT EXISTS area1_scout_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        ticker TEXT NOT NULL,
        exchange TEXT DEFAULT 'BINANCE',
        price REAL,
        type TEXT,
        vol_change REAL,
        raw_data TEXT
    )
`).run();

// Initialize Market Context Logs
// Stores passive telemetry like Watchlist breadth and Screener counts from Stream B
db.prepare(`
    CREATE TABLE IF NOT EXISTS market_context_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        screener_total_count INTEGER,
        watchlist_count INTEGER,
        payload_json TEXT
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

    // [GENIE SYNC]: Payload is already Sanitized at Ingress (app.post)
    // We can trust payload.market_sentiment now.
    const geniemood = payload.market_sentiment || { mood: 'NEUTRAL', moodScore: 0 };

    // Sync to Telegram Service
    TelegramService.syncStrategies(
        strategies,
        geniemood,
        { marketCheck: { mood: geniemood.mood, score: geniemood.moodScore } }
    );
}

// 3. QUALIFIED PICK (Stream B - Micro / Test Log)
// Writes to 'area1_scout_logs' for testing and shortlisting without colliding Stream A
app.post('/qualified-pick', (req, res) => {
    const { ticker, price, type, move, direction, total_market_count, market_snapshot } = req.body;
    const exchange = req.body.exchange || 'BINANCE';
    const volChange = req.body.volChange || 0;
    console.log(`[PICKER] 🎯 V3 Pick (Log): ${exchange}:${ticker} (${type})`);

    try {
        const now = new Date().toISOString();

        // 1. SAVE TO NEW LOG TABLE (Don't impact main active_ledger)
        db.prepare(`
            INSERT INTO area1_scout_logs (ticker, exchange, price, type, timestamp, vol_change, raw_data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(ticker, exchange, price, type, now, volChange, JSON.stringify(req.body));

        // Let the UI know a pick came in
        io.emit('ledger-update', { ticker, price, signal: type });

        // 2. GENERATE FEEDBACK LOOP FOR COIN SCANNER (Stateful & Cumulative)
        let activeList = [];
        let pruneList = [];
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        // A. Get Historical Stable Picks (Last 60 Minutes)
        const historicalPicks = db.prepare(`
            SELECT DISTINCT exchange, ticker 
            FROM area1_scout_logs 
            WHERE type = 'STABLE' AND timestamp > ?
        `).all(oneHourAgo);
        const historicalTargetSet = new Set(historicalPicks.map(p => `${p.exchange}:${p.ticker}`));

        // B. Cross-reference with Stream A (Macro Scans)
        const latestScan = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
        if (latestScan) {
            const scanData = JSON.parse(latestScan.raw_data);
            if (scanData.results && scanData.results.length > 0) {
                scanData.results.forEach(item => {
                    const d = item.data || item;
                    const cleanTicker = item.ticker;
                    const fullTicker = item.datakey || `BINANCE:${cleanTicker}`;

                    activeList.push(fullTicker);

                    if (d.score <= 30 || d.freeze === 1) {
                        pruneList.push(fullTicker);
                    }
                });
            }
        }

        // C. Construct Cumulative Graduate List
        const currentFullTicker = `${exchange}:${ticker}`;
        historicalTargetSet.add(currentFullTicker);
        const newGraduates = Array.from(historicalTargetSet).filter(t => !activeList.includes(t));

        res.json({
            message: "Saved to Log",
            ai_suggestion: "TRACKING",
            active_list: activeList,
            prune_list: [...new Set(pruneList)],
            new_graduates: newGraduates,
            master_targets: [...new Set([...activeList, ...newGraduates])]
        });

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

// 9. MARKET CONTEXT TELEMETRY (Phase 3)
// Passive telemetry from frontend scraper (Watchlist breadth, total screener counts)
app.post('/api/market-context', (req, res) => {
    try {
        const payload = req.body;
        const now = new Date().toISOString();

        db.prepare(`
            INSERT INTO market_context_logs (timestamp, screener_total_count, watchlist_count, payload_json)
            VALUES (?, ?, ?, ?)
        `).run(
            now,
            payload.screener_total_count || 0,
            payload.watchlist_count || 0,
            JSON.stringify(payload)
        );

        // --- STATEFUL SYNC FEEDBACK LOOP (Resilience) ---
        let activeList = [];
        let pruneList = [];
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

        // 1. Get Graduates from last 60m
        const historicalPicks = db.prepare(`
            SELECT DISTINCT exchange, ticker 
            FROM area1_scout_logs 
            WHERE type = 'STABLE' AND timestamp > ?
        `).all(oneHourAgo);
        const historicalTargetSet = new Set(historicalPicks.map(p => `${p.exchange}:${p.ticker}`));

        // 2. Get Macro Watchlist
        const latestScan = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
        if (latestScan) {
            const scanData = JSON.parse(latestScan.raw_data);
            if (scanData.results) {
                scanData.results.forEach(item => {
                    const d = item.data || item;
                    const fullTicker = item.datakey || `BINANCE:${item.ticker}`;
                    activeList.push(fullTicker);
                    if (d.score <= 30 || d.freeze === 1) pruneList.push(fullTicker);
                });
            }
        }

        const newGraduates = Array.from(historicalTargetSet).filter(t => !activeList.includes(t));

        // Optionally emit to frontend for live dashboard updates
        io.emit('market-context-update', payload);

        console.log(`[TELEMETRY] 📡 Received Context @ ${now} | Screener: ${payload.screener_total_count} | Watchlist: ${payload.watchlist_count}`);

        res.json({ 
            success: true, 
            message: "Market context telemetry saved.",
            active_list: activeList,
            prune_list: [...new Set(pruneList)],
            new_graduates: newGraduates,
            master_targets: [...new Set([...activeList, ...newGraduates])]
        });

    } catch (e) {
        console.error("Market Context Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// GET: Latest Market Context for Dashboard Widgets
app.get('/api/market-context/latest', (req, res) => {
    try {
        const row = db.prepare(`
            SELECT timestamp, screener_total_count, watchlist_count, payload_json 
            FROM market_context_logs 
            ORDER BY rowid DESC 
            LIMIT 1
        `).get();

        if (!row) {
            return res.json({ status: "No data available", timestamp: null });
        }

        const data = JSON.parse(row.payload_json);
        // Inject the exact server timestamp back into the response for time-sync displays
        data.server_timestamp = row.timestamp;

        res.json(data);
    } catch (e) {
        console.error("Error fetching market context:", e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// STREAM C - SMART LEVELS WEBHOOK
// ============================================================================
app.post('/api/webhook/smart-levels', (req, res) => {
    try {
        const payload = req.body;
        
        if (!payload || !payload.ticker) {
            return res.status(400).json({ error: "Invalid payload missing ticker" });
        }
        
        const ticker = payload.ticker;
        const price = parseFloat(payload.price || 0);
        
        // Convert timestamp (e.g. 1773840300000) to ISO 8601 UTC
        let parsedTimestamp = new Date().toISOString();
        if (payload.timestamp) {
            const timestampNum = parseInt(payload.timestamp, 10);
            if (!isNaN(timestampNum)) {
                parsedTimestamp = new Date(timestampNum).toISOString();
            }
        }
        
        const direction = payload.momentum?.direction !== undefined ? parseInt(payload.momentum.direction, 10) : 0;
        const roc_pct = payload.momentum?.roc_pct !== undefined ? parseFloat(payload.momentum.roc_pct) : 0.0;
        
        db.prepare(`
            INSERT INTO smart_level_events (ticker, timestamp, price, direction, roc_pct, raw_data)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            ticker,
            parsedTimestamp,
            price,
            direction,
            roc_pct,
            JSON.stringify(payload)
        );
        
        console.log(`[STREAM-C] 🧠 Smart Levels Webhook Received: ${ticker} | Dir: ${direction} | ROC: ${roc_pct}%`);
        
        // Emit for dashboard reactivity (Optional future use)
        io.emit('smart-level-update', { ticker, direction, timestamp: parsedTimestamp });
        
        res.json({ success: true, ticker });
    } catch (e) {
        console.error("Stream C Webhook Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// STREAM HUB: FUSION DASHBOARD ENDPOINT (A + B + C Consolidation)
// ============================================================================
app.get('/api/fusion/dashboard', (req, res) => {
    try {
        // 1. Get the latest Stream C events per ticker
        const streamC_Rows = db.prepare(`
            SELECT ticker, timestamp as alert_time, price, direction, roc_pct, raw_data 
            FROM smart_level_events 
            WHERE id IN (
                SELECT MAX(id) FROM smart_level_events GROUP BY ticker
            )
            ORDER BY timestamp DESC
        `).all();

        // 2. Get latest Stream A snapshot (Macro)
        const latestMacroRow = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
        const macroTickers = new Set();
        const macroDataMap = {}; // store ticker -> volume/changes
        if (latestMacroRow && latestMacroRow.raw_data) {
            const parsedMacro = JSON.parse(latestMacroRow.raw_data);
            if (parsedMacro.results) {
                parsedMacro.results.forEach(r => {
                    const d = r.data || r;
                    macroTickers.add(r.ticker);
                    macroDataMap[r.ticker] = d;
                });
            }
        }

        // 3. Get recent Stream B activity (Last 60 mins)
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const streamB_Rows = db.prepare(`
            SELECT ticker, MAX(vol_change) as maxVolChange 
            FROM area1_scout_logs 
            WHERE timestamp > ?
            GROUP BY ticker
        `).all(oneHourAgo);
        const scoutTickers = new Set(streamB_Rows.map(r => r.ticker));
        const scoutDataMap = {};
        streamB_Rows.forEach(r => scoutDataMap[r.ticker] = r.maxVolChange);

        // 3.5 Get Burst History (Last 24 Hours of Stream C alerts for these tickers)
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const burstRows = db.prepare(`
            SELECT ticker, timestamp, direction, roc_pct 
            FROM smart_level_events 
            WHERE timestamp > ?
            ORDER BY timestamp DESC
        `).all(twentyFourHoursAgo);
        
        const burstHistoryMap = {};
        burstRows.forEach(r => {
            if (!burstHistoryMap[r.ticker]) {
                burstHistoryMap[r.ticker] = [];
            }
            burstHistoryMap[r.ticker].push({
                timestamp: r.timestamp,
                direction: r.direction,
                roc_pct: r.roc_pct
            });
        });

        // 4. Consolidate and Compute Distances
        const dashboardData = streamC_Rows.map(row => {
            const raw = JSON.parse(row.raw_data);
            const currentPrice = row.price;
            
            // Calculate Day Change directly from Stream C payload
            let dayChangePct = null;
            if (raw.today_change_pct !== undefined) {
                dayChangePct = parseFloat(raw.today_change_pct);
            } else if (raw.momentum && raw.momentum.day_change_pct !== undefined) {
                dayChangePct = parseFloat(raw.momentum.day_change_pct);
            } else if (raw.smart_levels?.htf_daily?.open?.p) {
                const dayOpen = parseFloat(raw.smart_levels.htf_daily.open.p);
                if (dayOpen > 0) {
                    dayChangePct = ((currentPrice - dayOpen) / dayOpen) * 100;
                }
            }

            // Extract all price levels from smart_levels object
            const levels = [];
            const sl = raw.smart_levels || {};
            
            // Helper to extract nested 'p' (price) and 's' (stars) and attach a name
            const extractLevel = (obj, name) => {
                if (obj && obj.p) {
                    levels.push({ name, price: parseFloat(obj.p), stars: obj.s || 0 });
                }
            };

            extractLevel(sl.mega_spot, 'Mega Spot');
            if (sl.emas_200) {
                extractLevel(sl.emas_200.m5, '5m_200_EMA');
                extractLevel(sl.emas_200.m15, '15m_200_EMA');
                extractLevel(sl.emas_200.h1, '1H_200_EMA');
                extractLevel(sl.emas_200.h4, '4H_200_EMA');
            }
            if (sl.daily_logic) {
                extractLevel(sl.daily_logic.base_supp, 'D_Base_Supp');
                extractLevel(sl.daily_logic.base_res, 'D_Base_Res');
                extractLevel(sl.daily_logic.neck_supp, 'D_Neck_Supp');
                extractLevel(sl.daily_logic.neck_res, 'D_Neck_Res');
            }
            if (sl.hourly_logic) {
                extractLevel(sl.hourly_logic.base_supp, '1H_Base_Supp');
                extractLevel(sl.hourly_logic.base_res, '1H_Base_Res');
                extractLevel(sl.hourly_logic.neck_supp, '1H_Neck_Supp');
                extractLevel(sl.hourly_logic.neck_res, '1H_Neck_Res');
            }
            if (sl.h4_logic) {
                extractLevel(sl.h4_logic.neck_supp, '4H_Neck_Supp');
                extractLevel(sl.h4_logic.neck_res, '4H_Neck_Res');
            }
            if (sl.fibs_618) {
                extractLevel(sl.fibs_618.h1, '1H_Fib618');
                extractLevel(sl.fibs_618.d1, 'D_Fib618');
                extractLevel(sl.fibs_618.w1, 'W_Fib618');
            }
            if (sl.htf_weekly) {
                extractLevel(sl.htf_weekly.open, 'W_Open');
                extractLevel(sl.htf_weekly.high, 'W_High');
                extractLevel(sl.htf_weekly.low, 'W_Low');
                extractLevel(sl.htf_weekly.close, 'W_Close');
            }
            if (sl.htf_monthly) {
                extractLevel(sl.htf_monthly.open, 'M_Open');
                extractLevel(sl.htf_monthly.high, 'M_High');
                extractLevel(sl.htf_monthly.low, 'M_Low');
                extractLevel(sl.htf_monthly.close, 'M_Close');
            }

            // Find NEXT UP (Resistance)
            const resistances = levels.filter(l => l.price > currentPrice).sort((a, b) => a.price - b.price);
            const nextUp = resistances.length > 0 ? resistances[0] : null;
            let nextUpParam = null;
            if (nextUp) {
                nextUpParam = {
                    name: nextUp.name,
                    price: nextUp.price,
                    dist_pct: ((nextUp.price - currentPrice) / currentPrice) * 100
                };
            }

            // Find NEXT DOWN (Support)
            const supports = levels.filter(l => l.price < currentPrice).sort((a, b) => b.price - a.price);
            const nextDown = supports.length > 0 ? supports[0] : null;
            let nextDownParam = null;
            if (nextDown) {
                nextDownParam = {
                    name: nextDown.name,
                    price: nextDown.price,
                    dist_pct: ((nextDown.price - currentPrice) / currentPrice) * 100
                };
            }

            // A/B/C Signal Lights
            const inStreamA = macroTickers.has(row.ticker);
            const inStreamB = scoutTickers.has(row.ticker);
            const inStreamC = true; // inherently true since we query from Stream C

            // Extract Volume strictly from Stream C payload
            let reportedVol = '--';
            if (raw.today_volume !== undefined) {
                reportedVol = raw.today_volume;
            } else if (raw.volume && raw.volume.day_vol !== undefined && raw.volume.day_vol !== null) {
                reportedVol = raw.volume.day_vol;
            }

            return {
                ticker: row.ticker,
                timestamp: row.alert_time,
                price: currentPrice,
                dayChangePct: dayChangePct,
                momentum: {
                    direction: row.direction,
                    roc_pct: row.roc_pct
                },
                signals: {
                    A: inStreamA,
                    B: inStreamB,
                    C: inStreamC
                },
                volume_proxy: reportedVol,
                nextUp: nextUpParam,
                nextDown: nextDownParam,
                // Pass raw array of levels so frontend can draw the complete "Speed Breaker Ruler"
                allLevels: levels,
                // Burst History
                bursts: burstHistoryMap[row.ticker] || [],
                burstCount: (burstHistoryMap[row.ticker] || []).length
            };
        });

        res.json({
            success: true,
            count: dashboardData.length,
            records: dashboardData
        });

    } catch(e) {
        console.error("Fusion Dashboard Error:", e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`🚀 V3 Server running on port ${PORT}`);
});

/**
 * Server-Side Mirror of GenieSmart.calculateScore
 * Ensures Telegram alerts match the Client Dashboard.
 */
function calculateGenieScore(d) {
    const POSITION_CODE_SCORES = {
        530: 35, 502: 35, 430: 32, 403: 32, 521: 30,
        500: 28, 104: 28, 340: 28, 231: 25, 221: 20,
        212: 15, 222: 10, 421: 18, 412: 18
    };

    let score = 0;

    // 1. Base Score
    score += POSITION_CODE_SCORES[d.positionCode] || 0;

    // 2. Mega Zone
    if (d.megaSpotDist !== null && Math.abs(d.megaSpotDist) <= 0.5) {
        score += 20;
    }

    // 3. Trend Alignment
    const isBullishTrend = (d.netTrend || 0) >= 60;
    const isDailyBull = (d.dailyTrend || 0) === 1;

    if ((d.resistDist || 0) >= 2.0 && isBullishTrend) {
        score += 20;
        if (isDailyBull) score += 5;
    }

    // 4. Confluence
    if ((d.supportStars || d.resistStars || 0) >= 4) {
        score += 12;
    }

    // 5. Momentum & Volume
    if ((d.momScore || 0) >= 2) {
        score += d.momScore === 3 ? 7 : 5;
    }
    if (d.volSpike === 1) {
        score += 3;
    }

    // 6. Breakout
    if (d.breakout === 1) {
        score += 10;
    }

    return score;
}


