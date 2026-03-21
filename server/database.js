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

console.log('✅ V3 Schema Initialized: scans, scan_results, pulse_events, qualified_picks, smart_level_events, institutional_interest_events, unified_alerts (view)');

module.exports = db;
