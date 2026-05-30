// Backtest engine — Phase 1 SKELETON.
//
// This is intentionally a working-but-minimal scaffold. It loads archived
// Stream D history for a coin and evaluates a simplified cascade+RSI signal so
// the whole pipeline runs end-to-end TODAY. It is NOT yet a P&L-accurate
// backtest — see the KNOWN GAPS below.
//
// KNOWN GAPS (tracked in docs/HERMES_STRATEGY_ROADMAP.md):
//  1. coin_metric_history stores dist_* (% distance to EMA200), NOT raw price or
//     raw EMA values. True cascade = EMA-value stacking; here we approximate
//     direction from dist sign-alignment across timeframes. Good enough to wire
//     the loop; replace once price is also archived (from master_coin_store).
//  2. No real entry price / exit price yet → expectancy/maxDD are placeholders.
//  3. Key-level proximity (Stream C smart_levels) not joined yet.
//
// The point of Phase 1 is the SHAPE: backtest(config, ctx) -> metrics. The
// self-learning loop later only needs this contract to stay stable.

/** Map a strategy's TF list to coin_metric_history dist_* columns. */
const DIST_COL = { m1: 'dist_m1', m5: 'dist_m5', m15: 'dist_m15', h1: 'dist_h1', h4: 'dist_h4' };
const RSI_COL  = { m5: 'rsi_m5', m15: 'rsi_m15', m30: 'rsi_m30', h1: 'rsi_h1' };

/** Proxy cascade direction from dist sign-alignment (placeholder for EMA stacking). */
function proxyCascade(row, tfs) {
    let pos = 0, neg = 0, seen = 0;
    for (const tf of tfs) {
        const v = row[DIST_COL[tf]];
        if (v == null) continue;
        seen++;
        if (v > 0) pos++; else if (v < 0) neg++;
    }
    if (seen < tfs.length) return 'neutral';      // require all TFs present
    if (pos === tfs.length) return 'bull';        // price above all EMAs
    if (neg === tfs.length) return 'bear';        // price below all EMAs
    return 'neutral';
}

/**
 * Evaluate one strategy config against a coin's archived series.
 * @param {object} cfg  strategy config (see strategies/*.json)
 * @param {object[]} series  rows from archive coin_metric_history, ascending ts
 * @returns {object} per-coin signal stats
 */
function evaluateSeries(cfg, series) {
    const tfs   = cfg?.entry?.emaCascade?.tfs   || ['h1', 'm15'];
    const dir   = cfg?.entry?.emaCascade?.dir   || 'bull';
    const hold  = cfg?.entry?.emaCascade?.holdBuckets || 1;
    const rsiTf = cfg?.entry?.rsiPullback?.tf   || 'm15';
    const rsiZ  = cfg?.entry?.rsiPullback?.zone || [45, 55];

    let signals = 0, cascadeBuckets = 0, run = 0;
    for (const row of series) {
        const casc = proxyCascade(row, tfs);
        if (casc === dir) {
            cascadeBuckets++;
            run++;
            const rsi = row[RSI_COL[rsiTf]];
            const rsiOk = rsi != null && rsi >= rsiZ[0] && rsi <= rsiZ[1];
            if (run >= hold && rsiOk) signals++;   // cascade held + RSI in pullback zone
        } else {
            run = 0;
        }
    }
    return { bars: series.length, cascadeBuckets, signals };
}

/**
 * Top-level backtest. Aggregates across coins.
 * @param {object} cfg  strategy config
 * @param {object} ctx  { archive: betterSqlite3 db, sinceMs, tickers? }
 */
function backtest(cfg, ctx) {
    const { archive, sinceMs } = ctx;
    const since = sinceMs ?? 0;

    const tickers = ctx.tickers || archive.prepare(
        'SELECT DISTINCT ticker FROM coin_metric_history WHERE ts >= ?'
    ).all(since).map(r => r.ticker);

    const perCoin = [];
    let totalSignals = 0, totalBars = 0, totalCasc = 0;
    const load = archive.prepare(
        'SELECT * FROM coin_metric_history WHERE ticker = ? AND ts >= ? ORDER BY ts ASC'
    );

    for (const ticker of tickers) {
        const series = load.all(ticker, since);
        if (series.length < 3) continue;
        const r = evaluateSeries(cfg, series);
        perCoin.push({ ticker, ...r });
        totalSignals += r.signals;
        totalBars    += r.bars;
        totalCasc    += r.cascadeBuckets;
    }

    perCoin.sort((a, b) => b.signals - a.signals);

    return {
        strategy: cfg.name || 'unnamed',
        coins: perCoin.length,
        totalBars,
        cascadeBuckets: totalCasc,
        signals: totalSignals,
        // Placeholders until price is archived (see KNOWN GAPS):
        winRate: null,
        expectancy: null,
        maxDrawdownPct: null,
        topCoins: perCoin.slice(0, 10),
        note: 'Phase-1 skeleton: signal counting only. P&L metrics require archived price (Phase 1.5).',
    };
}

module.exports = { backtest, evaluateSeries, proxyCascade };
