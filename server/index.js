const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const db = require('./database'); // V3 Database Module

// --- SERVICES ---
// Telegram service kept for notifications (optional integration later)
const TelegramService = require('./services/telegram');
const RSIEngine = require('./services/RSIEngine');
const UmpireEngine = require('./validator/UmpireEngine');
const telegramValidator = require('./services/telegramValidator');
const MasterStoreService = require('./services/MasterStoreService');
const TimestampResolver = require('./services/TimestampResolver');
const GhostScoringEngine = require('./services/GhostScoringEngine');
const VolumeEventService = require('./services/VolumeEventService');

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

        // [V4 MASTER STORE INGESTION] - Fire and forget
        // Stream A: trust payload.timestamp (browser is ground truth).
        if (payload.results && Array.isArray(payload.results)) {
            setImmediate(() => {
                payload.results.forEach(item => {
                    const d = item.data || item;
                    const ticker = item.datakey ? item.datakey.replace('BINANCE:', '') : item.ticker;
                    const price = d.close || 0;
                    MasterStoreService.ingestStreamA(ticker, d, price, {
                        timestampISO: timestamp,           // payload.timestamp from scan
                        ingestionSource: 'SCAN_A',
                    }).catch(err => console.error(err));
                    // Volume edge detection — fires once on rising edge of volSpike
                    try {
                        VolumeEventService.onStreamA({
                            ticker,
                            ts: timestamp,
                            volSpike: d.volSpike,
                            price,
                            direction: d.direction,
                        });
                    } catch (e) { /* non-blocking */ }
                });
            });
        }

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

        // F. 3rd UMPIRE VALIDATOR (passive, fire-and-forget — Step 1 skeleton)
        setImmediate(() => {
            try { umpire.onStreamA(payload); } catch (err) { console.error('Umpire onStreamA error:', err); }
        });

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

    // --- 0. FETCH SYSTEM SETTINGS AND GHOST QUEUE ---
    const autoApproveSetting = db.prepare("SELECT value FROM system_settings WHERE key = 'ghost_auto_approve'").get();
    const autoApprove = autoApproveSetting ? autoApproveSetting.value === '1' : false;

    const ghostQueueRows = db.prepare("SELECT * FROM ghost_approval_queue").all();
    const ghostQueueMap = {};
    ghostQueueRows.forEach(row => ghostQueueMap[row.ticker] = row);

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

        // [LIFECYCLE TRACKING - Update Last Seen & Ensure Exists]
        db.prepare(`
            INSERT INTO coin_lifecycles (ticker, born_at, last_seen_at, status) 
            VALUES (?, ?, ?, 'ACTIVE') 
            ON CONFLICT(ticker) DO UPDATE SET 
                last_seen_at = excluded.last_seen_at, 
                status = CASE WHEN status = 'DEAD' THEN 'ACTIVE' ELSE status END
        `).run(cleanTicker, new Date().toISOString(), new Date().toISOString());

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
            // Ghost Approval Queue Logic
            const queuedGhost = ghostQueueMap[cleanTicker];
            let bypassQueue = false;

            if (autoApprove) {
                bypassQueue = true;
            } else if (queuedGhost && queuedGhost.is_approved === 1) {
                bypassQueue = true;
                // Once pruned, remove from queue
                db.prepare("DELETE FROM ghost_approval_queue WHERE ticker = ?").run(cleanTicker);
            }

            if (bypassQueue) {
                pruneList.push(fullTicker);
                ghostList.push({ ticker: cleanTicker, reason: pruneReason, state: 'PRUNING' });
                // [LIFECYCLE TRACKING - Mark DEAD]
                db.prepare("UPDATE coin_lifecycles SET status = 'DEAD', death_at = ? WHERE ticker = ?").run(new Date().toISOString(), cleanTicker);
            } else {
                // Upsert into queue if not already there
                if (!queuedGhost) {
                    db.prepare(`
                        INSERT INTO ghost_approval_queue (ticker, reason, queued_at, is_approved)
                        VALUES (?, ?, ?, 0)
                        ON CONFLICT(ticker) DO UPDATE SET reason = excluded.reason
                    `).run(cleanTicker, pruneReason, new Date().toISOString());
                }
                ghostList.push({ ticker: cleanTicker, reason: pruneReason, state: 'WAITING' });
                db.prepare("UPDATE coin_lifecycles SET status = 'GHOST' WHERE ticker = ?").run(cleanTicker);
            }
        } else {
            // MOMENTUM RESCUE / GATE 20 RESCUE
            // If it's no longer a ghost but was sitting in the queue, violently rescue it.
            if (ghostQueueMap[cleanTicker]) {
                db.prepare("DELETE FROM ghost_approval_queue WHERE ticker = ?").run(cleanTicker);
                db.prepare("UPDATE coin_lifecycles SET status = 'ACTIVE' WHERE ticker = ?").run(cleanTicker);
                console.log(`[GHOST-ENGINE] 🛟 Rescued ${cleanTicker} from Ghost Queue (Re-qualified or Momentum Recovered)`);
            }
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

        // [V4 MASTER STORE INGESTION] - Stream B
        // Trust payload.timestamp if present (scout reads live prices).
        setImmediate(() => {
            MasterStoreService.ingestStreamB(ticker, req.body, price, {
                timestampISO: req.body?.timestamp || now,
                ingestionSource: 'SCOUT_B',
            }).catch(e => console.error(e));
        });

        // [LIFECYCLE TRACKING - Birth Capture]
        if (type === 'STABLE') {
            const existing = db.prepare("SELECT * FROM coin_lifecycles WHERE ticker = ?").get(ticker);
            if (!existing || existing.status === 'DEAD') {
                if (existing) {
                    db.prepare("UPDATE coin_lifecycles SET born_at = ?, last_seen_at = ?, status = 'ACTIVE', death_at = NULL WHERE ticker = ?").run(now, now, ticker);
                } else {
                    db.prepare(`
                        INSERT INTO coin_lifecycles (ticker, born_at, last_seen_at, status)
                        VALUES (?, ?, ?, 'ACTIVE')
                    `).run(ticker, now, now);
                }
            } else {
                db.prepare("UPDATE coin_lifecycles SET last_seen_at = ?, status = 'ACTIVE' WHERE ticker = ?").run(now, ticker);
            }
        }

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

        // [V4 MASTER STORE INGESTION] - Stream B (market context)
        setImmediate(() => {
            const watchlistSnaps = payload.watchlist_active_snapshot || [];
            watchlistSnaps.forEach(w => {
                if (w.full) {
                    const ticker = w.full.replace('BINANCE:', '');
                    const price = w.price || 0;
                    MasterStoreService.ingestStreamB(ticker, w, price, {
                        timestampISO: w.timestamp || payload.timestamp || now,
                        ingestionSource: 'SCOUT_B',
                    }).catch(e => console.error(e));
                }
            });
        });

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

// ============================================================================
// STREAM D — TECHNICAL WATCHLIST (Tampermonkey → TradingView CEX Screener)
// ============================================================================

// POST /api/stream-d/technicals — ingest a full scan from the screener
app.post('/api/stream-d/technicals', (req, res) => {
    try {
        const payload = req.body;
        const timestamp = payload.timestamp || new Date().toISOString();

        if (!payload.results || !Array.isArray(payload.results)) {
            return res.status(400).json({ error: 'results array required' });
        }

        // Non-blocking: process after response is sent
        setImmediate(() => {
            let ingested = 0, skipped = 0;
            payload.results.forEach(item => {
                const data   = item.data || {};
                const ticker = (item.ticker || data.ticker || '').trim();
                const price  = parseFloat(data.close || data.price || 0);
                if (!ticker) { skipped++; return; }

                MasterStoreService.ingestStreamD(ticker, data, price, {
                    timestampISO:    timestamp,
                    ingestionSource: 'WATCHLIST_TECHNICALS',
                }).then(() => ingested++)
                  .catch(err => console.error(`[Stream D] ${ticker} ingest error:`, err.message));
                // Volume RelVol crossing detection
                try {
                    VolumeEventService.onStreamD({ ticker, ts: timestamp, data });
                } catch (e) { /* non-blocking */ }
            });
            console.log(`[Stream D] 📡 Scan processed: ${payload.results.length} coins | ts=${timestamp}`);
        });

        res.json({ success: true, accepted: payload.results.length });
    } catch (e) {
        console.error('[Stream D] Ingest Error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/stream-d/schema — dynamically discover all field names from stored data.
// Frontend uses this to render technical chips without hardcoded column names.
app.get('/api/stream-d/schema', (req, res) => {
    try {
        const fields = MasterStoreService.getStreamDSchema();
        // Also return one sample row so the frontend can see real values
        const sampleRow = db.prepare(
            `SELECT ticker, stream_d_state, timestamp FROM master_coin_store
             WHERE stream_d_state IS NOT NULL AND trigger_source = 'STREAM_D'
             ORDER BY timestamp DESC LIMIT 1`
        ).get();
        const sample = sampleRow
            ? { ticker: sampleRow.ticker, ts: sampleRow.timestamp, data: JSON.parse(sampleRow.stream_d_state) }
            : null;

        res.json({ fields, sample, field_count: fields.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/stream-d/latest — latest technical snapshot per ticker.
// Returns all tickers that have Stream D data, with their most recent values.
// Supports ?tickers=BTC,ETH,SOL to filter to specific coins.
app.get('/api/stream-d/latest', (req, res) => {
    try {
        const filterTickers = req.query.tickers
            ? req.query.tickers.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
            : null;

        // Get latest STREAM_D snapshot per ticker — table uses snapshot_id (TEXT PK),
        // not an integer id, so we group by ticker on MAX(timestamp).
        const rows = db.prepare(`
            SELECT m.ticker, m.stream_d_state, m.timestamp
            FROM master_coin_store m
            INNER JOIN (
                SELECT ticker, MAX(timestamp) AS max_ts
                FROM master_coin_store
                WHERE trigger_source = 'STREAM_D' AND stream_d_state IS NOT NULL
                GROUP BY ticker
            ) latest ON m.ticker = latest.ticker AND m.timestamp = latest.max_ts
            WHERE m.trigger_source = 'STREAM_D' AND m.stream_d_state IS NOT NULL
            ORDER BY m.timestamp DESC
        `).all();

        const result = {};
        for (const row of rows) {
            const cleanTicker = row.ticker.replace(/USDT\.P$|USDT$/, '').toUpperCase();
            if (filterTickers && !filterTickers.includes(cleanTicker) && !filterTickers.includes(row.ticker)) continue;
            try {
                result[row.ticker] = {
                    cleanTicker,
                    ts:   row.timestamp,
                    data: JSON.parse(row.stream_d_state),
                };
            } catch {}
        }

        res.json({ tickers: result, count: Object.keys(result).length });
    } catch (e) {
        console.error('[Stream D] latest error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// EMA200 STACK + SOURCE HEALTH — foundation endpoints for cascade widgets
// ============================================================================

// GET /api/ema-stack?ticker=BTC[&asOf=ISO]
//   Returns merged EMA200 ladder for a ticker:
//     m1   ← Stream D
//     m5/m15/h1/h4 ← Stream C → Stream A (most recent wins)
//   Each TF entry: { price, source, ts, ageMs, stale }
app.get('/api/ema-stack', (req, res) => {
    try {
        const ticker = (req.query.ticker || '').trim();
        if (!ticker) return res.status(400).json({ error: 'ticker required' });
        const asOf = req.query.asOf || null;
        res.json(MasterStoreService.getEMA200Stack(ticker, asOf));
    } catch (e) {
        console.error('[EMA Stack] error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/volume-events?ticker=BTC&since_min=120[&limit=200]
//   Or:  /api/volume-events?tickers=BTC,ETH,SOL&since_min=60
//   Returns discrete volume spike events (with provenance) since N minutes ago.
//   Sources: STREAM_C_ALERT (truth), STREAM_A_EDGE (rising-edge of volSpike),
//            STREAM_D_RVOL (relativevolume ≥ threshold).
//   Multi-ticker mode returns { by_ticker: { TICKER: [events...] } } for
//   efficient per-coin overlay in list widgets.
function _expandTickerVariants(t) {
    return Array.from(new Set([
        t,
        `${t}USDT.P`,
        `${t}USDT`,
        t.replace(/USDT\.P$|USDT$/, ''),
    ].filter(Boolean)));
}

app.get('/api/volume-events', (req, res) => {
    try {
        const sinceMin = Math.min(1440, Math.max(5, parseInt(req.query.since_min) || 120));
        const limit   = Math.min(500, Math.max(1, parseInt(req.query.limit) || 200));
        const sinceISO = new Date(Date.now() - sinceMin * 60 * 1000).toISOString();

        // Multi-ticker batch mode (audit fix M1: single IN-clause query)
        if (req.query.tickers) {
            const tickers = String(req.query.tickers)
                .split(',').map(s => s.trim()).filter(Boolean).slice(0, 64);
            const { by_canonical, counts_by_canonical } =
                VolumeEventService.getEventsBatch(tickers, sinceISO, limit);
            return res.json({
                multi: true,
                since_min: sinceMin,
                since: sinceISO,
                tickers,
                by_ticker: by_canonical,
                counts_by_ticker: counts_by_canonical,
            });
        }

        // Single-ticker mode (backward compat)
        const ticker = req.query.ticker ? req.query.ticker.trim() : null;
        let events = [];
        let resolvedTicker = ticker;
        if (ticker) {
            for (const v of _expandTickerVariants(ticker)) {
                events = VolumeEventService.getEvents(v, sinceISO, limit);
                if (events.length) { resolvedTicker = v; break; }
            }
        } else {
            events = VolumeEventService.getEvents(null, sinceISO, limit);
        }

        const counts = ticker
            ? VolumeEventService.countBySource(resolvedTicker, sinceISO)
            : null;

        res.json({
            ticker: resolvedTicker,
            since_min: sinceMin,
            since: sinceISO,
            count: events.length,
            counts_by_source: counts,
            events,
        });
    } catch (e) {
        console.error('[VolumeEvents] error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// EMA CASCADE — /api/ema-cascade
// ============================================================================
// For one ticker, returns a richly-typed time series for the EMA Cascade
// Monitor widget:
//   { ticker, history: [{ts, price, emas:{m1,m5,m15,h1,h4}, cascadeState,
//                        transitions:[], gapBefore?:bool, dataSource}],
//     volEvents:[{ts, source, strength, meta}],
//     defenseLevelNow, lastBreak, gaps, sourceHealth }
//
// Cascade state per row, per TF:  ABOVE | TESTING | BELOW
// Transitions emitted when state flips between adjacent rows.
// "Active defense level" = lowest TF where state is ABOVE (bull)  /
//                          lowest TF where state is BELOW (bear).
// When that flips, we emit BREAK / RESPECT / PULLBACK_HOLD / PULLBACK_REJECT.

app.get('/api/ema-cascade', (req, res) => {
    try {
        const tickerRaw = (req.query.ticker || '').trim();
        if (!tickerRaw) return res.status(400).json({ error: 'ticker required' });
        const windowMin = Math.min(720, Math.max(15, parseInt(req.query.window_min) || 120));
        const intervalMin = Math.max(1, Math.min(15, parseInt(req.query.interval) || 2));
        const sinceISO = new Date(Date.now() - windowMin * 60 * 1000).toISOString();

        // Resolve ticker via stack endpoint logic (one canonical name)
        const stackNow = MasterStoreService.getEMA200Stack(tickerRaw);
        const ticker = stackNow.ticker || tickerRaw;

        // 1. Pull all master_coin_store rows for ticker in window (any source)
        const rows = db.prepare(`
            SELECT timestamp, price, trigger_source, stream_a_state,
                   stream_c_state, stream_d_state
            FROM master_coin_store
            WHERE ticker = ? AND timestamp >= ?
            ORDER BY timestamp ASC
        `).all(ticker, sinceISO);

        if (!rows.length) {
            return res.json({
                ticker, window_min: windowMin, interval_min: intervalMin,
                history: [], volEvents: [],
                defenseLevelNow: null, lastBreak: null, gaps: [],
                sourceHealth: MasterStoreService.getSourceHeartbeats(ticker),
                stackNow,
            });
        }

        // 2. Bucket by interval — within each bucket, take last price + merge
        //    EMA slices from all source rows.
        const intervalMs = intervalMin * 60 * 1000;
        const TF_BY_RES = { 1: 'm1', 5: 'm5', 15: 'm15', 60: 'h1', 240: 'h4' };
        const buckets = new Map();

        for (const row of rows) {
            const ms = new Date(row.timestamp).getTime();
            const key = Math.floor(ms / intervalMs) * intervalMs;
            const b = buckets.get(key) || {
                ts: key,
                price: null,
                emas: { m1: null, m5: null, m15: null, h1: null, h4: null },
                emaSrc: { m1: null, m5: null, m15: null, h1: null, h4: null },
                lastSrc: null,
            };
            b.price = parseFloat(row.price) || b.price;
            b.lastSrc = row.trigger_source;

            // Stream D: dynamic ema_200Timeresolution<N> keys
            if (row.stream_d_state) {
                try {
                    const d = JSON.parse(row.stream_d_state);
                    for (const k of Object.keys(d)) {
                        const m = k.match(/^ema_200Timeresolution(\d+)$/i);
                        if (!m) continue;
                        const tf = TF_BY_RES[parseInt(m[1], 10)];
                        if (!tf) continue;
                        const v = parseFloat(d[k]);
                        if (!isNaN(v)) { b.emas[tf] = v; b.emaSrc[tf] = 'STREAM_D'; }
                    }
                    if (b.emas.m1 == null && d.ema_200 != null) {
                        const v = parseFloat(d.ema_200);
                        if (!isNaN(v)) { b.emas.m1 = v; b.emaSrc.m1 = 'STREAM_D'; }
                    }
                } catch {}
            }
            // Stream C: smart_levels.emas_200.{tf}.p
            if (row.stream_c_state) {
                try {
                    const s = JSON.parse(row.stream_c_state);
                    const e200 = s?.smart_levels?.emas_200 || null;
                    if (e200) {
                        for (const tf of ['m1', 'm5', 'm15', 'h1', 'h4']) {
                            if (b.emas[tf] != null) continue;  // D already won
                            const slot = e200[tf];
                            if (!slot) continue;
                            const v = parseFloat(slot.p ?? slot);
                            if (!isNaN(v)) { b.emas[tf] = v; b.emaSrc[tf] = 'STREAM_C'; }
                        }
                    }
                } catch {}
            }
            buckets.set(key, b);
        }

        // 3. Sort buckets, then LOCF: carry forward EMA values across buckets
        //    when a bucket didn't get fresh data (browser glitch resilience).
        const sortedBuckets = Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
        const carry = { m1: null, m5: null, m15: null, h1: null, h4: null };
        const carrySrc = { m1: null, m5: null, m15: null, h1: null, h4: null };
        const carryAge = { m1: 0, m5: 0, m15: 0, h1: 0, h4: 0 };

        for (const b of sortedBuckets) {
            for (const tf of ['m1', 'm5', 'm15', 'h1', 'h4']) {
                if (b.emas[tf] != null) {
                    carry[tf] = b.emas[tf];
                    carrySrc[tf] = b.emaSrc[tf];
                    carryAge[tf] = b.ts;
                } else if (carry[tf] != null) {
                    b.emas[tf] = carry[tf];
                    b.emaSrc[tf] = carrySrc[tf] + '_LOCF';
                }
            }
            // Carry price too if a bucket somehow had only EMA data
            if (b.price == null && sortedBuckets[0].price != null) {
                // find prior price
                const prior = sortedBuckets.filter(x => x.ts < b.ts && x.price != null).pop();
                if (prior) b.price = prior.price;
            }
        }

        // 4. Cascade state per bucket per TF
        const TESTING_PCT = 0.15;  // ±0.15% = touching the EMA
        const tfs = ['m1', 'm5', 'm15', 'h1', 'h4'];
        const computeCascadeState = (price, ema) => {
            if (price == null || ema == null) return 'UNKNOWN';
            const pct = ((price - ema) / ema) * 100;
            if (Math.abs(pct) <= TESTING_PCT) return 'TESTING';
            return pct > 0 ? 'ABOVE' : 'BELOW';
        };

        // Compute baseline state + active defense per bucket
        for (const b of sortedBuckets) {
            b.cascadeState = {};
            b.distPct = {};
            for (const tf of tfs) {
                b.cascadeState[tf] = computeCascadeState(b.price, b.emas[tf]);
                b.distPct[tf] = b.emas[tf] && b.price
                    ? ((b.price - b.emas[tf]) / b.emas[tf]) * 100
                    : null;
            }
            // Active defense: lowest TF still ABOVE = bull defense level;
            // lowest TF still BELOW = bear ceiling (resistance defense).
            const aboveTfs = tfs.filter(tf => b.cascadeState[tf] === 'ABOVE');
            const belowTfs = tfs.filter(tf => b.cascadeState[tf] === 'BELOW');
            b.bullDefense = aboveTfs[0] || null;          // first TF where price is still above its EMA
            b.bearDefense = belowTfs[0] || null;
            b.regime = aboveTfs.length >= belowTfs.length ? 'BULL' : 'BEAR';
        }

        // 5. Transition detection
        const transitions = [];
        for (let i = 1; i < sortedBuckets.length; i++) {
            const prev = sortedBuckets[i - 1];
            const cur  = sortedBuckets[i];
            cur.transitions = [];
            for (const tf of tfs) {
                const ps = prev.cascadeState[tf];
                const cs = cur.cascadeState[tf];
                if (ps === cs || ps === 'UNKNOWN' || cs === 'UNKNOWN') continue;

                let evt = null;
                if (ps === 'ABOVE' && cs === 'BELOW')         evt = 'BROKE';
                else if (ps === 'TESTING' && cs === 'BELOW')  evt = 'BROKE';
                else if (ps === 'TESTING' && cs === 'ABOVE')  evt = 'RESPECTED';
                else if (ps === 'BELOW' && cs === 'ABOVE')    evt = 'RECLAIM';
                else if (ps === 'ABOVE' && cs === 'TESTING')  evt = 'TOUCH';
                else if (ps === 'BELOW' && cs === 'TESTING')  evt = 'PULLBACK_TOUCH';

                if (evt) {
                    const t = {
                        ts: cur.ts, tf, event: evt,
                        prevState: ps, newState: cs,
                        price: cur.price, ema: cur.emas[tf],
                    };
                    cur.transitions.push(t);
                    transitions.push(t);
                }
            }

            // PULLBACK_HOLD detection: BROKE earlier in window, then RECLAIMED,
            // then re-tested as support and held (TESTING → ABOVE again).
            // Look back ≤30 buckets per TF.
            for (const tf of tfs) {
                if (cur.transitions.find(t => t.tf === tf && t.event === 'RESPECTED')) {
                    const look = sortedBuckets.slice(Math.max(0, i - 30), i);
                    const hadBreak = look.some(b =>
                        b.transitions?.find(t => t.tf === tf && t.event === 'BROKE')
                    );
                    if (hadBreak) {
                        const t = { ts: cur.ts, tf, event: 'PULLBACK_HOLD', price: cur.price, ema: cur.emas[tf] };
                        cur.transitions.push(t);
                        transitions.push(t);
                    }
                }
            }
        }

        // 6. Gap detection — flag buckets that follow a break in cadence
        const gaps = MasterStoreService.detectGaps(sortedBuckets, intervalMs, 2);
        const gapStartSet = new Set(gaps.map(g => g.endTs));
        for (const b of sortedBuckets) {
            b.gapBefore = gapStartSet.has(b.ts);
        }

        // 7. Volume events in window — try all ticker variants so BTCUSDT.P / BTC / BTCUSDT
        //    all resolve correctly regardless of how the stream stored the ticker.
        let volEventsRaw = [];
        for (const v of _expandTickerVariants(ticker)) {
            volEventsRaw = VolumeEventService.getEvents(v, sinceISO, 500);
            if (volEventsRaw.length) break;
        }
        const volEvents = volEventsRaw
            .map(e => ({ ts: new Date(e.ts).getTime(), source: e.source, strength: e.strength, meta: e.meta }))
            .sort((a, b) => a.ts - b.ts);

        // 8. Build the slim history array for FE
        const history = sortedBuckets.map(b => ({
            ts: b.ts,
            price: b.price,
            emas: b.emas,
            emaSrc: b.emaSrc,
            cascadeState: b.cascadeState,
            distPct: b.distPct,
            bullDefense: b.bullDefense,
            bearDefense: b.bearDefense,
            regime: b.regime,
            transitions: b.transitions || [],
            gapBefore: b.gapBefore,
            dataSource: b.lastSrc,
        }));

        // 9. Summary slots
        const last = history[history.length - 1] || null;
        const lastBreak = [...transitions].reverse().find(t => t.event === 'BROKE') || null;

        res.json({
            ticker,
            window_min: windowMin,
            interval_min: intervalMin,
            history,
            volEvents,
            transitions,
            defenseLevelNow: last
                ? { bull: last.bullDefense, bear: last.bearDefense, regime: last.regime }
                : null,
            lastBreak,
            gaps,
            sourceHealth: MasterStoreService.getSourceHeartbeats(ticker),
            stackNow,
        });
    } catch (e) {
        console.error('[EMA Cascade] error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/ema-distance-board?limit=40&max_dist=10[&active_min=60]
//   Cross-coin board of distance to 200 EMA across m1/m5/m15/h1/h4.
//   For every ticker active in master_coin_store within the last `active_min`
//   minutes, computes the merged EMA stack (Stream D + Stream C) and returns
//   distance % per TF along with a synthetic "minAbsDist" sort key.
app.get('/api/ema-distance-board', (req, res) => {
    try {
        const limit     = Math.min(120, Math.max(5, parseInt(req.query.limit) || 40));
        const maxDist   = Math.min(50, Math.max(0.5, parseFloat(req.query.max_dist) || 10));
        const activeMin = Math.min(720, Math.max(5, parseInt(req.query.active_min) || 60));
        const sinceISO  = new Date(Date.now() - activeMin * 60 * 1000).toISOString();
        const nowMs     = Date.now();

        // PERF AUDIT FIX (C1): replaces N+1 (one getEMA200Stack call per ticker
        // → up to 4 variant queries × 4 lookups = 640 queries) with 3 batched
        // queries total. With idx_master_source_ticker_time these are
        // index-only lookups; whole endpoint runs in ~30ms vs. ~1.5s before.

        // Q1 — latest snapshot per ticker (any source) in window: drives the
        //      ticker list + last price.
        const latestRows = db.prepare(`
            SELECT m.ticker, m.timestamp AS last_ts, m.price AS last_price
            FROM master_coin_store m
            INNER JOIN (
                SELECT ticker, MAX(timestamp) AS mx
                FROM master_coin_store
                WHERE timestamp >= ?
                GROUP BY ticker
            ) t ON t.ticker = m.ticker AND t.mx = m.timestamp
            ORDER BY m.timestamp DESC
            LIMIT ?
        `).all(sinceISO, Math.min(400, limit * 4));

        if (latestRows.length === 0) {
            return res.json({
                count: 0, limit, max_dist: maxDist, active_min: activeMin,
                board: [], generatedAt: new Date().toISOString(),
            });
        }

        const tickers = latestRows.map(r => r.ticker);
        const placeholders = tickers.map(() => '?').join(',');

        // Q2 — latest STREAM_D row per ticker (carries m1/m5/m15 EMAs)
        const dRows = db.prepare(`
            SELECT m.ticker, m.timestamp, m.stream_d_state
            FROM master_coin_store m
            INNER JOIN (
                SELECT ticker, MAX(timestamp) AS mx
                FROM master_coin_store
                WHERE trigger_source = 'STREAM_D' AND stream_d_state IS NOT NULL
                  AND ticker IN (${placeholders})
                GROUP BY ticker
            ) t ON t.ticker = m.ticker AND t.mx = m.timestamp
            WHERE m.trigger_source = 'STREAM_D'
        `).all(...tickers);
        const dByTicker = new Map(dRows.map(r => [r.ticker, r]));

        // Q3 — latest STREAM_C row per ticker (carries h1/h4 smart_levels)
        const cRows = db.prepare(`
            SELECT m.ticker, m.timestamp, m.stream_c_state
            FROM master_coin_store m
            INNER JOIN (
                SELECT ticker, MAX(timestamp) AS mx
                FROM master_coin_store
                WHERE trigger_source = 'STREAM_C' AND stream_c_state IS NOT NULL
                  AND ticker IN (${placeholders})
                GROUP BY ticker
            ) t ON t.ticker = m.ticker AND t.mx = m.timestamp
            WHERE m.trigger_source = 'STREAM_C'
        `).all(...tickers);
        const cByTicker = new Map(cRows.map(r => [r.ticker, r]));

        const TFS = ['m1','m5','m15','h1','h4'];
        const TF_BY_RES = { 1: 'm1', 5: 'm5', 15: 'm15', 60: 'h1', 240: 'h4' };
        const TTL = MasterStoreService.constructor.SOURCE_TTL_MS;

        const board = [];
        for (const r of latestRows) {
            const tfPicks = { m1: null, m5: null, m15: null, h1: null, h4: null };

            // Stream D — multi-TF EMA matrix
            const dRow = dByTicker.get(r.ticker);
            if (dRow) {
                let d; try { d = JSON.parse(dRow.stream_d_state); } catch { d = null; }
                if (d) {
                    const dTsMs = new Date(dRow.timestamp).getTime();
                    const dAge  = nowMs - dTsMs;
                    const dStale = dAge > (TTL.STREAM_D || 6 * 60 * 1000);
                    for (const k of Object.keys(d)) {
                        const m = k.match(/^ema_200Timeresolution(\d+)$/i);
                        if (!m) continue;
                        const slot = TF_BY_RES[parseInt(m[1], 10)];
                        if (!slot) continue;
                        const num = parseFloat(d[k]);
                        if (!isNaN(num)) {
                            tfPicks[slot] = { price: num, source: 'STREAM_D', ts: dRow.timestamp, ageMs: dAge, stale: dStale };
                        }
                    }
                    if (!tfPicks.m1 && d.ema_200 != null) {
                        const num = parseFloat(d.ema_200);
                        if (!isNaN(num)) tfPicks.m1 = { price: num, source: 'STREAM_D', ts: dRow.timestamp, ageMs: dAge, stale: dStale };
                    }
                }
            }

            // Stream C — smart_levels.emas_200 (fills h1/h4 typically)
            const cRow = cByTicker.get(r.ticker);
            if (cRow) {
                let c; try { c = JSON.parse(cRow.stream_c_state); } catch { c = null; }
                const e200 = c?.smart_levels?.emas_200;
                if (e200) {
                    const cTsMs = new Date(cRow.timestamp).getTime();
                    const cAge  = nowMs - cTsMs;
                    const cStale = cAge > (TTL.STREAM_C || 60 * 60 * 1000);
                    for (const tf of TFS) {
                        if (tfPicks[tf]) continue;
                        const slot = e200[tf];
                        if (!slot) continue;
                        const p = slot.p ?? slot;
                        const num = parseFloat(p);
                        if (!isNaN(num)) {
                            tfPicks[tf] = { price: num, source: 'STREAM_C', ts: cRow.timestamp, ageMs: cAge, stale: cStale };
                        }
                    }
                }
            }

            const px = r.last_price;
            if (px == null) continue;

            const dists = {}, sources = {}, ages = {};
            let minAbs = Infinity, minTf = null, anyStale = false, liveTfCount = 0;
            for (const tf of TFS) {
                const e = tfPicks[tf];
                if (!e || e.price == null) continue;
                const d = ((px - e.price) / e.price) * 100;
                dists[tf]   = d;
                sources[tf] = e.source;
                ages[tf]    = e.ageMs;
                if (e.stale) anyStale = true; else liveTfCount++;
                const a = Math.abs(d);
                if (a < minAbs) { minAbs = a; minTf = tf; }
            }
            if (!minTf || minAbs > maxDist) continue;

            board.push({
                ticker: r.ticker,
                cleanTicker: r.ticker.replace(/USDT(\.P)?$/i, ''),
                lastTs: r.last_ts,
                price: px,
                dists, sources, ages,
                minAbsDist: minAbs, minTf, liveTfCount, anyStale,
            });
        }

        board.sort((a, b) => a.minAbsDist - b.minAbsDist);
        res.json({
            count: board.length,
            limit, max_dist: maxDist, active_min: activeMin,
            board: board.slice(0, limit),
            generatedAt: new Date().toISOString(),
        });
    } catch (e) {
        console.error('[EMA Distance Board] error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/source-health[?ticker=BTC]
//   Returns last-seen timestamps + staleness per ingestion stream. Used by
//   widget headers to show "A: 0:42 ago · C: 12m ago · D: 1:58 ago" rows.
app.get('/api/source-health', (req, res) => {
    try {
        const ticker = req.query.ticker ? req.query.ticker.trim() : null;
        const heartbeats = MasterStoreService.getSourceHeartbeats(ticker);
        res.json({ ticker: ticker || null, heartbeats, now: new Date().toISOString() });
    } catch (e) {
        console.error('[Source Health] error:', e);
        res.status(500).json({ error: e.message });
    }
});

// 3C. PARTICIPATION PULSE (Analytics for Scout Screener)
app.get('/api/analytics/participation-pulse', (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const refTime = req.query.refTime ? new Date(req.query.refTime) : new Date();
        const anchorTime = isNaN(refTime.getTime()) ? new Date() : refTime;
        const anchorStr = anchorTime.toISOString();
        const cutoff = new Date(anchorTime.getTime() - hours * 60 * 60 * 1000).toISOString();

        // Query the market context logs
        const rows = db.prepare(`
            SELECT timestamp, payload_json
            FROM market_context_logs
            WHERE timestamp > ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `).all(cutoff, anchorStr);

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

        // Helper: Strip prefixes/suffixes to match 'ADAUSDT.P' with 'ADAUSDT'
        const normalizeTicker = (str) => {
            if (!str || typeof str !== 'string') return '';
            const core = str.includes(':') ? str.split(':')[1] : str;
            return core.replace(/\.P$|\.PRP$|\.PERP$/i, '').toUpperCase();
        };

        const timeline = rows.map(row => {
            const payload = JSON.parse(row.payload_json);
            const activeSnaps = payload.screener_visible_snapshot || [];
            const watchlistSnaps = payload.watchlist_active_snapshot || [];
            
            // Build a normalized set of current watchlist coins
            const normalizedWatchlist = new Set();
            watchlistSnaps.forEach(w => {
                if (w.full) normalizedWatchlist.add(normalizeTicker(w.full));
            });

            const rawWatchlistCount = payload.watchlist_count || watchlistSnaps.length || 0;

            let bull_score = 0;
            let bear_score = 0;
            let overlapCount = 0;

            activeSnaps.forEach(item => {
                // Use normalization to catch matches even if suffixes differ (.P)
                const normScreener = item.full ? normalizeTicker(item.full) : '';
                if (normScreener && normalizedWatchlist.has(normScreener)) {
                    overlapCount++;
                }

                // Calculate ratings for 100% of the discovery set
                let coinTotal = 0;
                Object.values(item).forEach(val => {
                    const score = getRatingScore(val);
                    coinTotal += score;
                });

                if (coinTotal > 0) bull_score += coinTotal;
                else if (coinTotal < 0) bear_score += Math.abs(coinTotal);
            });

            return {
                time: row.timestamp,
                // Total Screener: The full raw set appearing in discovery
                screener_count: activeSnaps.length,
                // Tracked Watchlist: Total minus those currently being highlighted in discovery
                watchlist_count: Math.max(0, rawWatchlistCount - overlapCount),
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

// ============================================================================
// 5.5 GHOST APPROVAL WIDGET API
// ============================================================================

app.get('/api/ghosts/queue', (req, res) => {
    try {
        const autoApproveSetting = db.prepare("SELECT value FROM system_settings WHERE key = 'ghost_auto_approve'").get();
        const autoApprove = autoApproveSetting ? autoApproveSetting.value === '1' : false;

        // Re-score all pending ghosts (fast — runs in transaction, typically <5ms)
        GhostScoringEngine.scoreAllGhosts();

        const queue = db.prepare(`
            SELECT ticker, reason, queued_at, confidence_score, score_breakdown
            FROM ghost_approval_queue
            WHERE is_approved = 0
            ORDER BY confidence_score DESC NULLS LAST, queued_at DESC
        `).all().map(row => ({
            ...row,
            score_breakdown: row.score_breakdown ? JSON.parse(row.score_breakdown) : null,
        }));

        res.json({ auto_approve: autoApprove, queue });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ghosts/approve', (req, res) => {
    try {
        const { ticker } = req.body;
        if (!ticker) return res.status(400).json({ error: "Ticker required" });
        db.prepare("UPDATE ghost_approval_queue SET is_approved = 1 WHERE ticker = ?").run(ticker);
        res.json({ success: true, ticker });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ghosts/approve-all', (req, res) => {
    try {
        db.prepare("UPDATE ghost_approval_queue SET is_approved = 1 WHERE is_approved = 0").run();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ghosts/toggle-auto', (req, res) => {
    try {
        const { enabled } = req.body;
        const val = enabled ? '1' : '0';
        db.prepare("INSERT INTO system_settings (key, value) VALUES ('ghost_auto_approve', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(val);
        res.json({ success: true, auto_approve: enabled });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/coins/age', (req, res) => {
    try {
        const rows = db.prepare("SELECT ticker, born_at, last_seen_at, status FROM coin_lifecycles WHERE status IN ('ACTIVE', 'GHOST') ORDER BY born_at DESC").all();
        res.json(rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// VALIDATOR API (3rd Umpire)
// ============================================================================
const { rebuildStatistics, getStats } = require('./validator/statisticsEngine');

// GET /api/validator/trials — active + recent resolved, DVR-aware
app.get('/api/validator/trials', (req, res) => {
    try {
        const refTime = req.query.refTime ? req.query.refTime : new Date().toISOString();
        const limit = parseInt(req.query.limit) || 30;

        // Active trials (not resolved): filter by detected_at <= refTime
        const active = db.prepare(`
            SELECT t.*,
                   (SELECT rule_snapshot FROM validation_state_log
                    WHERE trial_id = t.trial_id AND changed_at <= ?
                    ORDER BY changed_at DESC LIMIT 1) as latest_rules,
                   (SELECT unrealized_move_pct FROM validation_state_log
                    WHERE trial_id = t.trial_id AND unrealized_move_pct IS NOT NULL AND changed_at <= ?
                    ORDER BY changed_at DESC LIMIT 1) as latest_move
            FROM validation_trials t
            WHERE t.detected_at <= ? AND t.state != 'RESOLVED'
            ORDER BY t.detected_at DESC
        `).all(refTime, refTime, refTime);

        // Resolved trials within DVR window
        const resolved = db.prepare(`
            SELECT t.*,
                   (SELECT unrealized_move_pct FROM validation_state_log
                    WHERE trial_id = t.trial_id AND unrealized_move_pct IS NOT NULL
                    ORDER BY changed_at DESC LIMIT 1) as final_move
            FROM validation_trials t
            WHERE t.detected_at <= ? AND t.state = 'RESOLVED'
              AND (t.resolved_at IS NULL OR t.resolved_at <= ?)
            ORDER BY t.resolved_at DESC LIMIT ?
        `).all(refTime, refTime, limit);

        // ─── Enrich every trial with master_coin_store snapshot at trigger time ───
        // Single point-in-time read per trial. Uses the (ticker, timestamp) index.
        // Returns a compact `master_state` field so the inline mini-chart card has
        // EMA/vol/mood without N+1 fetches. Full timeline lives at /trial/:id/timeline.
        const masterStmt = db.prepare(`
            SELECT timestamp, price, ingestion_source, merged_state
            FROM master_coin_store
            WHERE ticker = ? AND timestamp <= ?
            ORDER BY timestamp DESC
            LIMIT 1
        `);

        const enrich = (trial) => {
            try {
                const snap = masterStmt.get(trial.ticker, trial.detected_at);
                if (!snap) return { ...trial, master_state: null };
                let merged = null;
                try { merged = snap.merged_state ? JSON.parse(snap.merged_state) : null; } catch {}
                return {
                    ...trial,
                    master_state: merged ? {
                        snapshot_at: snap.timestamp,
                        snapshot_price: snap.price,
                        ingestion_source: snap.ingestion_source,
                        stream_a: merged.stream_a || null,
                        stream_b: merged.stream_b || null,
                        stream_c: merged.stream_c || null,
                    } : null,
                };
            } catch { return { ...trial, master_state: null }; }
        };

        // Replay mode: recompute state from state_log if trial was still active at refTime
        const replayActive = [];
        for (const t of active) {
            const stateAtRef = db.prepare(`
                SELECT state FROM validation_state_log
                WHERE trial_id = ? AND changed_at <= ?
                ORDER BY changed_at DESC LIMIT 1
            `).get(t.trial_id, refTime);
            replayActive.push(enrich({ ...t, replay_state: stateAtRef?.state || t.state }));
        }

        const enrichedResolved = resolved.map(enrich);

        res.json({ active: replayActive, resolved: enrichedResolved, refTime });
    } catch (e) {
        console.error('Validator trials error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// DAILY PERFORMANCE CALENDAR
// ============================================================================
// GET /api/calendar/daily?days=7
// Returns one row per day for the requested lookback. Each row aggregates:
//   - market_mood: dominant raw_market_sentiment_log label of the day
//   - market_score: avg moodScore across the day's scans
//   - trials: { total, confirmed, failed, neutral, win_rate_pct }
//   - top_movers: { gainers: [{ticker, change_pct}], losers: [...] } based on
//     master_coin_store first→last close per ticker per day
// Compact summary; full per-coin heatmap available at /api/calendar/day/:date.
app.get('/api/calendar/daily', (req, res) => {
    try {
        const days = Math.min(parseInt(req.query.days) || 7, 30);
        const now = new Date();
        const result = [];

        for (let i = 0; i < days; i++) {
            const day = new Date(now);
            day.setUTCDate(now.getUTCDate() - i);
            const dateStr = day.toISOString().slice(0, 10);
            const dayStart = `${dateStr}T00:00:00.000Z`;
            const dayEnd = `${dateStr}T23:59:59.999Z`;

            // Market mood — dominant label and avg score for the day
            const mood = db.prepare(`
                SELECT raw_label as label, COUNT(*) as c, AVG(raw_mood_score) as avg_score
                FROM raw_market_sentiment_log
                WHERE timestamp BETWEEN ? AND ?
                GROUP BY raw_label
                ORDER BY c DESC LIMIT 1
            `).get(dayStart, dayEnd);

            // Trial verdict counts for the day
            const trialAgg = db.prepare(`
                SELECT
                    COUNT(*) as total,
                    SUM(CASE WHEN verdict = 'CONFIRMED' THEN 1 ELSE 0 END) as confirmed,
                    SUM(CASE WHEN verdict = 'FAILED' THEN 1 ELSE 0 END) as failed,
                    SUM(CASE WHEN verdict = 'NEUTRAL_TIMEOUT' THEN 1 ELSE 0 END) as neutral
                FROM validation_trials
                WHERE detected_at BETWEEN ? AND ?
            `).get(dayStart, dayEnd);
            const decisive = (trialAgg?.confirmed || 0) + (trialAgg?.failed || 0);
            const winRate = decisive > 0 ? Math.round(((trialAgg.confirmed || 0) / decisive) * 100) : null;

            // Top movers from master_coin_store: per-ticker first vs last price.
            // Single-pass CTE avoids N correlated subqueries (7 days × many tickers).
            const dayPrices = db.prepare(`
                WITH ranked AS (
                    SELECT ticker, price,
                        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp ASC)  AS rn_first,
                        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS rn_last
                    FROM master_coin_store
                    WHERE timestamp BETWEEN ? AND ?
                )
                SELECT
                    ticker,
                    MAX(CASE WHEN rn_first = 1 THEN price END) AS first_price,
                    MAX(CASE WHEN rn_last  = 1 THEN price END) AS last_price
                FROM ranked
                GROUP BY ticker
            `).all(dayStart, dayEnd);

            const movers = dayPrices
                .filter(r => r.first_price > 0 && r.last_price > 0)
                .map(r => ({ ticker: r.ticker, change_pct: ((r.last_price - r.first_price) / r.first_price) * 100 }))
                .sort((a, b) => b.change_pct - a.change_pct);

            result.push({
                date: dateStr,
                market: {
                    mood: mood?.label || 'UNKNOWN',
                    score: mood ? Math.round(mood.avg_score) : null,
                },
                trials: {
                    total: trialAgg?.total || 0,
                    confirmed: trialAgg?.confirmed || 0,
                    failed: trialAgg?.failed || 0,
                    neutral: trialAgg?.neutral || 0,
                    win_rate_pct: winRate,
                },
                top_gainers: movers.slice(0, 3),
                top_losers: movers.slice(-3).reverse(),
                coins_tracked: movers.length,
            });
        }

        res.json({ days, generated_at: now.toISOString(), calendar: result });
    } catch (e) {
        console.error('Calendar daily error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/calendar/day/:date — full drill-down for a single day (YYYY-MM-DD UTC).
// Returns the complete heatmap: every ticker tracked that day with day Δ%,
// trial outcomes per ticker, intraday hi/lo, and market mood timeline.
app.get('/api/calendar/day/:date', (req, res) => {
    try {
        const dateStr = req.params.date;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
        const dayStart = `${dateStr}T00:00:00.000Z`;
        const dayEnd = `${dateStr}T23:59:59.999Z`;

        // Per-ticker price stats from master_coin_store.
        // Single-pass CTE with window functions avoids N correlated subqueries
        // (critical for "today" which has the most rows; was timing out).
        const perTicker = db.prepare(`
            WITH ranked AS (
                SELECT ticker, price, timestamp,
                    ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp ASC)  AS rn_first,
                    ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS rn_last
                FROM master_coin_store
                WHERE timestamp BETWEEN ? AND ?
            )
            SELECT
                ticker,
                COUNT(*) AS samples,
                MIN(price) AS low,
                MAX(price) AS high,
                MAX(CASE WHEN rn_first = 1 THEN price END) AS open,
                MAX(CASE WHEN rn_last  = 1 THEN price END) AS close
            FROM ranked
            GROUP BY ticker
        `).all(dayStart, dayEnd);

        // Per-ticker trial outcomes
        const trialsByTicker = db.prepare(`
            SELECT ticker,
                   COUNT(*) as total,
                   SUM(CASE WHEN verdict='CONFIRMED' THEN 1 ELSE 0 END) as confirmed,
                   SUM(CASE WHEN verdict='FAILED' THEN 1 ELSE 0 END) as failed,
                   SUM(CASE WHEN verdict='NEUTRAL_TIMEOUT' THEN 1 ELSE 0 END) as neutral,
                   SUM(CASE WHEN direction='LONG' THEN 1 ELSE 0 END) as longs,
                   SUM(CASE WHEN direction='SHORT' THEN 1 ELSE 0 END) as shorts
            FROM validation_trials
            WHERE detected_at BETWEEN ? AND ?
            GROUP BY ticker
        `).all(dayStart, dayEnd);
        const trialMap = Object.fromEntries(trialsByTicker.map(r => [r.ticker, r]));

        // Build heatmap rows
        const heatmap = perTicker
            .filter(r => r.open > 0 && r.close > 0)
            .map(r => {
                const change_pct = ((r.close - r.open) / r.open) * 100;
                const range_pct = ((r.high - r.low) / r.low) * 100;
                const trials = trialMap[r.ticker] || { total: 0, confirmed: 0, failed: 0, neutral: 0, longs: 0, shorts: 0 };
                const decisive = trials.confirmed + trials.failed;
                return {
                    ticker: r.ticker,
                    open: r.open, close: r.close, low: r.low, high: r.high,
                    change_pct, range_pct, samples: r.samples,
                    trials: {
                        ...trials,
                        win_rate_pct: decisive > 0 ? Math.round((trials.confirmed / decisive) * 100) : null,
                    },
                };
            })
            .sort((a, b) => b.change_pct - a.change_pct);

        // Market mood progression through the day
        const moodTimeline = db.prepare(`
            SELECT timestamp, raw_label, raw_mood_score
            FROM raw_market_sentiment_log
            WHERE timestamp BETWEEN ? AND ?
            ORDER BY timestamp ASC
        `).all(dayStart, dayEnd);

        res.json({
            date: dateStr,
            heatmap,
            mood_timeline: moodTimeline,
            coin_count: heatmap.length,
        });
    } catch (e) {
        console.error('Calendar day error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/validator/trial/:trialId/ohlc?interval=5 (minutes, default 5)
// Groups master_coin_store price snapshots into real OHLC candles for the trial window.
// Also returns trial meta (trigger, level, cooldown/watch boundaries) for overlay lines.
app.get('/api/validator/trial/:trialId/ohlc', (req, res) => {
    try {
        const trial = db.prepare('SELECT * FROM validation_trials WHERE trial_id = ?').get(req.params.trialId);
        if (!trial) return res.status(404).json({ error: 'trial not found' });

        const intervalMin = Math.max(1, parseInt(req.query.interval) || 5);
        const intervalMs  = intervalMin * 60 * 1000;

        // Window: 1 bar before detection → resolved_at + 2 bars (or now + 2 bars)
        const detectedMs = new Date(trial.detected_at).getTime();
        const endMs = trial.resolved_at
            ? new Date(trial.resolved_at).getTime() + 2 * intervalMs
            : Date.now() + 2 * intervalMs;
        const startMs = detectedMs - intervalMs; // one bar before trigger

        const rows = db.prepare(`
            SELECT timestamp, price FROM master_coin_store
            WHERE ticker = ? AND timestamp BETWEEN ? AND ?
            ORDER BY timestamp ASC
        `).all(
            trial.ticker,
            new Date(startMs).toISOString(),
            new Date(endMs).toISOString()
        );

        // Bucket into OHLC candles
        const buckets = new Map();
        for (const row of rows) {
            const ms = new Date(row.timestamp).getTime();
            const bucketMs = Math.floor(ms / intervalMs) * intervalMs;
            if (!buckets.has(bucketMs)) {
                buckets.set(bucketMs, { open: row.price, high: row.price, low: row.price, close: row.price, samples: 1 });
            } else {
                const b = buckets.get(bucketMs);
                b.high = Math.max(b.high, row.price);
                b.low  = Math.min(b.low,  row.price);
                b.close = row.price;
                b.samples++;
            }
        }

        const candles = Array.from(buckets.entries())
            .sort(([a], [b]) => a - b)
            .map(([ts, b]) => ({
                ts,
                time: new Date(ts).toISOString(),
                open: b.open, high: b.high, low: b.low, close: b.close,
                samples: b.samples,
                bullish: b.close >= b.open,
            }));

        const featureSnap = (() => { try { return JSON.parse(trial.feature_snapshot); } catch { return {}; } })();
        const trig = Number(trial.trigger_price);
        const lvl  = Number(trial.level_price) || trig;

        // Use _price fields directly (preferred), fall back to computing from _dist_pct
        const emaPrice = (key) => {
            const direct = Number(featureSnap[`ema200_${key}_price`]);
            if (direct > 0) return direct;
            const distPct = featureSnap[`ema200_${key}_dist_pct`];
            if (distPct != null) return trig / (1 + distPct / 100);
            return null;
        };

        res.json({
            ticker: trial.ticker,
            direction: trial.direction,
            trigger_type: trial.trigger_type,
            level_type: trial.level_type,
            verdict: trial.verdict,
            // Price levels for overlay
            levels: {
                trigger: trig,
                smart_level: lvl,
                ema200_5m:  emaPrice('5m'),
                ema200_15m: emaPrice('15m'),
                ema200_1h:  emaPrice('1h'),
                ema200_4h:  emaPrice('4h'),
            },
            // Phase boundaries (ms) for vertical shading
            phases: {
                detected_ms:    detectedMs,
                cooldown_until_ms: trial.cooldown_until ? new Date(trial.cooldown_until).getTime() : null,
                watch_until_ms:    trial.watch_until    ? new Date(trial.watch_until).getTime()    : null,
                resolved_ms:       trial.resolved_at    ? new Date(trial.resolved_at).getTime()    : null,
            },
            interval_min: intervalMin,
            candle_count: candles.length,
            candles,
        });
    } catch (e) {
        console.error('Trial OHLC error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/validator/trial/:trialId/timeline — full forensic timeline for click-expand modal.
// Returns:
//   trial          : full validation_trials row
//   state_log      : every state transition with rule_snapshot + price + unrealized_move_pct
//   master_timeline: all master_coin_store snapshots from detected_at → resolved_at (or now)
//                    bounded to ±2h around the trial window for frontend perf
app.get('/api/validator/trial/:trialId/timeline', (req, res) => {
    try {
        const trial = db.prepare('SELECT * FROM validation_trials WHERE trial_id = ?').get(req.params.trialId);
        if (!trial) return res.status(404).json({ error: 'trial not found' });

        const stateLog = db.prepare(`
            SELECT log_id, changed_at, state, rule_snapshot, current_price, unrealized_move_pct
            FROM validation_state_log
            WHERE trial_id = ? ORDER BY changed_at ASC
        `).all(req.params.trialId);

        // Master timeline window: from 30m before detection to resolved_at (or now) + 30m buffer.
        const startISO = new Date(new Date(trial.detected_at).getTime() - 30 * 60 * 1000).toISOString();
        const endISO = trial.resolved_at
            ? new Date(new Date(trial.resolved_at).getTime() + 30 * 60 * 1000).toISOString()
            : new Date().toISOString();

        const masterTimeline = db.prepare(`
            SELECT timestamp, trigger_source, ingestion_source, price, merged_state
            FROM master_coin_store
            WHERE ticker = ? AND timestamp BETWEEN ? AND ?
            ORDER BY timestamp ASC
        `).all(trial.ticker, startISO, endISO).map(row => {
            let merged = null;
            try { merged = row.merged_state ? JSON.parse(row.merged_state) : null; } catch {}
            return {
                timestamp: row.timestamp,
                trigger_source: row.trigger_source,
                ingestion_source: row.ingestion_source,
                price: row.price,
                stream_a: merged?.stream_a || null,
                stream_b: merged?.stream_b || null,
                stream_c: merged?.stream_c || null,
            };
        });

        res.json({
            trial,
            state_log: stateLog,
            master_timeline: masterTimeline,
            window: { from: startISO, to: endISO },
        });
    } catch (e) {
        console.error('Trial timeline error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/validator/settings
app.get('/api/validator/settings', (req, res) => {
    try {
        res.json(require('./validator/settingsManager').getAll());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/validator/settings
app.post('/api/validator/settings', (req, res) => {
    try {
        const sm = require('./validator/settingsManager');
        const updated = {};
        for (const [key, value] of Object.entries(req.body)) {
            if (key.startsWith('validator.')) {
                sm.writeKey(key, value);
                updated[key] = value;
            }
        }
        res.json({ success: true, updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/validator/stats — returns pre-computed pattern_statistics
app.get('/api/validator/stats', (req, res) => {
    try {
        // Rebuild on demand if no stats exist yet
        const count = db.prepare('SELECT COUNT(*) as c FROM pattern_statistics').get();
        if (count.c === 0) rebuildStatistics();

        const stats = getStats({
            direction: req.query.direction,
            vol_filter: req.query.vol != null ? parseInt(req.query.vol) : undefined,
            ema_1h_align: req.query.ema1h != null ? parseInt(req.query.ema1h) : undefined,
            ema_4h_align: req.query.ema4h != null ? parseInt(req.query.ema4h) : undefined
        });
        res.json(stats);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /api/validator/stats/rebuild — manual trigger
app.post('/api/validator/stats/rebuild', (req, res) => {
    try {
        const written = rebuildStatistics();
        res.json({ success: true, entries: written });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/validator/export — CSV download for offline ML training
app.get('/api/validator/export', (req, res) => {
    try {
        const from = req.query.from || new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
        const to   = req.query.to   || new Date().toISOString();

        const trials = db.prepare(`
            SELECT t.*,
                   (SELECT unrealized_move_pct FROM validation_state_log
                    WHERE trial_id = t.trial_id AND unrealized_move_pct IS NOT NULL
                    ORDER BY changed_at DESC LIMIT 1) as final_move_pct
            FROM validation_trials t
            WHERE t.detected_at >= ? AND t.detected_at <= ?
            ORDER BY t.detected_at ASC
        `).all(from, to);

        if (trials.length === 0) return res.json({ message: 'No data in range', rows: 0 });

        const headers = [
            'trial_id','ticker','direction','trigger_type','level_type','trigger_price',
            'level_price','detected_at','verdict','failure_reason','final_move_pct',
            'ema200_5m_dist','ema200_15m_dist','ema200_1h_dist','ema200_4h_dist',
            'mega_spot_dist','rsi_h1','roc_pct','vol_spike','market_mood'
        ];

        const rows = [headers.join(',')];
        for (const t of trials) {
            let f = {};
            try { f = JSON.parse(t.feature_snapshot || '{}'); } catch {}
            rows.push([
                t.trial_id, t.ticker, t.direction, t.trigger_type, t.level_type,
                t.trigger_price, t.level_price, t.detected_at, t.verdict || '',
                t.failure_reason || '', t.final_move_pct ?? '',
                f.ema200_5m_dist_pct ?? '', f.ema200_15m_dist_pct ?? '',
                f.ema200_1h_dist_pct ?? '', f.ema200_4h_dist_pct ?? '',
                f.mega_spot_dist_pct ?? '', f.rsi_h1 ?? '',
                f.roc_pct ?? '', f.vol_spike ?? '', f.market_mood ?? ''
            ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="validation_trials_${from.slice(0,10)}_to_${to.slice(0,10)}.csv"`);
        res.send(rows.join('\n'));
    } catch (e) {
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
        const refTime = req.query.refTime ? new Date(req.query.refTime) : new Date();
        const anchorTime = isNaN(refTime.getTime()) ? new Date() : refTime;
        const anchorStr = anchorTime.toISOString();
        const cutoff = new Date(anchorTime.getTime() - hours * 60 * 60 * 1000).toISOString();

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
            WHERE timestamp > ? AND timestamp <= ?
            GROUP BY (CASE 
                WHEN timestamp LIKE '%-%' THEN strftime('%Y-%m-%d %H:%M', timestamp)
                ELSE strftime('%Y-%m-%d %H:%M', datetime(CAST(timestamp AS INTEGER)/1000, 'unixepoch'))
            END)
            ORDER BY min_time ASC
        `).all(cutoff, anchorStr);

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
        const latestScan = db.prepare('SELECT id FROM scans WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT 1').get(anchorStr);
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
            WHERE timestamp > ? AND timestamp <= ?
            ORDER BY timestamp DESC
            LIMIT 50
        `).all(cutoff, anchorStr);

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
        const refTime = req.query.refTime ? new Date(req.query.refTime) : new Date();
        const anchorTime = isNaN(refTime.getTime()) ? new Date() : refTime;
        const anchorStr = anchorTime.toISOString();

        // 1. Get Latest Scan
        const latestScan = db.prepare('SELECT id, timestamp FROM scans WHERE timestamp <= ? ORDER BY timestamp DESC LIMIT 1').get(anchorStr);
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
            const cutoff24 = new Date(anchorTime.getTime() - (24 * 60 * 60 * 1000)).toISOString();
            const activeSmartLevels = db.prepare(`
                SELECT ticker, raw_data
                FROM smart_level_events
                WHERE timestamp > ? AND timestamp <= ?
                GROUP BY ticker
                HAVING MAX(timestamp)
            `).all(cutoff24, anchorStr);

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
        const refTime = req.query.refTime ? new Date(req.query.refTime) : new Date();
        const anchorTime = isNaN(refTime.getTime()) ? new Date() : refTime;
        const anchorStr = anchorTime.toISOString();

        const logs = TelegramService.getLogs(limit, anchorStr);
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
        const refTime = req.query.refTime ? new Date(req.query.refTime) : new Date();
        const anchorTime = isNaN(refTime.getTime()) ? new Date() : refTime;
        const anchorStr = anchorTime.toISOString();
        const cutoff = new Date(anchorTime.getTime() - hours * 60 * 60 * 1000).toISOString();

        const rows = db.prepare(`
            SELECT ticker, timestamp, raw_data, strength, direction, origin
            FROM unified_alerts
            WHERE timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `).all(cutoff, anchorStr);

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

        // ─── TIMESTAMP POLICY (Stream C — WEBHOOK) ────────────────────────────
        // Single source of truth: TimestampResolver.
        // Webhook path = server receive time. payload.timestamp is BAR-OPEN time
        // from TradingView and lags 3–5 min — explicitly NOT used here.
        const resolved = TimestampResolver.resolve({
            stream: 'STREAM_C', source: 'WEBHOOK', payload
        });
        const parsedTimestamp = resolved.timestampISO;
        const payloadHash = TimestampResolver.computePayloadHash(payload);
        const ingestionSource = 'WEBHOOK';

        // Phase 9: Ingestion Routing Switch
        if (typeof payload.bar_move_pct !== 'undefined') {
            // Path A: Institutional Interest Payload
            const direction = payload.direction !== undefined ? parseInt(payload.direction, 10) : 0;
            const bar_move_pct = parseFloat(payload.bar_move_pct);
            const today_change_pct = parseFloat(payload.today_change_pct || 0);
            const today_volume = parseFloat(payload.today_volume || 0);

            // Hash-dedup: skip if rehydrator already wrote this exact payload.
            const dup = payloadHash
                ? db.prepare('SELECT id FROM institutional_interest_events WHERE payload_hash = ? LIMIT 1').get(payloadHash)
                : null;
            if (dup) {
                console.log(`[INST-INTEREST] ⏭️  Hash-dup skip: ${ticker} (already in DB via email)`);
            } else {
                db.prepare(`
                    INSERT OR IGNORE INTO institutional_interest_events
                    (ticker, timestamp, price, direction, bar_move_pct, today_change_pct, today_volume, raw_data, payload_hash, ingestion_source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(ticker, parsedTimestamp, price, direction, bar_move_pct, today_change_pct, today_volume, JSON.stringify(payload), payloadHash, ingestionSource);
                console.log(`[INST-INTEREST] 🏦 Institutional Webhook: ${ticker} | Dir: ${direction} | BarMove: ${bar_move_pct.toFixed(2)}%`);
                io.emit('institutional-interest-update', { ticker, direction, timestamp: parsedTimestamp });
            }
        } else {
            // Path B: Legacy Smart Levels (default fallback)
            const direction = payload.momentum?.direction !== undefined ? parseInt(payload.momentum.direction, 10) : (payload.direction || 0);
            const roc_pct = payload.momentum?.roc_pct !== undefined ? parseFloat(payload.momentum.roc_pct) : 0.0;

            const dup = payloadHash
                ? db.prepare('SELECT id FROM smart_level_events WHERE payload_hash = ? LIMIT 1').get(payloadHash)
                : null;
            if (dup) {
                console.log(`[SMART-LEVELS] ⏭️  Hash-dup skip: ${ticker} (already in DB via email)`);
            } else {
                db.prepare(`
                    INSERT OR IGNORE INTO smart_level_events
                    (ticker, timestamp, price, direction, roc_pct, raw_data, payload_hash, ingestion_source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(ticker, parsedTimestamp, price, direction, roc_pct, JSON.stringify(payload), payloadHash, ingestionSource);
                console.log(`[SMART-LEVELS] 🧠 Alert Received @ ${parsedTimestamp} | Ticker: ${ticker} | Payload Time: ${payload.timestamp || 'N/A'}`);
                io.emit('smart-level-update', { ticker, direction, timestamp: parsedTimestamp });
            }
        }

        // [V4 MASTER STORE INGESTION] - Stream C — pass resolved timestamp + source.
        setImmediate(() => {
            MasterStoreService.ingestStreamC(ticker, payload, price, {
                timestampISO: parsedTimestamp,
                ingestionSource,
                payloadHash,
            }).catch(e => console.error(e));
        });

        // [VOLUME-TRUTH] - Stream C alert moment = authoritative spike event.
        setImmediate(() => {
            try {
                VolumeEventService.onStreamC({
                    ticker,
                    ts: parsedTimestamp,
                    payload,
                    payloadHash,
                });
            } catch (e) { console.error('VolumeEvent C error:', e.message); }
        });

        // 3rd UMPIRE VALIDATOR — pass resolved timestamp (NEVER payload.timestamp).
        setImmediate(() => {
            try { umpire.onStreamC(payload, { resolvedTimestampISO: parsedTimestamp }); }
            catch (err) { console.error('Umpire onStreamC error:', err); }
        });

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
        const refTime = req.query.refTime ? new Date(req.query.refTime) : new Date();
        const anchorTime = isNaN(refTime.getTime()) ? new Date() : refTime;
        const anchorStr = anchorTime.toISOString();

        // 1. Get the latest Stream C events per ticker
        const streamC_Rows = db.prepare(`
            SELECT ticker, timestamp as alert_time, price, direction, roc_pct, raw_data 
            FROM smart_level_events 
            WHERE id IN (
                SELECT MAX(id) FROM smart_level_events WHERE timestamp <= ? GROUP BY ticker
            )
            ORDER BY timestamp DESC
        `).all(anchorStr);

        // 2. Get latest Stream A snapshot (Macro)
        const latestMacroRow = db.prepare('SELECT sr.raw_data FROM scan_results sr JOIN scans s ON sr.scan_id = s.id WHERE s.timestamp <= ? ORDER BY s.timestamp DESC LIMIT 1').get(anchorStr);
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
        const oneHourAgo = new Date(anchorTime.getTime() - 60 * 60 * 1000).toISOString();
        const streamB_Rows = db.prepare(`
            SELECT ticker, MAX(vol_change) as maxVolChange 
            FROM area1_scout_logs 
            WHERE timestamp > ? AND timestamp <= ?
            GROUP BY ticker
        `).all(oneHourAgo, anchorStr);
        const scoutTickers = new Set(streamB_Rows.map(r => r.ticker));
        const scoutDataMap = {};
        streamB_Rows.forEach(r => scoutDataMap[r.ticker] = r.maxVolChange);

        // 3.5 Get Burst History (Last 24 Hours of Stream C and Inst. Webhooks for these tickers)
        const twentyFourHoursAgo = new Date(anchorTime.getTime() - 24 * 60 * 60 * 1000).toISOString();
        const burstRows = db.prepare(`
            SELECT ticker, timestamp, direction, strength, origin 
            FROM unified_alerts 
            WHERE timestamp > ? AND timestamp <= ?
            ORDER BY timestamp DESC
        `).all(twentyFourHoursAgo, anchorStr);

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

// --- 3rd Umpire Validator ---
const umpire = new UmpireEngine({ io });
telegramValidator.attach(umpire, TelegramService);
umpire.start();

// ============================================================================
// LEVEL REACTION MONITOR — /api/level-reactions
// ============================================================================
//
// For each coin in the latest scan that is within ±maxDist% of a structural
// level (support or resistance), pulls master_coin_store price history and
// returns the path normalized as % above/below the level.  Used by the new
// LevelReactionWidget to draw swim-lane reaction charts.
//
// Query params:
//   window_min  (default 60)  — how far back to pull history (max 360)
//   interval    (default 5)   — bucket size in minutes (1/5/15/30)
//   limit       (default 12)  — max coins to return
//   max_dist    (default 5)   — max % distance from level to qualify

app.get('/api/level-reactions', (req, res) => {
    try {
        const windowMin  = Math.min(360, Math.max(15, parseInt(req.query.window_min) || 60));
        const intervalMin = Math.max(1, Math.min(30, parseInt(req.query.interval) || 5));
        const limit      = Math.min(20, Math.max(1, parseInt(req.query.limit) || 12));
        const maxDist    = Math.min(10, Math.max(0.5, parseFloat(req.query.max_dist) || 5));

        // ── 1. Latest scan ──────────────────────────────────────────────────
        const latestScanRow = db.prepare(
            'SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1'
        ).get();
        if (!latestScanRow) return res.json({ coins: [], window_min: windowMin });

        const scanData  = JSON.parse(latestScanRow.raw_data);
        const results   = scanData.results || [];
        const scanTs    = scanData.timestamp || new Date().toISOString();

        // ── 2a. Build smart-level label map from recent Stream C events ────────
        //  Gives us the real level type (EMA200_5M, FIB_618, DAILY_LOGIC …)
        //  for coins that have recently fired a webhook.
        const levelLabelMap = {};  // ticker → { supportLabel, resistLabel }
        const smLvlRows = db.prepare(`
            SELECT ticker, raw_data FROM smart_level_events
            WHERE id IN (SELECT MAX(id) FROM smart_level_events GROUP BY ticker)
        `).all();
        smLvlRows.forEach(row => {
            try {
                const raw = JSON.parse(row.raw_data);
                const sl  = raw.smart_levels || {};
                const e200 = sl.emas_200 || {};
                const labels = { support: [], resist: [] };

                // EMA200 hierarchy
                if (e200.m5?.p)  labels.support.push('EMA200_5M');
                if (e200.m15?.p) labels.support.push('EMA200_15M');
                if (e200.h1?.p)  labels.support.push('EMA200_1H');
                if (e200.h4?.p)  labels.support.push('EMA200_4H');

                // Mega spot
                if (sl.mega_spot?.p)  labels.support.push('MEGA_SPOT');

                // FIBs (resistance side)
                if (sl.fibs_618?.h1?.p) labels.resist.push('FIB_618');

                // Daily / hourly logic
                if (sl.daily_logic?.base_res?.p)   labels.resist.push('DAILY_RES');
                if (sl.daily_logic?.base_supp?.p)  labels.support.push('DAILY_SUPP');
                if (sl.daily_logic?.neck_res?.p)   labels.resist.push('DAILY_NECK_R');
                if (sl.hourly_logic?.base_res?.p)  labels.resist.push('HOURLY_RES');
                if (sl.hourly_logic?.base_supp?.p) labels.support.push('HOURLY_SUPP');

                levelLabelMap[row.ticker] = {
                    supportLabel: labels.support[0] || null,
                    resistLabel:  labels.resist[0]  || null,
                };
            } catch {}
        });

        // ── 2b. Compute level proximity for every coin ──────────────────────
        const candidates = [];

        results.forEach(r => {
            const d      = r.data || r;
            const ticker = (d.ticker || r.ticker || '').trim();
            const close  = parseFloat(d.close || 0);
            if (!ticker || !close) return;

            // Signed % distance convention:
            //   positive supportDist  → price is X% ABOVE support (healthy hold)
            //   negative supportDist  → price is X% BELOW support (broke down)
            //   positive resistDist   → price is X% BELOW resistance (approaching)
            //   negative resistDist   → price is X% ABOVE resistance (broke out)
            const hasLogicS = d.logicSupportDist != null;
            const hasLogicR = d.logicResistDist  != null;
            const sDist = parseFloat(hasLogicS ? d.logicSupportDist : (d.supportDist ?? 999));
            const rDist = parseFloat(hasLogicR ? d.logicResistDist  : (d.resistDist  ?? 999));

            const absS = Math.abs(sDist);
            const absR = Math.abs(rDist);

            if (absS > maxDist && absR > maxDist) return;

            const smLabels = levelLabelMap[ticker] || {};

            // Pick the level the coin is CLOSEST to (absolute dist)
            let side, distPct, levelPrice, levelLabel;
            if (absS <= absR) {
                side       = 'SUPPORT';
                distPct    = sDist;
                levelPrice = close / (1 + distPct / 100);
                // Label preference: Stream C type → logic vs structural hint
                levelLabel = smLabels.supportLabel
                    || (hasLogicS ? 'LOGIC_SUPP' : 'STRUCT_SUPP');
            } else {
                side       = 'RESISTANCE';
                distPct    = rDist;
                levelPrice = close * (1 + distPct / 100);
                levelLabel = smLabels.resistLabel
                    || (hasLogicR ? 'LOGIC_RES' : 'STRUCT_RES');
            }

            candidates.push({
                ticker,
                cleanTicker: (r.cleanTicker || ticker.replace(/USDT\.P$|USDT$/, '')).toUpperCase(),
                close,
                side,
                distPct,
                absDistPct: Math.min(absS, absR),
                levelPrice,
                levelLabel,
                direction:  d.direction || 'NEUTRAL',
                netTrend:   parseFloat(d.netTrend || 0),
                volSpike:   d.volSpike === 1 || d.volSpike === '1' || d.volSpike === true,
                momScore:   parseFloat(d.momScore || 0),
                breakout:   d.breakout === 1,
                sDist, rDist,
                dailyRange: parseFloat(d.dailyRange || 0),
            });
        });

        // Sort closest-to-level first
        candidates.sort((a, b) => a.absDistPct - b.absDistPct);
        const topCoins = candidates.slice(0, limit);

        // ── 3. Pull master_coin_store history per coin ──────────────────────
        const intervalMs = intervalMin * 60 * 1000;
        const startISO   = new Date(Date.now() - windowMin * 60 * 1000).toISOString();

        const coins = topCoins.map(coin => {
            const rows = db.prepare(`
                SELECT timestamp, price
                FROM master_coin_store
                WHERE ticker = ? AND timestamp >= ?
                ORDER BY timestamp ASC
            `).all(coin.ticker, startISO);

            // Bucket into intervals (use candle close = last price in bucket)
            const buckets = new Map();
            for (const row of rows) {
                const ms  = new Date(row.timestamp).getTime();
                const key = Math.floor(ms / intervalMs) * intervalMs;
                const b   = buckets.get(key);
                if (!b) {
                    buckets.set(key, { open: row.price, close: row.price, count: 1 });
                } else {
                    b.close = row.price;
                    b.count++;
                }
            }

            const history = Array.from(buckets.entries())
                .sort(([a], [b]) => a - b)
                .map(([ts, b]) => ({
                    ts,
                    price: b.close,
                    // Normalize: % above/below the level price (0 = exactly at level)
                    pct: ((b.close - coin.levelPrice) / coin.levelPrice) * 100,
                }));

            // ── 4. Classify reaction ────────────────────────────────────────
            let reaction = 'APPROACHING';
            if (history.length >= 2) {
                const pcts      = history.map(h => h.pct);
                const lastPct   = pcts[pcts.length - 1];
                const firstPct  = pcts[0];
                const minPct    = Math.min(...pcts);
                const maxPct    = Math.max(...pcts);
                const swing     = lastPct - firstPct;

                if (coin.side === 'SUPPORT') {
                    // distPct < 0 → price already broke below support
                    if (coin.distPct < -0.8)                          reaction = 'BREAK_BEAR';
                    else if (minPct < 0.2 && lastPct >  0.3)         reaction = 'BOUNCE';
                    else if (Math.abs(lastPct) <= 0.5)                reaction = 'TESTING';
                    else if (lastPct > 0.5 && swing > 0.15)          reaction = 'BOUNCE';
                    else                                               reaction = 'APPROACHING';
                } else {
                    // RESISTANCE
                    // distPct < 0 → price already broke above resistance
                    if (coin.distPct < -0.8)                          reaction = 'BREAK_BULL';
                    else if (maxPct > -0.2 && lastPct < -0.3)        reaction = 'REJECT';
                    else if (Math.abs(lastPct) <= 0.5)                reaction = 'TESTING';
                    else if (lastPct < -0.5 && swing < -0.15)        reaction = 'REJECT';
                    else                                               reaction = 'APPROACHING';
                }
            } else if (Math.abs(coin.distPct) <= 0.3) {
                reaction = 'TESTING';
            }

            // ── 5. Attach latest Stream D snapshot (RSI / EMA / ATR / RelVol) ──────
            const streamD = MasterStoreService.getLatestStreamD(coin.ticker);

            return {
                ticker:         coin.ticker,
                cleanTicker:    coin.cleanTicker,
                close:          coin.close,
                side:           coin.side,
                distPct:        coin.distPct,
                levelPrice:     coin.levelPrice,
                levelLabel:     coin.levelLabel,
                direction:      coin.direction,
                netTrend:       coin.netTrend,
                volSpike:       coin.volSpike,
                momScore:       coin.momScore,
                breakout:       coin.breakout,
                dailyRange:     coin.dailyRange,
                sDist:          coin.sDist,
                rDist:          coin.rDist,
                reaction,
                snapshot_count: rows.length,
                history,
                stream_d:       streamD ? { data: streamD.data, ts: streamD.ts } : null,
            };
        });

        res.json({
            coins,
            window_min:   windowMin,
            interval_min: intervalMin,
            scan_ts:      scanTs,
            total_in_scan: results.length,
        });
    } catch (e) {
        console.error('[LevelReactions] error:', e);
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 V3 Server running on port ${PORT} (All Interfaces)`);

    // One-shot volume-events backfill from existing history.
    // Idempotent (UNIQUE INDEX on ticker+ts+source dedupes), so safe on every boot.
    setImmediate(() => {
        try { VolumeEventService.backfill({ verbose: true }); }
        catch (e) { console.error('VolumeEvent backfill error:', e.message); }
    });
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


