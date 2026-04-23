/**
 * Validator Settings Manager
 *
 * Reads and writes validator configuration to the existing system_settings
 * key-value table. All keys are namespaced under "validator.*" so they never
 * collide with other subsystem settings.
 *
 * Live mode: each trial captures its own config_snapshot at creation time and
 * is judged against that snapshot. Settings changes only apply to NEW trials.
 *
 * Replay mode: the widget reads current settings from this manager and uses
 * them to recompute verdicts on the fly (what-if simulation).
 */

const db = require('../database');

const DEFAULTS = Object.freeze({
    'validator.cooldown_minutes': 15,
    'validator.watch_window_minutes': 60,
    'validator.win_threshold_30m_pct': 0.5,
    'validator.early_check_enabled': true,
    'validator.early_check_minutes': 15,
    'validator.early_check_threshold_pct': 0.2,
    'validator.reactive_zone_min_pct': 0.3,
    'validator.reactive_zone_max_pct': 0.5,
    'validator.ema_5m_role': 'GATE',
    'validator.ema_15m_role': 'GATE',
    'validator.ema_1h_role': 'MINOR',
    'validator.ema_4h_role': 'MAJOR',
    'validator.telegram_phase2_enabled': true,
    'validator.telegram_early_check_enabled': true,
    'validator.trigger_sources': ['STREAM_C']
});

const CASTERS = {
    'validator.cooldown_minutes': Number,
    'validator.watch_window_minutes': Number,
    'validator.win_threshold_30m_pct': Number,
    'validator.early_check_enabled': v => v === true || v === 'true' || v === 1 || v === '1',
    'validator.early_check_minutes': Number,
    'validator.early_check_threshold_pct': Number,
    'validator.reactive_zone_min_pct': Number,
    'validator.reactive_zone_max_pct': Number,
    'validator.ema_5m_role': String,
    'validator.ema_15m_role': String,
    'validator.ema_1h_role': String,
    'validator.ema_4h_role': String,
    'validator.telegram_phase2_enabled': v => v === true || v === 'true' || v === 1 || v === '1',
    'validator.telegram_early_check_enabled': v => v === true || v === 'true' || v === 1 || v === '1',
    'validator.trigger_sources': v => Array.isArray(v) ? v : JSON.parse(v)
};

function readKey(key) {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    if (!row) return DEFAULTS[key];
    try {
        const parsed = JSON.parse(row.value);
        const cast = CASTERS[key];
        return cast ? cast(parsed) : parsed;
    } catch {
        return DEFAULTS[key];
    }
}

function writeKey(key, value) {
    if (!(key in DEFAULTS)) {
        throw new Error(`Unknown validator setting: ${key}`);
    }
    const serialized = JSON.stringify(value);
    db.prepare(`
        INSERT INTO system_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, serialized);
}

function getAll() {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
        out[key] = readKey(key);
    }
    return out;
}

function seedDefaults() {
    const stmt = db.prepare(`
        INSERT INTO system_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO NOTHING
    `);
    let seeded = 0;
    for (const [key, value] of Object.entries(DEFAULTS)) {
        const result = stmt.run(key, JSON.stringify(value));
        if (result.changes > 0) seeded++;
    }
    if (seeded > 0) {
        console.log(`⚙️  Validator: seeded ${seeded} default setting(s)`);
    }
}

module.exports = {
    DEFAULTS,
    readKey,
    writeKey,
    getAll,
    seedDefaults
};
