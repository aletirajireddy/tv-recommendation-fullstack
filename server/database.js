const Database = require('better-sqlite3');
const path = require('path');

// V3 Database: Moved to project root to avoid node --watch infinite restart loop
const dbPath = path.resolve(__dirname, '..', 'dashboard_v3.db');
const db = new Database(dbPath);

console.log(`🔌 Connected to V3 Database: ${dbPath}`);

// Enable WAL for concurrency and performance
db.pragma('journal_mode = WAL');

// ============================================================================
// 1. SCANS (Timeline & Index)
// ============================================================================
// Stores the "when" and "why" of every scan. Lightweight index.
db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,       -- ISO 8601 UTC (Source of Truth)
        trigger TEXT,                  -- 'auto', 'manual', 'alert-triggered'
        
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// ============================================================================
// 2. SCAN_RESULTS (The "Full Blob" Storage)
// ============================================================================
// Stores the ENTIRE JSON payload. Solves "Schema Fragility" and "Redundancy".
// We no longer shred data into 26 columns. We store the blob.
db.exec(`
    CREATE TABLE IF NOT EXISTS scan_results (
        scan_id TEXT PRIMARY KEY,
        raw_data JSON NOT NULL,        -- The complete { id, results, market_sentiment } object
        
        FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );
`);

// ============================================================================
// 3. PULSE_EVENTS (Alert Stream - Stream A)
// ============================================================================
// Stores individual alerts extracted from 'institutional_pulse'.
// Conforms to Rule #6: Timestamp must be parsed from signal data.
db.exec(`
    CREATE TABLE IF NOT EXISTS pulse_events (
        id TEXT PRIMARY KEY,          -- Alert ID
        scan_id TEXT,                 -- Parent Scan ID
        timestamp TEXT NOT NULL,      -- ISO 8601 UTC (Combined Date + Time from Signal)
        ticker TEXT,
        type TEXT,                    -- 'INSTITUTIONAL_LEVEL', etc.
        payload_json JSON,            -- The specific alert object
        
        FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );
`);

// ============================================================================
// 4. QUALIFIED_PICKS (Picker Stream - Stream B)
// ============================================================================
// Stores isolated "Pick" events from the Coin Scanner script.
// Distinct from "Macro Scans".
db.exec(`
    CREATE TABLE IF NOT EXISTS qualified_picks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        price REAL,
        timestamp TEXT NOT NULL,      -- ISO 8601 UTC
        raw_data JSON                 -- The full pick payload
    );
`);

// ============================================================================
// 4B. QUALIFIED_PICKS_LOG (Test/Log Stream)
// ============================================================================
// Stores isolated "Pick" events into a separate log table for shortlisting and testing
// without impacting Stream A or the main active_ledger.
db.exec(`
    CREATE TABLE IF NOT EXISTS qualified_picks_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        price REAL,
        type TEXT,                    -- VELOCITY or STABLE
        timestamp TEXT NOT NULL,      -- ISO 8601 UTC
        raw_data JSON                 -- The full pick payload
    );
`);

// ============================================================================
// 5. SYSTEM SETTINGS (Persistence)
// ============================================================================
db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

// ============================================================================
// 6. RAW SENTIMENT LOG (Audit/Backtest Only)
// ============================================================================
// Stores the "Legacy" Browser-Calculated Sentiment BEFORE Server Overwrite.
// Strictly for comparing Client vs Server logic drift.
db.exec(`
    CREATE TABLE IF NOT EXISTS raw_market_sentiment_log (
        scan_id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        raw_mood_score INTEGER,
        raw_label TEXT,
        raw_bullish INTEGER,
        raw_bearish INTEGER,
        
        FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );
`);

// ============================================================================
// 7. STREAM C (Smart Levels Webhook)
// ============================================================================
// Stores isolated "Smart Levels" alerts from TradingView webhooks.
db.exec(`
    CREATE TABLE IF NOT EXISTS smart_level_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        timestamp TEXT NOT NULL,      -- ISO 8601 UTC
        price REAL,
        direction INTEGER,
        roc_pct REAL,
        raw_data JSON NOT NULL        -- The Full Payload
    );
`);

// ============================================================================
// 8. INSTITUTIONAL INTEREST (High-Conviction Webhooks)
// ============================================================================
// Stores isolated "Institutional Interest" alerts based on the bar_move_pct signature.
db.exec(`
    CREATE TABLE IF NOT EXISTS institutional_interest_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        timestamp TEXT NOT NULL,      -- ISO 8601 UTC
        price REAL,
        direction INTEGER,
        bar_move_pct REAL,
        today_change_pct REAL,
        today_volume REAL,
        raw_data JSON NOT NULL
    );
`);
// ============================================================================
// 9. UNIFIED EVENT BUS (VIEW)
// ============================================================================
// A virtual table merging both Webhook streams to feed the Unified Alert Engine.
db.exec(`
    CREATE VIEW IF NOT EXISTS unified_alerts AS
    SELECT 
        id, ticker, timestamp, price, direction, roc_pct as strength, 'TECHNICAL' as origin, raw_data 
    FROM smart_level_events
    UNION ALL
    SELECT 
        id, ticker, timestamp, price, direction, bar_move_pct as strength, 'INSTITUTIONAL' as origin, raw_data 
    FROM institutional_interest_events;
`);

// ============================================================================
// 10. GHOST APPROVAL QUEUE
// ============================================================================
// Holds coins that meet prune criteria but are waiting for manual widget approval.
db.exec(`
    CREATE TABLE IF NOT EXISTS ghost_approval_queue (
        ticker TEXT PRIMARY KEY,
        reason TEXT,
        queued_at TEXT NOT NULL,
        is_approved INTEGER DEFAULT 0  -- 0 = waiting, 1 = approved
    );
`);

// ============================================================================
// 11. COIN LIFECYCLES (Age & Maturity Tracking)
// ============================================================================
// Tracks the long-term age of a coin from its initial discovery in Stream B 
// until its absolute demise in Stream A.
db.exec(`
    CREATE TABLE IF NOT EXISTS coin_lifecycles (
        ticker TEXT PRIMARY KEY,
        born_at TEXT NOT NULL,         -- ISO 8601 UTC
        last_seen_at TEXT,             -- ISO 8601 UTC
        death_at TEXT,                 -- ISO 8601 UTC
        status TEXT                    -- 'ACTIVE', 'GHOST', 'DEAD'
    );
`);

// ============================================================================
// 12. VALIDATION TRIALS (3rd Umpire Validator - Trial Records)
// ============================================================================
// One row per detected setup. Captures the full feature snapshot at detection
// and config snapshot for live-mode immutability. Verdicts are CONFIRMED |
// FAILED | NEUTRAL_TIMEOUT | EARLY_FAVORABLE.
db.exec(`
    CREATE TABLE IF NOT EXISTS validation_trials (
        trial_id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        direction TEXT NOT NULL,                  -- LONG | SHORT
        trigger_source TEXT NOT NULL,             -- STREAM_C
        trigger_event_id INTEGER,                 -- FK smart_level_events.id
        trigger_type TEXT NOT NULL,               -- BOUNCE | BREAKOUT
        trigger_price REAL NOT NULL,
        level_price REAL,
        level_type TEXT,                          -- MEGA_SPOT|EMA200|EMA50|FIB|LOGIC
        detected_at TEXT NOT NULL,                -- ISO 8601 UTC
        cooldown_until TEXT NOT NULL,
        watch_until TEXT NOT NULL,
        state TEXT NOT NULL,                      -- DETECTED|COOLDOWN|WATCHING|RESOLVED
        verdict TEXT,                             -- CONFIRMED|FAILED|NEUTRAL_TIMEOUT|EARLY_FAVORABLE
        failure_reason TEXT,
        resolved_at TEXT,
        config_snapshot TEXT NOT NULL,            -- JSON of validator settings at trial creation
        feature_snapshot TEXT NOT NULL,           -- JSON: EMAs, RSI, vol, mood at detection
        raw_trigger_blob TEXT NOT NULL
    );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_trials_state ON validation_trials(state);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_trials_detected ON validation_trials(detected_at);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_trials_ticker_time ON validation_trials(ticker, detected_at);`);

// ============================================================================
// 13. VALIDATION STATE LOG (Trial State Transition Tape)
// ============================================================================
// Every state change in a trial's life. Required for DVR-aware replay so the
// validator widget can show what was known at any historical moment without
// future-data leakage (Rule #19 Time-Mirror Protocol).
db.exec(`
    CREATE TABLE IF NOT EXISTS validation_state_log (
        log_id INTEGER PRIMARY KEY AUTOINCREMENT,
        trial_id TEXT NOT NULL,
        changed_at TEXT NOT NULL,                 -- ISO 8601 UTC
        state TEXT NOT NULL,                      -- DETECTED|COOLDOWN|WATCHING|RESOLVED
        rule_snapshot TEXT,                       -- JSON: rule pass/fail snapshot
        current_price REAL,
        unrealized_move_pct REAL,
        FOREIGN KEY(trial_id) REFERENCES validation_trials(trial_id) ON DELETE CASCADE
    );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_state_log_trial ON validation_state_log(trial_id, changed_at);`);

// ============================================================================
// 14. PATTERN STATISTICS (Pre-computed Win Rates by Combination)
// ============================================================================
// Rebuilt periodically from validation_trials. Powers the stats panel and the
// MCP get_pattern_stats tool with low-token pre-aggregated answers.
db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_statistics (
        stat_key TEXT PRIMARY KEY,                -- canonical filter signature
        direction TEXT,
        level_type TEXT,
        vol_filter INTEGER,                       -- null=any, 0=no spike, 1=spike
        ema_1h_align INTEGER,                     -- null=any, 0=opposed, 1=aligned
        ema_4h_align INTEGER,
        trigger_type TEXT,                        -- BOUNCE | BREAKOUT | null=any
        sample_count INTEGER,
        win_count_15m INTEGER,
        win_rate_15m REAL,
        win_count_30m INTEGER,
        win_rate_30m REAL,
        win_count_1h INTEGER,
        win_rate_1h REAL,
        avg_move_pct REAL,
        confidence TEXT,                          -- LOW | MEDIUM | HIGH
        last_updated TEXT
    );
`);

// ============================================================================
// 15. MASTER COIN STORE (V4 Materialized Timeline)
// ============================================================================
// A unified event-sourcing store aggregating Stream A, B, and C.
// Enables deep forensic analysis of price action relative to key levels.
db.exec(`
    CREATE TABLE IF NOT EXISTS master_coin_store (
        snapshot_id TEXT PRIMARY KEY,
        ticker TEXT NOT NULL,
        timestamp TEXT NOT NULL,          -- ISO 8601 UTC
        trigger_source TEXT NOT NULL,     -- 'STREAM_A' | 'STREAM_B' | 'STREAM_C'
        price REAL NOT NULL,
        
        -- Sub-States
        stream_a_state JSON,
        stream_b_state JSON,
        stream_c_state JSON,
        stream_d_state JSON,
        
        -- Unified Full Context
        merged_state JSON NOT NULL
    );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_master_ticker_time ON master_coin_store(ticker, timestamp);`);
// Performance audit fix (H1): hot endpoints (getEMA200Stack, getSourceHeartbeats,
// distance-board, cascade) all filter by trigger_source — without this composite
// index they fall back to ticker scans + filter, ~10× slower on large tables.
db.exec(`CREATE INDEX IF NOT EXISTS idx_master_source_ticker_time ON master_coin_store(trigger_source, ticker, timestamp DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_master_ticker_source_time ON master_coin_store(ticker, trigger_source, timestamp DESC);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_master_timestamp ON master_coin_store(timestamp);`);

// ============================================================================
// 16. TIMESTAMP POLICY MIGRATION (Single Source of Truth)
// ============================================================================
// Adds:
//   - payload_hash    : SHA256 of canonical payload (excluding volatile fields).
//                       Used for true deduplication across webhook + email rehydration.
//   - ingestion_source: 'WEBHOOK' | 'EMAIL' | 'SCAN_A' | 'SCOUT_B' — provenance flag
//                       so widgets can distinguish live vs backfilled records.
// Logic: TimestampResolver computes the canonical timestamp ONCE before insert.
// All FE widgets read the `timestamp` column verbatim — no recalculation downstream.
function _safeAddColumn(table, columnDef, columnName) {
    try {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.find(c => c.name === columnName)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
            console.log(`   ↳ Added column ${columnName} to ${table}`);
        }
    } catch (e) {
        console.error(`   ⚠️ Migration error on ${table}.${columnName}:`, e.message);
    }
}

_safeAddColumn('smart_level_events', 'payload_hash TEXT', 'payload_hash');
_safeAddColumn('smart_level_events', "ingestion_source TEXT DEFAULT 'WEBHOOK'", 'ingestion_source');
_safeAddColumn('institutional_interest_events', 'payload_hash TEXT', 'payload_hash');
_safeAddColumn('institutional_interest_events', "ingestion_source TEXT DEFAULT 'WEBHOOK'", 'ingestion_source');
_safeAddColumn('master_coin_store', 'payload_hash TEXT', 'payload_hash');
_safeAddColumn('master_coin_store', "ingestion_source TEXT DEFAULT 'WEBHOOK'", 'ingestion_source');
_safeAddColumn('master_coin_store', 'stream_d_state JSON', 'stream_d_state');

// Ghost approval enrichment columns (Q5 — regime-aware confidence scoring)
_safeAddColumn('ghost_approval_queue', 'confidence_score REAL', 'confidence_score');
_safeAddColumn('ghost_approval_queue', 'score_breakdown TEXT', 'score_breakdown');
_safeAddColumn('ghost_approval_queue', 'scored_at TEXT', 'scored_at');

// Unique indexes on payload_hash (where present). NULLs allowed — legacy rows skipped.
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_smart_level_payload_hash ON smart_level_events(payload_hash) WHERE payload_hash IS NOT NULL;`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inst_interest_payload_hash ON institutional_interest_events(payload_hash) WHERE payload_hash IS NOT NULL;`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_master_payload_hash ON master_coin_store(payload_hash) WHERE payload_hash IS NOT NULL;`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_master_source ON master_coin_store(ingestion_source);`);

// ============================================================================
// 17. VOLUME EVENTS (Truth-source for "spike happened HERE")
// ============================================================================
// Stream A's volSpike flag persists ~15 min in scan payloads — useless for
// answering "when did volume actually spike?". This table records discrete
// events with provenance:
//   STREAM_C_ALERT  — TradingView alert fired (=> exact spike moment, truth)
//   STREAM_A_EDGE   — leading edge of a Stream A volSpike run (best-effort)
//   STREAM_D_RVOL   — relative volume crossed threshold in Stream D scan
// Widgets render these as discrete pins/dots instead of fat 15-min bars.
db.exec(`
    CREATE TABLE IF NOT EXISTS volume_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker      TEXT NOT NULL,
        ts          TEXT NOT NULL,         -- ISO 8601 UTC, the spike moment
        source      TEXT NOT NULL,         -- 'STREAM_C_ALERT' | 'STREAM_A_EDGE' | 'STREAM_D_RVOL'
        strength    REAL DEFAULT 1.0,      -- 1.0 = standard, >1 = bigger spike (RelVol multiplier when known)
        payload_hash TEXT,                 -- dedup across rehydration paths
        meta        JSON,                  -- optional context (price, direction, etc.)
        created_at  TEXT DEFAULT (datetime('now'))
    );
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_volume_events_ticker_ts ON volume_events(ticker, ts);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_volume_events_source ON volume_events(source);`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_volume_events_dedup
         ON volume_events(ticker, ts, source);`);

console.log('✅ V3 Schema Initialized: scans, scan_results, pulse_events, qualified_picks, smart_level_events, institutional_interest_events, unified_alerts (view), ghost_approval_queue, coin_lifecycles, validation_trials, validation_state_log, pattern_statistics, master_coin_store [+ timestamp policy migration]');

module.exports = db;
