const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const db = require('./database'); // V3 Database Module

// --- SERVICES ---
// Telegram service kept for notifications (optional integration later)
const TelegramService = require('./services/telegram');
const RSIEngine = require('./services/RSIEngine');

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

// 1.5 TRI-STREAM HEALTH MONITORING
app.get('/api/system/health', (req, res) => {
    try {
        const streamA = db.prepare(`SELECT timestamp FROM scans ORDER BY timestamp DESC LIMIT 1`).get();
        const streamB = db.prepare(`SELECT timestamp FROM market_context_logs ORDER BY timestamp DESC LIMIT 1`).get();
        const streamC = db.prepare(`SELECT timestamp FROM unified_alerts ORDER BY timestamp DESC LIMIT 1`).get();

        res.json({
            success: true,
            streamA: streamA ? streamA.timestamp : null,
            streamB: streamB ? streamB.timestamp : null,
            streamC: streamC ? streamC.timestamp : null
        });
    } catch (e) {
        console.error("Health Endpoint Error:", e);
        res.status(500).json({ error: e.message });
    }
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
        db.prepare('INSERT OR IGNORE INTO scans (id, timestamp, trigger) VALUES (?, ?, ?)')
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
        // [DEPRECATED - Phase 10]: HTML sidebar scraping is gone. Alerts are now handled exclusively
        // via Stream C webhooks and merged in the 'unified_alerts' VIEW.
        // We no longer insert into pulse_events here.

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

/**
 * 🦅 Phase 39: Intelligent Watchlist & Prune Engine (The "5+2" Rule)
 */
function generateScannerFeedback(clientWatchlistCount = -1) {
    let activeList = [];
    let pruneList = [];
    let newGraduates = [];

    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const eightHoursAgo = new Date(now - 8 * 60 * 60 * 1000).toISOString();

    // --- 1. THE 8-HOUR STABILITY GUARD ---
    const stabilityCheck = db.prepare(`
        SELECT COUNT(*) as count, MIN(timestamp) as oldest 
        FROM scans 
        WHERE timestamp > ?
    `).get(eightHoursAgo);
    const isStable = stabilityCheck && stabilityCheck.count > 100;

    // --- 2. ZERO-STATE REHYDRATION ---
    if (clientWatchlistCount === 0) {
        console.warn(`[WATCHLIST-ENGINE] 🚨 Catastrophic 0-Count Detected. Initiating Rehydration...`);
        const lastGoodLog = db.prepare(`
            SELECT payload_json 
            FROM market_context_logs 
            WHERE watchlist_count > 0 
            ORDER BY timestamp DESC LIMIT 1
        `).get();

        if (lastGoodLog) {
            try {
                const payload = JSON.parse(lastGoodLog.payload_json);
                if (payload.watchlist_active_snapshot && Array.isArray(payload.watchlist_active_snapshot)) {
                    const recoveredTargets = payload.watchlist_active_snapshot.map(w => w.full).filter(Boolean);
                    console.log(`[WATCHLIST-ENGINE] 💧 Rehydrated ${recoveredTargets.length} coins from history.`);
                    return {
                        ai_suggestion: "REHYDRATION",
                        active_list: recoveredTargets,
                        prune_list: [],
                        new_graduates: [],
                        master_targets: recoveredTargets
                    };
                }
            } catch (e) {
                console.error("[WATCHLIST-ENGINE] Rehydration parsing failed", e);
            }
        }
    }

    // --- 3. GET HISTORICAL PICKS (Last 2 Hours) ---
    // [PHASE 43] Extended to 2 hours to rigidly bridge Automa cooldown UI gaps.
    const historicalPicks = db.prepare(`
        SELECT DISTINCT exchange, ticker 
        FROM area1_scout_logs 
        WHERE type IN ('STABLE', 'ORPHANED_STABLE_RETRY') AND timestamp > ?
    `).all(twoHoursAgo);
    const historicalTargetSet = new Set(historicalPicks.map(p => `${p.exchange}:${p.ticker}`));

    // --- 4. RELATIVE VOLUME CALCULATION ---
    const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const activeVolumes = db.prepare(`
        SELECT ticker, raw_data
        FROM unified_alerts
        WHERE timestamp > ?
        GROUP BY ticker
        HAVING MAX(timestamp)
    `).all(cutoff24h);

    const volumeMap = {};
    let totalVol = 0;
    let volCount = 0;

    activeVolumes.forEach(row => {
        try {
            const raw = JSON.parse(row.raw_data);
            let v = null;
            if (raw.today_volume !== undefined) v = parseFloat(raw.today_volume);
            else if (raw.volume && raw.volume.day_vol !== undefined && raw.volume.day_vol !== null) v = parseFloat(raw.volume.day_vol);

            if (v && !isNaN(v)) {
                volumeMap[row.ticker] = v;
                totalVol += v;
                volCount++;
            }
        } catch (e) { }
    });

    const avgVolume = volCount > 0 ? (totalVol / volCount) : 0;
    const ghostThreshold = avgVolume * 0.15; // Ghost = trades < 15% of cohort average

    // --- 4.5 HISTORICAL SUSTAINABILITY CHECK (The 4-Hour Guard) ---
    // Fetch last 240 active scans (approx 4 hours of strict runtime data)
    const historicalScans = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 240').all();
    const historicalMaxScore = {};
    
    // [PHASE 43] Offline Gap Flush: If the system was offline, do NOT use stale history 
    // (> 12 hours old) to pardon current ghost coins.
    const staleGapMs = Date.now() - 12 * 60 * 60 * 1000;

    historicalScans.forEach(row => {
        try {
            const scanData = JSON.parse(row.raw_data);
            const scanMs = scanData.timestamp ? new Date(scanData.timestamp).getTime() : Date.now();
            
            if (scanMs > staleGapMs) {
                if (scanData.results) {
                    scanData.results.forEach(item => {
                        const d = item.data || item;
                        const cleanTicker = item.ticker;
                        const score = d.score || 0;
                        if (historicalMaxScore[cleanTicker] === undefined || score > historicalMaxScore[cleanTicker]) {
                            historicalMaxScore[cleanTicker] = score;
                        }
                    });
                }
            }
        } catch(e) {}
    });

    // --- 5. EXTRACT MACRO SCAN ---
    const latestScan = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    let scanResults = [];
    if (latestScan) {
        const scanData = JSON.parse(latestScan.raw_data);
        if (scanData.results) scanResults = scanData.results;
    }

    // Rank by Genie Score DESC
    scanResults.sort((a, b) => {
        const scoreA = (a.data || a).score || 0;
        const scoreB = (b.data || b).score || 0;
        return scoreB - scoreA;
    });

    const PERMANENT_MAJORS = ['BINANCE:BTCUSDT.P', 'BINANCE:ETHUSDT.P'];
    const protectedAltcoins = new Set();
    
    // [PHASE 42] The 8-Hour Graduate Grace Period (Includes Orphan Retries)
    const gracePeriodPicks = db.prepare(`
        SELECT DISTINCT exchange, ticker 
        FROM area1_scout_logs 
        WHERE type IN ('STABLE', 'ORPHANED_STABLE_RETRY') AND timestamp > ?
    `).all(eightHoursAgo);
    
    gracePeriodPicks.forEach(p => {
        protectedAltcoins.add(`${p.exchange}:${p.ticker}`);
    });

    // Identify Top 5 Altcoins to protect
    let altCount = 0;
    for (const r of scanResults) {
        const fullTicker = r.datakey || `BINANCE:${r.ticker}`;
        if (!PERMANENT_MAJORS.includes(fullTicker)) {
            protectedAltcoins.add(fullTicker);
            altCount++;
        }
        if (altCount >= 5) break;
    }

    const ghostList = [];

    // Process Candidates
    scanResults.forEach(item => {
        const d = item.data || item;
        const cleanTicker = item.ticker;
        const fullTicker = item.datakey || `BINANCE:${cleanTicker}`;

        activeList.push(fullTicker);

        const isProtected = PERMANENT_MAJORS.includes(fullTicker) || protectedAltcoins.has(fullTicker);

        let shouldPrune = false;
        let pruneReason = "";
        if (!isProtected) {
            const maxHistoricalScore = historicalMaxScore[cleanTicker];

            // Core logic
            if (d.freeze === 1) {
                shouldPrune = true;
                pruneReason = "Frozen";
            } else if (d.score <= 30) {
                if (maxHistoricalScore !== undefined && maxHistoricalScore > 30) {
                    // PARDON: Coin had a good score within the last 4 active hours.
                    // It is just experiencing a temporary dip; do not execute prune.
                } else {
                    shouldPrune = true;
                    pruneReason = "Sustained Low Score (<4h)";
                }
            }

            // Intelligent Volume Pruning
            if (isStable && !shouldPrune) {
                const coinVol = volumeMap[cleanTicker];
                if (coinVol !== undefined && coinVol < ghostThreshold) {
                    shouldPrune = true;
                    pruneReason = "Ghost Volume";
                }
            }
        }

        if (shouldPrune) {
            pruneList.push(fullTicker);
            ghostList.push({ ticker: cleanTicker, reason: pruneReason });
        }
    });

    newGraduates = Array.from(historicalTargetSet).filter(t => !activeList.includes(t));
    const finalSet = new Set([...activeList, ...newGraduates, ...PERMANENT_MAJORS]);

    // Exclude prunes
    pruneList.forEach(p => finalSet.delete(p));
    // Super-protect
    PERMANENT_MAJORS.forEach(p => finalSet.add(p));
    protectedAltcoins.forEach(p => finalSet.add(p));

    return {
        ai_suggestion: "TRACKING_5+2",
        active_list: activeList,
        prune_list: [...new Set(pruneList)],
        ghost_list: ghostList,
        new_graduates: newGraduates,
        master_targets: Array.from(finalSet)
    };
}


// 3. QUALIFIED PICK (Stream B - Micro / Test Log)
// Writes to 'area1_scout_logs' for testing and shortlisting without colliding Stream A
app.post('/qualified-pick', (req, res) => {
    const { ticker, price, type, move, direction, total_market_count, market_snapshot, reason } = req.body;
    const exchange = req.body.exchange || 'BINANCE';
    const volChange = req.body.volChange || 0;
    
    // [PHASE 41] Closed-Loop Verification Intercept
    let saveType = type;
    if (type === 'ORPHANED_STABLE') {
        if (reason === 'AUTOMA_SYNC_FAILED') {
            console.warn(`[WATCHLIST-ENGINE] 🔄 Explicit Retry Ordered for ${exchange}:${ticker} (Automa Failed)`);
            saveType = 'ORPHANED_STABLE_RETRY';
        } else if (reason === 'BACKEND_REJECTED') {
            console.log(`[WATCHLIST-ENGINE] 👁️ Anomaly Logged: Front-end detected backend rejection for ${exchange}:${ticker}`);
            // Save as normal ORPHANED_STABLE for auditing, no explicit retry ordered.
        }
    } else {
        console.log(`[PICKER] 🎯 V3 Pick (Log): ${exchange}:${ticker} (${type})`);
    }

    try {
        const now = new Date().toISOString();

        // 1. SAVE TO NEW LOG TABLE (Don't impact main active_ledger)
        db.prepare(`
            INSERT INTO area1_scout_logs (ticker, exchange, price, type, timestamp, vol_change, raw_data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(ticker, exchange, price, saveType, now, volChange, JSON.stringify(req.body));

        // Let the UI know a pick came in
        io.emit('ledger-update', { ticker, price, signal: type });

        // 2. GENERATE FEEDBACK LOOP FOR COIN SCANNER (Stateful & Cumulative)
        // [PHASE 39]: 5+2 Engine
        const feedback = generateScannerFeedback(total_market_count);

        res.json({
            message: "Saved to Log",
            success: true,
            status: 'success',
            ai_suggestion: feedback.ai_suggestion,
            active_list: feedback.active_list,
            prune_list: feedback.prune_list,
            ghost_list: feedback.ghost_list,
            new_graduates: feedback.new_graduates,
            master_targets: feedback.master_targets
        });

    } catch (e) {
        console.error("Pick Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 3B. MARKET CONTEXT TELEMETRY (Stream B)
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

        // Generate Stateful Feedback for Coin Scanner
        const feedback = generateScannerFeedback(payload.watchlist_count);

        io.emit('market-context-update', { timestamp: now, counts: { screener: payload.screener_total_count, watchlist: payload.watchlist_count } });

        res.json({
            success: true,
            message: "Market Context Telemetry Saved",
            master_targets: feedback.master_targets,
            prune_list: feedback.prune_list,
            new_graduates: feedback.new_graduates
        });
    } catch (e) {
        console.error("Market Context Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// 3C. PARTICIPATION PULSE (Analytics for Scout Screener)
app.get('/api/analytics/participation-pulse', (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        // Query the market context logs
        const rows = db.prepare(`
            SELECT timestamp, payload_json
            FROM market_context_logs
            WHERE timestamp > ?
            ORDER BY timestamp ASC
        `).all(cutoff);

        // Helper: Convert TV string rating to numeric score
        const getRatingScore = (val) => {
            if (typeof val !== 'string') return 0;
            const text = val.toLowerCase();
            if (text.includes('strong buy')) return 2;
            if (text.includes('buy')) return 1;
            if (text.includes('strong sell')) return -2;
            if (text.includes('sell')) return -1;
            return 0; // Neutral or uncategorized
        };

        const timeline = rows.map(row => {
            const payload = JSON.parse(row.payload_json);
            const activeSnaps = payload.screener_visible_snapshot || [];
            const watchlistSnaps = payload.watchlist_active_snapshot || [];
            
            // Track actively watched coins
            const watchlistTickers = new Set(watchlistSnaps.map(w => w.full));

            let bull_score = 0;
            let bear_score = 0;
            let net_screener_count = 0;

            activeSnaps.forEach(item => {
                // Rule: If it's already in the watchlist, do not count it as "New" momentum in the Screener
                if (item.full && watchlistTickers.has(item.full)) {
                    return;
                }

                net_screener_count++;
                let coinTotal = 0;
                
                // The user's widget screenshot shows: Symbol, Tech Rating, MA Rating, Os Rating.
                // Because TradingView DOM attributes can vary, we will scan *all* string values in the JSON object
                // belonging to this coin. If a string is a standard TV rating, we score it.
                Object.values(item).forEach(val => {
                    const score = getRatingScore(val);
                    coinTotal += score;
                });

                if (coinTotal > 0) bull_score += coinTotal;
                else if (coinTotal < 0) bear_score += Math.abs(coinTotal);
            });

            return {
                time: row.timestamp,
                screener_count: net_screener_count,
                watchlist_count: payload.watchlist_count || watchlistSnaps.length || 0,
                bull_score: bull_score,
                bear_score: bear_score,
                net_score: bull_score - bear_score
            };
        });

        res.json({ timeline });
    } catch (e) {
        console.error("Participation Pulse Error:", e);
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

        // --- ENRICHMENT: Inject Active Smart Levels ---
        const scanTime = payload.timestamp ? new Date(payload.timestamp) : new Date();
        const cutoff = new Date(scanTime.getTime() - (24 * 60 * 60 * 1000)).toISOString();

        // 1. Get the latest webhook alert for each ticker in the last 24h
        const activeSmartLevels = db.prepare(`
            SELECT ticker, raw_data, timestamp
            FROM smart_level_events
            WHERE timestamp > ? AND timestamp <= ?
            GROUP BY ticker
            HAVING MAX(timestamp)
        `).all(cutoff, scanTime.toISOString());

        const levelMap = {};

        // Helper to extract levels from the complex JSON
        const extractLevels = (slObj) => {
            const list = [];
            if (!slObj) return list;

            // Daily Logic
            if (slObj.daily_logic) {
                if (slObj.daily_logic.base_supp?.p) list.push({ type: 'Daily Support', price: parseFloat(slObj.daily_logic.base_supp.p) });
                if (slObj.daily_logic.base_res?.p) list.push({ type: 'Daily Resistance', price: parseFloat(slObj.daily_logic.base_res.p) });
                if (slObj.daily_logic.neck_supp?.p) list.push({ type: 'Daily Neck Support', price: parseFloat(slObj.daily_logic.neck_supp.p) });
                if (slObj.daily_logic.neck_res?.p) list.push({ type: 'Daily Neck Resistance', price: parseFloat(slObj.daily_logic.neck_res.p) });
            }
            // Hourly Logic
            if (slObj.hourly_logic) {
                if (slObj.hourly_logic.base_supp?.p) list.push({ type: 'Hourly Support', price: parseFloat(slObj.hourly_logic.base_supp.p) });
                if (slObj.hourly_logic.base_res?.p) list.push({ type: 'Hourly Resistance', price: parseFloat(slObj.hourly_logic.base_res.p) });
            }
            // Mega Spot
            if (slObj.mega_spot?.p) list.push({ type: 'Mega Spot Support', price: parseFloat(slObj.mega_spot.p) });

            return list;
        };

        activeSmartLevels.forEach(row => {
            try {
                const raw = JSON.parse(row.raw_data);
                if (raw.smart_levels) {
                    levelMap[row.ticker] = extractLevels(raw.smart_levels);
                }
            } catch (e) { }
        });

        // 2. Extract Volume Data from unified Webhooks
        const activeVolumes = db.prepare(`
            SELECT ticker, raw_data
            FROM unified_alerts
            WHERE timestamp > ? AND timestamp <= ?
            GROUP BY ticker
            HAVING MAX(timestamp)
        `).all(cutoff, scanTime.toISOString());

        const volumeMap = {};
        activeVolumes.forEach(row => {
            try {
                const raw = JSON.parse(row.raw_data);
                if (raw.today_volume !== undefined) {
                    volumeMap[row.ticker] = raw.today_volume;
                } else if (raw.volume && raw.volume.day_vol !== undefined && raw.volume.day_vol !== null) {
                    volumeMap[row.ticker] = raw.volume.day_vol;
                }
            } catch (e) { }
        });

        if (payload.results && Array.isArray(payload.results)) {
            payload.results.forEach(r => {
                const t = r.data ? r.data.ticker : r.ticker;
                if (levelMap[t]) {
                    if (r.data) r.data.smartLevels = levelMap[t];
                    else r.smartLevels = levelMap[t];
                }
                if (volumeMap[t]) {
                    if (r.data) r.data.volumeProxy = volumeMap[t];
                    else r.volumeProxy = volumeMap[t];
                }
            });
        }
        // --- END ENRICHMENT ---

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

        // Optimized for slider (Lightweight) and Sparklines
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
        // 1. Fetch all minute-buckets in the window chronologically
        const minuteBuckets = db.prepare(`
            SELECT 
                MAX(timestamp) as batch_time,
                MIN(timestamp) as min_time,
                count(*) as count,
                SUM(CASE WHEN origin = 'INSTITUTIONAL' THEN 1 ELSE 0 END) as inst_count,
                SUM(CASE WHEN origin = 'TECHNICAL' THEN 1 ELSE 0 END) as tech_count,
                AVG(direction) as avg_bias,
                AVG(strength) as avg_mom,
                AVG(strength) as avg_score,
                SUM(CASE WHEN direction > 0 THEN 1 ELSE 0 END) as bull_count,
                SUM(CASE WHEN direction < 0 THEN 1 ELSE 0 END) as bear_count,
                group_concat(DISTINCT ticker) as tickers
            FROM unified_alerts 
            WHERE timestamp > ? 
            GROUP BY (CASE 
                WHEN timestamp LIKE '%-%' THEN strftime('%Y-%m-%d %H:%M', timestamp)
                ELSE strftime('%Y-%m-%d %H:%M', datetime(CAST(timestamp AS INTEGER)/1000, 'unixepoch'))
            END)
            ORDER BY min_time ASC
        `).all(cutoff);

        // 2. Node.js Time-Clustering Algorithm (Throttle events <= 3 mins apart)
        const clusters = [];
        let currentCluster = null;

        minuteBuckets.forEach(bucket => {
            const bucketTime = new Date(bucket.batch_time).getTime();

            if (!currentCluster) {
                currentCluster = { ...bucket, tickers: new Set(bucket.tickers ? bucket.tickers.split(',') : []) };
            } else {
                const prevTime = new Date(currentCluster.batch_time).getTime();
                const diffMinutes = (bucketTime - prevTime) / 1000 / 60;

                if (diffMinutes <= 3) {
                    // Merge into current cluster
                    currentCluster.batch_time = bucket.batch_time; // shift end time
                    currentCluster.count += (bucket.count || 0);
                    currentCluster.inst_count += (bucket.inst_count || 0);
                    currentCluster.tech_count += (bucket.tech_count || 0);
                    currentCluster.bull_count += (bucket.bull_count || 0);
                    currentCluster.bear_count += (bucket.bear_count || 0);

                    // Simple rolling average for bias/mom
                    currentCluster.avg_bias = ((currentCluster.avg_bias || 0) + (bucket.avg_bias || 0)) / 2;
                    currentCluster.avg_mom = ((currentCluster.avg_mom || 0) + (bucket.avg_mom || 0)) / 2;

                    if (bucket.tickers) {
                        bucket.tickers.split(',').forEach(t => currentCluster.tickers.add(t));
                    }
                } else {
                    // Push finalized cluster and start new one
                    clusters.push(currentCluster);
                    currentCluster = { ...bucket, tickers: new Set(bucket.tickers ? bucket.tickers.split(',') : []) };
                }
            }
        });
        if (currentCluster) clusters.push(currentCluster);

        // Sort clusters DESC (newest first) and map for UI
        clusters.sort((a, b) => new Date(b.batch_time) - new Date(a.batch_time));

        const time_spread = clusters.map(r => {
            const count = r.count;
            const uniqueCoins = Array.from(r.tickers);
            const avgBias = r.avg_bias || 0;

            let biasLabel = 'NEUTRAL';
            if (avgBias >= 0.5) biasLabel = 'BULLISH';
            else if (avgBias <= -1.0) biasLabel = 'BEARISH';
            if (count > 5) { // Context boost
                if (avgBias > 0.2) biasLabel = 'STRONG BULL';
                else if (avgBias < -0.2) biasLabel = 'STRONG BEAR';
            }

            const startTimeStr = (!r.min_time || /^ *\d+ *$/.test(r.min_time.toString()))
                ? parseInt(r.min_time || Date.now(), 10)
                : (r.min_time.endsWith('Z') ? r.min_time : r.min_time + 'Z');

            const endTimeStr = (!r.batch_time || /^ *\d+ *$/.test(r.batch_time.toString()))
                ? parseInt(r.batch_time || Date.now(), 10)
                : (r.batch_time.endsWith('Z') ? r.batch_time : r.batch_time + 'Z');

            const startTime = new Date(startTimeStr);
            const endTime = new Date(endTimeStr);
            const durationMins = Math.max(1, Math.ceil((endTime - startTime) / 1000 / 60));

            return {
                time: endTime.toISOString(),
                start_time: startTime.toISOString(),
                duration: durationMins,
                count: count,
                inst_count: r.inst_count,
                tech_count: r.tech_count,
                unique_coins: uniqueCoins.length,
                density: (count / durationMins).toFixed(1),
                cluster: count > 5 ? 'BURST' : 'STEADY',
                bias: biasLabel,
                mom_pct: (r.avg_mom || 0).toFixed(1),
                timeline: uniqueCoins.slice(0, 3).join(', ') + (uniqueCoins.length > 3 ? '...' : ''),
                full_timeline: uniqueCoins.join(', '),
                bullish: r.bull_count,
                bearish: r.bear_count,
                mood_score: Math.round(avgBias * 100)
            };
        });

        // 2. Volume Intent (Aggregated from clustered rows)
        const total_alerts = clusters.reduce((acc, r) => acc + r.count, 0);
        const volume_intent = {
            bullish: clusters.reduce((acc, r) => acc + r.bull_count, 0),
            bearish: clusters.reduce((acc, r) => acc + r.bear_count, 0)
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
                timestamp,
                strength as mom,
                direction as bias_val,
                origin
            FROM unified_alerts
            WHERE timestamp > ?
            ORDER BY timestamp DESC
            LIMIT 50
        `).all(cutoff);

        const signals = signalRows.map(r => {
            const biasVal = r.bias_val || 0;
            return {
                ticker: r.ticker,
                time: r.timestamp,
                x: parseFloat(r.mom || 0),
                y: r.origin === 'INSTITUTIONAL' ? 100 : 50, // Highlight institutional sweeps on Y-Axis
                bias: biasVal > 0 ? 'BULLISH' : (biasVal < 0 ? 'BEARISH' : 'NEUTRAL'),
                volSpike: r.origin === 'INSTITUTIONAL', // Treat institutional as volume spike visually
                origin: r.origin
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
        const useSmartLevels = req.query.smartLevels === 'true'; // Toggle

        // 1. Get Latest Scan
        const latestScan = db.prepare('SELECT id, timestamp FROM scans ORDER BY timestamp DESC LIMIT 1').get();
        if (!latestScan) return res.json({ planA: [], planB: [], marketCheck: null });

        // 2. Fetch/Parse Payload
        const row = db.prepare('SELECT raw_data FROM scan_results WHERE scan_id = ?').get(latestScan.id);
        if (!row || !row.raw_data) return res.json({ planA: [], planB: [], marketCheck: null });

        const payload = JSON.parse(row.raw_data);
        const results = payload.results || [];
        const marketMood = payload.market_sentiment || { moodScore: 0, mood: 'NEUTRAL' };

        // --- Fetch Active Smart Levels for the last 24h ---
        const levelMap = {};
        if (useSmartLevels) {
            const cutoff24 = new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString();
            const activeSmartLevels = db.prepare(`
                SELECT ticker, raw_data
                FROM smart_level_events
                WHERE timestamp > ?
                GROUP BY ticker
                HAVING MAX(timestamp)
            `).all(cutoff24);

            // Helper to extract
            const extractLevels = (slObj) => {
                const list = [];
                if (!slObj) return list;
                if (slObj.daily_logic) {
                    if (slObj.daily_logic.base_supp?.p) list.push({ type: 'Support', price: parseFloat(slObj.daily_logic.base_supp.p) });
                    if (slObj.daily_logic.base_res?.p) list.push({ type: 'Resistance', price: parseFloat(slObj.daily_logic.base_res.p) });
                }
                if (slObj.hourly_logic) {
                    if (slObj.hourly_logic.base_supp?.p) list.push({ type: 'Support', price: parseFloat(slObj.hourly_logic.base_supp.p) });
                    if (slObj.hourly_logic.base_res?.p) list.push({ type: 'Resistance', price: parseFloat(slObj.hourly_logic.base_res.p) });
                }
                if (slObj.mega_spot?.p) list.push({ type: 'Support', price: parseFloat(slObj.mega_spot.p) });
                return list;
            };

            activeSmartLevels.forEach(row => {
                try {
                    const raw = JSON.parse(row.raw_data);
                    if (raw.smart_levels) {
                        levelMap[row.ticker] = extractLevels(raw.smart_levels);
                    }
                } catch (e) { }
            });
        }

        const planA = [];
        const planB = [];

        // 3. Categorize Candidates
        results.forEach(r => {
            const d = r.data || r; // Normalize
            const code = d.positionCode || 0;
            const mom = d.momScore || 0;
            const netTrend = parseFloat(d.netTrend || 0);
            const vol = d.volSpike || 0;
            const ticker = d.ticker;

            let isSmartSupport = false;
            let isSmartResist = false;

            // Check Smart Levels proximity if enabled
            if (useSmartLevels && levelMap[ticker]) {
                const currentPrice = d.close;
                levelMap[ticker].forEach(sl => {
                    const distPct = Math.abs((currentPrice - sl.price) / currentPrice) * 100;
                    if (distPct < 0.5) { // Within 0.5%
                        if (sl.type.includes('Support')) isSmartSupport = true;
                        if (sl.type.includes('Resistance') || sl.type.includes('Resist')) isSmartResist = true;
                    }
                });
            }

            // PLAN A: Bullish Scenarios
            if (isSmartSupport && netTrend > 0) {
                planA.push({ ticker, price: d.close, trigger: 'Smart Level Bounce', scope: 'Institutional', heat: 3, vol: vol });
            } else if (code >= 500) {
                planA.push({ ticker, price: d.close, trigger: 'Mega Spot Support', scope: 'Institutional', heat: 3, vol: vol });
            } else if (code >= 300 && code < 400 && netTrend > 20) {
                planA.push({ ticker, price: d.close, trigger: 'Trend Continuation', scope: 'Mid-Term', heat: 1, vol: vol });
            } else if (d.breakout) {
                planA.push({ ticker, price: d.close, trigger: 'Volatility Breakout', scope: 'Scalp', heat: 2, vol: 1 });
            }

            // PLAN B: Bearish Scenarios
            if (isSmartResist && netTrend < 0) {
                planB.push({ ticker, price: d.close, trigger: 'Smart Level Rejection', scope: 'Institutional', heat: 3, vol: vol });
            } else if (code >= 100 && code < 200 && netTrend < -10) {
                planB.push({ ticker, price: d.close, trigger: 'Trend Breakdown', scope: 'Mid-Term', heat: 1, vol: vol });
            } else if (code >= 400 && code < 500 && netTrend < -20) {
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
                FROM unified_alerts
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
            FROM unified_alerts
            WHERE timestamp > ? AND timestamp <= ?
            GROUP BY ticker
            ORDER BY scans DESC
            LIMIT 5
        `).all(cutoff, anchorStr);


        // C. Rejections (Proxy: Bearish Bias vs Bullish Bias distribution)
        // In a real 'Rejection' system, we'd check for specific 'rejected' event types.
        const sentimentRows = db.prepare(`
            SELECT 
                SUM(CASE WHEN direction > 0 THEN 1 ELSE 0 END) as bulls,
                SUM(CASE WHEN direction < 0 THEN 1 ELSE 0 END) as bears
            FROM unified_alerts
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



// 9c. ALPHA SQUAD (Time-Series Volume & Momentum Deltas)
app.get('/api/analytics/alpha-squad', (req, res) => {
    try {
        const hours = parseFloat(req.query.hours) || 24;
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        const rows = db.prepare(`
            SELECT ticker, timestamp, raw_data, strength, direction, origin
            FROM unified_alerts
            WHERE timestamp >= ?
            ORDER BY timestamp ASC
        `).all(cutoff);

        const tickerMap = {};
        rows.forEach(row => {
            if (!tickerMap[row.ticker]) {
                tickerMap[row.ticker] = { events: [] };
            }
            try {
                const raw = JSON.parse(row.raw_data);
                const vol = parseFloat(raw.today_volume || raw.volume || 0);
                if (vol > 0) {
                    tickerMap[row.ticker].events.push({
                        time: new Date(row.timestamp).getTime(),
                        vol: vol,
                        mom: parseFloat(row.strength || 0),
                        bias: row.direction > 0 ? 'BULL' : (row.direction < 0 ? 'BEAR' : 'NEUTRAL')
                    });
                }
            } catch (e) { }
        });

        const alphaSquad = [];
        for (const [ticker, ObjectData] of Object.entries(tickerMap)) {
            const events = ObjectData.events;
            if (events.length >= 2) {
                const first = events[0];
                const last = events[events.length - 1];

                let volDelta = last.vol - first.vol;
                if (volDelta < 0) volDelta = last.vol; // Midnight reset handler

                const momDelta = last.mom - first.mom;
                const hoursElapsed = (last.time - first.time) / (1000 * 60 * 60);

                // Base Condition: Increasing Volume AND Increasing Momentum
                if (volDelta > 0 && Math.abs(momDelta) >= 1.0) {
                    alphaSquad.push({
                        ticker,
                        volDelta,
                        momDelta,
                        bias: last.bias,
                        hoursElapsed: hoursElapsed > 0 ? hoursElapsed.toFixed(2) : 0.1,
                        eventCount: events.length
                    });
                }
            }
        }

        alphaSquad.sort((a, b) => b.volDelta - a.volDelta);
        res.json(alphaSquad);
    } catch (e) {
        console.error("Alpha Squad Error:", e);
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

        // TradingView's {{time}} placeholder outputs the BAR OPEN time (e.g. 09:35 for a 5m bar).
        // If the alert triggers at 09:38, the UI sees it as "3 minutes ago" instantly. 
        // To fix this discrepancy, we force the timestamp to the exact Server Receive Time for all live webhooks.
        const parsedTimestamp = new Date().toISOString();

        // Phase 9: Ingestion Routing Switch
        if (typeof payload.bar_move_pct !== 'undefined') {
            // Path A: Institutional Interest Payload
            const direction = payload.direction !== undefined ? parseInt(payload.direction, 10) : 0;
            const bar_move_pct = parseFloat(payload.bar_move_pct);
            const today_change_pct = parseFloat(payload.today_change_pct || 0);
            const today_volume = parseFloat(payload.today_volume || 0);

            db.prepare(`
                INSERT OR IGNORE INTO institutional_interest_events (ticker, timestamp, price, direction, bar_move_pct, today_change_pct, today_volume, raw_data)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(ticker, parsedTimestamp, price, direction, bar_move_pct, today_change_pct, today_volume, JSON.stringify(payload));

            console.log(`[INST-INTEREST] 🏦 Institutional Webhook: ${ticker} | Dir: ${direction} | BarMove: ${bar_move_pct.toFixed(2)}%`);
            io.emit('institutional-interest-update', { ticker, direction, timestamp: parsedTimestamp });
        } else {
            // Path B: Legacy Smart Levels (default fallback)
            const direction = payload.momentum?.direction !== undefined ? parseInt(payload.momentum.direction, 10) : (payload.direction || 0);
            const roc_pct = payload.momentum?.roc_pct !== undefined ? parseFloat(payload.momentum.roc_pct) : 0.0;

            db.prepare(`
                INSERT OR IGNORE INTO smart_level_events (ticker, timestamp, price, direction, roc_pct, raw_data)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(
                ticker,
                parsedTimestamp,
                price,
                direction,
                roc_pct,
                JSON.stringify(payload)
            );

            console.log(`[SMART-LEVELS] 🧠 Alert Received @ ${parsedTimestamp} | Ticker: ${ticker} | Payload Time: ${payload.timestamp || 'N/A'}`);
            io.emit('smart-level-update', { ticker, direction, timestamp: parsedTimestamp });
        }

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

        // 3.5 Get Burst History (Last 24 Hours of Stream C and Inst. Webhooks for these tickers)
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const burstRows = db.prepare(`
            SELECT ticker, timestamp, direction, strength, origin 
            FROM unified_alerts 
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
        // 5. RSI Distribution Processing
        const rsi_distribution = RSIEngine.processRSIData(streamC_Rows);

        res.json({
            success: true,
            count: dashboardData.length,
            records: dashboardData,
            rsi_distribution: rsi_distribution
        });

    } catch (e) {
        console.error("Fusion Dashboard Error:", e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 V3 Server running on port ${PORT} (All Interfaces)`);
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


