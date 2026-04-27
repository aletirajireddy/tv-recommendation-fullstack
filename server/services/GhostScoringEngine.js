/**
 * GhostScoringEngine — Regime-aware confidence scoring for ghost approval queue.
 *
 * Score = base_win_rate × regime_multiplier × sample_weight
 *
 * Components (all normalized 0–100):
 *
 *   1. base_win_rate (0–100)  — PRIORITY ORDER:
 *      a) Per-ticker recency-weighted win rate from actual resolved validation_trials
 *         (used when ticker has ≥ 5 resolved trials — most accurate, coin-specific)
 *      b) Best matching row from pattern_statistics for this ticker's last direction
 *         (global feature-combo stats — used as fallback when per-ticker data is sparse)
 *      c) Global average win rate (last resort when no stats at all)
 *
 *   2. regime_multiplier (0.5 – 1.5)
 *      Derived from latest market_sentiment mood (normalized to key):
 *        STRONGLY_BULLISH → LONG ×1.45, SHORT ×0.50
 *        EUPHORIC         → LONG ×1.30, SHORT ×0.60
 *        BULLISH          → LONG ×1.15, SHORT ×0.80
 *        NEUTRAL/RANGING  → both ×1.00
 *        BEARISH          → LONG ×0.80, SHORT ×1.15
 *        STRONGLY_BEARISH → LONG ×0.55, SHORT ×1.45
 *        PANIC            → LONG ×0.60, SHORT ×1.30
 *
 *   3. sample_confidence_weight (0.6 – 1.0)
 *      Scales down if sample_count < 20. Full weight at 20+ samples.
 *
 * Final score capped 0–100, rounded to 1dp.
 * score_breakdown JSON captures each component for FE display.
 */

const db = require('../database');

const REGIME_MULTIPLIERS = {
    STRONGLY_BULLISH: { LONG: 1.45, SHORT: 0.50 },
    EUPHORIC:         { LONG: 1.30, SHORT: 0.60 },
    BULLISH:          { LONG: 1.15, SHORT: 0.80 },
    NEUTRAL:          { LONG: 1.00, SHORT: 1.00 },
    RANGING:          { LONG: 1.00, SHORT: 1.00 },
    BEARISH:          { LONG: 0.80, SHORT: 1.15 },
    STRONGLY_BEARISH: { LONG: 0.55, SHORT: 1.45 },
    PANIC:            { LONG: 0.60, SHORT: 1.30 },
};

const CONFIDENCE_LABEL = (s) =>
    s >= 72 ? 'HIGH' : s >= 52 ? 'MEDIUM' : s >= 35 ? 'LOW' : 'VERY_LOW';

/** Normalize raw_label strings like "STRONGLY BEARISH" → "STRONGLY_BEARISH" */
function normalizeMood(raw) {
    if (!raw) return 'NEUTRAL';
    return raw.trim().toUpperCase().replace(/\s+/g, '_');
}

function getLatestRegime() {
    const row = db.prepare(`
        SELECT raw_label, raw_mood_score
        FROM raw_market_sentiment_log
        ORDER BY timestamp DESC LIMIT 1
    `).get();
    return row || { raw_label: 'NEUTRAL', raw_mood_score: 0 };
}

/**
 * Per-ticker recency-weighted win rate.
 * Uses exponential decay (half-life 14d) so recent trials count more.
 * Returns null if fewer than 5 resolved trials exist for this ticker.
 */
function getTickerWinRate(ticker) {
    const trials = db.prepare(`
        SELECT verdict, detected_at, direction
        FROM validation_trials
        WHERE ticker = ? AND state = 'RESOLVED' AND verdict IS NOT NULL
        ORDER BY resolved_at DESC LIMIT 50
    `).all(ticker);

    if (trials.length < 5) return null;

    const now = Date.now();
    let weightedWins = 0, totalWeight = 0;
    for (const t of trials) {
        const ageMs   = now - new Date(t.detected_at).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const weight  = Math.exp(-ageDays / 14); // ~half-life 10 days
        totalWeight  += weight;
        if (t.verdict === 'CONFIRMED') weightedWins += weight;
    }
    const win_rate = totalWeight > 0 ? (weightedWins / totalWeight) * 100 : 50;

    return {
        win_rate,
        sample_count: trials.length,
        confidence:   trials.length >= 20 ? 'HIGH' : trials.length >= 10 ? 'MEDIUM' : 'LOW',
        direction:    trials[0]?.direction || null,
        stat_key:     `ticker_history(n=${trials.length})`,
    };
}

function getBestWinRate(ticker) {
    // ── Priority 1: per-ticker actual track record ─────────────────────────
    const tickerData = getTickerWinRate(ticker);
    if (tickerData) return tickerData;

    // ── Priority 2: pattern_statistics (direction-level feature combos) ────
    const lastTrial = db.prepare(`
        SELECT direction FROM validation_trials
        WHERE ticker = ? AND state = 'RESOLVED'
        ORDER BY resolved_at DESC LIMIT 1
    `).get(ticker);

    const direction = lastTrial?.direction || null;

    const statQuery = direction
        ? db.prepare(`
            SELECT win_rate_30m, sample_count, confidence, stat_key
            FROM pattern_statistics
            WHERE stat_key LIKE ?
            ORDER BY
                CASE confidence WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END ASC,
                win_rate_30m DESC
            LIMIT 1
          `).get(`%dir=${direction}%`)
        : null;

    if (statQuery) {
        return { win_rate: statQuery.win_rate_30m, sample_count: statQuery.sample_count, confidence: statQuery.confidence, direction, stat_key: statQuery.stat_key };
    }

    // ── Priority 3: global fallback ────────────────────────────────────────
    const global = db.prepare(`
        SELECT AVG(win_rate_30m) as avg_wr, SUM(sample_count) as total_samples
        FROM pattern_statistics
    `).get();

    return {
        win_rate:     global?.avg_wr || 50,
        sample_count: global?.total_samples || 0,
        confidence:   'LOW',
        direction:    direction || 'UNKNOWN',
        stat_key:     'global_fallback',
    };
}

/**
 * Score a single ghost ticker.
 * @param {string} ticker
 * @returns {{ confidence_score: number, score_breakdown: object }}
 */
function scoreGhost(ticker) {
    const regime = getLatestRegime();
    const statData = getBestWinRate(ticker);

    const mood  = normalizeMood(regime.raw_label);
    const dir   = statData.direction;
    const mults = REGIME_MULTIPLIERS[mood] || REGIME_MULTIPLIERS.NEUTRAL;
    const regimeMult = dir && (dir === 'LONG' || dir === 'SHORT')
        ? mults[dir]
        : 1.0; // unknown direction — no boost/penalty

    // Sample confidence weight: 0.6 at 1 sample, scales linearly to 1.0 at 20+ samples
    const sampleWeight = Math.min(1.0, 0.6 + (Math.min(statData.sample_count, 20) / 20) * 0.4);

    const rawScore = statData.win_rate * regimeMult * sampleWeight;
    const confidence_score = Math.max(0, Math.min(100, Math.round(rawScore * 10) / 10));

    const score_breakdown = {
        base_win_rate: Math.round(statData.win_rate * 10) / 10,
        regime_mood: mood,
        regime_multiplier: regimeMult,
        sample_weight: Math.round(sampleWeight * 100) / 100,
        sample_count: statData.sample_count,
        direction_used: dir,
        stat_key: statData.stat_key,
        confidence: CONFIDENCE_LABEL(confidence_score),
        scored_at: new Date().toISOString(),
    };

    return { confidence_score, score_breakdown };
}

/**
 * Score all un-approved ghosts in the queue and persist to DB.
 * Called on ghost queue fetch so scores stay fresh.
 */
function scoreAllGhosts() {
    const ghosts = db.prepare('SELECT ticker FROM ghost_approval_queue WHERE is_approved = 0').all();
    const update = db.prepare(`
        UPDATE ghost_approval_queue
        SET confidence_score = ?, score_breakdown = ?, scored_at = ?
        WHERE ticker = ?
    `);
    const scoredAt = new Date().toISOString();
    const tx = db.transaction((rows) => {
        for (const { ticker } of rows) {
            const { confidence_score, score_breakdown } = scoreGhost(ticker);
            update.run(confidence_score, JSON.stringify(score_breakdown), scoredAt, ticker);
        }
    });
    tx(ghosts);
}

module.exports = { scoreGhost, scoreAllGhosts, CONFIDENCE_LABEL };
