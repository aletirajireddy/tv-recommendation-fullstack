// Smart Alerts DB — separate SQLite file (sibling pattern to mcp_journal.db).
// Lives at <repo>/smart_alerts.db. WAL + NORMAL sync for hot writes.
// Generic schema: `alert_type` + `params_json` future-proofs us for non-EMA200
// alerts (RSI, structural levels, etc.) without migrations.

const Database = require('better-sqlite3');
const path     = require('path');

const dbPath = path.resolve(__dirname, '../../..', 'smart_alerts.db');
const db = new Database(dbPath);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA foreign_keys = ON;');

console.log(`🔌 Smart Alerts DB connected: ${dbPath}`);

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
    CREATE TABLE IF NOT EXISTS alerts (
        id                  TEXT PRIMARY KEY,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        enabled             INTEGER NOT NULL DEFAULT 1,
        deleted_at          TEXT,

        alert_type          TEXT NOT NULL,            -- 'EMA200' (v1) | future types
        ticker              TEXT NOT NULL,            -- raw e.g. 'BTCUSDT.P'
        clean_ticker        TEXT NOT NULL,            -- 'BTC'
        timeframe           TEXT NOT NULL,            -- 'm1'|'m5'|'m15'|'h1'|'h4'

        triggers_json       TEXT NOT NULL,            -- JSON array: ["approach","touch","cross"]
        params_json         TEXT NOT NULL,            -- JSON: {approach_atr, touch_atr, recurring, cooldown_min, expiry_hours, note}

        state               TEXT NOT NULL DEFAULT 'active',  -- active|qualified|expired|disabled
        qualified_count     INTEGER NOT NULL DEFAULT 0,
        last_qualified_at   TEXT,
        last_evaluated_at   TEXT,
        expires_at          TEXT,

        last_price          REAL,
        last_ema            REAL,
        last_atr            REAL,
        last_side           TEXT,                     -- 'above'|'below'|'at' (for cross detection)

        acknowledged_at     TEXT                      -- read-state for header bell badge
    );
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS alert_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id      TEXT NOT NULL,
        ts            TEXT NOT NULL,
        event_type    TEXT NOT NULL,           -- created|approach|touch|cross|expired|enabled|disabled|edited|reset
        price         REAL,
        ema           REAL,
        atr           REAL,
        distance_pct  REAL,
        distance_atr  REAL,                    -- |price-ema|/atr ratio
        message       TEXT,
        FOREIGN KEY(alert_id) REFERENCES alerts(id) ON DELETE CASCADE
    );
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_state    ON alerts(state, enabled, deleted_at);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_alerts_ticker   ON alerts(ticker, timeframe);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_alert_ts ON alert_events(alert_id, ts DESC);`);

module.exports = db;
