// Smart Alerts service — pure data layer. Routes wrap this; the evaluator
// also uses these helpers. Validates inputs, normalises state strings,
// emits structured event rows for every transition (so history survives
// even after the alert is disabled).

const { randomUUID } = require('crypto');
const db = require('./db');

const TFS              = ['m1', 'm5', 'm15', 'h1', 'h4'];
const VALID_TRIGGERS   = ['approach', 'touch', 'cross'];
const VALID_TYPES      = ['EMA200']; // v1 — extend here as future types land
const DEFAULT_APPROACH_ATR = 0.50;   // |Δ| ≤ 0.50 × ATR  → approaching
const DEFAULT_TOUCH_ATR    = 0.10;   // |Δ| ≤ 0.10 × ATR  → touched
const DEFAULT_COOLDOWN_MIN = 15;     // recurring alerts re-arm after 15min
const DEFAULT_EXPIRY_HOURS = 24;     // 0 = never

const stmts = {
    insertAlert: db.prepare(`
        INSERT INTO alerts (id, created_at, updated_at, enabled, alert_type, ticker, clean_ticker,
                            timeframe, triggers_json, params_json, state, expires_at,
                            last_price, last_ema, last_atr, last_side)
        VALUES (@id, @created_at, @updated_at, @enabled, @alert_type, @ticker, @clean_ticker,
                @timeframe, @triggers_json, @params_json, 'active', @expires_at,
                @last_price, @last_ema, @last_atr, @last_side)
    `),
    insertEvent: db.prepare(`
        INSERT INTO alert_events (alert_id, ts, event_type, price, ema, atr,
                                  distance_pct, distance_atr, message)
        VALUES (@alert_id, @ts, @event_type, @price, @ema, @atr,
                @distance_pct, @distance_atr, @message)
    `),
    updateAfterEval: db.prepare(`
        UPDATE alerts SET last_evaluated_at=@ts, last_price=@price, last_ema=@ema,
                          last_atr=@atr, last_side=@side, updated_at=@ts
        WHERE id=@id
    `),
    markQualified: db.prepare(`
        UPDATE alerts SET state='qualified', enabled=@enabled, qualified_count=qualified_count+1,
                          last_qualified_at=@ts, updated_at=@ts
        WHERE id=@id
    `),
    markExpired: db.prepare(`
        UPDATE alerts SET state='expired', enabled=0, updated_at=@ts WHERE id=@id
    `),
    setEnabled: db.prepare(`
        UPDATE alerts SET enabled=@enabled, state=@state, updated_at=@ts WHERE id=@id
    `),
    softDelete: db.prepare(`
        UPDATE alerts SET deleted_at=@ts, enabled=0, updated_at=@ts WHERE id=@id AND deleted_at IS NULL
    `),
    markRead: db.prepare(`UPDATE alerts SET acknowledged_at=@ts, updated_at=@ts WHERE id=@id`),
    markAllRead: db.prepare(`
        UPDATE alerts SET acknowledged_at=@ts, updated_at=@ts
        WHERE state='qualified' AND deleted_at IS NULL AND (acknowledged_at IS NULL OR acknowledged_at < last_qualified_at)
    `),
    getById: db.prepare(`SELECT * FROM alerts WHERE id=?`),
    getActiveForTicker: db.prepare(`
        SELECT * FROM alerts WHERE ticker=? AND deleted_at IS NULL AND enabled=1 AND state='active'
    `),
    listAll: db.prepare(`
        SELECT * FROM alerts WHERE deleted_at IS NULL ORDER BY datetime(created_at) DESC LIMIT ?
    `),
    listByState: db.prepare(`
        SELECT * FROM alerts WHERE deleted_at IS NULL AND state=? ORDER BY datetime(created_at) DESC LIMIT ?
    `),
    listAllActive: db.prepare(`
        SELECT * FROM alerts WHERE deleted_at IS NULL AND state='active' AND enabled=1
    `),
    eventsForAlert: db.prepare(`
        SELECT * FROM alert_events WHERE alert_id=? ORDER BY id DESC LIMIT ?
    `),
    unreadQualifiedCount: db.prepare(`
        SELECT COUNT(*) AS n FROM alerts
        WHERE deleted_at IS NULL AND state='qualified'
          AND (acknowledged_at IS NULL OR acknowledged_at < last_qualified_at)
    `),
    bulkDeleteByState: db.prepare(`
        UPDATE alerts SET deleted_at=@ts, enabled=0, updated_at=@ts
        WHERE deleted_at IS NULL AND (state=@state OR @state='all')
    `),
};

// ── Hydration helper ─────────────────────────────────────────────────────────
function hydrate(row) {
    if (!row) return null;
    return {
        ...row,
        enabled:        !!row.enabled,
        triggers:       safeJSON(row.triggers_json, []),
        params:         safeJSON(row.params_json, {}),
        is_unread:      row.state === 'qualified' &&
                        (!row.acknowledged_at || row.acknowledged_at < row.last_qualified_at),
    };
}
function safeJSON(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

// ── Public API ───────────────────────────────────────────────────────────────

function createAlert(input) {
    // Validate
    const alertType = input.alert_type || 'EMA200';
    if (!VALID_TYPES.includes(alertType)) throw new Error(`Unsupported alert_type: ${alertType}`);
    if (!input.ticker)       throw new Error('ticker is required');
    if (!TFS.includes(input.timeframe)) throw new Error(`Invalid timeframe: ${input.timeframe}`);

    const triggers = Array.isArray(input.triggers) ? input.triggers.filter(t => VALID_TRIGGERS.includes(t)) : [];
    if (!triggers.length) throw new Error('At least one trigger required (approach|touch|cross)');

    const params = {
        approach_atr: clampNum(input.approach_atr, 0.05, 5, DEFAULT_APPROACH_ATR),
        touch_atr:    clampNum(input.touch_atr,    0.01, 1, DEFAULT_TOUCH_ATR),
        recurring:    !!input.recurring,
        cooldown_min: clampNum(input.cooldown_min, 1, 240, DEFAULT_COOLDOWN_MIN),
        expiry_hours: input.expiry_hours == null ? DEFAULT_EXPIRY_HOURS
                                                 : clampNum(input.expiry_hours, 0, 168, DEFAULT_EXPIRY_HOURS),
        note: (input.note || '').toString().slice(0, 280) || null,
    };

    const now = new Date().toISOString();
    const id  = randomUUID();
    const expiresAt = params.expiry_hours > 0
        ? new Date(Date.now() + params.expiry_hours * 3600_000).toISOString()
        : null;

    const initialSide = input.last_price != null && input.last_ema != null
        ? (input.last_price > input.last_ema ? 'above'
          : input.last_price < input.last_ema ? 'below' : 'at')
        : null;

    stmts.insertAlert.run({
        id, created_at: now, updated_at: now, enabled: 1,
        alert_type: alertType,
        ticker:        input.ticker,
        clean_ticker:  (input.clean_ticker || input.ticker).replace(/USDT(\.P)?$/i, ''),
        timeframe:     input.timeframe,
        triggers_json: JSON.stringify(triggers),
        params_json:   JSON.stringify(params),
        expires_at:    expiresAt,
        last_price:    input.last_price ?? null,
        last_ema:      input.last_ema ?? null,
        last_atr:      input.last_atr ?? null,
        last_side:     initialSide,
    });

    stmts.insertEvent.run({
        alert_id: id, ts: now, event_type: 'created',
        price: input.last_price ?? null, ema: input.last_ema ?? null, atr: input.last_atr ?? null,
        distance_pct: deltaPct(input.last_price, input.last_ema),
        distance_atr: deltaAtr(input.last_price, input.last_ema, input.last_atr),
        message: `Created · triggers=[${triggers.join(',')}] · ${alertType} ${input.timeframe}`,
    });

    return getById(id);
}

function getById(id) { return hydrate(stmts.getById.get(id)); }

function list({ state = 'all', limit = 200 } = {}) {
    const cap = Math.min(500, Math.max(1, limit));
    const rows = state === 'all' ? stmts.listAll.all(cap) : stmts.listByState.all(state, cap);
    return rows.map(hydrate);
}

function listEvaluable() { return stmts.listAllActive.all().map(hydrate); }

function getEvents(alertId, limit = 100) {
    return stmts.eventsForAlert.all(alertId, Math.min(500, Math.max(1, limit)));
}

function setEnabled(id, enabled) {
    const row = getById(id);
    if (!row) return null;
    const ts = new Date().toISOString();
    // Re-enabling a qualified one-shot resets state to active.
    const newState = enabled
        ? (row.state === 'expired' ? 'active' : (row.state === 'qualified' ? 'active' : row.state))
        : 'disabled';
    stmts.setEnabled.run({ id, enabled: enabled ? 1 : 0, state: newState, ts });
    stmts.insertEvent.run({
        alert_id: id, ts, event_type: enabled ? 'enabled' : 'disabled',
        price: null, ema: null, atr: null, distance_pct: null, distance_atr: null,
        message: enabled ? 'Re-enabled by user' : 'Disabled by user',
    });
    return getById(id);
}

function softDelete(id) {
    const ts = new Date().toISOString();
    const r = stmts.softDelete.run({ id, ts });
    return r.changes > 0;
}

function markRead(id) {
    stmts.markRead.run({ id, ts: new Date().toISOString() });
    return getById(id);
}

function markAllRead() {
    const r = stmts.markAllRead.run({ ts: new Date().toISOString() });
    return { updated: r.changes };
}

function bulkDelete(scope = 'expired') {
    const valid = ['active', 'qualified', 'expired', 'disabled', 'all'];
    if (!valid.includes(scope)) throw new Error(`Invalid scope: ${scope}`);
    const r = stmts.bulkDeleteByState.run({ state: scope, ts: new Date().toISOString() });
    return { deleted: r.changes };
}

function unreadQualifiedCount() {
    return stmts.unreadQualifiedCount.get().n || 0;
}

// ── Evaluator-only mutators ─────────────────────────────────────────────────

function recordEvaluation({ id, ts, price, ema, atr, side }) {
    stmts.updateAfterEval.run({ id, ts, price, ema, atr, side });
}

function recordTrigger({ alert, eventType, price, ema, atr }) {
    const ts = new Date().toISOString();
    const dPct = deltaPct(price, ema);
    const dAtr = deltaAtr(price, ema, atr);

    stmts.insertEvent.run({
        alert_id: alert.id, ts, event_type: eventType,
        price, ema, atr, distance_pct: dPct, distance_atr: dAtr,
        message: `${eventType.toUpperCase()} · Δ=${dPct?.toFixed(3)}% (${dAtr?.toFixed(2)}× ATR)`,
    });

    // One-shot vs recurring
    const recurring = alert.params?.recurring;
    stmts.markQualified.run({ id: alert.id, enabled: recurring ? 1 : 0, ts });
}

function recordExpiry(alert) {
    const ts = new Date().toISOString();
    stmts.markExpired.run({ id: alert.id, ts });
    stmts.insertEvent.run({
        alert_id: alert.id, ts, event_type: 'expired',
        price: null, ema: null, atr: null, distance_pct: null, distance_atr: null,
        message: 'TTL reached without qualification',
    });
}

// ── Math helpers (also used by evaluator) ────────────────────────────────────
function deltaPct(price, ema) {
    if (price == null || ema == null || ema === 0) return null;
    return ((price - ema) / ema) * 100;
}
function deltaAtr(price, ema, atrPct) {
    if (price == null || ema == null || ema === 0 || !atrPct) return null;
    const distAbsPct = Math.abs((price - ema) / ema) * 100;
    return distAbsPct / atrPct;  // both in %, ratio is unitless
}
function sideOf(price, ema) {
    if (price == null || ema == null) return null;
    if (price > ema) return 'above';
    if (price < ema) return 'below';
    return 'at';
}
function clampNum(v, lo, hi, dflt) {
    const n = parseFloat(v);
    if (isNaN(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
}

module.exports = {
    // CRUD
    createAlert, getById, list, getEvents,
    setEnabled, softDelete, markRead, markAllRead, bulkDelete, unreadQualifiedCount,
    // Evaluator
    listEvaluable, recordEvaluation, recordTrigger, recordExpiry,
    // Constants + helpers
    TFS, VALID_TRIGGERS, VALID_TYPES,
    DEFAULT_APPROACH_ATR, DEFAULT_TOUCH_ATR, DEFAULT_COOLDOWN_MIN, DEFAULT_EXPIRY_HOURS,
    deltaPct, deltaAtr, sideOf,
};
