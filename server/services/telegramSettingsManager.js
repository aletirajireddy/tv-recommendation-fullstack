/**
 * Telegram Category Settings Manager
 *
 * Per-category on/off toggles for Telegram notifications, backed by the
 * existing system_settings key-value table. Namespaced under "telegram.category.*"
 * so keys never collide with other subsystems (mirrors server/validator/settingsManager.js).
 *
 * All categories default to `true` so existing behavior is unchanged until the
 * user explicitly opts a category out via the dashboard settings modal.
 */

const db = require('../database');

const DEFAULTS = Object.freeze({
    'telegram.category.stream_a_pulse':     true,
    'telegram.category.scout_graduation':   true,
    'telegram.category.institutional_move': true,
    'telegram.category.rvol_spike':         true,
    'telegram.category.ghost_queue':        true,
    'telegram.category.validator_verdict':  true,
    'telegram.category.validator_early':    true,
    'telegram.category.smart_alerts':       true,
    'telegram.category.heartbeat':          true,
    'telegram.category.watchlist':          true,
    'telegram.category.feed_health':        true,
});

const CATEGORY_LABELS = Object.freeze({
    'telegram.category.stream_a_pulse':     'Market Pulse (Stream A)',
    'telegram.category.scout_graduation':   'Scout Graduation (Stream B)',
    'telegram.category.institutional_move': 'Institutional Moves (Stream C)',
    'telegram.category.rvol_spike':         'Volume Spikes (Stream D)',
    'telegram.category.ghost_queue':        'Ghost Queue',
    'telegram.category.validator_verdict':  '3rd Umpire Verdicts',
    'telegram.category.validator_early':    '3rd Umpire Early Favorable',
    'telegram.category.smart_alerts':       'Smart Alerts',
    'telegram.category.heartbeat':          'System Heartbeat & Digest',
    'telegram.category.watchlist':          'Coins of Interest',
    'telegram.category.feed_health':        'Data Feed Health (stream down/recovered)',
});

const toBool = v => v === true || v === 'true' || v === 1 || v === '1';

function readKey(key) {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    if (!row) return DEFAULTS[key] !== undefined ? DEFAULTS[key] : true;
    try {
        return toBool(JSON.parse(row.value));
    } catch {
        return DEFAULTS[key] !== undefined ? DEFAULTS[key] : true;
    }
}

function writeKey(key, value) {
    if (!(key in DEFAULTS)) {
        throw new Error(`Unknown telegram category: ${key}`);
    }
    db.prepare(`
        INSERT INTO system_settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(toBool(value)));
}

function getAll() {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
        out[key] = { enabled: readKey(key), label: CATEGORY_LABELS[key] };
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
        console.log(`⚙️  Telegram: seeded ${seeded} default category setting(s)`);
    }
}

module.exports = {
    DEFAULTS,
    CATEGORY_LABELS,
    readKey,
    writeKey,
    getAll,
    seedDefaults,
};
