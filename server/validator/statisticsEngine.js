/**
 * Statistics Engine — rebuilds pattern_statistics from resolved validation_trials.
 * Run on-demand or on a schedule. Pure read + aggregation; writes only to
 * pattern_statistics. Never touches trials or state_log.
 */

const db = require('../database');

function rebuildStatistics() {
    const trials = db.prepare(`
        SELECT trial_id, ticker, direction, trigger_type, verdict,
               feature_snapshot, detected_at, resolved_at
        FROM validation_trials
        WHERE state = 'RESOLVED' AND verdict IS NOT NULL
    `).all();

    if (trials.length === 0) return 0;

    // Pull price move for each trial from state log (last non-null entry)
    const getMoveStmt = db.prepare(`
        SELECT unrealized_move_pct FROM validation_state_log
        WHERE trial_id = ? AND unrealized_move_pct IS NOT NULL
        ORDER BY changed_at DESC LIMIT 1
    `);

    // Build combination groups
    const groups = {};

    const addToGroup = (key, meta, isWin, priceMove) => {
        if (!groups[key]) groups[key] = { meta, wins: 0, count: 0, totalMove: 0 };
        groups[key].count++;
        groups[key].totalMove += priceMove;
        if (isWin) groups[key].wins++;
    };

    for (const trial of trials) {
        let features = {};
        try { features = JSON.parse(trial.feature_snapshot || '{}'); } catch {}

        const moveRow = getMoveStmt.get(trial.trial_id);
        const priceMove = moveRow?.unrealized_move_pct ?? 0;
        const isWin = trial.verdict === 'CONFIRMED';

        const isLong = trial.direction === 'LONG';
        const ema1hAlign = features.ema200_1h_dist_pct != null
            ? ((isLong ? features.ema200_1h_dist_pct > 0 : features.ema200_1h_dist_pct < 0) ? 1 : 0)
            : null;
        const ema4hAlign = features.ema200_4h_dist_pct != null
            ? ((isLong ? features.ema200_4h_dist_pct > 0 : features.ema200_4h_dist_pct < 0) ? 1 : 0)
            : null;
        const volFilter = features.vol_spike != null ? (features.vol_spike ? 1 : 0) : null;

        // Group by direction only
        addToGroup(`dir=${trial.direction}`, { direction: trial.direction }, isWin, priceMove);

        // Group by direction + trigger_type
        addToGroup(`dir=${trial.direction}|trigger=${trial.trigger_type}`,
            { direction: trial.direction, trigger_type: trial.trigger_type }, isWin, priceMove);

        // Group by direction + volume
        if (volFilter !== null) {
            addToGroup(`dir=${trial.direction}|vol=${volFilter}`,
                { direction: trial.direction, vol_filter: volFilter }, isWin, priceMove);
        }

        // Group by direction + 1h EMA alignment
        if (ema1hAlign !== null) {
            addToGroup(`dir=${trial.direction}|ema1h=${ema1hAlign}`,
                { direction: trial.direction, ema_1h_align: ema1hAlign }, isWin, priceMove);
        }

        // Group by direction + 4h EMA alignment
        if (ema4hAlign !== null) {
            addToGroup(`dir=${trial.direction}|ema4h=${ema4hAlign}`,
                { direction: trial.direction, ema_4h_align: ema4hAlign }, isWin, priceMove);
        }

        // Group by direction + vol + 1h + 4h (richest combo)
        if (volFilter !== null && ema1hAlign !== null && ema4hAlign !== null) {
            addToGroup(
                `dir=${trial.direction}|vol=${volFilter}|ema1h=${ema1hAlign}|ema4h=${ema4hAlign}`,
                { direction: trial.direction, vol_filter: volFilter, ema_1h_align: ema1hAlign, ema_4h_align: ema4hAlign },
                isWin, priceMove
            );
        }
    }

    const upsert = db.prepare(`
        INSERT INTO pattern_statistics
            (stat_key, direction, level_type, vol_filter, ema_1h_align, ema_4h_align, trigger_type,
             sample_count, win_count_30m, win_rate_30m, avg_move_pct, confidence, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stat_key) DO UPDATE SET
            sample_count = excluded.sample_count,
            win_count_30m = excluded.win_count_30m,
            win_rate_30m = excluded.win_rate_30m,
            avg_move_pct = excluded.avg_move_pct,
            confidence = excluded.confidence,
            last_updated = excluded.last_updated
    `);

    const insertMany = db.transaction(() => {
        let written = 0;
        for (const [key, g] of Object.entries(groups)) {
            const winRate = g.count > 0 ? Math.round((g.wins / g.count) * 1000) / 10 : 0;
            const avgMove = g.count > 0 ? Math.round((g.totalMove / g.count) * 100) / 100 : 0;
            const confidence = g.count >= 50 ? 'HIGH' : g.count >= 20 ? 'MEDIUM' : 'LOW';
            const m = g.meta;

            upsert.run(
                key,
                m.direction || null,
                m.level_type || null,
                m.vol_filter ?? null,
                m.ema_1h_align ?? null,
                m.ema_4h_align ?? null,
                m.trigger_type || null,
                g.count, g.wins, winRate, avgMove,
                confidence, new Date().toISOString()
            );
            written++;
        }
        return written;
    });

    const written = insertMany();
    console.log(`📊 [Stats] Rebuilt pattern_statistics: ${written} entries from ${trials.length} resolved trials`);
    return written;
}

function getStats(filters = {}) {
    let where = '1=1';
    const params = [];

    if (filters.direction) { where += ' AND direction = ?'; params.push(filters.direction); }
    if (filters.vol_filter != null) { where += ' AND vol_filter = ?'; params.push(filters.vol_filter); }
    if (filters.ema_1h_align != null) { where += ' AND ema_1h_align = ?'; params.push(filters.ema_1h_align); }
    if (filters.ema_4h_align != null) { where += ' AND ema_4h_align = ?'; params.push(filters.ema_4h_align); }

    return db.prepare(`
        SELECT * FROM pattern_statistics WHERE ${where}
        ORDER BY sample_count DESC LIMIT 50
    `).all(...params);
}

module.exports = { rebuildStatistics, getStats };
