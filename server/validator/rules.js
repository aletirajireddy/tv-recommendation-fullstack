/**
 * Validator Rules — 7 evaluators for the 3rd Umpire checklist.
 *
 * EMA hierarchy (from user spec):
 *   5m  EMA200 = GATE  (must hold for entry)
 *   15m EMA200 = GATE  (must hold to sustain)
 *   1h  EMA200 = MINOR (weight only)
 *   4h  EMA200 = MAJOR (can veto — overrides everything)
 */

const RULE_IDS = Object.freeze({
    TRIGGER_VALID:    'TRIGGER_VALID',
    EMA_5M_HOLD:      'EMA_5M_HOLD',
    EMA_15M_SUSTAIN:  'EMA_15M_SUSTAIN',
    EMA_1H_ALIGN:     'EMA_1H_ALIGN',
    EMA_4H_ALIGN:     'EMA_4H_ALIGN',
    VOLUME_CONFIRM:   'VOLUME_CONFIRM',
    REACTIVE_ZONE:    'REACTIVE_ZONE'
});

/**
 * @param {object} trial         - validation_trials row
 * @param {object} features      - parsed feature_snapshot (EMAs, RSI, etc.)
 * @param {object} scanData      - coin's row from latest Stream A scan
 * @param {object} cfg           - parsed config_snapshot
 * @param {number} currentPrice  - latest close price from Stream A
 */
function evaluateAll(trial, features, scanData, cfg, currentPrice) {
    const isLong = trial.direction === 'LONG';
    const result = {};

    // Rule 1 — Trigger valid (informational, always true)
    result[RULE_IDS.TRIGGER_VALID] = {
        passed: true, role: 'INFO',
        observed: trial.trigger_type
    };

    // Rule 2 — 5m EMA200 hold (GATE)
    const ema5m = features.ema200_5m_price ? Number(features.ema200_5m_price) : null;
    if (ema5m && currentPrice) {
        const dist = (currentPrice - ema5m) / ema5m * 100;
        const passed = isLong ? dist > -0.1 : dist < 0.1;
        result[RULE_IDS.EMA_5M_HOLD] = {
            passed, role: 'GATE',
            observed: `${dist.toFixed(3)}%`,
            threshold: isLong ? '> -0.1%' : '< +0.1%',
            reason: passed ? null : 'Price broke through 5m EMA200'
        };
    } else {
        result[RULE_IDS.EMA_5M_HOLD] = { passed: null, role: 'GATE', observed: null, reason: 'No 5m EMA data' };
    }

    // Rule 3 — 15m EMA200 sustain (GATE)
    const ema15m = features.ema200_15m_price ? Number(features.ema200_15m_price) : null;
    if (ema15m && currentPrice) {
        const dist = (currentPrice - ema15m) / ema15m * 100;
        const passed = isLong ? dist > -0.15 : dist < 0.15;
        result[RULE_IDS.EMA_15M_SUSTAIN] = {
            passed, role: 'GATE',
            observed: `${dist.toFixed(3)}%`,
            threshold: isLong ? '> -0.15%' : '< +0.15%',
            reason: passed ? null : 'Price broke through 15m EMA200'
        };
    } else {
        result[RULE_IDS.EMA_15M_SUSTAIN] = { passed: null, role: 'GATE', observed: null, reason: 'No 15m EMA data' };
    }

    // Rule 4 — 1h EMA200 align (MINOR weight)
    const ema1h = features.ema200_1h_price ? Number(features.ema200_1h_price) : null;
    if (ema1h && currentPrice) {
        const dist = (currentPrice - ema1h) / ema1h * 100;
        const passed = isLong ? dist > 0 : dist < 0;
        result[RULE_IDS.EMA_1H_ALIGN] = {
            passed, role: 'MINOR',
            observed: `${dist.toFixed(3)}%`,
            reason: passed ? null : '1H EMA200 not aligned with direction'
        };
    } else {
        result[RULE_IDS.EMA_1H_ALIGN] = { passed: null, role: 'MINOR', observed: null, reason: 'No 1H EMA data' };
    }

    // Rule 5 — 4h EMA200 align (MAJOR — can veto verdict)
    const ema4h = features.ema200_4h_price ? Number(features.ema200_4h_price) : null;
    if (ema4h && currentPrice) {
        const dist = (currentPrice - ema4h) / ema4h * 100;
        const passed = isLong ? dist > 0 : dist < 0;
        result[RULE_IDS.EMA_4H_ALIGN] = {
            passed, role: 'MAJOR',
            observed: `${dist.toFixed(3)}%`,
            reason: passed ? null : '4H EMA200 opposes — VETO applied'
        };
    } else {
        result[RULE_IDS.EMA_4H_ALIGN] = { passed: null, role: 'MAJOR', observed: null, reason: 'No 4H EMA data' };
    }

    // Rule 6 — Volume confirm (WEIGHT)
    const volSpike = parseInt(scanData?.volSpike ?? scanData?.vol_spike ?? features.vol_spike ?? 0);
    result[RULE_IDS.VOLUME_CONFIRM] = {
        passed: volSpike === 1,
        role: 'WEIGHT',
        observed: volSpike,
        reason: volSpike === 1 ? null : 'No volume spike on retest'
    };

    // Rule 7 — Reactive zone touch (WEIGHT)
    const levelPrice = trial.level_price;
    const minZone = parseFloat(cfg['validator.reactive_zone_min_pct'] ?? 0.3);
    const maxZone = parseFloat(cfg['validator.reactive_zone_max_pct'] ?? 0.5);
    if (levelPrice && currentPrice) {
        const touchDist = Math.abs((currentPrice - levelPrice) / levelPrice * 100);
        const passed = touchDist >= minZone && touchDist <= maxZone;
        result[RULE_IDS.REACTIVE_ZONE] = {
            passed, role: 'WEIGHT',
            observed: `${touchDist.toFixed(3)}%`,
            threshold: `${minZone}–${maxZone}%`,
            reason: passed ? null : touchDist < minZone ? 'Not retested level yet' : 'Retest overshot level'
        };
    } else {
        result[RULE_IDS.REACTIVE_ZONE] = { passed: null, role: 'WEIGHT', observed: null, reason: 'No level price' };
    }

    return result;
}

function getFailureReason(ruleSnapshot) {
    if (!ruleSnapshot) return 'PRICE_AGAINST';
    for (const [id, r] of Object.entries(ruleSnapshot)) {
        if (r.passed === false && (r.role === 'GATE' || r.role === 'MAJOR')) return id;
    }
    return 'PRICE_AGAINST';
}

function gatesPass(ruleSnapshot) {
    if (!ruleSnapshot) return false;
    const gates = [RULE_IDS.EMA_5M_HOLD, RULE_IDS.EMA_15M_SUSTAIN];
    return gates.every(id => ruleSnapshot[id]?.passed !== false);
}

module.exports = { RULE_IDS, evaluateAll, getFailureReason, gatesPass };
