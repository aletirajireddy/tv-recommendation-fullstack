const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const compression = require('compression');
const path = require('path');
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
const smartAlertsService   = require('./services/smartAlerts/service');
const smartAlertsEvaluator = require('./services/smartAlerts/evaluator');
const smartAlertsRouter    = require('./routes/smartAlerts');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    // Tailscale Serve proxies WebSocket upgrades cleanly but terminates
    // long-lived HTTP connections. Prefer WebSocket; allow polling only as
    // last resort. Shorter pingTimeout keeps connections from stalling through
    // the Tailscale HTTPS proxy layer.
    transports: ['websocket', 'polling'],
    pingTimeout:  20000,   // 20s — close dead connections promptly
    pingInterval: 10000,   // 10s heartbeat — keeps WS tunnel alive through proxy
    allowEIO3: true,       // accept legacy Socket.IO v3 clients (Tampermonkey scripts)
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- GZIP COMPRESSION (Institutional Bandwidth Win) ---
// Compresses every JSON/text response 5–10× over the wire. Critical for
// large endpoints like /api/ai/history (~187KB → ~25KB) and /api/validator/trials.
// Defaults: only compresses responses > 1KB and only if client sent Accept-Encoding: gzip.
// CPU cost: negligible (level 6 by default; <1ms for typical payloads on this hardware).
// SAFE: skips already-compressed types (images, video) automatically.
app.use(compression({
    threshold: 1024,           // skip tiny responses where compression overhead > savings
    filter: (req, res) => {
        // Honor explicit no-compression hint from clients (rare, mostly proxies)
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    },
}));

// ============================================================================
// V3 ROUTES
// ============================================================================

// Smart Alerts (EMA200-based smart alert system, ATR-normalised triggers)
app.use('/api/smart-alerts', smartAlertsRouter);
smartAlertsEvaluator.init({ io, db });

// ─── Price parsing helper ────────────────────────────────────────────────────
// TradingView screeners and Tampermonkey sometimes send prices as formatted
// strings with thousands-separator commas: "77,000.00", "1,234.5678".
// Plain parseFloat("77,000.00") = 77  ← stops at the comma.
// This strips ALL commas before parsing, handles numbers pass-through cleanly.
function parsePrice(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const cleaned = String(v).replace(/,/g, '');
    const n = parseFloat(cleaned);
    return isFinite(n) ? n : 0;
}

// ── coin_metric_history helpers ───────────────────────────────────────────────
// Extract ATR% or RVOL from a Stream D data object by resolution (minutes).
function _extractStreamDField(data, pattern, resolutionMin) {
    const re = new RegExp(pattern + resolutionMin + '$', 'i');
    for (const key of Object.keys(data)) {
        if (re.test(key)) {
            const v = parseFloat(data[key]);
            return isFinite(v) ? v : null;
        }
    }
    return null;
}

// 2-min bucket dedup: floor ts to nearest 2 minutes
function _bucket2min(tsMs) { return Math.floor(tsMs / 120000) * 120000; }

const _insertCoinMetric = db.prepare(`
    INSERT OR REPLACE INTO coin_metric_history
      (ticker, ts,
       atr_m15, atr_h1, atr_h4,
       rvol_m15, rvol_h1,
       dist_m1, dist_m5, dist_m15, dist_h1, dist_h4,
       rsi_m5, rsi_m15, rsi_m30, rsi_h1)
    VALUES
      (@ticker, @ts,
       @atr_m15, @atr_h1, @atr_h4,
       @rvol_m15, @rvol_h1,
       @dist_m1, @dist_m5, @dist_m15, @dist_h1, @dist_h4,
       @rsi_m5, @rsi_m15, @rsi_m30, @rsi_h1)
`);
const _pruneCoinMetric = db.prepare(
    `DELETE FROM coin_metric_history WHERE ts < ?`
);

function writeCoinMetric(ticker, tsMs, data) {
    try {
        const bucket = _bucket2min(tsMs);

        // ATR%
        const atr_m15 = _extractStreamDField(data, 'averagetruerangepercent_14Timeresolution', 15);
        const atr_h1  = _extractStreamDField(data, 'averagetruerangepercent_14Timeresolution', 60);
        const atr_h4  = _extractStreamDField(data, 'averagetruerangepercent_14Timeresolution', 240);

        // Relative Volume (try multiple key variants TV has used)
        const _rvol = (res) =>
            _extractStreamDField(data, 'relative_volume_at_time_Timeresolution', res)
         ?? _extractStreamDField(data, 'relativevolume_liveTimeresolution', res)
         ?? _extractStreamDField(data, 'relativevolumeattime_14Timeresolution', res)
         ?? _extractStreamDField(data, 'relativevolumecexTimeresolution', res);
        const rvol_m15 = _rvol(15);
        const rvol_h1  = _rvol(60);

        // EMA 200 distances: ((price - ema200) / ema200) × 100
        const price  = parseFloat(data.close || data.price) || null;
        const _ema   = (res) => _extractStreamDField(data, 'ema_200Timeresolution', res);
        const _dist  = (ema) => (price && ema) ? ((price - ema) / ema) * 100 : null;
        const dist_m1  = _dist(_ema(1));
        const dist_m5  = _dist(_ema(5));
        const dist_m15 = _dist(_ema(15));
        const dist_h1  = _dist(_ema(60));
        const dist_h4  = _dist(_ema(240));

        // RSI 14 — all 4 TFs now arriving from Stream D
        const rsi_m5  = _extractStreamDField(data, 'relativestrengthindex_14Timeresolution', 5);
        const rsi_m15 = _extractStreamDField(data, 'relativestrengthindex_14Timeresolution', 15);
        const rsi_m30 = _extractStreamDField(data, 'relativestrengthindex_14Timeresolution', 30);
        const rsi_h1  = _extractStreamDField(data, 'relativestrengthindex_14Timeresolution', 60);

        // Skip entirely if nothing arrived
        if ([atr_m15, atr_h1, rvol_m15, rvol_h1, dist_m15, dist_h1,
             rsi_m5, rsi_m15, rsi_m30, rsi_h1].every(v => v == null)) return;

        _insertCoinMetric.run({
            ticker, ts: bucket,
            atr_m15, atr_h1, atr_h4,
            rvol_m15, rvol_h1,
            dist_m1, dist_m5, dist_m15, dist_h1, dist_h4,
            rsi_m5, rsi_m15, rsi_m30, rsi_h1,
        });
        // Prune rows older than 8 hours (runs inline, <1ms on tiny table)
        _pruneCoinMetric.run(Date.now() - 8 * 60 * 60 * 1000);
    } catch (e) { /* non-blocking — never crash the handler */ }
}

// 1. HEALTH CHECK
app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: 'v3-fresh-start', timestamp: new Date() });
});

// 1.5 QUAD-STREAM HEALTH MONITORING
// --- HEALTH CACHE (30s TTL) ---
// Stream timestamps change at scan cadence (1-5 min); caching for 30s is safe and
// drops repeated calls from ~2.9s on a busy DB to <1ms cache hit.
// Hoisted prepared statements avoid query-plan recompilation on each miss.
let _healthCache = { ts: 0, data: null };
const HEALTH_CACHE_TTL = 30_000; // 30s
const _healthStmtA = db.prepare(`SELECT timestamp FROM scans ORDER BY timestamp DESC LIMIT 1`);
const _healthStmtB = db.prepare(`SELECT timestamp FROM market_context_logs ORDER BY timestamp DESC LIMIT 1`);
const _healthStmtC = db.prepare(`SELECT timestamp FROM unified_alerts ORDER BY timestamp DESC LIMIT 1`);
// Stream D: coin_metric_history stores ts as Unix ms — convert to ISO string for consistency.
// Uses idx_cmh_ticker_ts (ticker, ts DESC) — ORDER BY ts DESC LIMIT 1 hits leaf of B-tree.
const _healthStmtD = db.prepare(`SELECT ts FROM coin_metric_history ORDER BY ts DESC LIMIT 1`);

app.get('/api/system/health', (req, res) => {
    try {
        const now = Date.now();
        if (_healthCache.data && (now - _healthCache.ts) < HEALTH_CACHE_TTL) {
            // Cache hit — set short max-age so any intermediary caches also benefit
            res.set('Cache-Control', 'public, max-age=15');
            return res.json(_healthCache.data);
        }

        const streamA = _healthStmtA.get();
        const streamB = _healthStmtB.get();
        const streamC = _healthStmtC.get();
        const streamD = _healthStmtD.get();

        const data = {
            success: true,
            streamA: streamA ? streamA.timestamp : null,
            streamB: streamB ? streamB.timestamp : null,
            streamC: streamC ? streamC.timestamp : null,
            // D stores Unix ms — expose as ISO string to match A/B/C format
            streamD: streamD ? new Date(streamD.ts).toISOString() : null,
        };
        _healthCache = { ts: now, data };
        res.set('Cache-Control', 'public, max-age=15');
        res.json(data);
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

        // ── Stream A deduplication gate ────────────────────────────────────────────
        // TradingView screener sends the same coin from many exchanges simultaneously
        // (BINANCE:XRPUSDT.P, BYBIT:XRPUSDT.P, OKX:XRPUSDT.P …).  If we don't
        // collapse them here the duplicate full-tickers end up in master_targets,
        // which the scanner adds back to its watchlist, inflating Stream B next cycle.
        // We keep only .P perpetuals and pick the highest-priority exchange per coin.
        if (payload.results && Array.isArray(payload.results)) {
            const rawCount = payload.results.length;
            payload.results = _deduplicateStreamA(payload.results);
            if (payload.results.length !== rawCount) {
                console.log(`[Stream A] Deduped ${rawCount} → ${payload.results.length} unique .P coins`);
            }
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
                neutral: neutral,
                tickers: payload.market_sentiment?.tickers || { bullish: [], bearish: [] }
            };

            console.log(`[INGRESS] Sanitized Scan: ${moodScore}% (${label}) | Overwrote Scores`);
        }

        // B. Insert Scan Results (Sanitized JSON Blob)
        db.prepare('INSERT INTO scan_results (scan_id, raw_data) VALUES (?, ?)')
            .run(scanId, JSON.stringify(payload));

        // Invalidate the /api/ai/history cache — new row means slider/sparkline
        // would otherwise show stale 30s-old data until next TTL expiry.
        // Cheap (just a Map.clear()), called once per scan (~every 2min).
        _invalidateHistoryCache();

        // [V4 MASTER STORE INGESTION] - Fire and forget
        // Stream A: trust payload.timestamp (browser is ground truth).
        if (payload.results && Array.isArray(payload.results)) {
            setImmediate(() => {
                payload.results.forEach(item => {
                    const d = item.data || item;
                    // Strip exchange prefix from datakey (e.g. "BINANCE:XRPUSDT.P" → "XRPUSDT.P").
                    // The old .replace('BINANCE:', '') only handled Binance — any other exchange
                    // prefix would be stored verbatim ("BYBIT:XRPUSDT.P"), creating ghost keys.
                    const rawKey   = item.datakey || '';
                    const colonIdx = rawKey.indexOf(':');
                    const ticker   = colonIdx >= 0 ? rawKey.slice(colonIdx + 1) : (item.ticker || rawKey);
                    const price = parsePrice(d.close || d.price);
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

        // D2. SMART ALERTS — fire-and-forget evaluation pass against fresh EMA/ATR data.
        // Runs out-of-band so it never blocks the scan ingestion path. Each alert is
        // evaluated against the latest Stream D snapshot per ticker (batched).
        setImmediate(() => {
            smartAlertsEvaluator.evaluateAll('scan-update')
                .catch(err => console.error('[SmartAlerts] eval error:', err.message));
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

// Coin Whitelist — permanently immune to ghost pruning (user-managed, like PERMANENT_MAJORS)
db.prepare(`
    CREATE TABLE IF NOT EXISTS coin_whitelist (
        ticker   TEXT PRIMARY KEY,
        exchange TEXT NOT NULL DEFAULT 'BINANCE',
        added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
`).run();

// ── Watchlist Sync Audit ─────────────────────────────────────────────────────
// Closed-loop verification that the TV watchlist actually received what the
// backend asked for. There is no way to confirm an Automa run succeeded from
// the browser side, so we verify from the DATA instead: after we publish
// master_targets, every subsequent Stream B snapshot tells us what TradingView
// really contains. A target that stays missing across cycles means the Automa
// push silently failed — we then escalate with action_required=UPDATE_WATCHLIST.
db.prepare(`
    CREATE TABLE IF NOT EXISTS watchlist_sync_audit (
        ticker               TEXT PRIMARY KEY,
        first_missing_at     TEXT NOT NULL,
        last_missing_at      TEXT NOT NULL,
        consecutive_misses   INTEGER NOT NULL DEFAULT 1,
        escalations          INTEGER NOT NULL DEFAULT 0,
        last_escalated_at    TEXT,
        last_resolved_at     TEXT,
        resolve_count        INTEGER NOT NULL DEFAULT 0
    )
`).run();

// ── Watchlist Wipe Events ────────────────────────────────────────────────────
// Automa's update is DESTRUCTIVE and NON-ATOMIC: it clears the TradingView
// watchlist first, then types the new list. If the second step fails (observed
// directly — the "enter" keystroke doesn't land), the watchlist is left EMPTY
// and the system goes blind until something restores it.
//
// Evidence from market_context_logs: 24 of 24 zero-count runs began from a
// NON-EMPTY watchlist, including 33→0→15 (half the list lost) and one 179-minute
// blackout. Zero-count is therefore a WIPE signature, not a read failure.
//
// Each wipe is recorded here so downtime is measurable rather than invisible.
db.prepare(`
    CREATE TABLE IF NOT EXISTS watchlist_wipe_events (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        detected_at       TEXT NOT NULL,
        prev_count        INTEGER,
        restore_attempts  INTEGER NOT NULL DEFAULT 0,
        last_attempt_at   TEXT,
        recovered_at      TEXT,
        recovered_count   INTEGER,
        downtime_sec      INTEGER
    )
`).run();

// Fresh Session round-trip audit — a click on the widget only PROVES intent
// (the DB history was wiped); it does not prove Automa actually cleared the
// live watchlist. This table tracks the full lifecycle so the widget can show
// "waiting to hear back" honestly instead of declaring success on request alone.
db.prepare(`
    CREATE TABLE IF NOT EXISTS fresh_session_events (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        requested_at      TEXT NOT NULL,
        expected_targets  TEXT NOT NULL,   -- JSON array, captured at request time
        consumed_at       TEXT,            -- browser's next check-in received the signal
        confirmed_at      TEXT,            -- watchlist verified matching (no foreign coins left)
        status            TEXT NOT NULL DEFAULT 'PENDING',
        -- PENDING (armed, not yet seen by browser) -> AWAITING_CONFIRMATION
        -- (browser consumed it) -> CONFIRMED (verified) | TIMED_OUT (gave up waiting)
        last_checked_at   TEXT,
        last_extra_count  INTEGER,
        cleared_counts    TEXT             -- JSON of the DB row-clear counts
    )
`).run();
// Migration: add exchange column to existing installs that only have ticker + added_at
try {
    db.prepare("ALTER TABLE coin_whitelist ADD COLUMN exchange TEXT NOT NULL DEFAULT 'BINANCE'").run();
} catch (_) { /* column already exists — fine */ }

/* ─────────────────────────────────────────────────────────────────────────────
 * WATCHLIST SYNC RECONCILIATION
 *
 * Problem: when the backend publishes master_targets, the Tampermonkey script
 * copies them to the clipboard and opens the Automa tab — then assumes success.
 * If Automa is disabled, its workflow broke, or the tab never ran, the coins
 * never reach TradingView and NOTHING reports the failure. Whitelisted coins
 * (and even BTC/ETH) can stay missing for months, which is exactly what
 * happened to PUMP.
 *
 * Fix: verify from the data. Every Stream B snapshot reports what TradingView
 * ACTUALLY contains. Compare that against what we asked for:
 *   • target present      → resolved (clear any outstanding miss)
 *   • target still absent → increment consecutive_misses
 *   • misses >= threshold → escalate with action_required=UPDATE_WATCHLIST,
 *                           which sets isForcedUpdate in the script and
 *                           bypasses its 15-min Automa cooldown.
 *
 * Only evaluated on VALID snapshots (uniqueCount > 0). A zero-count read means
 * the panel wasn't readable — that's a scraper problem, not an Automa failure,
 * and judging it would produce false escalations.
 * ────────────────────────────────────────────────────────────────────────── */

// Escalate once a target has been missing this many consecutive valid snapshots.
// 2 gives Automa a full cycle (~5-10 min) to land before we re-fire.
const _SYNC_ESCALATE_AFTER_MISSES = 2;
// Minimum gap between escalations for the same ticker — stops a broken Automa
// from being re-triggered on every single snapshot.
const _SYNC_ESCALATE_COOLDOWN_MS = 10 * 60 * 1000;

/** Persistent replacement for the old in-memory `_pendingWhitelistSync` flag.
 *  An in-memory boolean is lost on every restart, so a coin whitelisted before
 *  a restart never got its one-shot UPDATE_WATCHLIST. Backed by system_settings
 *  so the intent survives restarts. */
function _setWhitelistSyncPending(val) {
    db.prepare(
        "INSERT INTO system_settings (key, value) VALUES ('whitelist_sync_pending', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(val ? '1' : '0');
}
function _consumeWhitelistSyncPending() {
    const row = db.prepare("SELECT value FROM system_settings WHERE key = 'whitelist_sync_pending'").get();
    const pending = row?.value === '1';
    if (pending) _setWhitelistSyncPending(false);
    return pending;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * FRESH SESSION RESET (2026-08-19)
 *
 * Manual escape hatch: "the watchlist got spammed with junk, wipe everything
 * and start clean, trusting only what the browser can currently, freshly see."
 *
 * Triggered by the dashboard (POST /api/watchlist/fresh-session), never
 * automatically. Wipes every table that ACCUMULATES history driving
 * master_targets composition — coin_lifecycles (settle/momentum clocks),
 * ghost_approval_queue, area1_scout_logs (the graduation records that force
 * old coins back into master_targets via the momentum-watch join), the sync/
 * wipe audit tables, and market_context_logs (so a later zero-count event
 * can't REHYDRATE the very spam this reset is trying to escape).
 *
 * Deliberately preserved: coin_whitelist (user-curated, not noise) and every
 * system_settings key except the one-shot flag this function itself manages.
 * ────────────────────────────────────────────────────────────────────────── */
function _setFreshSessionPending(val) {
    db.prepare(
        "INSERT INTO system_settings (key, value) VALUES ('fresh_session_pending', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(val ? '1' : '0');
}
function _consumeFreshSessionPending() {
    const row = db.prepare("SELECT value FROM system_settings WHERE key = 'fresh_session_pending'").get();
    const pending = row?.value === '1';
    if (pending) _setFreshSessionPending(false);
    return pending;
}

/** Wipes accumulated history. Returns row counts removed, for the confirmation response. */
// Confirmation must arrive within this window of the browser consuming the
// signal, or the event is marked TIMED_OUT — surfacing an Automa failure
// instead of silently leaving the widget stuck on "waiting" forever.
const FRESH_SESSION_CONFIRM_TIMEOUT_MIN = 15;

function performFreshSessionReset() {
    const counts = {};
    const nowISO = new Date().toISOString();
    const PERMANENT_MAJORS_FS = ['BINANCE:BTCUSDT.P', 'BINANCE:ETHUSDT.P'];
    const whitelistPins = db.prepare('SELECT ticker, exchange FROM coin_whitelist').all()
        .map(r => `${r.exchange}:${r.ticker}`);
    const expectedTargets = _dedupeFullTickers([...PERMANENT_MAJORS_FS, ...whitelistPins]);

    let eventId;
    const tx = db.transaction(() => {
        counts.coin_lifecycles       = db.prepare('DELETE FROM coin_lifecycles').run().changes;
        counts.ghost_approval_queue  = db.prepare('DELETE FROM ghost_approval_queue').run().changes;
        counts.area1_scout_logs      = db.prepare('DELETE FROM area1_scout_logs').run().changes;
        counts.watchlist_sync_audit  = db.prepare('DELETE FROM watchlist_sync_audit').run().changes;
        counts.watchlist_wipe_events = db.prepare('DELETE FROM watchlist_wipe_events').run().changes;
        counts.market_context_logs   = db.prepare('DELETE FROM market_context_logs').run().changes;
        eventId = db.prepare(`
            INSERT INTO fresh_session_events (requested_at, expected_targets, status, cleared_counts)
            VALUES (?, ?, 'PENDING', ?)
        `).run(nowISO, JSON.stringify(expectedTargets), JSON.stringify(counts)).lastInsertRowid;
    });
    tx();
    _setFreshSessionPending(true);
    console.warn(
        `[FRESH-SESSION] 🔥 Reset requested (event #${eventId}) — cleared ${counts.coin_lifecycles} lifecycles, ` +
        `${counts.ghost_approval_queue} ghost entries, ${counts.area1_scout_logs} scout logs, ` +
        `${counts.watchlist_sync_audit} sync-audit rows, ${counts.watchlist_wipe_events} wipe-events, ` +
        `${counts.market_context_logs} watchlist snapshots. Whitelist and settings preserved. ` +
        `Armed FRESH_SESSION for the browser's next check-in — awaiting round-trip confirmation.`
    );
    return { counts, eventId };
}

/** Marks the most recent PENDING fresh-session event as consumed by the browser. */
function _markFreshSessionConsumed() {
    const open = db.prepare("SELECT id FROM fresh_session_events WHERE status = 'PENDING' ORDER BY id DESC LIMIT 1").get();
    if (!open) return;
    db.prepare("UPDATE fresh_session_events SET consumed_at = ?, status = 'AWAITING_CONFIRMATION' WHERE id = ?")
        .run(new Date().toISOString(), open.id);
    console.log(`[FRESH-SESSION] 📡 Event #${open.id} consumed by browser — now awaiting confirmation from the next real watchlist snapshot.`);
}

/**
 * Called on every valid (non-zero) Stream B snapshot. If a fresh-session event
 * is awaiting confirmation, checks whether the ACTUAL watchlist now has zero
 * coins outside the expected baseline — that's the proof Automa really ran.
 */
function _checkFreshSessionConfirmation(cleanWatchlist) {
    const open = db.prepare("SELECT * FROM fresh_session_events WHERE status = 'AWAITING_CONFIRMATION' ORDER BY id DESC LIMIT 1").get();
    if (!open) return;

    const expected = new Set(JSON.parse(open.expected_targets));
    const extras = cleanWatchlist.filter(t => !expected.has(t));
    const nowISO = new Date().toISOString();

    if (extras.length === 0) {
        db.prepare("UPDATE fresh_session_events SET confirmed_at = ?, status = 'CONFIRMED', last_checked_at = ?, last_extra_count = 0 WHERE id = ?")
            .run(nowISO, nowISO, open.id);
        const roundTripSec = Math.round((Date.now() - new Date(open.consumed_at).getTime()) / 1000);
        console.log(`[FRESH-SESSION] ✅ Event #${open.id} CONFIRMED — watchlist matches expected baseline (${roundTripSec}s from browser consumption to confirmation).`);
        return;
    }

    const elapsedMin = (Date.now() - new Date(open.consumed_at).getTime()) / 60000;
    if (elapsedMin > FRESH_SESSION_CONFIRM_TIMEOUT_MIN) {
        db.prepare("UPDATE fresh_session_events SET status = 'TIMED_OUT', last_checked_at = ?, last_extra_count = ? WHERE id = ?")
            .run(nowISO, extras.length, open.id);
        console.warn(`[FRESH-SESSION] ⏱️  Event #${open.id} TIMED OUT after ${elapsedMin.toFixed(1)}m — ${extras.length} foreign coin(s) still present. Automa likely did not apply the reset.`);
    } else {
        db.prepare("UPDATE fresh_session_events SET last_checked_at = ?, last_extra_count = ? WHERE id = ?")
            .run(nowISO, extras.length, open.id);
    }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * WATCHLIST WIPE RECOVERY
 *
 * Automa clears the TV watchlist before writing the new one. When the write
 * half fails, the watchlist is left empty. The correct response is to RESTORE
 * (re-push the list), not to re-read an empty panel.
 *
 * Escalation ladder — deliberately tries the SAFE action first, because every
 * Automa run is itself destructive and can fail the same way:
 *   1st empty snapshot   → REFRESH_WATCHLIST  (cheap, non-destructive re-read;
 *                          fixes the case where the panel merely wasn't rendered)
 *   2nd+ empty snapshot  → UPDATE_WATCHLIST   (accept the Automa risk — the list
 *                          is genuinely gone and must be rebuilt)
 *
 * Restores are rate-limited so a failing Automa is retried steadily rather than
 * hammered once per snapshot (yesterday: 74 empty snapshots in 13 minutes).
 * ────────────────────────────────────────────────────────────────────────── */
const _WIPE_RESTORE_COOLDOWN_MS = 90 * 1000; // give Automa time to finish a run

/** Open (or create) the wipe event for an ongoing blackout. */
function _openWipeEvent(nowISO) {
    const open = db.prepare(
        'SELECT * FROM watchlist_wipe_events WHERE recovered_at IS NULL ORDER BY id DESC LIMIT 1'
    ).get();
    if (open) return open;

    // prev_count = the last non-empty snapshot before this blackout
    const prev = db.prepare(
        'SELECT watchlist_count FROM market_context_logs WHERE watchlist_count > 0 ORDER BY id DESC LIMIT 1'
    ).get();
    const info = db.prepare(
        'INSERT INTO watchlist_wipe_events (detected_at, prev_count) VALUES (?, ?)'
    ).run(nowISO, prev?.watchlist_count ?? null);
    console.warn(
        `[WIPE-GUARD] 🧨 Watchlist EMPTIED (was ${prev?.watchlist_count ?? '?'} coins) — ` +
        `Automa clear/add failure suspected. Starting recovery.`
    );
    return db.prepare('SELECT * FROM watchlist_wipe_events WHERE id = ?').get(info.lastInsertRowid);
}

/** Close any open wipe event once the watchlist is populated again. */
function _closeWipeEvent(nowISO, count) {
    const open = db.prepare(
        'SELECT * FROM watchlist_wipe_events WHERE recovered_at IS NULL ORDER BY id DESC LIMIT 1'
    ).get();
    if (!open) return;
    const downtimeSec = Math.round((new Date(nowISO) - new Date(open.detected_at)) / 1000);
    db.prepare(
        `UPDATE watchlist_wipe_events
         SET recovered_at = ?, recovered_count = ?, downtime_sec = ?
         WHERE id = ?`
    ).run(nowISO, count, downtimeSec, open.id);
    const lost = open.prev_count != null ? open.prev_count - count : null;
    console.log(
        `[WIPE-GUARD] ✅ Watchlist recovered: ${count} coins after ${(downtimeSec / 60).toFixed(1)}m ` +
        `(${open.restore_attempts} restore attempt(s))` +
        (lost > 0 ? ` — ⚠️ ${lost} coin(s) did NOT come back` : '')
    );
}

/**
 * Decide how to respond to an empty watchlist snapshot.
 * @returns {'REFRESH_WATCHLIST'|'UPDATE_WATCHLIST'|null}
 */
function handleWatchlistWipe(nowISO) {
    const evt = _openWipeEvent(nowISO);
    const nowMs = Date.now();
    const lastMs = evt.last_attempt_at ? new Date(evt.last_attempt_at).getTime() : 0;

    // First detection → try the cheap, non-destructive re-read.
    if (evt.restore_attempts === 0) {
        db.prepare(
            'UPDATE watchlist_wipe_events SET restore_attempts = 1, last_attempt_at = ? WHERE id = ?'
        ).run(nowISO, evt.id);
        console.warn('[WIPE-GUARD] 🔄 Attempt 1: REFRESH_WATCHLIST (safe re-read before rebuilding)');
        return 'REFRESH_WATCHLIST';
    }

    // Still empty → the list is really gone. Rebuild it, rate-limited.
    if (nowMs - lastMs < _WIPE_RESTORE_COOLDOWN_MS) return null;

    db.prepare(
        'UPDATE watchlist_wipe_events SET restore_attempts = restore_attempts + 1, last_attempt_at = ? WHERE id = ?'
    ).run(nowISO, evt.id);
    console.warn(
        `[WIPE-GUARD] 🚑 Attempt ${evt.restore_attempts + 1}: UPDATE_WATCHLIST — ` +
        `re-pushing rehydrated targets to rebuild the wiped list.`
    );
    return 'UPDATE_WATCHLIST';
}

/**
 * Reconcile requested targets against what TradingView actually reports.
 * @param {string[]} masterTargets  full EXCHANGE:TICKER.P strings we asked for
 * @param {string[]} observed       full tickers actually present in the snapshot
 * @returns {{escalate: boolean, missing: string[], escalated: string[], recovered: string[]}}
 */
function reconcileWatchlistSync(masterTargets, observed) {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    const observedSet = new Set(observed);
    const missing = (masterTargets || []).filter(t => !observedSet.has(t));
    const missingSet = new Set(missing);

    const escalated = [];
    const recovered = [];

    // 1. Clear entries that have now arrived (Automa worked, or user added manually).
    //    Only rows still marked outstanding are considered — otherwise every
    //    already-resolved ticker would be "recovered" again on every single
    //    snapshot, spamming the log and inflating resolve_count forever.
    for (const row of db.prepare('SELECT ticker FROM watchlist_sync_audit WHERE consecutive_misses > 0').all()) {
        if (!missingSet.has(row.ticker)) {
            db.prepare(
                `UPDATE watchlist_sync_audit
                 SET consecutive_misses = 0, last_resolved_at = ?, resolve_count = resolve_count + 1
                 WHERE ticker = ?`
            ).run(now, row.ticker);
            recovered.push(row.ticker);
        }
    }

    // 2. Record / advance current misses
    const upsert = db.prepare(`
        INSERT INTO watchlist_sync_audit (ticker, first_missing_at, last_missing_at, consecutive_misses)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(ticker) DO UPDATE SET
            last_missing_at    = excluded.last_missing_at,
            consecutive_misses = watchlist_sync_audit.consecutive_misses + 1,
            first_missing_at   = CASE WHEN watchlist_sync_audit.consecutive_misses = 0
                                      THEN excluded.first_missing_at
                                      ELSE watchlist_sync_audit.first_missing_at END
    `);
    for (const t of missing) upsert.run(t, now, now);

    // 3. Decide escalation — any ticker past threshold and out of cooldown
    if (missing.length) {
        const rows = db.prepare(
            `SELECT ticker, consecutive_misses, last_escalated_at
             FROM watchlist_sync_audit
             WHERE consecutive_misses >= ?`
        ).all(_SYNC_ESCALATE_AFTER_MISSES);

        for (const r of rows) {
            if (!missingSet.has(r.ticker)) continue;
            const lastMs = r.last_escalated_at ? new Date(r.last_escalated_at).getTime() : 0;
            if (nowMs - lastMs < _SYNC_ESCALATE_COOLDOWN_MS) continue;
            db.prepare(
                `UPDATE watchlist_sync_audit
                 SET escalations = escalations + 1, last_escalated_at = ?
                 WHERE ticker = ?`
            ).run(now, r.ticker);
            escalated.push(r.ticker);
        }
    }

    if (recovered.length) {
        console.log(`[SYNC-VERIFY] ✅ Landed in watchlist: ${recovered.join(', ')}`);
    }
    if (escalated.length) {
        console.warn(
            `[SYNC-VERIFY] 🚨 Automa appears to have FAILED for ${escalated.length} target(s): ` +
            `${escalated.join(', ')} — forcing UPDATE_WATCHLIST (cooldown bypass).`
        );
    } else if (missing.length) {
        console.log(`[SYNC-VERIFY] ⏳ Awaiting Automa for: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`);
    }

    return { escalate: escalated.length > 0, missing, escalated, recovered };
}

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
/* ─────────────────────────────────────────────────────────────────────────────
 * WATCHDOG CONFIDENCE CLOCK (2026-08-18)
 *
 * Replaces three previously-overlapping, differently-scoped grace windows
 * (8h graduate-grace, ~4h low-score lookback pardon, absolute 12h staleness
 * cutoff) with ONE clock per coin and two checkpoints on it. See CLAUDE.md
 * "Watchdog Confidence Clock" for the full design writeup.
 *
 * The clock (coin_lifecycles.clock_start_at) resets to now() on exactly three
 * events: a coin's first-ever birth, a detected system-wide monitoring gap
 * (the whole point: a multi-day outage shouldn't let a month-old coin get
 * judged on its very first post-restart reading), or a ghost-queue revival.
 *
 *   settle_hours (default 12) — a coin younger than this is NEVER evaluated
 *     for pruning at all (frozen/score/volume checks are skipped entirely,
 *     same as a protected coin). At the settle mark, first-ever judgment runs.
 *   ghost_hours  (default 36) — MANUAL-MODE ONLY (auto-approve OFF). While a
 *     flagged coin sits in the queue, it's re-checked every cycle; the moment
 *     it stops matching the prune condition it's revived (existing "Momentum
 *     Rescue" behaviour, now additionally resetting the clock). If NO
 *     momentum ever returns by ghost_hours, it's force-reset anyway — not
 *     held forever, just recycled to a clean slate.
 *   With auto-approve ON, ghost_hours is irrelevant: a bad coin is pruned the
 *     instant it clears settle_hours, exactly like today, and carries no
 *     memory forward if it reappears later.
 * ────────────────────────────────────────────────────────────────────────── */

function _getWatchdogSettings() {
    const num = (key, def) => {
        const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
        const v = row ? parseFloat(row.value) : NaN;
        return (isFinite(v) && v >= 0) ? v : def;
    };
    const str = (key, def, allowed) => {
        const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
        return (row?.value && allowed.includes(row.value)) ? row.value : def;
    };
    return {
        settleHours:     num('watchdog_settle_hours', 12),
        ghostHours:      num('watchdog_ghost_hours', 36),
        gapToleranceMin: num('watchdog_gap_tolerance_min', 15),
        momentumHours:   num('watchdog_momentum_hours', 2),
        // 'bypass' = Fresh Session force-removes everything down to majors +
        //   whitelist regardless of live DOM screener visibility (a coin must
        //   re-earn its spot via a fresh 8/20min cycle).
        // 'smart'  = Fresh Session still wipes all backend history/clocks, but
        //   the browser's VETO_PRUNE keeps protecting any coin still visible
        //   on the live screener — same "don't remove what's genuinely still
        //   there" behavior it already applies to normal prune cycles.
        freshSessionVetoMode: str('fresh_session_veto_mode', 'bypass', ['bypass', 'smart']),
    };
}

function _setWatchdogSetting(key, value) {
    db.prepare(
        "INSERT INTO system_settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, String(value));
}

/**
 * Detects a system-wide monitoring gap (browser closed, laptop off, etc.) by
 * comparing "now" to the last time this function ran. If the gap exceeds
 * gapToleranceMin, EVERY tracked coin's confidence clock is reset in one bulk
 * update — a coin's individual age no longer matters once continuity broke;
 * everyone restarts the settle/ghost clock together, same as a fresh boot.
 * Cheap (one bulk UPDATE on a small table) — safe to call every request.
 */
function _checkMonitoringGap(gapToleranceMin) {
    const nowMs  = Date.now();
    const nowISO = new Date(nowMs).toISOString();
    const lastSeenRow = db.prepare("SELECT value FROM system_settings WHERE key = 'watchdog_last_scan_seen_at'").get();

    if (lastSeenRow?.value) {
        const gapMin = (nowMs - new Date(lastSeenRow.value).getTime()) / 60000;
        if (gapMin > gapToleranceMin) {
            const result = db.prepare('UPDATE coin_lifecycles SET clock_start_at = ?').run(nowISO);
            console.warn(
                `[WATCHDOG-CLOCK] 🕳️  Monitoring gap detected: ${gapMin.toFixed(1)}m since last scan ` +
                `(tolerance ${gapToleranceMin}m). Reset confidence clock for ${result.changes} tracked coin(s) — ` +
                `every coin re-earns its settle window from here.`
            );
            _setWatchdogSetting('watchdog_monitoring_continuous_since', nowISO);
        }
    }
    _setWatchdogSetting('watchdog_last_scan_seen_at', nowISO);
}

function generateScannerFeedback(clientWatchlistCount = -1) {
    let activeList = [];
    let pruneList = [];
    let newGraduates = [];

    const now = Date.now();
    const eightHoursAgo = new Date(now - 8 * 60 * 60 * 1000).toISOString();

    // --- 0. FETCH SYSTEM SETTINGS AND GHOST QUEUE ---
    const autoApproveSetting = db.prepare("SELECT value FROM system_settings WHERE key = 'ghost_auto_approve'").get();
    const autoApprove = autoApproveSetting ? autoApproveSetting.value === '1' : false;

    const ghostQueueRows = db.prepare("SELECT * FROM ghost_approval_queue").all();
    const ghostQueueMap = {};
    ghostQueueRows.forEach(row => ghostQueueMap[row.ticker] = row);

    // Coin Whitelist — user-pinned coins that bypass ghost pruning AND are always
    // included in master_targets so the TV watchlist always contains them.
    // We also consume the pending-sync flag here so the next response to the
    // Tampermonkey script includes action_required: 'UPDATE_WATCHLIST' exactly once.
    // Persisted in system_settings — an in-memory flag was silently lost on every
    // backend restart, so coins whitelisted before a restart never received their
    // one-shot UPDATE_WATCHLIST (this is why PUMP never reached the watchlist).
    const hasWhitelistPending = _consumeWhitelistSyncPending();

    const whitelistRows    = db.prepare("SELECT ticker, exchange FROM coin_whitelist").all();
    const whitelistTickers = new Set(whitelistRows.map(r => r.ticker));
    // Full EXCHANGE:TICKER.P format — these will be force-added to finalSet below.
    const whitelistFullSet = new Set(whitelistRows.map(r => `${r.exchange}:${r.ticker}`));

    // --- 0.5 FRESH SESSION — highest priority, overrides even rehydration ---
    // A manual reset was requested. Don't run the normal per-coin evaluation
    // at all this call — Stream A's raw scan still has whatever's currently
    // visible, but flowing that straight into activeList would immediately
    // refill the watchlist with unearned coins, defeating the entire point
    // ("only listen to what the browser freshly re-discovers going forward").
    // Return just the minimal baseline; every other coin has to earn its way
    // back in through the normal BIRTH -> 8min -> 20min -> momentum-watch path.
    const hasFreshSessionPending = _consumeFreshSessionPending();
    if (hasFreshSessionPending) {
        const PERMANENT_MAJORS_FS = ['BINANCE:BTCUSDT.P', 'BINANCE:ETHUSDT.P'];
        const whitelistPins = whitelistRows.map(r => `${r.exchange}:${r.ticker}`);
        const freshTargets = _dedupeFullTickers([...PERMANENT_MAJORS_FS, ...whitelistPins]);
        const vetoMode = _getWatchdogSettings().freshSessionVetoMode;
        console.warn(`[FRESH-SESSION] 🧹 Sending minimal baseline (${freshTargets.length} coins: majors + whitelist), veto_mode=${vetoMode} — browser will wipe local state and the TV watchlist to match.`);
        _markFreshSessionConsumed();
        return {
            ai_suggestion: "FRESH_SESSION",
            active_list: freshTargets,
            prune_list: [],
            new_graduates: [],
            master_targets: freshTargets,
            action_required: "FRESH_SESSION",
            // Tells the browser whether this reset should force-remove coins
            // still visible on the live screener ('bypass', default) or still
            // respect VETO_PRUNE and only remove what's genuinely off-screener
            // ('smart'). Adjustable via POST /api/ghosts/watchdog-settings
            // { freshSessionVetoMode }. See coin_scanner.js v20.13.
            veto_mode: vetoMode,
        };
    }

    // --- 1. THE 8-HOUR STABILITY GUARD (Ghost-Volume rule only) ---
    // Distinct from the per-coin confidence clock below — this tests whether
    // the SYSTEM has enough scan density to trust the cohort average-volume
    // baseline (ghostThreshold), not whether any individual coin is settled.
    const stabilityCheck = db.prepare(`
        SELECT COUNT(*) as count, MIN(timestamp) as oldest
        FROM scans
        WHERE timestamp > ?
    `).get(eightHoursAgo);
    const isStable = stabilityCheck && stabilityCheck.count > 100;

    // --- 1.5 WATCHDOG CONFIDENCE CLOCK — settings + gap detection ---
    const watchdogSettings = _getWatchdogSettings();
    _checkMonitoringGap(watchdogSettings.gapToleranceMin);
    const settleMs   = watchdogSettings.settleHours * 3600000;
    const ghostMs    = watchdogSettings.ghostHours * 3600000;
    const momentumMs = watchdogSettings.momentumHours * 3600000;

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
                    // Apply the same .P + dedup rules as Stream B so the recovered list
                    // doesn't re-inflate the scanner watchlist with exchange duplicates.
                    const deduped = _deduplicateStreamB(payload.watchlist_active_snapshot);
                    // Belt-and-suspenders: pass through the universal full-ticker
                    // deduper too, in case the snapshot itself was malformed or
                    // contained exchange duplicates that slipped past Stream B's gate.
                    const baseTargets = _dedupeFullTickers(
                        deduped.map(({ exchange, baseSymbol }) => `${exchange}:${baseSymbol}`)
                    );
                    // Always include whitelist pins — user explicitly pinned these,
                    // they must survive even catastrophic 0-count rehydration.
                    const whitelistPins = whitelistRows.map(r => `${r.exchange}:${r.ticker}`);
                    const recoveredTargets = _dedupeFullTickers([...baseTargets, ...whitelistPins]);
                    console.log(`[WATCHLIST-ENGINE] 💧 Rehydrated ${recoveredTargets.length} unique .P coins from history (raw snapshot had ${payload.watchlist_active_snapshot.length} entries, +${whitelistPins.length} whitelist pins).`);
                    return {
                        ai_suggestion: "REHYDRATION",
                        active_list: recoveredTargets,
                        prune_list: [],
                        new_graduates: [],
                        master_targets: recoveredTargets,
                        action_required: hasWhitelistPending ? "UPDATE_WATCHLIST" : null,
                    };
                }
            } catch (e) {
                console.error("[WATCHLIST-ENGINE] Rehydration parsing failed", e);
            }
        }
    }

    // --- 3. GRADUATES CURRENTLY UNDER MOMENTUM WATCH (or already verified) ---
    // [SUPERSEDED 2026-08-19] Replaces the old blind, unverified "any STABLE
    // pick in the last 2 hours" window (see CLAUDE.md "Momentum Watcher").
    // Force-inclusion is now driven by real state on coin_lifecycles, not a
    // fixed timer — a graduate stays force-included for exactly as long as
    // its momentum_watch is active, or forever-normal once momentum_verified.
    //
    // This also fixes a real bug found while tracing an Automa storm: the OLD
    // query pulled ALL distinct (exchange,ticker) pairs ever logged for a
    // ticker, so a coin graduated under two different exchanges (observed:
    // SNXX via both OKX and BITGET) fed BOTH into the raw target set every
    // cycle — _dedupeFullTickers then had to strip one out on every single
    // call, which is very likely why action_required stayed "hot" constantly.
    // Only the MOST RECENT logged exchange per ticker is used now.
    const historicalPicks = db.prepare(`
        SELECT a.exchange, a.ticker
        FROM area1_scout_logs a
        JOIN coin_lifecycles c ON c.ticker = a.ticker
        WHERE a.type IN ('STABLE', 'ORPHANED_STABLE_RETRY')
          AND (c.momentum_watch_started_at IS NOT NULL OR c.momentum_verified = 1)
          AND a.timestamp = (
              SELECT MAX(a2.timestamp) FROM area1_scout_logs a2
              WHERE a2.ticker = a.ticker AND a2.type IN ('STABLE', 'ORPHANED_STABLE_RETRY')
          )
    `).all();
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

    // --- 4.5 [SUPERSEDED 2026-08-18] ---
    // The old "4-hour sustainability guard" (re-scan last 240 scan_results blobs
    // looking for any score>30 to pardon a current low reading) is replaced by
    // the settle-window check below: nothing is judged before settle_hours
    // clears, so there's no more need for a look-back pardon at judgment time.

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

    // ── Helper: normalise any ticker to "EXCHANGE:BASE.P" canonical form ─────────
    // Old DB rows may still have datakey = "BYBIT:XRPUSDT.P" (before the dedup fix).
    // This ensures master_targets never re-introduces exchange duplicates.
    function _canonicalFullTicker(item) {
        const rawKey   = item.datakey || '';
        const colonIdx = rawKey.indexOf(':');
        if (colonIdx >= 0) {
            // Already has exchange prefix — return as-is (dedup happens at ingestion now)
            return rawKey;
        }
        // Fallback: no exchange prefix in datakey — use item.ticker, default to BINANCE
        const base = item.ticker || rawKey;
        return `BINANCE:${base}`;
    }

    const PERMANENT_MAJORS = ['BINANCE:BTCUSDT.P', 'BINANCE:ETHUSDT.P'];
    const protectedAltcoins = new Set();

    // [SUPERSEDED 2026-08-18] The old "8-Hour Graduate Grace Period" (protect
    // anything that graduated via STABLE/ORPHANED_STABLE_RETRY in the last 8h,
    // regardless of coin age) is replaced by the settle-window check below —
    // graduation no longer grants a separate immunity window; a graduated coin
    // is judged by the same confidence clock as everything else.

    // Identify Top 5 Altcoins to protect (unchanged — separate mechanism, has
    // a known freeze-check gap tracked separately, not touched in this pass)
    let altCount = 0;
    for (const r of scanResults) {
        const fullTicker = _canonicalFullTicker(r);
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
        const fullTicker = _canonicalFullTicker(item);

        activeList.push(fullTicker);

        // [WATCHDOG CLOCK] Read the coin's current clock BEFORE upserting —
        // a brand-new coin has no row yet, so its clock starts now (settle
        // window begins at birth, same instant as today's born_at).
        const nowISO = new Date().toISOString();
        const existingLifecycle = db.prepare(
            'SELECT clock_start_at, born_at, momentum_watch_started_at, momentum_proven, momentum_verified FROM coin_lifecycles WHERE ticker = ?'
        ).get(cleanTicker);
        const clockStartAt = existingLifecycle?.clock_start_at || existingLifecycle?.born_at || nowISO;

        // [LIFECYCLE TRACKING - Update Last Seen & Ensure Exists]
        // clock_start_at is intentionally NOT touched here on the UPDATE path —
        // it only resets via _checkMonitoringGap() (system-wide) or the ghost
        // revival / auto-reset branches below (per-coin).
        db.prepare(`
            INSERT INTO coin_lifecycles (ticker, born_at, last_seen_at, status, clock_start_at)
            VALUES (?, ?, ?, 'ACTIVE', ?)
            ON CONFLICT(ticker) DO UPDATE SET
                last_seen_at = excluded.last_seen_at,
                status = CASE WHEN status = 'DEAD' THEN 'ACTIVE' ELSE status END
        `).run(cleanTicker, nowISO, nowISO, nowISO);

        // [MOMENTUM WATCHER] See CLAUDE.md "Momentum Watcher". A coin that
        // graduated (GATE_20/STABLE) carries momentum_watch_started_at instead
        // of waiting out settle_hours. While the window is open it's protected
        // from every normal prune check — the ONLY question that matters is
        // "did it ever show real momentum." Resolved once, at window-close:
        // PASS -> becomes a normal coin (momentum_verified=1, bypasses
        // settle_hours going forward, since it already proved something
        // stronger). FAIL -> discarded now, not after another 12h/36h wait —
        // that's the whole point of replacing the old blind 2h window.
        const underMomentumWatch = !!existingLifecycle?.momentum_watch_started_at;
        let momentumJustPassed = false;
        let momentumJustFailed = false;

        if (underMomentumWatch) {
            const watchElapsedMs = now - new Date(existingLifecycle.momentum_watch_started_at).getTime();
            const showsMomentumNow = (d.score > 30) || (d.breakout === 1);
            const provenSoFar = existingLifecycle.momentum_proven === 1 || showsMomentumNow;

            if (watchElapsedMs >= momentumMs) {
                if (provenSoFar) {
                    db.prepare(
                        "UPDATE coin_lifecycles SET momentum_watch_started_at = NULL, momentum_proven = 0, momentum_verified = 1 WHERE ticker = ?"
                    ).run(cleanTicker);
                    momentumJustPassed = true;
                    console.log(`[MOMENTUM-WATCHER] ✅ ${cleanTicker} proved momentum within ${watchdogSettings.momentumHours}h — verified, now a normal tracked coin.`);
                } else {
                    db.prepare(
                        "UPDATE coin_lifecycles SET momentum_watch_started_at = NULL, momentum_proven = 0 WHERE ticker = ?"
                    ).run(cleanTicker);
                    momentumJustFailed = true;
                    console.log(`[MOMENTUM-WATCHER] ❌ ${cleanTicker} showed no momentum in ${watchdogSettings.momentumHours}h — discarding now.`);
                }
            } else if (showsMomentumNow && existingLifecycle.momentum_proven !== 1) {
                db.prepare("UPDATE coin_lifecycles SET momentum_proven = 1 WHERE ticker = ?").run(cleanTicker);
            }
        }

        // Still genuinely inside its window (not resolved either way this cycle) —
        // protected from every normal check below, same as PERMANENT_MAJORS.
        const stillWatchingMomentum = underMomentumWatch && !momentumJustPassed && !momentumJustFailed;

        const isSettled = momentumJustPassed
            || existingLifecycle?.momentum_verified === 1
            || (now - new Date(clockStartAt).getTime()) >= settleMs;

        const isProtected = PERMANENT_MAJORS.includes(fullTicker)
            || protectedAltcoins.has(fullTicker)
            || whitelistTickers.has(cleanTicker) // user whitelist — never ghost
            || stillWatchingMomentum;

        let shouldPrune = false;
        let pruneReason = "";
        if (momentumJustFailed) {
            shouldPrune = true;
            pruneReason = `No Momentum (${watchdogSettings.momentumHours}h)`;
        } else if (!isProtected && isSettled) {
            // [WATCHDOG CLOCK] A coin younger than settle_hours is never judged —
            // same treatment as a protected coin, but for a different reason (not
            // enough continuous data yet, not "this coin is special").
            if (d.freeze === 1) {
                shouldPrune = true;
                pruneReason = "Frozen";
            } else if (d.score <= 30) {
                shouldPrune = true;
                pruneReason = "Sustained Low Score";
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
                // Auto-approve mode: pruned immediately, exactly like today.
                // No ghost_hours tracking applies here — the coin carries no
                // memory forward; its next appearance starts a clean slate.
                pruneList.push(fullTicker);
                ghostList.push({ ticker: cleanTicker, reason: pruneReason, state: 'PRUNING' });
                db.prepare("UPDATE coin_lifecycles SET status = 'DEAD', death_at = ? WHERE ticker = ?").run(nowISO, cleanTicker);
            } else if (queuedGhost && (now - new Date(queuedGhost.queued_at).getTime()) >= ghostMs) {
                // [WATCHDOG CLOCK] Manual mode only — this coin has sat in the
                // ghost queue for the full ghost_hours window with no momentum
                // ever returning. Not held indefinitely: force-reset to a clean
                // slate now, same as a fresh coin. It stays on the watchlist
                // throughout (manual mode never auto-removes it); only the
                // queue entry and its confidence clock reset.
                db.prepare("DELETE FROM ghost_approval_queue WHERE ticker = ?").run(cleanTicker);
                db.prepare("UPDATE coin_lifecycles SET clock_start_at = ?, status = 'ACTIVE' WHERE ticker = ?").run(nowISO, cleanTicker);
                console.log(`[GHOST-ENGINE] 🔄 ${cleanTicker} ghost window (${watchdogSettings.ghostHours}h) expired with no momentum — reset to fresh, clock restarted.`);
            } else {
                // Upsert into queue if not already there
                if (!queuedGhost) {
                    db.prepare(`
                        INSERT INTO ghost_approval_queue (ticker, reason, queued_at, is_approved)
                        VALUES (?, ?, ?, 0)
                        ON CONFLICT(ticker) DO UPDATE SET reason = excluded.reason
                    `).run(cleanTicker, pruneReason, nowISO);

                    // 📣 Telegram: ghost queued — new coin needs approval (Phase 1 gap fix)
                    setImmediate(() => {
                        try {
                            TelegramService.onGhostQueued({ ticker: cleanTicker, reason: pruneReason });
                        } catch (e) { console.error('[Ghost] Telegram hook error:', e.message); }
                    });
                }
                ghostList.push({ ticker: cleanTicker, reason: pruneReason, state: 'WAITING' });
                db.prepare("UPDATE coin_lifecycles SET status = 'GHOST' WHERE ticker = ?").run(cleanTicker);
            }
        } else {
            // MOMENTUM RESCUE / GATE 20 RESCUE
            // If it's no longer a ghost but was sitting in the queue, violently rescue it.
            if (ghostQueueMap[cleanTicker]) {
                db.prepare("DELETE FROM ghost_approval_queue WHERE ticker = ?").run(cleanTicker);
                // [WATCHDOG CLOCK] Real momentum returned — reset the clock too,
                // not just the queue/status. It re-earns settle_hours from zero,
                // same as any coin proving itself for the first time.
                db.prepare("UPDATE coin_lifecycles SET status = 'ACTIVE', clock_start_at = ? WHERE ticker = ?").run(nowISO, cleanTicker);
                console.log(`[GHOST-ENGINE] 🛟 Rescued ${cleanTicker} from Ghost Queue (Re-qualified or Momentum Recovered) — clock reset.`);
            }
        }
    });

    // [2026-08-20] GATED ADDITION — closes the unconditional-add gap.
    // Previously `activeList` (every coin the raw Stream A macro scan currently
    // matches, zero gating) was dumped straight into finalSet/master_targets —
    // the moment a coin flashed on the screener it was pushed onto the real TV
    // watchlist via Automa, regardless of whether it ever passed the browser's
    // FE 8/20-min gate. That's why Fresh Session resets never stuck: the very
    // next scan cycle re-added anything currently matching the screener.
    // master_targets now comes ONLY from historicalTargetSet — coins that
    // actually graduated (logged a real STABLE/ORPHANED_STABLE_RETRY pick to
    // area1_scout_logs via /qualified-pick) and are still within their
    // momentum-watch window or already momentum_verified. `activeList` is kept
    // only for the informational `active_list` response field (not consumed by
    // the browser) — it no longer feeds master_targets.
    newGraduates = Array.from(historicalTargetSet);
    const finalSet = new Set([...historicalTargetSet, ...PERMANENT_MAJORS]);

    // Exclude prunes
    pruneList.forEach(p => finalSet.delete(p));
    // Super-protect — these are always present regardless of pruning
    PERMANENT_MAJORS.forEach(p => finalSet.add(p));
    // NOTE: protectedAltcoins (top-5 by raw score) is intentionally NOT added
    // to finalSet here anymore — it still protects an already-graduated coin
    // from prune checks (via isProtected below), but no longer force-adds an
    // ungraduated coin to the watchlist just for ranking high on the raw scan.
    // Whitelist pins — user explicitly chose these coins; always in master_targets.
    // Added AFTER the prune exclusion so they cannot be evicted by pruneList,
    // mirroring the same guarantee as PERMANENT_MAJORS (BTC/ETH).
    whitelistFullSet.forEach(full => finalSet.add(full));

    // ── Final dedup pass — applied to EVERY output array ─────────────────────
    // Calculate the exact duplicates that were dropped by dedup to force-prune them.
    const rawMasterTargets = Array.from(finalSet);
    const dedupedMasterTargets = _dedupeFullTickers(rawMasterTargets);
    const dedupedSet = new Set(dedupedMasterTargets);
    const droppedDuplicates = rawMasterTargets.filter(t => !dedupedSet.has(t));

    // action_required is set when:
    //  a) the dedup pass found exchange duplicates to force-prune, OR
    //  b) a coin was just added to the whitelist (one-shot — clears after this call).
    //     This bypasses the Tampermonkey 15-min Automa cooldown so the new coin
    //     reaches the TV watchlist on the very next processSyncPayload, not 15 min later.
    const actionRequired = (droppedDuplicates.length > 0 || hasWhitelistPending)
        ? "UPDATE_WATCHLIST"
        : null;

    if (hasWhitelistPending) {
        console.log(`[WHITELIST-ENGINE] 🔔 Whitelist sync flag consumed — next response carries action_required: UPDATE_WATCHLIST`);
    }

    return {
        ai_suggestion: "TRACKING_5+2",
        active_list:    _dedupeFullTickers(activeList),
        prune_list:     _dedupeFullTickers([...new Set(pruneList)]),
        ghost_list:     ghostList,
        new_graduates:  _dedupeFullTickers(newGraduates),
        master_targets: dedupedMasterTargets,
        force_prune:    droppedDuplicates,
        action_required: actionRequired,
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
            // [MOMENTUM WATCHER] A genuine GATE_20 graduation starts (or restarts)
            // the momentum-watch window — this REPLACES settle_hours for this coin
            // going forward, not stacks on top of it. Reset momentum_proven/verified
            // too: passing once does not grandfather a coin forever — a fresh
            // graduation is a fresh claim that deserves its own fresh verification.
            db.prepare(
                "UPDATE coin_lifecycles SET momentum_watch_started_at = ?, momentum_proven = 0, momentum_verified = 0 WHERE ticker = ?"
            ).run(now, ticker);
        }

        // Let the UI know a pick came in
        io.emit('ledger-update', { ticker, price, signal: type });

        // 📣 Telegram: scout graduation alert — STABLE picks only (Phase 1 gap fix)
        if (saveType === 'STABLE') {
            setImmediate(() => {
                try {
                    TelegramService.onScoutGraduation({ ticker, price, type: saveType, volChange });
                } catch (e) { console.error('[Scout] Telegram hook error:', e.message); }
            });
        }

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
            master_targets: feedback.master_targets,
            force_prune: feedback.force_prune,
            action_required: feedback.action_required,
            veto_mode: feedback.veto_mode
        });

    } catch (e) {
        console.error("Pick Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// ─── Stream B gatekeeper helpers ─────────────────────────────────────────────
// Exchange preference order for deduplication: higher index = lower priority.
// When two entries share the same base ticker, we keep the one from the
// highest-priority exchange so the stored ticker has no exchange prefix.
// NOTE: the whitelist one-shot flag now lives in system_settings — see
// _setWhitelistSyncPending() / _consumeWhitelistSyncPending() above. It used to
// be an in-memory boolean here, which was lost on every backend restart.

// NOTE: zero-count throttling now lives in handleWatchlistWipe(), keyed off the
// persistent watchlist_wipe_events row rather than an in-memory timestamp, so
// recovery state survives restarts mid-blackout.

const _B_EXCHANGE_PRIORITY = [
    'BINANCE', 'OKX', 'BYBIT', 'BITGET', 'BINGX', 'GATE', 'KUCOIN',
    'COINBASE', 'WEEX', 'BLOFIN', 'LBANK', 'BITUNIX', 'PHEMEX',
    'MEXC', 'HTX', 'COINEX', 'COINW', 'PIONEX', 'KCEX', 'TOOBIT',
    'BYDFI', 'BITRUE', 'WHITEBIT', 'ZOOMEX', 'BYBIT', 'POLONIEX',
    'UPBIT', 'CRYPTOCOM', 'DERIBIT', 'PHEMEX',
];
const _B_MAX_COINS = 40; // overload threshold — more than this skips qualification

/**
 * Normalises the raw watchlist_active_snapshot from Stream B:
 *  1. Keep only perpetual contracts (w.full ends with '.P')
 *  2. Deduplicate by base ticker — prefer highest-priority exchange
 *  3. Return array of { baseSymbol, exchange, price, raw } objects
 */
/**
 * Universal full-ticker deduplicator — input: array of "EXCHANGE:BASE.P" strings.
 * Collapses any two entries sharing the same BASE.P down to the preferred
 * exchange (per _B_EXCHANGE_PRIORITY). Also drops non-.P tickers.
 * Used by generateScannerFeedback to guarantee no exchange duplicates ever
 * reach the scanner via master_targets / active_list / new_graduates / prune_list,
 * including from historical fallback paths (gracePeriodPicks, area1_scout_logs,
 * old scan_results rows ingested before _deduplicateStreamA was added).
 */
function _dedupeFullTickers(arr) {
    if (!Array.isArray(arr)) return [];
    const best = new Map(); // cleanBase → { hasP, rank, full }
    const order = [];       // preserve first-seen order for the kept entries
    for (const full of arr) {
        if (!full || typeof full !== 'string') continue;
        const colonIdx = full.indexOf(':');
        if (colonIdx < 0) continue;
        const exchange   = full.slice(0, colonIdx).toUpperCase();
        const baseSymbol = full.slice(colonIdx + 1);
        
        const hasP = baseSymbol.endsWith('.P') || baseSymbol.includes('PERP');
        const cleanBase = baseSymbol.replace(/\.P$/, '').replace(/PERP$/, '');

        const rank = _B_EXCHANGE_PRIORITY.indexOf(exchange);
        const effectiveRank = rank === -1 ? 9999 : rank;
        const existing = best.get(cleanBase);

        if (!existing) {
            best.set(cleanBase, { hasP, rank: effectiveRank, full: `${exchange}:${baseSymbol}` });
            order.push(cleanBase);
        } else if (hasP && !existing.hasP) {
            best.set(cleanBase, { hasP, rank: effectiveRank, full: `${exchange}:${baseSymbol}` });
        } else if (hasP === existing.hasP && effectiveRank < existing.rank) {
            best.set(cleanBase, { hasP, rank: effectiveRank, full: `${exchange}:${baseSymbol}` });
        }
    }
    return order.map(b => best.get(b).full);
}

function _deduplicateStreamB(rawSnaps) {
    const best = new Map(); // cleanBase → { hasP, rank, exchange, raw, baseSymbol }
    for (const w of rawSnaps) {
        if (!w.full) continue;
        const colonIdx = w.full.indexOf(':');
        if (colonIdx < 0) continue;
        const exchange   = w.full.slice(0, colonIdx).toUpperCase();
        const baseSymbol = w.full.slice(colonIdx + 1); // e.g. "XRPUSDT.P"
        
        const hasP = baseSymbol.endsWith('.P') || baseSymbol.includes('PERP');
        const cleanBase = baseSymbol.replace(/\.P$/, '').replace(/PERP$/, '');

        const rank = _B_EXCHANGE_PRIORITY.indexOf(exchange);
        const effectiveRank = rank === -1 ? 9999 : rank;
        const existing = best.get(cleanBase);

        if (!existing) {
            best.set(cleanBase, { hasP, rank: effectiveRank, exchange, raw: w, baseSymbol });
        } else if (hasP && !existing.hasP) {
            best.set(cleanBase, { hasP, rank: effectiveRank, exchange, raw: w, baseSymbol });
        } else if (hasP === existing.hasP && effectiveRank < existing.rank) {
            best.set(cleanBase, { hasP, rank: effectiveRank, exchange, raw: w, baseSymbol });
        }
    }
    return [...best.values()].map(({ baseSymbol, exchange, raw }) => ({
        baseSymbol,
        exchange,
        price: parsePrice(raw.price || raw.close),
        raw,
    }));
}

/**
 * Deduplicate Stream A & D scan results by base ticker.
 * Rules (mirrors Stream B gatekeeper):
 *  1. Prefer perpetual contracts (item.datakey or item.ticker ends with '.P' or 'PERP')
 *  2. When multiple exchanges send the same base coin, keep the highest-priority one
 * Returns a deduplicated array of the original result objects (unmodified).
 */
function _deduplicateStreamA(results) {
    const best = new Map(); // cleanBase → { hasP, rank, item }
    for (const item of results) {
        const raw = item.datakey || item.ticker || '';
        const colonIdx    = raw.indexOf(':');
        const exchange    = colonIdx >= 0 ? raw.slice(0, colonIdx).toUpperCase() : 'UNKNOWN';
        const baseSymbol  = colonIdx >= 0 ? raw.slice(colonIdx + 1) : raw; // e.g. "XRPUSDT.P"
        
        const hasP = baseSymbol.endsWith('.P') || baseSymbol.includes('PERP');
        const cleanBase = baseSymbol.replace(/\.P$/, '').replace(/PERP$/, '');

        const rank        = _B_EXCHANGE_PRIORITY.indexOf(exchange);
        const effectiveRank = rank === -1 ? 9999 : rank;
        const existing = best.get(cleanBase);

        if (!existing) {
            best.set(cleanBase, { hasP, rank: effectiveRank, item });
        } else if (hasP && !existing.hasP) {
            best.set(cleanBase, { hasP, rank: effectiveRank, item });
        } else if (hasP === existing.hasP && effectiveRank < existing.rank) {
            best.set(cleanBase, { hasP, rank: effectiveRank, item });
        }
    }
    return [...best.values()].map(({ item }) => item);
}

// 3B. MARKET CONTEXT TELEMETRY (Stream B)
app.post('/api/market-context', (req, res) => {
    try {
        const payload = req.body;
        const now = new Date().toISOString();

        // ── Step 1: Deduplicate & filter raw snapshot ──────────────────────────
        const rawSnaps     = payload.watchlist_active_snapshot || [];
        const deduped      = _deduplicateStreamB(rawSnaps);
        const rawPerpCount = rawSnaps.filter(w => w.full && w.full.endsWith('.P')).length;
        const uniqueCount  = deduped.length;
        const isOverloaded = uniqueCount > _B_MAX_COINS;

        // Build the clean watchlist from THIS snapshot — the exact set of
        // EXCHANGE:TICKER.P strings the scanner should keep after dedup.
        // Returned in every response so the scanner can always self-correct
        // its watchlist without waiting for a separate "fix" push.
        const cleanWatchlist = deduped.map(({ exchange, baseSymbol }) => `${exchange}:${baseSymbol}`);

        // Detect coins that were in the raw push but dropped by the gatekeeper.
        // "Dropped" = sent by the scanner but not in the clean list.
        const rawFullSet    = new Set(rawSnaps.map(w => w.full).filter(Boolean));
        const cleanSet      = new Set(cleanWatchlist);
        const rejectedTickers = [...rawFullSet].filter(f => !cleanSet.has(f));
        const dedupApplied  = rawSnaps.length !== uniqueCount;

        if (dedupApplied) {
            console.log(
                `[Stream B] 🧹 Dedup: raw=${rawSnaps.length} perps=${rawPerpCount} → accepted=${uniqueCount}` +
                (rejectedTickers.length ? ` rejected=${rejectedTickers.length} (${rejectedTickers.slice(0, 5).join(', ')}${rejectedTickers.length > 5 ? '…' : ''})` : '')
            );
        }

        // Log to DB — store ONLY the clean deduped snapshot, never the raw blob.
        // The raw payload can contain 100+ duplicate-exchange entries; storing it
        // verbatim bloats market_context_logs and corrupts the rehydration path
        // (which reads payload_json to recover the watchlist on zero-count events).
        const _cleanPayload = {
            timestamp:            payload.timestamp || now,
            screener_total_count: payload.screener_total_count || 0,
            // Only the deduped .P coins — one entry per base symbol, preferred exchange.
            // Each object retains the original raw fields but with `full` normalised.
            watchlist_active_snapshot: deduped.map(({ exchange, baseSymbol, raw }) => ({
                ...raw,
                full:  `${exchange}:${baseSymbol}`,   // canonical EXCHANGE:TICKER.P
                short: baseSymbol.replace('USDT.P', '').replace('.P', ''),
            })),
            // Screener snap stored as-is (typically 10–30 rows, no bloat risk).
            // Required by /api/analytics/participation-pulse to compute discovery
            // bull/bear metrics. Previously omitted — caused DISCOVERY always "offline".
            screener_visible_snapshot: payload.screener_visible_snapshot || [],
        };
        db.prepare(`
            INSERT INTO market_context_logs (timestamp, screener_total_count, watchlist_count, payload_json)
            VALUES (?, ?, ?, ?)
        `).run(
            now,
            payload.screener_total_count || 0,
            uniqueCount,
            JSON.stringify(_cleanPayload)   // ← clean deduped snapshot only
        );

        // ── Step 2: Overload guard ─────────────────────────────────────────────
        if (isOverloaded) {
            const msg = `Stream B overloaded — ${uniqueCount} unique .P coins (raw: ${rawSnaps.length}, perps: ${rawPerpCount}). Max allowed: ${_B_MAX_COINS}. Qualification SKIPPED.`;
            console.warn(`[Stream B] ⚠️  ${msg}`);
            io.emit('stream-b-overload', {
                rawCount:    rawSnaps.length,
                perpCount:   rawPerpCount,
                uniqueCount,
                maxAllowed:  _B_MAX_COINS,
                timestamp:   now,
                message:     msg,
                cleanWatchlist,  // give dashboard the clean list too
            });
            io.emit('market-context-update', { timestamp: now, counts: { screener: payload.screener_total_count, watchlist: uniqueCount }, overloaded: true });
            io.emit('stream-b-update', { timestamp: now, uniqueCount, cleanWatchlist, overloaded: true });
            // Still respond OK — include the clean list so the scanner can
            // immediately shrink its watchlist without waiting for a manual fix.
            const feedback = generateScannerFeedback(uniqueCount);
            // Same force-prune logic as the normal path — dupes go to prune_list,
            // master_targets is the clean list minus rejected dupes.
            const _rejectedSet  = new Set(rejectedTickers);
            const combinedForcePrune = [...new Set([...(feedback.prune_list || []), ...(feedback.force_prune || []), ...rejectedTickers])];
            const _forcedTargets = [...new Set([...(feedback.master_targets || []), ...cleanWatchlist])]
                .filter(t => !_rejectedSet.has(t));
            return res.json({
                success: true,
                warning:          'OVERLOADED — qualification skipped',
                action_required:  'RESET_WATCHLIST',
                raw_count:        rawSnaps.length,
                unique_count:     uniqueCount,
                max_allowed:      _B_MAX_COINS,
                clean_watchlist:  cleanWatchlist,
                rejected_tickers: rejectedTickers,
                master_targets:   _forcedTargets,   // duplicates physically removed
                prune_list:       combinedForcePrune, // rejected dupes forced into prune
                force_prune:      [...new Set([...rejectedTickers, ...(feedback.force_prune || [])])], // explicit field
                new_graduates:    feedback.new_graduates,
            });
        }

        // ── Step 3: Normal path — ingest deduped .P coins only ────────────────
        console.log(`[Stream B] ✅ Accepted ${uniqueCount} unique .P coins (raw ${rawSnaps.length} → perps ${rawPerpCount} → deduped ${uniqueCount})`);

        const feedback = generateScannerFeedback(uniqueCount);
        // market-context-update: existing event (GlobalHeader, health widgets)
        io.emit('market-context-update', { timestamp: now, counts: { screener: payload.screener_total_count, watchlist: uniqueCount } });
        // stream-b-update: dedicated event so BYOC screener + other widgets
        // can immediately re-query when fresh Stream B data arrives.
        io.emit('stream-b-update', { timestamp: now, uniqueCount, cleanWatchlist });

        setImmediate(() => {
            deduped.forEach(({ baseSymbol, price, raw }) => {
                MasterStoreService.ingestStreamB(baseSymbol, raw, price, {
                    timestampISO: raw.timestamp || payload.timestamp || now,
                    ingestionSource: 'SCOUT_B',
                }).catch(e => console.error('[Stream B] ingestStreamB error:', e.message));
            });
        });

        // ── FORCE-PRUNE EXCHANGE DUPLICATES ──────────────────────────────────
        // The scanner uses `prune_list` to physically REMOVE coins from its
        // TradingView watchlist. Without merging rejectedTickers here, the
        // scanner re-pushes the same duplicates forever (BINANCE:XRPUSDT.P +
        // BYBIT:XRPUSDT.P + OKX:XRPUSDT.P every batch).
        //
        // master_targets is also overridden: take the union of the engine's
        // master list AND cleanWatchlist, then strip anything we just rejected.
        // This guarantees the scanner cannot keep a duplicate even if the
        // engine's master_targets is stale.
        //
        // EXCEPTION — FRESH_SESSION: feedback.master_targets IS the deliberately
        // minimal majors+whitelist baseline. Merging it with cleanWatchlist here
        // would immediately pollute it back with whatever's currently sitting on
        // the (spammed) watchlist — exactly what a fresh session exists to escape.
        const _rejectedSet  = new Set(rejectedTickers);
        const combinedForcePrune = [...new Set([...(feedback.prune_list || []), ...(feedback.force_prune || []), ...rejectedTickers])];
        const _forcedTargets = feedback.action_required === 'FRESH_SESSION'
            ? feedback.master_targets
            : [...new Set([...(feedback.master_targets || []), ...cleanWatchlist])].filter(t => !_rejectedSet.has(t));

        // ── Closed-loop Automa verification ───────────────────────────────────
        // Only meaningful on a VALID snapshot. A zero-count read means the panel
        // wasn't readable (scraper problem) — judging Automa on that would raise
        // false failures, so we skip reconciliation entirely in that case.
        let _syncReport = null;
        if (uniqueCount > 0) {
            try {
                _syncReport = reconcileWatchlistSync(_forcedTargets, cleanWatchlist);
                // Watchlist is populated again — close any open wipe blackout and
                // report how many coins failed to come back (partial-add failures
                // like the observed 33 → 0 → 15 are invisible otherwise).
                _closeWipeEvent(now, uniqueCount);
            } catch (e) {
                console.error('[SYNC-VERIFY] reconciliation error:', e.message);
            }
            // Round-trip proof for the Fresh Session button — a real watchlist
            // read, not just "we sent the signal." Only meaningful on a valid
            // snapshot for the same reason the sync report above is gated.
            try { _checkFreshSessionConfirmation(cleanWatchlist); }
            catch (e) { console.error('[FRESH-SESSION] confirmation check error:', e.message); }
        }

        // ── Determine action_required ─────────────────────────────────────────
        // Priority: FRESH_SESSION (manual reset, absolute top — never downgraded)
        //           > UPDATE_WATCHLIST (dedup / whitelist / failed-Automa escalation)
        //           > REFRESH_WATCHLIST (panel unreadable) > null
        //
        // NOTE: REFRESH_WATCHLIST is now evaluated independently of the
        // UPDATE_WATCHLIST branch. The previous `!_actionRequired` guard meant a
        // zero-count snapshot was silently ignored whenever any other action was
        // pending — i.e. it was suppressed in exactly the situation it exists for.
        let _actionRequired = null;

        if (uniqueCount === 0) {
            // An empty watchlist is an Automa wipe until proven otherwise (24/24
            // historical zero-runs began from a populated watchlist). Recovery
            // ladder: safe re-read first, then rebuild. Internally rate-limited.
            _actionRequired = handleWatchlistWipe(now);
        }

        // UPDATE_WATCHLIST outranks REFRESH — it carries an actual list to apply.
        if (dedupApplied || feedback.action_required || _syncReport?.escalate) {
            _actionRequired = 'UPDATE_WATCHLIST';
        }

        // FRESH_SESSION outranks everything above — a manual reset must never be
        // silently rewritten into a generic UPDATE_WATCHLIST by this fallback logic.
        if (feedback.action_required === 'FRESH_SESSION') {
            _actionRequired = 'FRESH_SESSION';
        }

        res.json({
            success:          true,
            message:          'Market Context Telemetry Saved',
            raw_count:        rawSnaps.length,
            unique_count:     uniqueCount,
            dedup_applied:    dedupApplied,
            clean_watchlist:  cleanWatchlist,
            rejected_tickers: rejectedTickers,
            action_required:  _actionRequired,
            master_targets:   _forcedTargets,   // duplicates physically removed
            veto_mode:        _actionRequired === 'FRESH_SESSION' ? feedback.veto_mode : undefined,
            prune_list:       combinedForcePrune, // rejected dupes forced into prune list
            force_prune:      [...new Set([...rejectedTickers, ...(feedback.force_prune || [])])], // explicit field for scanners that key on it
            new_graduates:    feedback.new_graduates,
            // Closed-loop verification result — lets the scanner (and the
            // dashboard) see which targets TradingView has not accepted yet.
            sync_status: _syncReport ? {
                missing:   _syncReport.missing,
                escalated: _syncReport.escalated,
                recovered: _syncReport.recovered,
            } : null,
        });
    } catch (e) {
        console.error('Market Context Error:', e);
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

        // Apply deduplication to Stream D to prevent duplicates (preferring .P pairs)
        payload.results = _deduplicateStreamA(payload.results);

        // Non-blocking: process after response is sent
        setImmediate(() => {
            let ingested = 0, skipped = 0;
            payload.results.forEach(item => {
                const data   = item.data || {};
                const ticker = (item.ticker || data.ticker || '').trim();
                const price  = parsePrice(data.close || data.price);
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
                // Rolling metric history for ATRRaceWidget
                writeCoinMetric(ticker, Date.now(), data);
            });
            console.log(`[Stream D] 📡 Scan processed: ${payload.results.length} coins | ts=${timestamp}`);
            // Emit both events: scan-update keeps backward-compat; stream-d-update lets
            // EMA/Level/DistanceTracker widgets distinguish a Stream-D push from a full scan-A push
            // so they can prioritise their own targeted reloads.
            io.emit('scan-update', { source: 'STREAM_D', timestamp });
            io.emit('stream-d-update', { timestamp });

            // Smart Alerts — Stream D push is the freshest EMA/ATR signal, so
            // re-evaluate. setImmediate keeps it off the request hot-path.
            setImmediate(() => {
                smartAlertsEvaluator.evaluateAll('stream-d-update')
                    .catch(err => console.error('[SmartAlerts] eval error:', err.message));
            });
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
        // ATR tracked across all rows — latest value per TF (ATR is slow-moving,
        // last seen is a good coin-level reference for TESTING threshold).
        const rawAtrs = { m1: null, m5: null, m15: null, h1: null, h4: null };

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
            b.price = parsePrice(row.price) || b.price;
            b.lastSrc = row.trigger_source;

            // Stream D: dynamic ema_200Timeresolution<N> + ATR keys
            if (row.stream_d_state) {
                try {
                    const d = JSON.parse(row.stream_d_state);
                    for (const k of Object.keys(d)) {
                        const mE = k.match(/^ema_200Timeresolution(\d+)$/i);
                        if (mE) {
                            const tf = TF_BY_RES[parseInt(mE[1], 10)];
                            if (!tf) continue;
                            const v = parseFloat(d[k]);
                            if (!isNaN(v)) { b.emas[tf] = v; b.emaSrc[tf] = 'STREAM_D'; }
                            continue;
                        }
                        // ATR — overwrite with latest seen (newest row wins)
                        const mA = k.match(/^averagetruerangepercent_\d+Timeresolution(\d+)$/i);
                        if (mA) {
                            const tf = TF_BY_RES[parseInt(mA[1], 10)];
                            if (!tf) continue;
                            const v = parseFloat(d[k]);
                            if (!isNaN(v)) rawAtrs[tf] = v;
                        }
                    }
                    if (b.emas.m1 == null && d.ema_200 != null) {
                        const v = parseFloat(d.ema_200);
                        if (!isNaN(v)) { b.emas.m1 = v; b.emaSrc.m1 = 'STREAM_D'; }
                    }
                } catch {}
            }
            // Stream C EMA200 intentionally skipped — only Stream D values are trusted.
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
        // TESTING threshold: 0.15× ATR (adapts to coin volatility).
        // Fallback 0.15% fixed when ATR unavailable (preserves old behaviour).
        const TESTING_ATR_MULT     = 0.15;
        const TESTING_PCT_FALLBACK = 0.15;
        const TF_RES_MIN_CASCADE   = { m1: 1, m5: 5, m15: 15, h1: 60, h4: 240 };
        const tfs = ['m1', 'm5', 'm15', 'h1', 'h4'];

        // ATR nearest-TF fallback — fill gaps using closest available resolution
        const tfsWithAtr = tfs.filter(tf => rawAtrs[tf] != null);
        if (tfsWithAtr.length) {
            for (const tf of tfs) {
                if (rawAtrs[tf] != null) continue;
                const target = TF_RES_MIN_CASCADE[tf];
                let best = tfsWithAtr[0];
                let bestDelta = Math.abs(TF_RES_MIN_CASCADE[best] - target);
                for (const cand of tfsWithAtr) {
                    const delta = Math.abs(TF_RES_MIN_CASCADE[cand] - target);
                    if (delta < bestDelta) { bestDelta = delta; best = cand; }
                }
                rawAtrs[tf] = rawAtrs[best];
            }
        }

        const computeCascadeState = (price, ema, atr) => {
            if (price == null || ema == null) return 'UNKNOWN';
            const pct = ((price - ema) / ema) * 100;
            const thresh = atr ? TESTING_ATR_MULT * atr : TESTING_PCT_FALLBACK;
            if (Math.abs(pct) <= thresh) return 'TESTING';
            return pct > 0 ? 'ABOVE' : 'BELOW';
        };

        // Compute baseline state + active defense per bucket
        for (const b of sortedBuckets) {
            b.cascadeState = {};
            b.distPct = {};
            for (const tf of tfs) {
                b.cascadeState[tf] = computeCascadeState(b.price, b.emas[tf], rawAtrs[tf]);
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
        let resolvedVolTicker = null;
        for (const v of _expandTickerVariants(ticker)) {
            volEventsRaw = VolumeEventService.getEvents(v, sinceISO, 500);
            if (volEventsRaw.length) { resolvedVolTicker = v; break; }
        }
        const volEvents = volEventsRaw
            .map(e => ({ ts: new Date(e.ts).getTime(), source: e.source, strength: e.strength, meta: e.meta }))
            .sort((a, b) => a.ts - b.ts);

        // 7b. If no events in window, look up the most recent event EVER for this ticker
        //     so the FE can show "last vol spike was Xh ago" even when nothing is on-chart.
        let lastVolEventMs = volEvents.length ? volEvents[volEvents.length - 1].ts : null;
        if (!lastVolEventMs) {
            const sinceAllTime = new Date(0).toISOString();
            for (const v of _expandTickerVariants(ticker)) {
                const recent = VolumeEventService.getEvents(v, sinceAllTime, 1);
                if (recent.length) {
                    lastVolEventMs = new Date(recent[0].ts).getTime();
                    break;
                }
            }
        }

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
            lastVolEventMs,  // most recent event ever (may be outside window) — for "last vol Xh ago" badge
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
//   minutes, computes the EMA stack (Stream D ONLY — Stream C intentionally excluded) and returns
//   distance % per TF along with a synthetic "minAbsDist" sort key.

// Short-TTL response cache (15 s) — collapses burst requests from multiple
// widgets polling the same endpoint (DistanceTracker + EMACascadeMonitor).
// ── GET /api/coin-metric-history — ATRRaceWidget time-series data ─────────────
// Returns ATR% and RVOL% readings per coin over the requested window.
// Coins are filtered to those that have at least one reading in the window.
app.get('/api/coin-metric-history', (req, res) => {
    try {
        const windowMin = Math.min(Math.max(parseInt(req.query.window_min) || 120, 15), 480);
        const sinceMs   = Date.now() - windowMin * 60 * 1000;
        // Accept clean tickers (BTC) or full (BTCUSDT.P) — expand to all DB variants
        const tickerParam  = (req.query.tickers || '').trim();
        const cleanTickers = tickerParam
            ? tickerParam.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
            : [];
        const expanded = cleanTickers.length > 0
            ? [...new Set(cleanTickers.flatMap(t => {
                const base = t.replace(/USDT(\.P)?$/i, '');
                return [`${base}USDT.P`, `${base}USDT`, base];
              }))]
            : [];

        let rows;
        if (expanded.length > 0) {
            const placeholders = expanded.map(() => '?').join(',');
            rows = db.prepare(
                `SELECT ticker, ts, atr_m15, atr_h1, rvol_m15, rvol_h1, dist_m15, dist_h1
                 FROM coin_metric_history
                 WHERE ts >= ? AND ticker IN (${placeholders})
                 ORDER BY ticker, ts ASC`
            ).all(sinceMs, ...expanded);
        } else {
            rows = db.prepare(
                `SELECT ticker, ts, atr_m15, atr_h1, rvol_m15, rvol_h1, dist_m15, dist_h1
                 FROM coin_metric_history
                 WHERE ts >= ?
                 ORDER BY ticker, ts ASC`
            ).all(sinceMs);
        }

        // Group by clean ticker (strip USDT.P / USDT suffix) so frontend keys match
        const result = {};
        for (const row of rows) {
            const key = row.ticker.replace(/USDT(\.P)?$/i, '').toUpperCase();
            if (!result[key]) result[key] = [];
            result[key].push({
                ts:       row.ts,
                atr_m15:  row.atr_m15,
                atr_h1:   row.atr_h1,
                rvol_m15: row.rvol_m15,
                rvol_h1:  row.rvol_h1,
                dist_m15: row.dist_m15,
                dist_h1:  row.dist_h1,
            });
        }

        res.json({ windowMin, sinceMs, coins: result, generatedAt: new Date().toISOString() });
    } catch (e) {
        console.error('[coin-metric-history]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Key = serialised normalised params; value = { ts, payload }.
const _distanceBoardCache = new Map();
const DIST_BOARD_CACHE_TTL = 15_000; // 15 seconds

app.get('/api/ema-distance-board', (req, res) => {
    try {
        const requestedTicker = req.query.ticker?.toUpperCase();
        const limit     = requestedTicker ? 1 : Math.min(120, Math.max(5, parseInt(req.query.limit) || 40));
        const maxDist   = requestedTicker ? 100 : Math.min(50, Math.max(0.5, parseFloat(req.query.max_dist) || 10));
        const activeMin = Math.min(720, Math.max(5, parseInt(req.query.active_min) || 60));

        // Cache-hit check — key on normalised params (not raw query string)
        const cacheKey = `${requestedTicker || ''}|${limit}|${maxDist}|${activeMin}`;
        const cached = _distanceBoardCache.get(cacheKey);
        if (cached && (Date.now() - cached.ts) < DIST_BOARD_CACHE_TTL) {
            return res.json(cached.payload);
        }

        const sinceISO  = new Date(Date.now() - activeMin * 60 * 1000).toISOString();
        const nowMs     = Date.now();

        // PERF AUDIT FIX (C1): replaces N+1 (one getEMA200Stack call per ticker
        // → up to 4 variant queries × 4 lookups = 640 queries) with 3 batched
        // queries total. With idx_master_source_ticker_time these are
        // index-only lookups; whole endpoint runs in ~30ms vs. ~1.5s before.

        // Q1a — active tickers in window (no correlated subquery for price)
        const sql1a = `
            SELECT ticker, MAX(timestamp) AS last_ts
            FROM master_coin_store
            WHERE timestamp >= ?
            ${requestedTicker ? 'AND (ticker = ? OR ticker = ? OR ticker = ?)' : ''}
            GROUP BY ticker
            ORDER BY MAX(timestamp) DESC
            LIMIT ?
        `;
        const params1a = requestedTicker
            ? [sinceISO, requestedTicker, `${requestedTicker}USDT.P`, `${requestedTicker}USDT`, limit]
            : [sinceISO, Math.min(400, limit * 4)];

        const latestRows = db.prepare(sql1a).all(...params1a);

        if (latestRows.length === 0) {
            const emptyPayload = {
                count: 0, limit, max_dist: maxDist, active_min: activeMin,
                board: [], generatedAt: new Date().toISOString(),
            };
            _distanceBoardCache.set(cacheKey, { ts: Date.now(), payload: emptyPayload });
            return res.json(emptyPayload);
        }

        const tickers = latestRows.map(r => r.ticker);
        const placeholders = tickers.map(() => '?').join(',');

        // Q0 — batch RVOL lookup from Stream D history (latest per ticker).
        // Added for: cascade+RVOL entry score in Distance Tracker.
        const rvolSince = Date.now() - 10 * 60 * 1000; // last 10 min
        const rvolRows = db.prepare(`
            WITH ranked AS (
                SELECT ticker, rvol_m15,
                       ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) AS rn
                FROM coin_metric_history
                WHERE ts > ? AND ticker IN (${placeholders})
            )
            SELECT ticker, rvol_m15 FROM ranked WHERE rn = 1
        `).all(rvolSince, ...tickers);
        const rvolByTicker = new Map(rvolRows.map(r => [r.ticker, r.rvol_m15 ?? null]));

        // Q1b — batch price lookup (replaces N correlated subqueries).
        // Gets the latest non-null price for every ticker in one JOIN.
        const priceRows = db.prepare(`
            SELECT m.ticker, m.price
            FROM master_coin_store m
            INNER JOIN (
                SELECT ticker, MAX(timestamp) AS mx
                FROM master_coin_store
                WHERE price IS NOT NULL AND ticker IN (${placeholders})
                GROUP BY ticker
            ) t ON m.ticker = t.ticker AND m.timestamp = t.mx
        `).all(...tickers);
        const priceByTicker = new Map(priceRows.map(r => [r.ticker, r.price]));

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

        // Q3 (Stream C) intentionally removed — EMA200 is sourced from Stream D only.

        const TFS = ['m1','m5','m15','h1','h4'];
        const TF_BY_RES = { 1: 'm1', 5: 'm5', 15: 'm15', 60: 'h1', 240: 'h4' };
        // TF ordering for ATR nearest-fallback (closest in resolution wins).
        const TF_RES_MIN = { m1: 1, m5: 5, m15: 15, h1: 60, h4: 240 };
        const TTL = MasterStoreService.constructor.SOURCE_TTL_MS;

        const board = [];
        for (const r of latestRows) {
            const tfPicks = { m1: null, m5: null, m15: null, h1: null, h4: null };
            // Per-TF ATR% (parallel to tfPicks). Sourced from Stream D below.
            const tfAtrs  = { m1: null, m5: null, m15: null, h1: null, h4: null };
            let volatilityDay = null; // last-resort fallback (1d volatility %)

            // Stream D — multi-TF EMA matrix + ATR matrix (single pass)
            const dRow = dByTicker.get(r.ticker);
            if (dRow) {
                let d; try { d = JSON.parse(dRow.stream_d_state); } catch { d = null; }
                if (d) {
                    const dTsMs = new Date(dRow.timestamp).getTime();
                    const dAge  = nowMs - dTsMs;
                    const dStale = dAge > (TTL.STREAM_D || 6 * 60 * 1000);
                    for (const k of Object.keys(d)) {
                        // EMA200 per TF
                        const mEma = k.match(/^ema_200Timeresolution(\d+)$/i);
                        if (mEma) {
                            const slot = TF_BY_RES[parseInt(mEma[1], 10)];
                            if (!slot) continue;
                            const num = parseFloat(d[k]);
                            if (!isNaN(num)) {
                                tfPicks[slot] = { price: num, source: 'STREAM_D', ts: dRow.timestamp, ageMs: dAge, stale: dStale };
                            }
                            continue;
                        }
                        // ATR% per TF — `averagetruerangepercent_14Timeresolution<N>`
                        const mAtr = k.match(/^averagetruerangepercent_\d+Timeresolution(\d+)$/i);
                        if (mAtr) {
                            const slot = TF_BY_RES[parseInt(mAtr[1], 10)];
                            if (!slot) continue;
                            const num = parseFloat(d[k]);
                            if (!isNaN(num)) tfAtrs[slot] = num;
                            continue;
                        }
                    }
                    if (!tfPicks.m1 && d.ema_200 != null) {
                        const num = parseFloat(d.ema_200);
                        if (!isNaN(num)) tfPicks.m1 = { price: num, source: 'STREAM_D', ts: dRow.timestamp, ageMs: dAge, stale: dStale };
                    }
                    // Daily volatility fallback for TFs with no ATR signal
                    if (d.volatilityInterval1d != null) {
                        const v = parseFloat(d.volatilityInterval1d);
                        if (!isNaN(v)) volatilityDay = v;
                    }
                }
            }

            // Nearest-TF ATR fallback: if a TF has no ATR, copy from the closest TF
            // that does (by resolution distance). If still none, scale daily volatility.
            const tfsWithAtr = TFS.filter(tf => tfAtrs[tf] != null);
            if (tfsWithAtr.length) {
                for (const tf of TFS) {
                    if (tfAtrs[tf] != null) continue;
                    const target = TF_RES_MIN[tf];
                    let best = tfsWithAtr[0], bestDelta = Math.abs(TF_RES_MIN[best] - target);
                    for (const cand of tfsWithAtr) {
                        const delta = Math.abs(TF_RES_MIN[cand] - target);
                        if (delta < bestDelta) { bestDelta = delta; best = cand; }
                    }
                    tfAtrs[tf] = tfAtrs[best];
                }
            } else if (volatilityDay != null) {
                // Scale 1d vol → per-TF estimate via sqrt-time ratio (1d = 1440m)
                for (const tf of TFS) {
                    tfAtrs[tf] = +(volatilityDay * Math.sqrt(TF_RES_MIN[tf] / 1440)).toFixed(3);
                }
            }

            // EMA200 is Stream D ONLY — Stream C smart_levels.emas_200 is intentionally
            // not used here because its values can diverge from TradingView's ema_200
            // indicator and produce incorrect cascade / distance readings.

            // Q1b result: batch price (eliminates correlated subquery)
            const px = priceByTicker.get(r.ticker);
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
                atrs: tfAtrs,                 // per-TF ATR% (with nearest-TF fallback)
                emas: { m1: tfPicks.m1?.price ?? null, m5: tfPicks.m5?.price ?? null,
                        m15: tfPicks.m15?.price ?? null, h1: tfPicks.h1?.price ?? null, h4: tfPicks.h4?.price ?? null },
                rvolM15: rvolByTicker.get(r.ticker) ?? null,  // Stream D RVOL 15m
                minAbsDist: minAbs, minTf, liveTfCount, anyStale,
            });
        }

        board.sort((a, b) => a.minAbsDist - b.minAbsDist);
        const responsePayload = {
            count: board.length,
            limit, max_dist: maxDist, active_min: activeMin,
            board: board.slice(0, limit),
            generatedAt: new Date().toISOString(),
        };

        // Cache the result for DIST_BOARD_CACHE_TTL ms
        _distanceBoardCache.set(cacheKey, { ts: Date.now(), payload: responsePayload });

        res.json(responsePayload);
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

// ── STREAM SYNC DIAGNOSTICS (read-only) ──────────────────────────────────────
// Visualises the gap between Stream B (the authoritative watchlist) and what
// Stream A (macro scan) + Stream D (per-coin technicals) actually contain.
//
// A "cycle" = one Stream B publish (a market_context_logs row). For each cycle:
//   • find the nearest Stream A scan within ±tolerance
//   • collect all distinct Stream D tickers bucketed within [t0 ± tolerance]
//   • diff both coin-sets against B's list (the reference)
// The headline signal is A↔D divergence *within B's list* — coins B asked for
// that A and D disagree on.
//
// PURE DERIVED VIEW: no writes, no socket emits, no migrations. All queries are
// index-backed and bounded (≤40 cycles, ≤8h window, 30s in-memory cache).
const _streamSyncCache = new Map();
const STREAM_SYNC_CACHE_TTL = 30_000;

// Strip exchange prefix ("BINANCE:XRPUSDT.P") then USDT/.P suffix → base ("XRP").
function _syncCleanBase(t) {
    if (!t) return '';
    const colon = t.indexOf(':');
    const sym = colon >= 0 ? t.slice(colon + 1) : t;
    return sym.replace(/USDT(\.P)?$/i, '').replace(/\.P$/i, '').toUpperCase();
}

app.get('/api/stream-sync', (req, res) => {
    try {
        const windowMin    = Math.min(Math.max(parseInt(req.query.window_min)    || 120, 30), 480);
        const toleranceMin = Math.min(Math.max(parseInt(req.query.tolerance_min) || 5,    1),  15);

        const cacheKey = `${windowMin}:${toleranceMin}`;
        const cached = _streamSyncCache.get(cacheKey);
        if (cached && Date.now() - cached.ts < STREAM_SYNC_CACHE_TTL) {
            return res.json(cached.payload);
        }

        const nowMs    = Date.now();
        const sinceMs  = nowMs - windowMin * 60 * 1000;
        const sinceISO = new Date(sinceMs).toISOString();
        const tolMs    = toleranceMin * 60 * 1000;

        // ── Stream B cycles (reference list) — 40 most recent in window ──────
        const bRows = db.prepare(`
            SELECT id, timestamp, watchlist_count, payload_json
            FROM market_context_logs
            WHERE timestamp >= ?
            ORDER BY timestamp DESC
            LIMIT 40
        `).all(sinceISO);

        // Stream A scans in window (+tolerance lead) — small set, id+ts only.
        const aScans = db.prepare(`
            SELECT id, timestamp FROM scans
            WHERE timestamp >= ?
            ORDER BY timestamp ASC
        `).all(new Date(sinceMs - tolMs).toISOString());
        const aScanTs = aScans.map(s => ({ id: s.id, t: new Date(s.timestamp).getTime(), iso: s.timestamp }));

        // Stream D distinct (ticker, bucket-ts) across window — one indexed query.
        const dRows = db.prepare(`
            SELECT DISTINCT ticker, ts FROM coin_metric_history
            WHERE ts >= ?
        `).all(sinceMs - tolMs);

        // Lazy-parse scan_results only for scans we actually match (cached per id).
        const scanCoinCache = new Map();
        function getScanCoins(scanId) {
            if (scanCoinCache.has(scanId)) return scanCoinCache.get(scanId);
            const row = db.prepare('SELECT raw_data FROM scan_results WHERE scan_id = ?').get(scanId);
            const coins = new Set();
            if (row) {
                try {
                    const p = JSON.parse(row.raw_data);
                    for (const item of (p.results || [])) {
                        const c = _syncCleanBase(item.datakey || item.ticker || '');
                        if (c) coins.add(c);
                    }
                } catch { /* malformed blob — empty set */ }
            }
            scanCoinCache.set(scanId, coins);
            return coins;
        }

        const cycles = bRows.map(b => {
            const t0 = new Date(b.timestamp).getTime();

            // B coins (already clean "short" base symbols)
            let bCoins = [];
            try {
                const pj = JSON.parse(b.payload_json);
                bCoins = [...new Set((pj.watchlist_active_snapshot || [])
                    .map(w => _syncCleanBase(w.short || w.full || ''))
                    .filter(Boolean))];
            } catch { /* ignore */ }

            // Nearest Stream A scan within ±tolerance
            let bestA = null, bestADiff = Infinity;
            for (const s of aScanTs) {
                const diff = Math.abs(s.t - t0);
                if (diff < bestADiff && diff <= tolMs) { bestADiff = diff; bestA = s; }
            }
            const aCoins = bestA ? [...getScanCoins(bestA.id)] : [];
            const aHas   = !!bestA;

            // Stream D buckets within ±tolerance of t0
            const dSet = new Set();
            const dBucketTs = new Set();
            for (const d of dRows) {
                if (Math.abs(d.ts - t0) <= tolMs) {
                    const c = _syncCleanBase(d.ticker);
                    if (c) dSet.add(c);
                    dBucketTs.add(d.ts);
                }
            }
            const dCoins = [...dSet];
            const dHas   = dCoins.length > 0;

            const aSetC = new Set(aCoins);
            const dSetC = new Set(dCoins);
            const bSetC = new Set(bCoins);

            // Diffs anchored to B's list
            const missingInA = bCoins.filter(c => !aSetC.has(c));
            const missingInD = bCoins.filter(c => !dSetC.has(c));
            // A↔D divergence within B's list (the headline signal)
            const inAnotD   = bCoins.filter(c => aSetC.has(c) && !dSetC.has(c));
            const inDnotA   = bCoins.filter(c => dSetC.has(c) && !aSetC.has(c));
            const inNeither = bCoins.filter(c => !aSetC.has(c) && !dSetC.has(c));
            // Orphans — present downstream but NOT in B (stale/noise)
            const extraInA = aCoins.filter(c => !bSetC.has(c));
            const extraInD = dCoins.filter(c => !bSetC.has(c));

            let status;
            if (b.watchlist_count === 0 || bCoins.length === 0)            status = 'EMPTY_B';
            else if (!aHas || !dHas)                                       status = 'STALE';
            else if (inAnotD.length || inDnotA.length || inNeither.length) status = 'DIVERGED';
            else                                                           status = 'SYNCED';

            return {
                cycleId:      b.id,
                ts:           b.timestamp,
                bCount:       bCoins.length,
                bCoins,
                aTs:          bestA ? bestA.iso : null,
                aOffsetSec:   bestA ? Math.round((bestA.t - t0) / 1000) : null,
                aCount:       aCoins.length,
                aCoins,
                aHas,
                dCount:       dCoins.length,
                dCoins,
                dHas,
                dBucketCount: dBucketTs.size,
                missingInA, missingInD,
                inAnotD, inDnotA, inNeither,
                extraInA, extraInD,
                status,
            };
        });

        // Event log — surfaced markers (empty-B snapshots) newest-first
        const events = [];
        for (const b of bRows) {
            if (b.watchlist_count === 0) {
                events.push({ ts: b.timestamp, type: 'EMPTY_B', message: 'Stream B published 0 coins' });
            }
        }

        const payload = {
            generatedAt:  new Date().toISOString(),
            windowMin, toleranceMin,
            cycleCount:   cycles.length,
            cycles,            // newest-first
            events:       events.slice(0, 20),
            summary: {
                synced:   cycles.filter(c => c.status === 'SYNCED').length,
                diverged: cycles.filter(c => c.status === 'DIVERGED').length,
                emptyB:   cycles.filter(c => c.status === 'EMPTY_B').length,
                stale:    cycles.filter(c => c.status === 'STALE').length,
            },
        };
        _streamSyncCache.set(cacheKey, { ts: Date.now(), payload });
        res.json(payload);
    } catch (e) {
        console.error('[stream-sync]', e.message);
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
            const activeSnaps    = payload.screener_visible_snapshot || [];
            const watchlistSnaps = payload.watchlist_active_snapshot || [];

            // Build normalized watchlist set for overlap detection (Option D: both pools kept pure)
            const normalizedWatchlist = new Set();
            watchlistSnaps.forEach(w => {
                if (w.full) normalizedWatchlist.add(normalizeTicker(w.full));
            });

            // ── Discovery pool (screener) ─────────────────────────────────────────
            // Per-coin: aggregate all TechRating columns → classify bull or bear.
            // Normalization: (bull_count / total) × 100 → -100 to +100 per pool.
            let disc_bull_count = 0, disc_bear_count = 0, overlapCount = 0;
            activeSnaps.forEach(item => {
                const normScreener = item.full ? normalizeTicker(item.full) : '';
                if (normScreener && normalizedWatchlist.has(normScreener)) overlapCount++;

                let coinTotal = 0;
                Object.values(item).forEach(val => { coinTotal += getRatingScore(val); });
                if (coinTotal > 0) disc_bull_count++;
                else if (coinTotal < 0) disc_bear_count++;
            });

            const disc_count    = activeSnaps.length;
            const screener_active = disc_count > 0;
            // Normalized percentages: bull is positive, bear is negative
            const disc_bull = disc_count > 0 ? Math.round((disc_bull_count / disc_count) * 100) : 0;
            const disc_bear = disc_count > 0 ? Math.round((disc_bear_count / disc_count) * -100) : 0;
            const disc_net  = disc_bull + disc_bear; // 0 when screener offline

            // ── Watchlist pool ────────────────────────────────────────────────────
            // Per-coin: change_pct threshold ±0.3% filters noise around flat coins.
            // Both pools are pure — overlap coins counted in both (Option D).
            let wl_bull_count = 0, wl_bear_count = 0;
            watchlistSnaps.forEach(w => {
                const chg = parseFloat(w.change_pct);
                if (!isNaN(chg)) {
                    if (chg >  0.3) wl_bull_count++;
                    else if (chg < -0.3) wl_bear_count++;
                }
            });

            const wl_count = watchlistSnaps.length;
            const wl_bull  = wl_count > 0 ? Math.round((wl_bull_count / wl_count) * 100) : 0;
            const wl_bear  = wl_count > 0 ? Math.round((wl_bear_count / wl_count) * -100) : 0;
            const wl_net   = wl_bull + wl_bear;

            return {
                time: row.timestamp,
                // Discovery (screener) pool — normalized -100 to +100
                discovery_count: disc_count,
                disc_bull, disc_bear, disc_net,
                screener_active,
                // Watchlist pool — normalized -100 to +100
                watchlist_count: wl_count,
                wl_bull, wl_bear, wl_net,
                // Coins appearing in both pools (Option D: exposed, not removed)
                overlap_count: overlapCount,
            };
        });

        // ── Forward-fill zero-watchlist data points ───────────────────────────
        // watchlist_count = 0 means the watchlist DOM wasn't readable at that
        // snapshot instant (panel closed, race condition). Carrying the last
        // known good watchlist values forward prevents cliff-drops to zero on
        // the chart and stops the header pill from falsely showing "0 coins".
        let lastGoodWl = null;
        const filledTimeline = timeline.map(p => {
            if (p.watchlist_count > 0) {
                lastGoodWl = {
                    watchlist_count: p.watchlist_count,
                    wl_bull:         p.wl_bull,
                    wl_bear:         p.wl_bear,
                    wl_net:          p.wl_net,
                };
                return p;
            }
            // 0-count snapshot: substitute carried-forward watchlist state
            return lastGoodWl ? { ...p, ...lastGoodWl } : p;
        });

        res.json({ timeline: filledTimeline });
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
// --- HISTORY CACHE (per-hours-bucket, 30s TTL) ---
// Append-only data — newest scan arrives ~every 2min via /scan-report. A 30s cache
// is well within the freshness window the slider needs (and the socket scan-update
// event invalidates it explicitly so the live edge stays sharp). Without this cache
// the json_extract+json_array_length over 30 days of scan_results was costing
// 1.5–3s per call (and called 2× by StrictMode in dev = 3-6s of pure waste per page load).
const _historyCache = new Map(); // key: hours → { ts, data }
const HISTORY_CACHE_TTL = 30_000;
const _historyStmt = db.prepare(`
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
`);

// Exposed so the /scan-report ingest path can invalidate the cache the moment a
// new scan arrives — keeps the live slider in sync without waiting for TTL expiry.
function _invalidateHistoryCache() { _historyCache.clear(); }

app.get('/api/ai/history', (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const now = Date.now();
        const hit = _historyCache.get(hours);
        if (hit && (now - hit.ts) < HISTORY_CACHE_TTL) {
            res.set('Cache-Control', 'public, max-age=15');
            return res.json(hit.data);
        }

        const cutoff = new Date(now - hours * 60 * 60 * 1000).toISOString();
        const rows = _historyStmt.all(cutoff);

        // Cache by hours bucket. Bound: only 2-3 hours values are ever requested
        // in practice (24, 720) — so the Map stays tiny and we don't need eviction.
        _historyCache.set(hours, { ts: now, data: rows });
        res.set('Cache-Control', 'public, max-age=15');
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

        // Proactively evict any whitelisted coins that may have been queued before
        // the coin was added to the whitelist (defensive cleanup alongside Fix A).
        db.prepare(`
            DELETE FROM ghost_approval_queue
            WHERE is_approved = 0
              AND ticker IN (SELECT ticker FROM coin_whitelist)
        `).run();

        // Fetch remaining queue with a whitelisted flag so the UI can show a
        // shield badge on any entry that somehow still appears (belt-and-suspenders).
        const queue = db.prepare(`
            SELECT g.ticker, g.reason, g.queued_at, g.confidence_score, g.score_breakdown,
                   CASE WHEN w.ticker IS NOT NULL THEN 1 ELSE 0 END AS is_whitelisted
            FROM ghost_approval_queue g
            LEFT JOIN coin_whitelist w ON w.ticker = g.ticker
            WHERE g.is_approved = 0
            ORDER BY g.confidence_score DESC NULLS LAST, g.queued_at DESC
        `).all().map(row => ({
            ...row,
            is_whitelisted:  row.is_whitelisted === 1,
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

        // Block manual prune of whitelisted coins — they are immune to ghost
        // pruning by design. The UI shields the button; this is the server-side guard.
        const isWhitelisted = db.prepare(
            "SELECT 1 FROM coin_whitelist WHERE ticker = ?"
        ).get(ticker);
        if (isWhitelisted) {
            // Clean it up from the queue (shouldn't be there, but fix it now)
            db.prepare("DELETE FROM ghost_approval_queue WHERE ticker = ?").run(ticker);
            io.emit('ghost-update', { action: 'whitelist-evict', ticker });
            return res.status(409).json({
                error: 'WHITELISTED',
                message: `${ticker} is on the whitelist and cannot be pruned. Remove it from the whitelist first.`,
            });
        }

        db.prepare("UPDATE ghost_approval_queue SET is_approved = 1 WHERE ticker = ?").run(ticker);
        io.emit('ghost-update', { action: 'approve', ticker }); // push to all clients
        res.json({ success: true, ticker });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ghosts/approve-all', (req, res) => {
    try {
        // Exclude whitelisted coins — approve-all is a bulk prune, but user-pinned
        // coins must never be removed via a bulk action. Individual approve still
        // works for them if the user explicitly clicks their row's Prune button.
        const result = db.prepare(`
            UPDATE ghost_approval_queue
            SET is_approved = 1
            WHERE is_approved = 0
              AND ticker NOT IN (SELECT ticker FROM coin_whitelist)
        `).run();

        const skipped = db.prepare(`
            SELECT COUNT(*) AS cnt
            FROM ghost_approval_queue
            WHERE is_approved = 0
              AND ticker IN (SELECT ticker FROM coin_whitelist)
        `).get();

        io.emit('ghost-update', { action: 'approve-all' });
        res.json({ success: true, approved: result.changes, skipped: skipped.cnt });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ghosts/toggle-auto', (req, res) => {
    try {
        const { enabled } = req.body;
        const val = enabled ? '1' : '0';
        db.prepare("INSERT INTO system_settings (key, value) VALUES ('ghost_auto_approve', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(val);

        let cleared = 0;
        if (enabled) {
            // Auto-Prune was just turned ON — immediately approve every pending
            // non-whitelisted ghost so the queue drains right away.
            // Without this, coins queued before the toggle was flipped sit
            // indefinitely because the scan engine only bypasses queue insertion
            // for NEW ghosts, never retroactively clears old entries.
            const result = db.prepare(`
                UPDATE ghost_approval_queue
                SET is_approved = 1
                WHERE is_approved = 0
                  AND ticker NOT IN (SELECT ticker FROM coin_whitelist)
            `).run();
            cleared = result.changes;
            if (cleared > 0) {
                console.log(`[GHOST-ENGINE] 🔥 Auto-Prune enabled — bulk-approved ${cleared} pending ghost(s)`);
            }
        }

        io.emit('ghost-update', { action: 'toggle-auto', enabled, cleared });
        res.json({ success: true, auto_approve: enabled, cleared });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Watchdog Confidence Clock settings — settle_hours, ghost_hours, gap_tolerance_min.
// See generateScannerFeedback()'s "WATCHDOG CONFIDENCE CLOCK" block for how these
// are used. All three are plain hour/minute counts, adjustable without a deploy.
app.get('/api/ghosts/watchdog-settings', (req, res) => {
    try {
        res.json({ success: true, ...(_getWatchdogSettings()) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/ghosts/watchdog-settings', (req, res) => {
    try {
        const { settleHours, ghostHours, gapToleranceMin, momentumHours, freshSessionVetoMode } = req.body || {};
        const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

        if (settleHours !== undefined) {
            const v = parseFloat(settleHours);
            if (!isFinite(v)) return res.status(400).json({ error: 'settleHours must be a number' });
            _setWatchdogSetting('watchdog_settle_hours', clamp(v, 0, 72));
        }
        if (ghostHours !== undefined) {
            const v = parseFloat(ghostHours);
            if (!isFinite(v)) return res.status(400).json({ error: 'ghostHours must be a number' });
            _setWatchdogSetting('watchdog_ghost_hours', clamp(v, 1, 336)); // up to 14 days
        }
        if (gapToleranceMin !== undefined) {
            const v = parseFloat(gapToleranceMin);
            if (!isFinite(v)) return res.status(400).json({ error: 'gapToleranceMin must be a number' });
            _setWatchdogSetting('watchdog_gap_tolerance_min', clamp(v, 1, 120));
        }
        if (momentumHours !== undefined) {
            const v = parseFloat(momentumHours);
            if (!isFinite(v)) return res.status(400).json({ error: 'momentumHours must be a number' });
            _setWatchdogSetting('watchdog_momentum_hours', clamp(v, 0.25, 24));
        }
        if (freshSessionVetoMode !== undefined) {
            if (!['bypass', 'smart'].includes(freshSessionVetoMode)) {
                return res.status(400).json({ error: "freshSessionVetoMode must be 'bypass' or 'smart'" });
            }
            _setWatchdogSetting('fresh_session_veto_mode', freshSessionVetoMode);
        }

        const updated = _getWatchdogSettings();
        console.log(`[WATCHDOG-CLOCK] ⚙️  Settings updated: settle=${updated.settleHours}h ghost=${updated.ghostHours}h gapTolerance=${updated.gapToleranceMin}m momentum=${updated.momentumHours}h`);
        io.emit('ghost-update', { action: 'watchdog-settings', ...updated });
        res.json({ success: true, ...updated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Fresh Session — manual "burn it down and start over" reset. Requires an
// explicit confirm flag; this is destructive (clears accumulated graduation/
// ghost/sync history and the actual TV watchlist down to majors+whitelist)
// and is never triggered automatically. See performFreshSessionReset() for
// exactly what is and isn't touched.
app.post('/api/watchlist/fresh-session', (req, res) => {
    try {
        if (req.body?.confirm !== true) {
            return res.status(400).json({
                error: 'confirm:true required — this is destructive (clears watchlist history and resets the TV watchlist to majors + whitelist).',
            });
        }
        const { counts, eventId } = performFreshSessionReset();
        io.emit('ghost-update', { action: 'fresh-session', counts, eventId });
        io.emit('market-context-update', { timestamp: new Date().toISOString(), counts: { screener: 0, watchlist: 0 }, freshSession: true });
        res.json({
            success: true,
            message: 'Fresh session armed — waiting for the browser to check in and the reset to actually take effect.',
            cleared: counts,
            eventId,
        });
    } catch (e) {
        console.error('[FRESH-SESSION] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Round-trip status for the Fresh Session button — lets the widget show an
// honest "waiting to hear back" state instead of declaring success on request
// alone, plus a persistent log of recent resets for future reference.
app.get('/api/watchlist/fresh-session-status', (req, res) => {
    try {
        const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 5));
        const rows = db.prepare(
            'SELECT * FROM fresh_session_events ORDER BY id DESC LIMIT ?'
        ).all(limit).map(r => {
            const requestedMs = new Date(r.requested_at).getTime();
            const consumedMs  = r.consumed_at  ? new Date(r.consumed_at).getTime()  : null;
            const confirmedMs = r.confirmed_at ? new Date(r.confirmed_at).getTime() : null;
            return {
                id:                r.id,
                requestedAt:       r.requested_at,
                consumedAt:        r.consumed_at,
                confirmedAt:       r.confirmed_at,
                status:            r.status,
                lastCheckedAt:     r.last_checked_at,
                lastExtraCount:    r.last_extra_count,
                clearedCounts:     r.cleared_counts ? JSON.parse(r.cleared_counts) : null,
                expectedCount:     r.expected_targets ? JSON.parse(r.expected_targets).length : 0,
                // Timings, in seconds, for display — null where not yet reached.
                requestToConsumeSec:  consumedMs  ? Math.round((consumedMs  - requestedMs) / 1000) : null,
                consumeToConfirmSec:  (consumedMs && confirmedMs) ? Math.round((confirmedMs - consumedMs) / 1000) : null,
                totalRoundTripSec:    confirmedMs ? Math.round((confirmedMs - requestedMs) / 1000) : null,
            };
        });
        res.json({ success: true, events: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ============================================================================
// 5.6 COIN WHITELIST API
// ============================================================================

// Helper: normalise any ticker format → cleanTicker as stored in coin_lifecycles.
// coin_lifecycles stores item.ticker which includes the .P suffix (e.g. "XRPUSDT.P").
// We only strip the exchange prefix — everything else (including .P) is kept so
// whitelistTickers.has(cleanTicker) works correctly at protection-check time.
// Accepts: "XRPUSDT.P", "BINANCE:XRPUSDT.P", "xrpusdt.p"
function normaliseWhitelistTicker(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let s = raw.trim().toUpperCase();
    // Strip exchange prefix (e.g. "BINANCE:")
    const colonIdx = s.indexOf(':');
    if (colonIdx !== -1) s = s.slice(colonIdx + 1);
    return s || null;
}

// Watchlist sync health — which targets TradingView has not accepted, how long
// they've been outstanding, and how many times we've re-fired Automa for them.
// A non-empty `stuck` list means the Automa push path is broken.
app.get('/api/watchlist/sync-status', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT ticker, first_missing_at, last_missing_at, consecutive_misses,
                   escalations, last_escalated_at, last_resolved_at, resolve_count
            FROM watchlist_sync_audit
            ORDER BY consecutive_misses DESC, first_missing_at ASC
        `).all();

        const now = Date.now();
        const outstanding = rows.filter(r => r.consecutive_misses > 0).map(r => ({
            ...r,
            missing_for_min: Math.round((now - new Date(r.first_missing_at).getTime()) / 60000),
        }));
        // "Stuck" = escalated at least once and still missing → Automa isn't working.
        const stuck = outstanding.filter(r => r.escalations > 0);

        // Automa wipe history — destructive clear/add failures and their downtime.
        const wipes = db.prepare(`
            SELECT id, detected_at, prev_count, restore_attempts, recovered_at,
                   recovered_count, downtime_sec
            FROM watchlist_wipe_events
            ORDER BY id DESC LIMIT 20
        `).all().map(w => ({
            ...w,
            // Coins that never came back after the wipe (partial-add failure)
            coins_lost: (w.prev_count != null && w.recovered_count != null)
                ? Math.max(0, w.prev_count - w.recovered_count)
                : null,
        }));
        const activeWipe = wipes.find(w => !w.recovered_at) || null;
        const dayAgo = new Date(now - 24 * 3600 * 1000).toISOString();
        const wipes24h = db.prepare(
            'SELECT COUNT(*) c FROM watchlist_wipe_events WHERE detected_at > ?'
        ).get(dayAgo).c;

        res.json({
            generatedAt:  new Date().toISOString(),
            healthy:      outstanding.length === 0 && !activeWipe,
            outstanding,
            stuck,
            resolved_recently: rows
                .filter(r => r.consecutive_misses === 0 && r.last_resolved_at)
                .slice(0, 20),
            // Wipe = Automa cleared the list and failed to re-add it
            active_wipe:   activeWipe,
            wipes_24h:     wipes24h,
            recent_wipes:  wipes,
        });
    } catch (e) {
        console.error('[sync-status]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/whitelist', (req, res) => {
    try {
        const rows = db.prepare(
            "SELECT ticker, exchange, added_at FROM coin_whitelist ORDER BY added_at DESC"
        ).all();
        res.json({ whitelist: rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/whitelist', (req, res) => {
    try {
        const raw      = req.body?.ticker;
        const ticker   = normaliseWhitelistTicker(raw);
        if (!ticker) return res.status(400).json({ error: 'Ticker required' });

        // Resolve exchange: use client-supplied value, fall back to most-recent
        // record in area1_scout_logs (Stream A), then default to BINANCE.
        let exchange = (req.body?.exchange || '').trim().toUpperCase() || null;
        if (!exchange) {
            const found = db.prepare(
                "SELECT exchange FROM area1_scout_logs WHERE ticker = ? ORDER BY timestamp DESC LIMIT 1"
            ).get(ticker.replace(/\.P$/i, '')); // strip .P for scout log lookup
            exchange = found?.exchange || 'BINANCE';
        }

        db.prepare(`
            INSERT INTO coin_whitelist (ticker, exchange, added_at)
            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            ON CONFLICT(ticker) DO UPDATE SET exchange = excluded.exchange
        `).run(ticker, exchange);

        // Immediately evict from ghost queue — a whitelisted coin must never
        // be prunable, so there's no point keeping it in the approval queue.
        // The scan engine's isProtected guard also prevents re-addition on the
        // next cycle, so this cleanup is permanent until the coin is un-whitelisted.
        const evicted = db.prepare(
            "DELETE FROM ghost_approval_queue WHERE ticker = ?"
        ).run(ticker);
        if (evicted.changes > 0) {
            console.log(`[WHITELIST] 🛡️  Evicted ${ticker} from ghost queue (whitelisted)`);
            io.emit('ghost-update', { action: 'whitelist-evict', ticker });
        }

        // Signal the next generateScannerFeedback() call to include
        // action_required: 'UPDATE_WATCHLIST' so Tampermonkey bypasses its
        // 15-min Automa cooldown and pushes the new coin to TV immediately.
        // Persisted (not in-memory) so a restart can't swallow the intent.
        _setWhitelistSyncPending(true);

        io.emit('whitelist-update', { action: 'add', ticker, exchange });
        res.json({ success: true, ticker, exchange, evicted_from_queue: evicted.changes > 0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/whitelist/:ticker', (req, res) => {
    try {
        const ticker = normaliseWhitelistTicker(req.params.ticker);
        if (!ticker) return res.status(400).json({ error: 'Ticker required' });

        db.prepare("DELETE FROM coin_whitelist WHERE ticker = ?").run(ticker);
        io.emit('whitelist-update', { action: 'remove', ticker });
        res.json({ success: true, ticker });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Known-coin suggestions for the whitelist picker.
// Joins coin_lifecycles with the most-recent area1_scout_logs entry per ticker
// so we can show the correct exchange alongside each suggestion.
app.get('/api/coins/known', (req, res) => {
    try {
        const rows = db.prepare(`
            SELECT cl.ticker, cl.status, cl.last_seen_at,
                   COALESCE(al.exchange, 'BINANCE') AS exchange
            FROM coin_lifecycles cl
            LEFT JOIN (
                SELECT ticker, exchange, MAX(timestamp) AS ts
                FROM area1_scout_logs
                GROUP BY ticker
            ) al ON al.ticker = REPLACE(REPLACE(cl.ticker, '.P', ''), '.PERP', '')
            ORDER BY cl.last_seen_at DESC
            LIMIT 200
        `).all();
        res.json({ coins: rows });
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

// --- ANALYTICS CACHE (Institutional Speed) ---
// Keyed by `hours|refTime` string — collapses burst from multiple widgets
// (RSIDistribution, MarketStructure, ConfluenceGrid, AlertsAnalyzer) all
// hitting /api/analytics/pulse simultaneously on scan-update.
const _pulseCache   = new Map(); // key -> { ts, data }
const PULSE_CACHE_TTL = 15_000;  // 15s — safe since data changes at scan cadence (~1-5 min)

// --- FUSION CACHE ---
const _fusionCache  = new Map(); // key -> { ts, data }
const FUSION_CACHE_TTL = 10_000; // 10s

// --- RSI GRID CACHE ---
const _rsiGridCache = new Map(); // key -> { ts, data }
const RSI_GRID_CACHE_TTL = 15_000; // 15s — RSI updates at Stream D cadence (~2 min)

// --- MOMENTUM PULSE CACHE ---
const _momentumCache = new Map(); // key -> { ts, data }
const MOMENTUM_CACHE_TTL = 15_000; // 15s

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

// 8. ANALYTICS PULSE (Real V3 Aggregation)
app.get('/api/analytics/pulse', (req, res) => {
    try {
        const hours = parseInt(req.query.hours) || 24;
        const refTime = req.query.refTime ? new Date(req.query.refTime) : new Date();
        const anchorTime = isNaN(refTime.getTime()) ? new Date() : refTime;
        const anchorStr = anchorTime.toISOString();
        const cutoff = new Date(anchorTime.getTime() - hours * 60 * 60 * 1000).toISOString();

        // Cache check — collapses widget burst (4 components hit this at once on scan-update)
        // Replay queries (with explicit refTime) are also cached briefly to absorb double-mount.
        const _pulseCacheKey = `${hours}|${req.query.refTime || ''}`;
        const _pulseCacheHit = _pulseCache.get(_pulseCacheKey);
        if (_pulseCacheHit && (Date.now() - _pulseCacheHit.ts) < PULSE_CACHE_TTL) {
            res.set('Cache-Control', 'public, max-age=15');
            return res.json(_pulseCacheHit.data);
        }

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

        const responseData = {
            total_alerts,
            volume_intent,
            market_structure,
            time_spread,
            signals, // New Field
            predictions: [],
            insights: total_alerts > 0 ? [`${total_alerts} events in last ${hours}h`] : ["No recent activity"]
        };

        // Cache the result (all queries — short TTL so stale data is never a concern)
        _pulseCache.set(_pulseCacheKey, { ts: Date.now(), data: responseData });
        res.set('Cache-Control', 'public, max-age=15');
        res.json(responseData);

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
// Liveness probe for the Stream C webhook.
//
// The ingestion route below is POST-only, so ANY GET — a browser address bar, a
// curl sanity check, or TradingView's own webhook-URL validator — returns 404
// and reads as "endpoint not reachable" even when POST ingestion is working
// perfectly. This sibling route answers GET with a 200 and useful diagnostics so
// the URL can be verified from anywhere without sending a fake alert.
app.get('/api/webhook/smart-levels', (req, res) => {
    try {
        const last = db.prepare(
            'SELECT ticker, timestamp FROM smart_level_events ORDER BY id DESC LIMIT 1'
        ).get();
        const ageMin = last
            ? Math.round((Date.now() - new Date(last.timestamp).getTime()) / 60000)
            : null;
        res.json({
            ok: true,
            endpoint: '/api/webhook/smart-levels',
            accepts: 'POST application/json',
            note: 'Endpoint is live. Stream C alerts are event-driven — a quiet period is normal.',
            last_event: last ? { ticker: last.ticker, timestamp: last.timestamp, age_min: ageMin } : null,
            server_time: new Date().toISOString(),
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/webhook/smart-levels', (req, res) => {
    try {
        const payload = req.body;

        if (!payload || !payload.ticker) {
            return res.status(400).json({ error: "Invalid payload missing ticker" });
        }

        const ticker = payload.ticker;
        const price = parsePrice(payload.price || payload.close);

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

                // 📣 Telegram: institutional bar move alert (Phase 1 gap fix)
                setImmediate(() => {
                    try {
                        TelegramService.onInstitutionalBarMove({
                            ticker, price, barMovePct: bar_move_pct,
                            direction, volume: today_volume,
                        });
                    } catch (e) { console.error('[INST-INTEREST] Telegram hook error:', e.message); }
                });
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

        // Cache check — fusion fires on every smart-level-update socket event which
        // can arrive multiple times per second during active market conditions.
        const _fusionKey = req.query.refTime || 'live';
        const _fusionHit = _fusionCache.get(_fusionKey);
        if (_fusionHit && (Date.now() - _fusionHit.ts) < FUSION_CACHE_TTL) {
            res.set('Cache-Control', 'public, max-age=10');
            return res.json(_fusionHit.data);
        }

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

        const _fusionPayload = {
            success: true,
            count: dashboardData.length,
            records: dashboardData,
            rsi_distribution: rsi_distribution
        };
        _fusionCache.set(_fusionKey, { ts: Date.now(), data: _fusionPayload });
        res.set('Cache-Control', 'public, max-age=10');
        res.json(_fusionPayload);

    } catch (e) {
        console.error("Fusion Dashboard Error:", e);
        res.status(500).json({ error: e.message });
    }
});

// --- 3rd Umpire Validator ---
const umpire = new UmpireEngine({ io });
telegramValidator.attach(umpire, TelegramService);
umpire.start();

// ─────────────────────────────────────────────────────────────────────────────
// HOURLY HEARTBEAT — system-alive digest + key market stats
// Fires every 60 minutes. First fire is delayed 60s after boot so that
// the startup notification doesn't immediately collide with it.
// ─────────────────────────────────────────────────────────────────────────────
setTimeout(() => {
    setInterval(() => {
        TelegramService.onHeartbeat().catch(e => console.error('[Heartbeat]', e.message));
    }, 60 * 60 * 1000);
}, 60 * 1000);

// ============================================================================
// LEVEL REACTION MONITOR — /api/level-reactions
// ============================================================================
//
// For each coin in the latest scan that is within ±maxDist% of a structural
// level (support or resistance), pulls master_coin_store price history and
// ─── RSI Grid Wall ─────────────────────────────────────────────────────────
// Per-coin RSI "candle wall": body = cascade series TFs (e.g. 1h+30m RSI span),
// white line = temp TF (e.g. 15m) RSI. Pullback signal = cascade active + temp near 50.
app.get('/api/rsi-grid-wall', (req, res) => {
    try {
        const seriesTFsRaw  = (req.query.series_tfs  || 'h1,m30').split(',').map(s => s.trim());
        const tempTF        = (req.query.temp_tf      || 'm15').trim();
        const oversold      = parseFloat(req.query.oversold      ?? 30);
        const overbought    = parseFloat(req.query.overbought     ?? 70);
        const pullbackZone  = parseFloat(req.query.pullback_zone  ?? 5);

        // Cache check — RSI values update at Stream D cadence (~2 min); 15s cache is safe.
        const _rsiKey = `${seriesTFsRaw.join(',')}|${tempTF}|${oversold}|${overbought}|${pullbackZone}`;
        const _rsiHit = _rsiGridCache.get(_rsiKey);
        if (_rsiHit && (Date.now() - _rsiHit.ts) < RSI_GRID_CACHE_TTL) {
            res.set('Cache-Control', 'public, max-age=15');
            return res.json(_rsiHit.data);
        }

        const TF_COL = { m5: 'rsi_m5', m15: 'rsi_m15', m30: 'rsi_m30', h1: 'rsi_h1' };
        const validTFs  = Object.keys(TF_COL);
        const seriesTFs = seriesTFsRaw.filter(tf => validTFs.includes(tf));
        if (!seriesTFs.length) return res.status(400).json({ error: 'no valid series_tfs' });
        if (!validTFs.includes(tempTF)) return res.status(400).json({ error: 'invalid temp_tf' });

        const since = Date.now() - 30 * 60 * 1000;

        // Latest 2 rows per ticker — row 1 = current, row 2 = previous (for direction)
        const rows = db.prepare(`
            WITH ranked AS (
                SELECT ticker, ts, rsi_m5, rsi_m15, rsi_m30, rsi_h1,
                       ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) AS rn
                FROM coin_metric_history
                WHERE ts > ?
            )
            SELECT
                r1.ticker, r1.ts,
                r1.rsi_m5, r1.rsi_m15, r1.rsi_m30, r1.rsi_h1,
                r2.rsi_m5  AS prev_m5,  r2.rsi_m15 AS prev_m15,
                r2.rsi_m30 AS prev_m30, r2.rsi_h1  AS prev_h1
            FROM ranked r1
            LEFT JOIN ranked r2 ON r1.ticker = r2.ticker AND r2.rn = 2
            WHERE r1.rn = 1
        `).all(since);

        const getZone = (v) => {
            if (v == null) return null;
            if (v < oversold)  return 'oversold';
            if (v > overbought) return 'overbought';
            return 'middle';
        };

        const CASCADE_ORDER = { BEAR_CASCADE: 0, BULL_CASCADE: 1, PARTIAL_BEAR: 2, PARTIAL_BULL: 3, NEUTRAL: 4 };

        const coins = rows.map(row => {
            const rsi     = { m5: row.rsi_m5,  m15: row.rsi_m15,  m30: row.rsi_m30,  h1: row.rsi_h1  };
            const prevRsi = { m5: row.prev_m5, m15: row.prev_m15, m30: row.prev_m30, h1: row.prev_h1 };

            if (seriesTFs.every(tf => rsi[tf] == null)) return null;

            const seriesZones = seriesTFs.map(tf => getZone(rsi[tf]));
            let cascadeState = 'NEUTRAL';
            if (seriesZones.every(z => z === 'oversold'))    cascadeState = 'BEAR_CASCADE';
            else if (seriesZones.every(z => z === 'overbought')) cascadeState = 'BULL_CASCADE';
            else if (seriesZones.some(z => z === 'oversold'))    cascadeState = 'PARTIAL_BEAR';
            else if (seriesZones.some(z => z === 'overbought'))  cascadeState = 'PARTIAL_BULL';

            const tempRsi  = rsi[tempTF];
            const prevTemp = prevRsi[tempTF];
            const tempZone = getZone(tempRsi);
            const tempDir  = (tempRsi == null || prevTemp == null) ? 'flat'
                           : tempRsi > prevTemp + 0.5 ? 'up'
                           : tempRsi < prevTemp - 0.5 ? 'down' : 'flat';
            const prevTempZone = getZone(prevTemp);

            const cascadeActive = cascadeState === 'BEAR_CASCADE' || cascadeState === 'BULL_CASCADE';
            const pullback = cascadeActive && tempZone === 'middle'
                          && tempRsi != null && Math.abs(tempRsi - 50) <= (pullbackZone + 5);

            // RSI velocity (Δ vs previous 2-min bucket) — enables entry quality signal
            const rsiDelta = {};
            const allTFs = [...new Set([...seriesTFs, tempTF])];
            for (const tf of allTFs) {
                const curr = rsi[tf]; const prev = prevRsi[tf];
                rsiDelta[tf] = (curr != null && prev != null) ? +(curr - prev).toFixed(1) : null;
            }

            const clean = row.ticker.replace(/USDT\.P$|USDT$|BUSD$|USD$/, '');
            return { ticker: row.ticker, clean, ts: row.ts, rsi, rsiDelta, cascadeState, tempZone, tempDir, prevTempZone, pullback };
        }).filter(Boolean);

        coins.sort((a, b) => {
            const od = (CASCADE_ORDER[a.cascadeState] ?? 5) - (CASCADE_ORDER[b.cascadeState] ?? 5);
            return od !== 0 ? od : (b.pullback ? 1 : 0) - (a.pullback ? 1 : 0);
        });

        const _rsiPayload = { coins, config: { seriesTFs, tempTF, oversold, overbought, pullbackZone } };
        _rsiGridCache.set(_rsiKey, { ts: Date.now(), data: _rsiPayload });
        res.set('Cache-Control', 'public, max-age=15');
        res.json(_rsiPayload);
    } catch (e) {
        console.error('[RSI Grid Wall]', e);
        res.status(500).json({ error: e.message });
    }
});

// ─── BYOC Screener — Bring Your Own Coins ─────────────────────────────────
// Dynamic multi-criteria filter across all coin metrics.
// Clause fields from coin_metric_history (RSI/RVOL/ATR/EMA-dist) + Stream C
// (change%, volume, price). Clauses joined by AND or OR.
//
// Query params:
//   clauses  JSON array of {field, op, value}
//   mode     'AND' | 'OR'  (default AND)

// Module-level cached prepared statements — compiled once, reused on every request.
const _bycCmhStmt = db.prepare(`
    WITH ranked AS (
        SELECT ticker, ts,
               rsi_m5, rsi_m15, rsi_m30, rsi_h1,
               rvol_m15, rvol_h1,
               atr_m15, atr_h1, atr_h4,
               dist_m1, dist_m5, dist_m15, dist_h1, dist_h4,
               ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) AS rn
        FROM coin_metric_history WHERE ts > ?
    )
    SELECT * FROM ranked WHERE rn = 1
`);
const _bycScStmt = db.prepare(`
    WITH ranked AS (
        SELECT ticker, stream_c_state, price, timestamp,
               ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS rn
        FROM master_coin_store
        WHERE trigger_source = 'STREAM_C'
          AND stream_c_state IS NOT NULL
          AND timestamp > ?
    )
    SELECT ticker, stream_c_state, price, timestamp FROM ranked WHERE rn = 1
`);
// Whitelist sets — constant, computed once.
const _bycValidFields = new Set([
    'rsi_m5','rsi_m15','rsi_m30','rsi_h1',
    'rvol_m15','rvol_h1',
    'atr_m15','atr_h1','atr_h4',
    'dist_m1','dist_m5','dist_m15','dist_h1','dist_h4',
    'change_pct','volume','price',
]);
const _bycValidOps = new Set(['>', '<', '>=', '<=', '=', 'above_ema', 'below_ema', 'at_ema']);

app.get('/api/byc-screener', (req, res) => {
    try {
        let clauses = [];
        try { clauses = JSON.parse(req.query.clauses || '[]'); } catch {}
        const mode = (req.query.mode || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';

        // Sanitise — drop anything with unknown field/op (SQL injection guard)
        const safeClauses = clauses.filter(c =>
            c && _bycValidFields.has(c.field) && _bycValidOps.has(c.op)
        );

        // 1. Latest coin_metric_history per ticker (Stream D — last 30 min)
        const cmhRows = _bycCmhStmt.all(Date.now() - 30 * 60 * 1000);

        // 2. Latest stream_c_state per ticker (change%, volume, price — last 2h)
        const scRows  = _bycScStmt.all(new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());

        // 3. Build unified coin map (Stream D keys authoritative; Stream C adds change%/vol)
        const coinMap = new Map();
        for (const r of cmhRows) {
            coinMap.set(r.ticker, {
                ticker: r.ticker, ts: r.ts,
                rsi_m5: r.rsi_m5, rsi_m15: r.rsi_m15, rsi_m30: r.rsi_m30, rsi_h1: r.rsi_h1,
                rvol_m15: r.rvol_m15, rvol_h1: r.rvol_h1,
                atr_m15: r.atr_m15, atr_h1: r.atr_h1, atr_h4: r.atr_h4,
                dist_m1: r.dist_m1, dist_m5: r.dist_m5, dist_m15: r.dist_m15,
                dist_h1: r.dist_h1, dist_h4: r.dist_h4,
                price: null, change_pct: null, volume: null, src: 'D',
            });
        }
        for (const r of scRows) {
            let sc = {};
            try { sc = JSON.parse(r.stream_c_state); } catch {}
            const ex = coinMap.get(r.ticker) || { ticker: r.ticker };
            coinMap.set(r.ticker, {
                ...ex,
                price:      parseFloat(sc.price      ?? r.price) || ex.price,
                change_pct: sc.today_change_pct != null ? parseFloat(sc.today_change_pct) : ex.change_pct,
                volume:     sc.today_volume     != null ? parseFloat(sc.today_volume)     : ex.volume,
                scTs: r.timestamp,
                src: ex.rsi_m15 != null ? 'D+C' : 'C',
            });
        }

        // 4. Clause evaluator
        function evalClause(coin, c) {
            let val = coin[c.field];
            if (val == null) return false;
            val = parseFloat(val);
            if (!isFinite(val)) return false;
            const threshold = parseFloat(c.value);
            switch (c.op) {
                case '>':         return val > threshold;
                case '<':         return val < threshold;
                case '>=':        return val >= threshold;
                case '<=':        return val <= threshold;
                case '=':         return Math.abs(val - threshold) < 0.01;
                case 'above_ema': return val > 0;
                case 'below_ema': return val < 0;
                case 'at_ema':    return Math.abs(val) <= (isFinite(threshold) ? threshold : 0.5);
                default:          return false;
            }
        }

        // 5. Filter + shape output
        const fmt = (v, dp = 2) => v != null ? +parseFloat(v).toFixed(dp) : null;
        const coins = [];
        for (const [ticker, coin] of coinMap) {
            let match;
            if (!safeClauses.length) {
                match = true;
            } else if (mode === 'OR') {
                match = safeClauses.some(c => evalClause(coin, c));
            } else {
                match = safeClauses.every(c => evalClause(coin, c));
            }
            if (!match) continue;

            const clean = ticker.replace(/USDT\.P$|USDT$|BUSD$|USD$/, '');
            coins.push({
                ticker, clean, src: coin.src,
                price:      fmt(coin.price, 4),
                change_pct: fmt(coin.change_pct),
                volume:     coin.volume ? Math.round(coin.volume) : null,
                rsi: {
                    m5:  fmt(coin.rsi_m5,  1),
                    m15: fmt(coin.rsi_m15, 1),
                    m30: fmt(coin.rsi_m30, 1),
                    h1:  fmt(coin.rsi_h1,  1),
                },
                rvol: { m15: fmt(coin.rvol_m15), h1: fmt(coin.rvol_h1) },
                atr:  { m15: fmt(coin.atr_m15),  h1: fmt(coin.atr_h1), h4: fmt(coin.atr_h4) },
                dist: {
                    m1:  fmt(coin.dist_m1),  m5:  fmt(coin.dist_m5),
                    m15: fmt(coin.dist_m15), h1:  fmt(coin.dist_h1), h4: fmt(coin.dist_h4),
                },
                ts: coin.ts, scTs: coin.scTs,
            });
        }

        // Sort: most data first, then by |change%| desc
        coins.sort((a, b) => {
            const s = (x) => x.src === 'D+C' ? 2 : x.src === 'D' ? 1 : 0;
            const sd = s(b) - s(a);
            return sd !== 0 ? sd : (Math.abs(b.change_pct ?? 0) - Math.abs(a.change_pct ?? 0));
        });

        res.json({ coins, matched: coins.length, ts: Date.now(), mode, clauses: safeClauses });
    } catch (e) {
        console.error('[byc-screener]', e);
        res.status(500).json({ error: e.message });
    }
});

// ─── Momentum Pulse ────────────────────────────────────────────────────────
// Combines Stream B (day change%, volume) with Stream D rolling history
// (RVOL, ATR, EMA-distance) to show which coins are pushing with persistence.
//
// RVOL persistence = how many consecutive 2-min buckets had rvol_m15 > threshold
// Helper: derive cascade state from multi-TF EMA distances + price.
// Uses same threshold logic as client-side cascadeUtils.checkCascade.
// series: longest→shortest, e.g. ['h4','h1','m15']
function _cascadeFromDists(price, dists, series = ['h4','h1','m15'], threshold = 0.2) {
    if (!price) return 'neutral';
    const emas = {};
    for (const tf of series) {
        const d = dists[tf];
        if (d == null) return 'neutral'; // missing TF → can't classify
        emas[tf] = price / (1 + d / 100); // derive EMA200 price from distance %
    }
    let isBull = true, isBear = true;
    for (let i = 0; i < series.length - 1; i++) {
        const longer  = emas[series[i]];
        const shorter = emas[series[i + 1]];
        if (!longer || !shorter) return 'neutral';
        const pctDiff = ((shorter - longer) / longer) * 100;
        if (pctDiff < -threshold) isBull = false;
        if (pctDiff >  threshold) isBear = false;
    }
    if (isBull && !isBear) return 'bull';
    if (isBear && !isBull) return 'bear';
    return 'neutral';
}

// EMA distance    = price % above/below 15m EMA200 (overbought/oversold proxy)
app.get('/api/momentum-pulse', (req, res) => {
    try {
        const rvolThresh  = parseFloat(req.query.rvol_thresh) || 1.2;
        const histBuckets = Math.min(120, parseInt(req.query.hist) || 30);
        const cutoffTs    = Date.now() - histBuckets * 2 * 60 * 1000;

        // Cache check — data changes at Stream D cadence (~2 min); 15s TTL is safe.
        const _momentumKey = `${rvolThresh}|${histBuckets}`;
        const _momentumHit = _momentumCache.get(_momentumKey);
        if (_momentumHit && (Date.now() - _momentumHit.ts) < MOMENTUM_CACHE_TTL) {
            res.set('Cache-Control', 'public, max-age=15');
            return res.json(_momentumHit.data);
        }

        // ── 1. Primary: latest Stream C state per ticker (master_coin_store) ──
        // Stream C fires per-coin on every scan/alert cycle — fresher than Stream B's
        // batched watchlist snapshot. Provides today_change_pct, today_volume, rsi_matrix,
        // momentum.roc_pct. Use a 2h window so we still cover slow-moving coins.
        const scSince = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const scRows = db.prepare(`
            WITH ranked AS (
                SELECT ticker, stream_c_state, timestamp, price,
                       ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) AS rn
                FROM master_coin_store
                WHERE stream_c_state IS NOT NULL AND timestamp > ?
            )
            SELECT ticker, stream_c_state, timestamp, price FROM ranked WHERE rn = 1
        `).all(scSince);

        // ── 2. Fallback: Stream B watchlist for any ticker not in Stream C ─────
        const bRow = db.prepare(
            `SELECT payload_json FROM market_context_logs ORDER BY id DESC LIMIT 1`
        ).get();
        const bWatchlist = bRow
            ? (JSON.parse(bRow.payload_json || '{}').watchlist_active_snapshot || [])
            : [];
        const bMap = new Map(bWatchlist.map(w => [w.short, w]));

        // ── 3. Parse Stream C into a unified coin map ─────────────────────────
        // Stream C provides ONLY: today_change_pct, today_volume, price, rocPct.
        // All RSI and EMA values come exclusively from Stream D (coin_metric_history).
        const coinMap = new Map();
        for (const row of scRows) {
            let sc = {};
            try { sc = JSON.parse(row.stream_c_state); } catch {}
            coinMap.set(row.ticker, {
                price:     parseFloat(sc.price || row.price) || null,
                changePct: parseFloat(sc.today_change_pct)   || 0,
                volume:    parseFloat(sc.today_volume)        || 0,
                rocPct:    parseFloat(sc.momentum?.roc_pct)   || 0,
                direction: parseInt(sc.momentum?.direction)   || 0,
                scTs: row.timestamp,
                src: 'STREAM_C',
            });
        }
        // Merge in any Stream B tickers not covered by Stream C
        for (const w of bWatchlist) {
            if (!coinMap.has(w.short) && w.short) {
                coinMap.set(w.short, {
                    price:     w.price      ?? null,
                    changePct: w.change_pct ?? 0,
                    volume:    w.vol_raw    ?? 0,
                    rocPct:    0,
                    direction: 0,
                    scTs:      null,
                    src: 'STREAM_B',
                });
            }
        }

        if (!coinMap.size) return res.json({ coins: [], ts: Date.now() });

        // ── 4. Rolling coin_metric_history for RVOL + RSI + EMA dist ─────────
        const tickers = [...coinMap.keys()];
        const ph = tickers.map(() => '?').join(',');
        const metricRows = db.prepare(`
            SELECT ticker, ts, rvol_m15, atr_m15,
                   dist_m1, dist_m5, dist_m15, dist_h1, dist_h4,
                   rsi_m15, rsi_m30, rsi_h1
            FROM coin_metric_history
            WHERE ticker IN (${ph}) AND ts >= ?
            ORDER BY ticker, ts ASC
        `).all(...tickers, cutoffTs);

        const byTicker = new Map();
        for (const r of metricRows) {
            if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
            byTicker.get(r.ticker).push(r);
        }

        // ── 5. Per-coin signals ───────────────────────────────────────────────
        const coins = [];
        for (const [ticker, coinData] of coinMap) {
            const rows   = byTicker.get(ticker) || [];
            const latest = rows[rows.length - 1] || {};

            const rvolNow = latest.rvol_m15 ?? null;
            const atrNow  = latest.atr_m15  ?? null;
            const distNow = latest.dist_m15  ?? null;
            // Multi-TF distances — used for EMA cascade classification
            const dists = {
                m1:  latest.dist_m1  ?? null,
                m5:  latest.dist_m5  ?? null,
                m15: latest.dist_m15 ?? null,
                h1:  latest.dist_h1  ?? null,
                h4:  latest.dist_h4  ?? null,
            };
            // EMA cascade state from multi-TF distances (default long series h4→h1→m15)
            const cascadeState = _cascadeFromDists(coinData.price, dists);
            // RSI exclusively from Stream D (coin_metric_history) — no Stream C fallback
            const rsi_m15 = latest.rsi_m15 ?? null;
            const rsi_m30 = latest.rsi_m30 ?? null;
            const rsi_h1  = latest.rsi_h1  ?? null;

            // RVOL persistence (consecutive 2-min buckets above threshold)
            let rvolPersist = 0;
            for (let i = rows.length - 1; i >= 0; i--) {
                if ((rows[i].rvol_m15 ?? 0) >= rvolThresh) rvolPersist++;
                else break;
            }

            // RVOL trend (avg last-3 vs prev-3 buckets)
            let rvolTrend = 'flat';
            if (rows.length >= 6) {
                const r3  = rows.slice(-3).map(r => r.rvol_m15 ?? 0);
                const p3  = rows.slice(-6, -3).map(r => r.rvol_m15 ?? 0);
                const avgR = r3.reduce((s, v) => s + v, 0) / 3;
                const avgP = p3.reduce((s, v) => s + v, 0) / 3;
                if (avgR > avgP * 1.2)      rvolTrend = 'rising';
                else if (avgR < avgP * 0.8) rvolTrend = 'fading';
            }

            // EMA distance zone
            let distState = 'neutral';
            if      (distNow != null && distNow >  3) distState = 'extended_high';
            else if (distNow != null && distNow >  1) distState = 'above';
            else if (distNow != null && distNow < -3) distState = 'extended_low';
            else if (distNow != null && distNow < -1) distState = 'below';
            else if (distNow != null)                  distState = 'near_ema';

            // Synthesised signal — now RSI-aware
            const chg = coinData.changePct;
            let signal = 'WATCH';
            if      (rvolPersist >= 5 && chg > 2 && distNow != null && distNow > 1)
                signal = 'SURGING';
            else if (rvolPersist >= 3 && chg > 0)
                signal = 'BUILDING';
            else if (rsi_m15 != null && rsi_m15 < 30 && (rsi_h1 ?? 50) < 40)
                signal = 'RSI_OS';   // multi-TF oversold cascade
            else if (rsi_m15 != null && rsi_m15 > 70 && (rsi_h1 ?? 50) > 60)
                signal = 'RSI_OB';   // multi-TF overbought cascade
            else if (rvolTrend === 'fading' && distNow != null && distNow > 2)
                signal = 'FADING';
            else if (distNow != null && distNow > 4 && (rvolNow ?? 0) < 1)
                signal = 'EXTENDED';
            else if (distNow != null && distNow < -4 && (rvolNow ?? 0) < 1)
                signal = 'STRETCHED';
            else if (distNow != null && Math.abs(distNow) < 0.5)
                signal = 'AT EMA';

            const rvolSpark = rows.slice(-15).map(r => +(r.rvol_m15 ?? 0).toFixed(2));
            const clean = ticker.replace(/USDT\.P$|USDT$|BUSD$|USD$/, '');

            coins.push({
                ticker, clean,
                price:       coinData.price,
                changePct:   +coinData.changePct.toFixed(2),
                volume:      coinData.volume,
                rocPct:      +coinData.rocPct.toFixed(2),
                direction:   coinData.direction,
                rvolNow:     rvolNow != null ? +rvolNow.toFixed(2) : null,
                atrNow:      atrNow  != null ? +atrNow.toFixed(2)  : null,
                distNow:     distNow != null ? +distNow.toFixed(2) : null,
                rsi_m15:     rsi_m15 != null ? +rsi_m15.toFixed(1) : null,
                rsi_m30:     rsi_m30 != null ? +rsi_m30.toFixed(1) : null,
                rsi_h1:      rsi_h1  != null ? +rsi_h1.toFixed(1)  : null,
                rvolPersist, rvolTrend, distState, signal, rvolSpark,
                cascadeState, dists,
                src: coinData.src,
                scTs: coinData.scTs,
            });
        }

        const _momentumPayload = { coins, ts: Date.now(), rvolThresh };
        _momentumCache.set(_momentumKey, { ts: Date.now(), data: _momentumPayload });
        res.set('Cache-Control', 'public, max-age=15');
        res.json(_momentumPayload);
    } catch (e) {
        console.error('[momentum-pulse]', e);
        res.status(500).json({ error: e.message });
    }
});

// ─── Smart Mood Chart ──────────────────────────────────────────────────────
// Aggregated market mood + breadth timeline with shift detection, volume
// spikes and Stream C events — feeds SmartMoodChart widget.
//
// Query params:
//   hours        (default 8, max 48) — history window
//   interval_min (default 5, max 60) — bucket size in minutes
app.get('/api/smart-mood-chart', (req, res) => {
    try {
        const hours       = Math.min(48, Math.max(0.5, parseFloat(req.query.hours)       || 8));
        const intervalMin = Math.min(60, Math.max(1,   parseInt(req.query.interval_min)  || 5));
        const sinceMs     = Date.now() - hours * 3600 * 1000;
        const sinceIso    = new Date(sinceMs).toISOString();
        const intervalMs  = intervalMin * 60 * 1000;

        // 1. Mood + breadth from raw_market_sentiment_log
        const moodRows = db.prepare(`
            SELECT timestamp, raw_mood_score as mood, raw_bullish as bull, raw_bearish as bear
            FROM raw_market_sentiment_log
            WHERE timestamp >= ?
            ORDER BY timestamp ASC
        `).all(sinceIso);

        // Bucket into intervalMin bins
        const bucketMap = new Map();
        for (const row of moodRows) {
            const ts  = new Date(row.timestamp).getTime();
            const key = Math.floor(ts / intervalMs) * intervalMs;
            if (!bucketMap.has(key)) bucketMap.set(key, { ts: key, moodSum: 0, bullSum: 0, bearSum: 0, n: 0 });
            const b = bucketMap.get(key);
            b.moodSum += (row.mood || 0);
            b.bullSum += (row.bull || 0);
            b.bearSum += (row.bear || 0);
            b.n++;
        }
        const timeline = [...bucketMap.values()].sort((a, b) => a.ts - b.ts).map(b => ({
            ts:   b.ts,
            mood: Math.round(b.moodSum / b.n),
            bull: Math.round(b.bullSum  / b.n),
            bear: Math.round(b.bearSum  / b.n),
            net:  Math.round((b.bullSum - b.bearSum) / b.n),
        }));

        // 2. Shift / inflection detection
        const shifts = [];
        for (let i = 1; i < timeline.length; i++) {
            const prev = timeline[i - 1];
            const cur  = timeline[i];
            // Net-breadth zero crossing
            if (prev.net !== 0 && cur.net !== 0 && Math.sign(prev.net) !== Math.sign(cur.net)) {
                shifts.push({ ts: cur.ts, type: 'net_cross', direction: cur.net > 0 ? 'bull' : 'bear', from: prev.net, to: cur.net });
            }
            // Mood zero crossing
            if (prev.mood !== 0 && cur.mood !== 0 && Math.sign(prev.mood) !== Math.sign(cur.mood)) {
                shifts.push({ ts: cur.ts, type: 'mood_cross', direction: cur.mood > 0 ? 'bull' : 'bear', from: prev.mood, to: cur.mood });
            }
            // Momentum reversal (second-derivative sign change with >5pt magnitude)
            if (i >= 2) {
                const prev2 = timeline[i - 2];
                const d1 = prev.mood - prev2.mood;
                const d2 = cur.mood  - prev.mood;
                if (Math.abs(d1) > 5 && Math.abs(d2) > 5 && Math.sign(d1) !== Math.sign(d2)) {
                    shifts.push({ ts: cur.ts, type: 'momentum_flip', direction: d2 > 0 ? 'bull' : 'bear', magnitude: Math.abs(d2) });
                }
            }
        }

        // 3. Volume spikes
        const allVolEvents = db.prepare(`
            SELECT ticker, ts, source, strength
            FROM volume_events
            WHERE ts >= ?
            ORDER BY ts ASC
            LIMIT 600
        `).all(sinceIso).map(r => ({
            ticker:   r.ticker,
            ts:       typeof r.ts === 'number' ? r.ts : new Date(r.ts).getTime(),
            source:   r.source,
            strength: r.strength,
            clean:    r.ticker.replace(/USDT\.P$|USDT$/, ''),
        }));

        // 4. Stream C alerts
        const allStreamC = db.prepare(`
            SELECT ticker, timestamp as ts, direction, roc_pct as strength, price
            FROM smart_level_events
            WHERE timestamp >= ?
            ORDER BY timestamp ASC
            LIMIT 600
        `).all(sinceIso).map(r => ({
            ticker:    r.ticker,
            ts:        new Date(r.ts).getTime(),
            direction: r.direction,
            strength:  r.strength,
            price:     r.price,
            clean:     r.ticker.replace(/USDT\.P$|USDT$/, ''),
        }));

        // 5. Annotate timeline buckets with participating coin names
        //    so the tooltip can show which coins contributed to each bucket.
        const volByBucket  = new Map();
        const scByBucket   = new Map();
        for (const e of allVolEvents) {
            const key = Math.floor(e.ts / intervalMs) * intervalMs;
            if (!volByBucket.has(key)) volByBucket.set(key, []);
            volByBucket.get(key).push({ clean: e.clean, source: e.source, strength: e.strength });
        }
        for (const e of allStreamC) {
            const key = Math.floor(e.ts / intervalMs) * intervalMs;
            if (!scByBucket.has(key)) scByBucket.set(key, []);
            scByBucket.get(key).push({ clean: e.clean, direction: e.direction });
        }
        for (const b of timeline) {
            const vols = volByBucket.get(b.ts) || [];
            const scs  = scByBucket.get(b.ts)  || [];
            // Deduplicate by coin name, keep highest-strength entry
            const volMap = new Map();
            for (const v of vols) {
                if (!volMap.has(v.clean) || (v.strength || 0) > (volMap.get(v.clean).strength || 0))
                    volMap.set(v.clean, v);
            }
            b.volCoins = [...volMap.values()].sort((a, b) => (b.strength || 0) - (a.strength || 0)).slice(0, 8)
                .map(v => ({ c: v.clean, s: v.source, str: +(v.strength || 1).toFixed(2) }));
            // Deduplicate stream C by coin
            const scMap = new Map();
            for (const s of scs) { if (!scMap.has(s.clean)) scMap.set(s.clean, s.direction); }
            b.scCoins = [...scMap.entries()].slice(0, 8).map(([c, d]) => ({ c, d }));
        }

        // Keep raw overlay events for the chart markers (capped for perf)
        const volEvents    = allVolEvents.slice(-400);
        const streamCEvents= allStreamC.slice(-400);

        res.json({ timeline, shifts, volEvents, streamCEvents, hours, intervalMin });
    } catch (e) {
        console.error('[smart-mood-chart]', e);
        res.status(500).json({ error: e.message });
    }
});

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
        const requestedTicker = req.query.ticker?.toUpperCase();
        // If a single ticker is requested, allow 1 results (limit is ignored) and slightly wider dist
        const limit      = requestedTicker ? 1 : Math.min(20, Math.max(1, parseInt(req.query.limit) || 12));
        const maxDist    = Math.min(requestedTicker ? 100 : 10, Math.max(0.5, parseFloat(req.query.max_dist) || 5));

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
            const cleanTicker = ticker.replace(/USDT\.P$|USDT$/, '').toUpperCase();
            
            // Filter by requested ticker if present
            if (requestedTicker && cleanTicker !== requestedTicker && ticker.toUpperCase() !== requestedTicker) return;

            const close  = parsePrice(d.close || d.price);
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
            // Fetch Stream D now (in-memory cache, no extra DB query) so we can
            // derive the 1h ATR reference for adaptive TESTING/APPROACHING zones.
            const streamD = MasterStoreService.getLatestStreamD(coin.ticker);

            // Prefer 1h ATR (stable coin-level reference), fall back to 15m.
            let atrRef = null;
            if (streamD?.data) {
                for (const [k, v] of Object.entries(streamD.data)) {
                    if (!/averagetruerangepercent/i.test(k)) continue;
                    const parsed = parseFloat(v);
                    if (isNaN(parsed)) continue;
                    if (/timeresolution60/i.test(k))  { atrRef = parsed; break; }
                    if (/timeresolution15/i.test(k) && !atrRef) atrRef = parsed;
                }
            }

            // TESTING zone: within 0.5× ATR of level (adaptive to coin volatility).
            // BREAK/BOUNCE/REJECT keep fixed % — those are outcome thresholds on a fixed level.
            const TESTING_MULT = 0.50;
            const testingZone  = atrRef ? TESTING_MULT * atrRef : 0.50;   // fallback 0.5%
            const approachZone = atrRef ? 0.30 * atrRef          : 0.30;   // single-point fallback 0.3%

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
                    if (coin.distPct < -0.8)                              reaction = 'BREAK_BEAR';
                    else if (minPct < 0.2 && lastPct >  0.3)             reaction = 'BOUNCE';
                    else if (Math.abs(lastPct) <= testingZone)            reaction = 'TESTING';
                    else if (lastPct > 0.5 && swing > 0.15)              reaction = 'BOUNCE';
                    else                                                   reaction = 'APPROACHING';
                } else {
                    // RESISTANCE — distPct < 0 → price already broke above resistance
                    if (coin.distPct < -0.8)                              reaction = 'BREAK_BULL';
                    else if (maxPct > -0.2 && lastPct < -0.3)            reaction = 'REJECT';
                    else if (Math.abs(lastPct) <= testingZone)            reaction = 'TESTING';
                    else if (lastPct < -0.5 && swing < -0.15)            reaction = 'REJECT';
                    else                                                   reaction = 'APPROACHING';
                }
            } else if (Math.abs(coin.distPct) <= approachZone) {
                reaction = 'TESTING';
            }

            // ── 5. Attach latest Stream D snapshot (RSI / EMA / ATR / RelVol) ──────
            // streamD already fetched above — reuse the same reference.

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
    console.log(`🚀 V3 Server running on port ${PORT}`);

    // Idempotent (UNIQUE INDEX on ticker+ts+source dedupes), so safe on every boot.
    setImmediate(() => {
        try { VolumeEventService.backfill({ verbose: true }); }
        catch (e) { console.error('VolumeEvent backfill error:', e.message); }
    });

    // --- DAILY PRUNING ENGINE (Institutional Stability) ---
    // Deletes history older than 30 days to keep the database lean and fast.
    setInterval(() => {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
        console.log(`[Maintenance] 🧹 Pruning records older than ${thirtyDaysAgo}...`);
        try {
            db.transaction(() => {
                const s = db.prepare('DELETE FROM scans WHERE timestamp < ?').run(thirtyDaysAgo);
                const m = db.prepare('DELETE FROM master_coin_store WHERE timestamp < ?').run(thirtyDaysAgo);
                const v = db.prepare('DELETE FROM volume_events WHERE ts < ?').run(thirtyDaysAgo);
                console.log(`[Maintenance] ✅ Pruned: ${s.changes} scans, ${m.changes} snapshots, ${v.changes} volume events.`);
            })();
        } catch (e) { console.error('[Maintenance] Pruning error:', e.message); }
    }, 24 * 60 * 60 * 1000); // Once every 24 hours
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


