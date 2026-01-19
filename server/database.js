const Database = require('better-sqlite3');
const path = require('path');

// V3 Database: Explicitly named to differentiate from legacy versions
const dbPath = path.resolve(__dirname, 'dashboard_v3.db');
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
// 5. SYSTEM SETTINGS (Persistence)
// ============================================================================
db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

console.log('✅ V3 Schema Initialized: scans, scan_results, pulse_events, qualified_picks');

module.exports = db;
