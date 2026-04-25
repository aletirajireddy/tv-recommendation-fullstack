/**
 * Telegram Validator Alerts
 *
 * Subscribes to UmpireEngine events and sends enriched phase-2 verdict messages.
 * Silent in replay mode — only fires when the system is LIVE (latest scan = current).
 *
 * Message format is self-contained: ticker, direction, all rule pass/fail details,
 * market mood, similar setup win rate, next level, invalidation price.
 * The user can act on it by looking at the chart alone — no dashboard visit needed.
 */

const db = require('../database');

const RULE_LABELS = {
    TRIGGER_VALID:   'Trigger',
    EMA_5M_HOLD:     '5m EMA200 Hold',
    EMA_15M_SUSTAIN: '15m EMA200 Sustain',
    EMA_1H_ALIGN:    '1H EMA200 Align',
    EMA_4H_ALIGN:    '4H EMA200 Align (Major)',
    VOLUME_CONFIRM:  'Volume Confirmed',
    REACTIVE_ZONE:   'Reactive Zone Touch'
};

function isLiveMode() {
    try {
        const latest = db.prepare(`SELECT timestamp FROM scans ORDER BY timestamp DESC LIMIT 1`).get();
        if (!latest) return true;
        const age = Date.now() - new Date(latest.timestamp).getTime();
        return age < 15 * 60 * 1000; // Within 15 min = live
    } catch { return true; }
}

function getSimilarWinRate(direction, triggerType) {
    try {
        const key = `dir=${direction}|trigger=${triggerType}`;
        const row = db.prepare(`SELECT win_rate_30m, sample_count, confidence FROM pattern_statistics WHERE stat_key = ?`).get(key);
        return row ? { rate: row.win_rate_30m, count: row.sample_count, confidence: row.confidence } : null;
    } catch { return null; }
}

function getNextLevel(ticker, price, direction, smartLevels) {
    if (!smartLevels) return null;
    const sl = smartLevels;
    const e200 = sl.emas_200 || {};
    const levels = [
        { label: 'Mega Spot',    price: sl.mega_spot?.p },
        { label: '4H EMA200',    price: e200.h4?.p },
        { label: '1H EMA200',    price: e200.h1?.p },
        { label: 'Daily Logic',  price: sl.daily_logic?.base_res?.p || sl.daily_logic?.base_supp?.p },
    ].filter(l => l.price);

    const relevant = direction === 'LONG'
        ? levels.filter(l => l.price > price).sort((a, b) => a.price - b.price)
        : levels.filter(l => l.price < price).sort((a, b) => b.price - a.price);

    return relevant[0] || null;
}

function buildVerdictMessage(trial, ruleSnapshot, priceMovePct, prefix) {
    const dir = trial.direction;
    const emoji = dir === 'LONG' ? '🟢' : '🔴';
    const moveStr = priceMovePct != null ? `${priceMovePct >= 0 ? '+' : ''}${priceMovePct.toFixed(2)}%` : 'N/A';

    const verdictEmoji = {
        CONFIRMED: '✅',
        FAILED: '❌',
        NEUTRAL_TIMEOUT: '⏱',
        EARLY_FAVORABLE: '⚡'
    }[trial.verdict] || '❓';

    let features = {};
    try { features = JSON.parse(trial.feature_snapshot || '{}'); } catch {}

    let rawTrigger = {};
    try { rawTrigger = JSON.parse(trial.raw_trigger_blob || '{}'); } catch {}

    // Rules checklist
    let rulesText = '';
    if (ruleSnapshot) {
        for (const [id, r] of Object.entries(ruleSnapshot)) {
            if (id === 'TRIGGER_VALID') continue;
            const icon = r.passed === true ? '✓' : r.passed === false ? '✗' : '?';
            rulesText += `   ${icon} ${RULE_LABELS[id] || id}${r.observed ? ` (${r.observed})` : ''}\n`;
        }
    }

    // Similar setups win rate
    const winData = getSimilarWinRate(dir, trial.trigger_type);
    const winStr = winData
        ? `📊 Similar setups: ${winData.rate}% win rate (n=${winData.count}, ${winData.confidence} confidence)\n`
        : '';

    // Next level target
    const nextLevel = getNextLevel(trial.ticker, trial.trigger_price, dir, rawTrigger.smart_levels);
    const nextLevelStr = nextLevel
        ? `🎯 Next target: $${nextLevel.price} (${nextLevel.label})\n`
        : '';

    // Invalidation price — ema200_5m_price may be stored as a string, coerce to Number
    const ema5mInval = features.ema200_5m_price ? Number(features.ema200_5m_price) : null;
    const invalidation = ema5mInval ? `$${ema5mInval.toFixed(4)} (5m EMA200)` : null;
    const invalidStr = invalidation ? `🚫 Invalidation: ${invalidation}\n` : '';

    // Market mood
    const mood = features.market_mood;
    const moodStr = mood != null ? `🌡 Market mood: ${mood > 0 ? '+' : ''}${mood}\n` : '';

    // Duration
    const duration = trial.resolved_at && trial.detected_at
        ? Math.round((new Date(trial.resolved_at) - new Date(trial.detected_at)) / 60000)
        : null;
    const durStr = duration ? ` | ${duration}m elapsed` : '';

    return `${prefix} ${verdictEmoji} *${trial.verdict}* — ${emoji} ${trial.ticker} ${dir}\n` +
        `   Level: $${trial.trigger_price} (${trial.trigger_type} @ ${trial.level_type})\n` +
        `   Move: ${moveStr}${durStr}\n\n` +
        (rulesText ? `${rulesText}\n` : '') +
        moodStr + winStr + nextLevelStr + invalidStr;
}

function buildEarlyMessage(trial, priceMovePct, prefix) {
    let features = {};
    try { features = JSON.parse(trial.feature_snapshot || '{}'); } catch {}
    const dir = trial.direction;
    const emoji = dir === 'LONG' ? '🟢' : '🔴';
    const moveStr = `+${priceMovePct.toFixed(2)}%`;
    const mood = features.market_mood;
    const moodStr = mood != null ? ` | Mood: ${mood > 0 ? '+' : ''}${mood}` : '';

    return `${prefix} ⚡ *EARLY FAVORABLE* — ${emoji} ${trial.ticker} ${dir}\n` +
        `   Level: $${trial.trigger_price} (${trial.trigger_type})\n` +
        `   At 15m check: ${moveStr}${moodStr}\n` +
        `   ⏳ Watching for confirmation — 5m+15m EMA200 holding\n`;
}

function attach(engine, telegramService) {
    engine.on('verdict', ({ trial, verdict, ruleSnapshot, priceMovePct }) => {
        if (!isLiveMode()) return;

        const cfg = {};
        try { Object.assign(cfg, JSON.parse(trial.config_snapshot || '{}')); } catch {}
        if (cfg['validator.telegram_phase2_enabled'] === false) return;

        const prefix = telegramService.getPrefix ? telegramService.getPrefix() : '💻 [LOCAL]';
        const msg = buildVerdictMessage({ ...trial, verdict }, ruleSnapshot, priceMovePct, prefix);
        telegramService.sendAlert(msg, verdict === 'CONFIRMED' ? 'SUCCESS' : verdict === 'FAILED' ? 'WARN' : 'INFO');
    });

    engine.on('early_favorable', ({ trial, priceMovePct }) => {
        if (!isLiveMode()) return;

        const cfg = {};
        try { Object.assign(cfg, JSON.parse(trial.config_snapshot || '{}')); } catch {}
        if (cfg['validator.telegram_early_check_enabled'] === false) return;

        const prefix = telegramService.getPrefix ? telegramService.getPrefix() : '💻 [LOCAL]';
        const msg = buildEarlyMessage(trial, priceMovePct, prefix);
        telegramService.sendAlert(msg, 'INFO');
    });

    console.log('📣 Telegram Validator attached to Umpire Engine');
}

module.exports = { attach, isLiveMode };
