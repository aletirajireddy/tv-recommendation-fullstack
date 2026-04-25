/**
 * Umpire Engine — The 3rd Umpire Validator (event-driven state machine).
 *
 * Hooks into existing ingestion streams with fire-and-forget setImmediate calls.
 * Never makes outbound TradingView calls — all context read from local SQLite.
 *
 * Lifecycle per trial:
 *   DETECTED → COOLDOWN (on Stream C trigger)
 *   COOLDOWN → WATCHING (when cooldown_until elapses)
 *   WATCHING → RESOLVED: CONFIRMED | FAILED | NEUTRAL_TIMEOUT
 *            → EARLY_FAVORABLE emitted (no state change) at early_check_minutes
 */

const EventEmitter = require('events');
const db = require('../database');
const settings = require('./settingsManager');
const rules = require('./rules');

const TIMER_INTERVAL_MS = 30 * 1000;

class UmpireEngine extends EventEmitter {
    constructor({ io = null } = {}) {
        super();
        this.io = io;
        this.timerHandle = null;
        this.started = false;
        this.earlyChecksDone = new Set();
    }

    start() {
        if (this.started) return;
        settings.seedDefaults();
        this.timerHandle = setInterval(() => this.checkTimers(), TIMER_INTERVAL_MS);
        this.started = true;
        console.log('🎯 Umpire Engine started');
    }

    stop() {
        if (this.timerHandle) clearInterval(this.timerHandle);
        this.timerHandle = null;
        this.started = false;
    }

    // ─────────────────────────────────────────────
    // PUBLIC HOOKS (called from server/index.js)
    // ─────────────────────────────────────────────

    /**
     * @param {object} payload - Raw alert payload
     * @param {object} [opts]
     * @param {string} [opts.resolvedTimestampISO] - Authoritative timestamp from TimestampResolver.
     *   REQUIRED for live correctness — do NOT fall back to payload.timestamp (that is TradingView's
     *   bar-open time and lags 3–5 min). If omitted, we use server "now" rather than payload.timestamp.
     */
    onStreamC(payload, opts = {}) {
        if (!payload || !payload.ticker || !payload.price) return;
        // Skip institutional interest payloads (bar_move_pct signals different handler)
        if (typeof payload.bar_move_pct !== 'undefined') return;

        const cfg = settings.getAll();
        const ticker = payload.ticker;
        const price = parseFloat(payload.price);
        const direction = payload.momentum?.direction ?? payload.direction ?? 0;
        const roc_pct = parseFloat(payload.momentum?.roc_pct ?? payload.roc_pct ?? 0);

        if (!direction || price <= 0) return;

        const trialDirection = direction > 0 ? 'LONG' : 'SHORT';
        const triggerType = Math.abs(roc_pct) > 0.5 ? 'BREAKOUT' : 'BOUNCE';

        const featureSnapshot = this._extractFeatureSnapshot(payload, price, direction);
        featureSnapshot.market_mood = this._getLatestMarketMood();
        featureSnapshot.vol_spike = this._getLatestVolSpike(ticker);

        const { levelType, levelPrice } = this._detectClosestLevel(price, payload.smart_levels || {});

        const latestEvent = db.prepare(
            'SELECT id FROM smart_level_events WHERE ticker = ? ORDER BY id DESC LIMIT 1'
        ).get(ticker);

        // BUG FIX (timestamp policy): payload.timestamp from TradingView is BAR-OPEN time
        // and lags the actual fire moment by 3–5 minutes. Always prefer the resolver-supplied
        // canonical timestamp; fall back to server now() — never to payload.timestamp.
        const now = opts.resolvedTimestampISO
            ? new Date(opts.resolvedTimestampISO)
            : new Date();
        const cooldownMs = (cfg['validator.cooldown_minutes'] || 15) * 60 * 1000;
        const watchMs = (cfg['validator.watch_window_minutes'] || 60) * 60 * 1000;
        const cooldownUntil = new Date(now.getTime() + cooldownMs);
        const watchUntil = new Date(cooldownUntil.getTime() + watchMs);

        const trialId = `trial_${ticker}_${now.getTime()}`;

        try {
            db.prepare(`
                INSERT INTO validation_trials (
                    trial_id, ticker, direction, trigger_source, trigger_event_id,
                    trigger_type, trigger_price, level_price, level_type,
                    detected_at, cooldown_until, watch_until, state,
                    config_snapshot, feature_snapshot, raw_trigger_blob
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                trialId, ticker, trialDirection, 'STREAM_C',
                latestEvent?.id ?? null, triggerType, price, levelPrice, levelType,
                now.toISOString(), cooldownUntil.toISOString(), watchUntil.toISOString(),
                'COOLDOWN', JSON.stringify(cfg), JSON.stringify(featureSnapshot),
                JSON.stringify(payload)
            );

            this._logState(trialId, 'COOLDOWN', null, price, 0, now.toISOString());

            console.log(`🎯 [UMPIRE] Trial opened: ${ticker} ${trialDirection} | ${triggerType} @ ${price} | cooldown ${cfg['validator.cooldown_minutes']}m`);
            this._emitUpdate({ type: 'TRIAL_OPENED', trialId, ticker, direction: trialDirection, triggerType, price, levelType, levelPrice });

        } catch (err) {
            if (!err.message?.includes('UNIQUE')) {
                console.error('[Umpire] onStreamC error:', err.message);
            }
        }
    }

    onStreamA(payload, nowOverride = null) {
        if (!payload?.results) return;

        const now = nowOverride ? new Date(nowOverride) : new Date();

        const activeTrials = db.prepare(`
            SELECT * FROM validation_trials WHERE state IN ('COOLDOWN', 'WATCHING')
        `).all();

        if (activeTrials.length === 0) return;

        // Build ticker → scan data map
        const tickerMap = {};
        for (const r of payload.results) {
            const d = r.data || r;
            const t = d.ticker || r.ticker;
            if (t) tickerMap[t] = d;
        }



        for (const trial of activeTrials) {
            const scanData = tickerMap[trial.ticker];
            if (!scanData) continue;

            let cfg, features;
            try {
                cfg = JSON.parse(trial.config_snapshot);
                features = JSON.parse(trial.feature_snapshot);
            } catch { continue; }

            const currentPrice = parseFloat(scanData.close || 0);
            if (currentPrice <= 0) continue;

            const priceMovePct = trial.direction === 'LONG'
                ? (currentPrice - trial.trigger_price) / trial.trigger_price * 100
                : (trial.trigger_price - currentPrice) / trial.trigger_price * 100;

            const ruleSnapshot = rules.evaluateAll(trial, features, scanData, cfg, currentPrice);

            this._logState(trial.trial_id, trial.state, JSON.stringify(ruleSnapshot), currentPrice, priceMovePct, now.toISOString());

            // Only apply verdict logic during WATCHING state
            if (trial.state !== 'WATCHING') continue;

            const verdict = this._resolveVerdict(trial, ruleSnapshot, priceMovePct, cfg, now);
            if (verdict) {
                this._resolveTrial(trial, verdict, ruleSnapshot, currentPrice, priceMovePct, now);
            }
        }
    }

    checkTimers(nowOverride = null) {
        const now = nowOverride ? new Date(nowOverride) : new Date();

        // COOLDOWN → WATCHING transitions
        const cooling = db.prepare(`SELECT * FROM validation_trials WHERE state = 'COOLDOWN'`).all();
        for (const trial of cooling) {
            if (now >= new Date(trial.cooldown_until)) {
                db.prepare(`UPDATE validation_trials SET state = 'WATCHING' WHERE trial_id = ?`).run(trial.trial_id);
                this._logState(trial.trial_id, 'WATCHING', null, null, null, now.toISOString());
                console.log(`👀 [UMPIRE] ${trial.ticker} → WATCHING`);
                this._emitUpdate({ type: 'STATE_CHANGE', trialId: trial.trial_id, state: 'WATCHING', ticker: trial.ticker });
            }
        }

        // WATCHING — early check and timeout
        const watching = db.prepare(`SELECT * FROM validation_trials WHERE state = 'WATCHING'`).all();
        for (const trial of watching) {
            let cfg;
            try { cfg = JSON.parse(trial.config_snapshot); } catch { continue; }

            // Timeout
            if (now >= new Date(trial.watch_until)) {
                this._resolveTrial(trial, 'NEUTRAL_TIMEOUT', null, null, null, now);
                continue;
            }

            // Early check
            const earlyEnabled = cfg['validator.early_check_enabled'];
            if (!earlyEnabled || this.earlyChecksDone.has(trial.trial_id)) continue;

            const earlyMinutes = cfg['validator.early_check_minutes'] || 15;
            const earlyThreshold = cfg['validator.early_check_threshold_pct'] || 0.2;
            const earlyTime = new Date(new Date(trial.detected_at).getTime() + earlyMinutes * 60 * 1000);

            if (now >= earlyTime) {
                this.earlyChecksDone.add(trial.trial_id);

                const latestLog = db.prepare(`
                    SELECT unrealized_move_pct, rule_snapshot FROM validation_state_log
                    WHERE trial_id = ? AND unrealized_move_pct IS NOT NULL
                    ORDER BY changed_at DESC LIMIT 1
                `).get(trial.trial_id);

                if (latestLog && latestLog.unrealized_move_pct >= earlyThreshold) {
                    let ruleSnap = null;
                    try { ruleSnap = JSON.parse(latestLog.rule_snapshot); } catch {}
                    if (rules.gatesPass(ruleSnap)) {
                        console.log(`⚡ [UMPIRE] ${trial.ticker} EARLY_FAVORABLE @ +${latestLog.unrealized_move_pct.toFixed(2)}%`);
                        this.emit('early_favorable', { trial, priceMovePct: latestLog.unrealized_move_pct, ruleSnapshot: ruleSnap });
                        this._emitUpdate({ type: 'EARLY_FAVORABLE', trialId: trial.trial_id, ticker: trial.ticker, movePct: latestLog.unrealized_move_pct });
                    }
                }
            }
        }
    }

    // ─────────────────────────────────────────────
    // PRIVATE HELPERS
    // ─────────────────────────────────────────────

    _resolveVerdict(trial, ruleSnapshot, priceMovePct, cfg, now) {
        const winThreshold = parseFloat(cfg['validator.win_threshold_30m_pct'] || 0.5);

        // GATE failure → immediate FAILED
        for (const result of Object.values(ruleSnapshot)) {
            if (result.role === 'GATE' && result.passed === false) return 'FAILED';
        }

        // MAJOR veto → immediate FAILED
        const major = ruleSnapshot[rules.RULE_IDS.EMA_4H_ALIGN];
        if (major?.role === 'MAJOR' && major?.passed === false) return 'FAILED';

        // Price moved hard against → FAILED
        if (priceMovePct <= -winThreshold) return 'FAILED';

        // Price reached target → CONFIRMED
        if (priceMovePct >= winThreshold) return 'CONFIRMED';

        return null;
    }

    _resolveTrial(trial, verdict, ruleSnapshot, currentPrice, priceMovePct, now) {
        try {
            db.prepare(`
                UPDATE validation_trials
                SET state = 'RESOLVED', verdict = ?, failure_reason = ?, resolved_at = ?
                WHERE trial_id = ?
            `).run(
                verdict,
                verdict === 'FAILED' ? rules.getFailureReason(ruleSnapshot) : null,
                now.toISOString(),
                trial.trial_id
            );

            this._logState(
                trial.trial_id, 'RESOLVED',
                ruleSnapshot ? JSON.stringify(ruleSnapshot) : null,
                currentPrice, priceMovePct, now.toISOString()
            );

            const moveStr = priceMovePct != null ? ` | Move: ${priceMovePct.toFixed(2)}%` : '';
            console.log(`🏁 [UMPIRE] ${trial.ticker} ${trial.direction} → ${verdict}${moveStr}`);

            this._emitUpdate({ type: 'VERDICT', trialId: trial.trial_id, verdict, ticker: trial.ticker, direction: trial.direction, movePct: priceMovePct });
            this.emit('verdict', { trial, verdict, ruleSnapshot, currentPrice, priceMovePct });
            this.earlyChecksDone.delete(trial.trial_id);

        } catch (err) {
            console.error('[Umpire] _resolveTrial error:', err.message);
        }
    }

    _logState(trialId, state, ruleSnapshot, currentPrice, unrealizedMovePct, timestamp = null) {
        try {
            const time = timestamp || new Date().toISOString();
            db.prepare(`
                INSERT INTO validation_state_log (trial_id, changed_at, state, rule_snapshot, current_price, unrealized_move_pct)
                VALUES (?, ?, ?, ?, ?, ?)
            `).run(trialId, time, state, ruleSnapshot, currentPrice, unrealizedMovePct);
        } catch (err) {
            console.error('[Umpire] _logState error:', err.message);
        }
    }

    _emitUpdate(data) {
        if (this.io) this.io.emit('validator-update', data);
    }

    _extractFeatureSnapshot(payload, price, direction) {
        const sl = payload.smart_levels || {};
        const e200 = sl.emas_200 || {};
        const rsi = payload.rsi_matrix || {};
        const dist = (p) => (p && price) ? (price - p) / p * 100 : null;

        const toNum = (v) => v != null ? Number(v) || null : null;

        return {
            price, direction,
            ema200_5m_price:      toNum(e200.m5?.p),
            ema200_15m_price:     toNum(e200.m15?.p),
            ema200_1h_price:      toNum(e200.h1?.p),
            ema200_4h_price:      toNum(e200.h4?.p),
            ema200_5m_dist_pct:   dist(e200.m5?.p),
            ema200_15m_dist_pct:  dist(e200.m15?.p),
            ema200_1h_dist_pct:   dist(e200.h1?.p),
            ema200_4h_dist_pct:   dist(e200.h4?.p),
            mega_spot_price:      toNum(sl.mega_spot?.p),
            mega_spot_dist_pct:   dist(sl.mega_spot?.p),
            rsi_h1:               rsi.h1 ?? null,
            roc_pct:              payload.momentum?.roc_pct ?? payload.roc_pct ?? 0
        };
    }

    _detectClosestLevel(price, sl) {
        if (!sl || !price) return { levelType: 'UNKNOWN', levelPrice: price };
        const e200 = sl.emas_200 || {};
        const candidates = [
            { type: 'MEGA_SPOT',    p: sl.mega_spot?.p },
            { type: 'EMA200_5M',    p: e200.m5?.p },
            { type: 'EMA200_15M',   p: e200.m15?.p },
            { type: 'EMA200_1H',    p: e200.h1?.p },
            { type: 'EMA200_4H',    p: e200.h4?.p },
            { type: 'EMA50_1H',     p: sl.emas_50?.h1?.p },
            { type: 'FIB_618',      p: sl.fibs_618?.h1?.p },
            { type: 'DAILY_LOGIC',  p: sl.daily_logic?.base_supp?.p ?? sl.daily_logic?.base_res?.p },
            { type: 'HOURLY_LOGIC', p: sl.hourly_logic?.base_supp?.p ?? sl.hourly_logic?.base_res?.p },
        ].filter(c => c.p);

        if (!candidates.length) return { levelType: 'UNKNOWN', levelPrice: price };
        // Coerce all .p values to numbers before comparison
        const numCandidates = candidates.map(c => ({ ...c, p: Number(c.p) })).filter(c => c.p > 0);
        if (!numCandidates.length) return { levelType: 'UNKNOWN', levelPrice: price };
        numCandidates.sort((a, b) => Math.abs(price - a.p) - Math.abs(price - b.p));
        return { levelType: numCandidates[0].type, levelPrice: numCandidates[0].p };
    }

    _getLatestMarketMood() {
        try {
            const row = db.prepare(`SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1`).get();
            if (!row) return null;
            return JSON.parse(row.raw_data).market_sentiment?.moodScore ?? null;
        } catch { return null; }
    }

    _getLatestVolSpike(ticker) {
        try {
            const row = db.prepare(`SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1`).get();
            if (!row) return 0;
            const results = JSON.parse(row.raw_data).results || [];
            const coin = results.find(r => (r.data?.ticker ?? r.ticker) === ticker);
            const d = coin?.data || coin;
            return d?.volSpike ?? 0;
        } catch { return 0; }
    }
}

module.exports = UmpireEngine;
