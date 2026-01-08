const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.resolve(__dirname, 'dashboard.db');
const db = new Database(dbPath); // Will create new file since we moved the old one

// Enable WAL for concurrency
db.pragma('journal_mode = WAL');

// 1. SCANS (The Timeline Master)
db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,       -- ISO String (The logical time of the scan)
        trigger_type TEXT DEFAULT 'auto',
        
        -- Metadata for "Time Context" Widget
        latency INTEGER,              -- ms taken to process
        change_reason TEXT,           -- Why this scan exists
        
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// 2. MARKET_STATES (Section 4: Macro View)
db.exec(`
    CREATE TABLE IF NOT EXISTS market_states (
        scan_id TEXT PRIMARY KEY,
        mood TEXT,                    -- 'BULLISH', 'BEARISH'
        mood_score INTEGER,           -- -100 to 100
        counts_json TEXT,             -- { bullish: 10, bearish: 5 }
        tickers_json TEXT,            -- [{ t:'BTC', s:80, nt:60 }, ...] (The Lightweight Replay Lists)
        FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );
`);

// 3. SCAN_ENTRIES (Section 2: The Logic Results)
// Normalized: One row per ticker per scan
db.exec(`
    CREATE TABLE IF NOT EXISTS scan_entries (
        scan_id TEXT,
        ticker TEXT,
        status TEXT,                  -- 'PASS' or 'MISSED'
        label TEXT,                   -- 'STRONG BUY', etc.
        direction TEXT,               -- 'BULL' or 'BEAR'
        
        strategies_json TEXT,         -- ['BUY', 'RETRACE']
        missed_reason TEXT,           -- Combined text
        
        -- The visual replay payload (Raw 26 cols + Context)
        raw_data_json TEXT,
        
        PRIMARY KEY (scan_id, ticker),
        FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );
`);

// 4. PULSE_EVENTS (Section 1: Raw Stream)
db.exec(`
    CREATE TABLE IF NOT EXISTS pulse_events (
        id TEXT PRIMARY KEY,
        scan_id TEXT,
        timestamp INTEGER,
        ticker TEXT,
        type TEXT,
        payload_json TEXT,
        FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );
`);

// 5. AI NOTIFICATIONS (Telegram Log)
db.exec(`
    CREATE TABLE IF NOT EXISTS ai_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        trigger_type TEXT,            -- 'MARKET_SHIFT', 'BURST', 'HIGH_SCOPE'
        message TEXT,
        priority INTEGER,             -- 1=Info, 2=Important, 3=Critical
        
        FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE CASCADE
    );
`);

// 6. SYSTEM SETTINGS (Key-Value Persistence)
db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

console.log('✅ Database (v2) Initialized: dashboard.db');

module.exports = db;
