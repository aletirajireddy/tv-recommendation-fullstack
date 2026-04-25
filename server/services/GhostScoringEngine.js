/**
 * GhostScoringEngine — Regime-aware confidence scoring for ghost approval queue.
 *
 * Score = base_win_rate × regime_multiplier
 *
 * Components (all normalized 0–100):
 *
 *   1. base_win_rate (0–100)
 *      Pull best matching row from pattern_statistics for this ticker's most
 *      recent trial direction. If no trial history exists, fall back to the
 *      global average win rate for the current regime direction.
 *
 *   2. regime_multiplier (0.5 – 1.5)
 *      Derived from latest market_sentiment mood + mood_score:
 *        EUPHORIC  → LONG +1.3,  SHORT ×0.6
 *        BULLISH   → LONG ×1.15, SHORT ×0.8
 *        NEUTRAL   → both ×1.0
 *        BEARISH   → LONG ×0.8,  SHORT ×1.15
 *        PANIC     → LONG ×0.6,  SHORT ×1.3
 *
 *   3. sample_confidence_weight (0.6 – 1.0)
 *      Scales down if sample_count < 10. Full weight at 20+ samples.
 *
 * Final score capped 0–100, rounded to 1dp.
 * score_breakdown JSON captures each component for FE display.
 *
 * Q5 choice: stats + current market regime (boost when aligned, penalty when opposed).
 * Future: add per-ticker trial track record weight (Q5-future).
 */

const db = require('../database');

const REGIME_MULTIPLIERS = {
    EUPHORIC: { LONG: 1.30, SHORT: 0.60 },
    BULLISH:  { LONG: 1.15, SHORT: 0.80 },
    NEUTRAL:  { LONG: 1.00, SHORT: 1.00 },
    RANGING:  { LONG: 1.00, SHORT: 1.00 },
    BEARISH:  { LONG: 0.80, SHORT: 1.15 },
    PANIC:    { LONG: 0.60, SHORT: 1.30 },
};

const CONFIDENCE_LABEL = (s) =>
    s >= 72 ? 'HIGH' : s >= 52 ? 'MEDIUM' : s >= 35 ? 'LOW' : 'VERY_LOW';

function getLatestRegime() {
    const row = db.prepare(`
        SELECT raw_label, raw_mood_score
        FROM raw_market_sentiment_log
        ORDER BY timestamp DESC LIMIT 1
    `).get();
    return row || { raw_label: 'NEUTRAL', raw_mood_score: 0 };
}

function getBestWinRate(ticker) {
    // Try: most recent resolved trial direction for this ticker → best matching pattern_stat
    const lastTrial = db.prepare(`
        SELECT direction FROM validation_trials
        WHERE ticker = ? AND state = 'RESOLVED'
        ORDER BY resolved_at DESC LIMIT 1
    `).get(ticker);

    const direction = lastTrial?.direction || null;

    // Pull best win rate from pattern_statistics (highest confidence first, then win rate)
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

    // Fallback: global average for any direction
    const global = db.prepare(`
        SELECT AVG(win_rate_30m) as avg_wr, SUM(sample_count) as total_samples
        FROM pattern_statistics
    `).get();

    return {
        win_rate: global?.avg_wr || 50,
        sample_count: global?.total_samples || 0,
        confidence: 'LOW',
        direction: direction || 'UNKNOWN',
        stat_key: 'global_fallback',
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

    const mood = regime.raw_label || 'NEUTRAL';
    const dir = statData.direction;
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
