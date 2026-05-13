const db = require('./database');
const path = require('path');
const RSIEngine = require(path.join(__dirname, '../server/services/RSIEngine'));

// ─────────────────────────────────────────────────────────────────────────────
// HELPER
// ─────────────────────────────────────────────────────────────────────────────
const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

// ─────────────────────────────────────────────────────────────────────────────
// STREAM D HELPER — normalise the long TradingView column names into a clean obj
//
// IMPORTANT DATA-SOURCE RULES (matches client-side authority):
//   RSI values    → coin_metric_history ONLY (Stream D rolling history).
//                   stream_d_state in master_coin_store has the raw TV fields, but
//                   coin_metric_history is the deduped/bucketed source of truth.
//                   Use get_coin_metrics tool for RSI queries, not this helper.
//   EMA 200       → same: coin_metric_history dist_m1 … dist_h4 for % distances.
//                   This helper exposes raw EMA price values (for cascade direction),
//                   NOT distance %. Use get_coin_metrics for pre-computed distances.
//   change_24h_pct here = rolling 24h window (CMC-style).
//                   TODAY's session change% comes ONLY from stream_c_state.today_change_pct
//                   (Stream C per-coin). These two NEVER match except at midnight UTC.
//   today_volume  → stream_c_state.today_volume ONLY.
// ─────────────────────────────────────────────────────────────────────────────
function normaliseStreamD(raw, ticker, timestamp) {
    if (!raw) return null;
    const d = typeof raw === 'string' ? parseJson(raw) : raw;
    if (!d) return null;
    const price = d.price ?? d.close;
    const ema1   = d.ema_200Timeresolution1;
    const ema5   = d.ema_200Timeresolution5;
    const ema15  = d.ema_200Timeresolution15;
    const ema60  = d.ema_200Timeresolution60;
    const ema240 = d.ema_200Timeresolution240;
    const pctDist = (ema) => (price && ema) ? +((price - ema) / ema * 100).toFixed(3) : null;
    // RVOL: TV uses multiple key variants — try them all
    const rvol = (n) =>
        d[`relative_volume_at_time_Timeresolution${n}`] ??
        d[`relativevolume_liveTimeresolution${n}`] ??
        d[`relativeattime_14Timeresolution${n}`] ??
        d[`relativevolumecexTimeresolution${n}`] ?? null;
    return {
        as_of: timestamp,
        price,
        // 24h rolling window (NOT session change% — see note above)
        change_24h_pct:        d.changecryptoInterval24h,
        volume_24h:            d.volume24hInterval24h,
        volume_change_24h_pct: d.volume24hchangeInterval24h,
        // RSI 14 across all 4 TFs stored in coin_metric_history
        // NOTE: prefer get_coin_metrics for RSI queries — this is the raw TV push value
        rsi: {
            m5:  d.relativestrengthindex_14Timeresolution5  ?? null,
            m15: d.relativestrengthindex_14Timeresolution15 ?? null,
            m30: d.relativestrengthindex_14Timeresolution30 ?? null,
            h1:  d.relativestrengthindex_14Timeresolution60 ?? null,
        },
        // EMA 200 actual price values (for cascade direction stacking)
        ema_200: { m1: ema1, m5: ema5, m15: ema15, h1: ema60, h4: ema240 },
        // % distance price to EMA200 (positive = price above EMA)
        ema_dist_pct: {
            m1:  pctDist(ema1),
            m5:  pctDist(ema5),
            m15: pctDist(ema15),
            h1:  pctDist(ema60),
            h4:  pctDist(ema240),
        },
        // EMA cascade alignment (stacking, not price-vs-EMA)
        ema_alignment: {
            above_m1:  price > ema1,
            above_m5:  price > ema5,
            above_m15: price > ema15,
            above_h1:  price > ema60,
            above_h4:  price > ema240,
            // Bull cascade: shorter TF EMA > longer TF EMA (they react faster to rising price)
            cascade_bullish_short:  ema1 > ema5 && ema5 > ema15,          // m1>m5>m15
            cascade_bullish_long:   ema15 > ema60 && ema60 > ema240,      // m15>h1>h4
            cascade_bearish_short:  ema1 < ema5 && ema5 < ema15,
            cascade_bearish_long:   ema15 < ema60 && ema60 < ema240,
        },
        // Relative volume (multiple TF key variants tried)
        relative_volume: {
            m15: rvol(15),
            h1:  rvol(60),
        },
        // ATR %
        atr_pct: {
            m15: d.averagetruerangepercent_14Timeresolution15  ?? null,
            h1:  d.averagetruerangepercent_14Timeresolution60  ?? null,
            h4:  d.averagetruerangepercent_14Timeresolution240 ?? null,
        },
        volatility_1d: d.volatilityInterval1d,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 1 — get_market_sentiment  (ENHANCED)
// ─────────────────────────────────────────────────────────────────────────────
async function getMarketSentiment() {
    // Pull last 10 ticks from the dedicated sentiment log (updated every scan cycle)
    const history = db.prepare(`
        SELECT timestamp, raw_mood_score, raw_label, raw_bullish, raw_bearish
        FROM raw_market_sentiment_log
        ORDER BY timestamp DESC LIMIT 10
    `).all();

    const latest = history[0];

    // Compute trend by comparing newest vs 3 ticks ago (~6 min ago)
    let trend = 'INSUFFICIENT_DATA';
    if (history.length >= 4) {
        const delta = (history[0].raw_mood_score ?? 0) - (history[3].raw_mood_score ?? 0);
        trend = delta > 5 ? 'IMPROVING' : delta < -5 ? 'DETERIORATING' : 'STABLE';
    }

    // Fallback: also read from latest scan_results blob if log empty
    let scanSentiment = null;
    if (!latest) {
        const row = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
        if (row) scanSentiment = parseJson(row.raw_data)?.market_sentiment || null;
    }

    return {
        current: {
            label:         latest?.raw_label    ?? scanSentiment?.label ?? 'UNKNOWN',
            score:         latest?.raw_mood_score ?? scanSentiment?.score ?? 0,
            bullish_count: latest?.raw_bullish  ?? 0,
            bearish_count: latest?.raw_bearish  ?? 0,
            as_of:         latest?.timestamp,
            trend_vs_prev_4_snapshots: trend,
        },
        recent_10_snapshots: history,
        fallback_scan_sentiment: scanSentiment,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 2 — get_master_watchlist
// ─────────────────────────────────────────────────────────────────────────────
async function getMasterWatchlist() {
    const now = Date.now();
    const activeList = [];
    const graduates = new Set();

    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const picks = db.prepare(`
        SELECT ticker, type FROM area1_scout_logs WHERE timestamp > ?
    `).all(twoHoursAgo);

    picks.forEach(p => {
        if (p.type === 'STABLE' || p.type === 'ORPHANED_STABLE_RETRY') graduates.add(p.ticker);
        else activeList.push(p.ticker);
    });

    return {
        recent_activity_count: picks.length,
        graduates: Array.from(graduates),
        in_pipeline: [...new Set(activeList)],
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 3 — get_top_catalysts
// ─────────────────────────────────────────────────────────────────────────────
async function getTopCatalysts() {
    const row = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    if (!row) return { error: "No market data available" };

    try {
        const payload = parseJson(row.raw_data);
        const results = payload?.results || [];
        const breakouts      = results.filter(r => r.data?.breakout === 1).map(r => r.ticker);
        const momentumSpikes = results.filter(r => r.data?.momScore >= 2 && r.data?.volSpike === 1).map(r => r.ticker);
        return { breakouts, momentumSpikes };
    } catch(e) {
        return { error: "Failed to parse market data" };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 4 — get_institutional_pulse
// ─────────────────────────────────────────────────────────────────────────────
async function getInstitutionalPulse() {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return db.prepare(`
        SELECT ticker, COUNT(*) as pulse_count, MAX(bar_move_pct) as max_move
        FROM institutional_interest_events
        WHERE timestamp > ?
        GROUP BY ticker ORDER BY pulse_count DESC LIMIT 10
    `).all(last24h);
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 5 — analyze_target  (ENHANCED: +Stream D matrix, +active trial, +volume events)
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeTarget(ticker) {
    if (!ticker) return { error: "Ticker string required (e.g. BTCUSDT.P)" };
    const cleanTicker = ticker.replace('BINANCE:', '');

    // 1. Current scan data (26-column macro)
    const scanRow = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    let currentData = null;
    if (scanRow) {
        const results = parseJson(scanRow.raw_data)?.results || [];
        currentData = results.find(r =>
            r.ticker === cleanTicker ||
            r.datakey === ticker ||
            r.datakey === `BINANCE:${cleanTicker}`
        );
    }

    // 2. Smart levels from last 24h
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const levelRow = db.prepare(`
        SELECT raw_data FROM smart_level_events
        WHERE ticker = ? AND timestamp > ?
        ORDER BY timestamp DESC LIMIT 1
    `).get(cleanTicker, last24h);
    const smartLevels = parseJson(levelRow?.raw_data)?.smart_levels || null;

    // 3. Stream D EMA cascade matrix
    const dRow = db.prepare(`
        SELECT timestamp, stream_d_state FROM master_coin_store
        WHERE ticker = ? AND stream_d_state IS NOT NULL
        ORDER BY timestamp DESC LIMIT 1
    `).get(cleanTicker);
    const streamDMatrix = dRow ? normaliseStreamD(dRow.stream_d_state, cleanTicker, dRow.timestamp) : null;

    // 4. Active 3rd Umpire Validator trial
    const activeTrial = db.prepare(`
        SELECT trial_id, direction, trigger_type, level_type, state, verdict,
               trigger_price, level_price, detected_at, latest_move, failure_reason
        FROM validation_trials
        WHERE ticker = ? AND state IN ('WATCHING','EARLY_FAVORABLE','CONFIRMED')
        ORDER BY detected_at DESC LIMIT 1
    `).get(cleanTicker);

    // 5. Recent volume events (12h)
    const last12h = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const volumeEvents = db.prepare(`
        SELECT ts, source, strength, meta FROM volume_events
        WHERE ticker = ? AND ts > ?
        ORDER BY ts DESC LIMIT 10
    `).all(cleanTicker, last12h).map(r => ({ ...r, meta: parseJson(r.meta) }));

    // 6. Nearest speedbreakers (price vs smart levels)
    let speedbreakers = null;
    const price = streamDMatrix?.price ?? currentData?.data?.price;
    const levels = smartLevels ?? currentData?.data?.smart_levels;
    if (price && levels) {
        try { speedbreakers = RSIEngine.generateSpeedbreakers(price, levels).slice(0, 6); } catch(e) {}
    }

    return {
        ticker: cleanTicker,
        current_scan_status: currentData?.data ?? 'Not in active top scan window',
        stream_d_matrix:     streamDMatrix     ?? 'No Stream D data (push not yet received)',
        nearest_smart_levels: speedbreakers    ?? 'No speedbreakers computed (no price+levels data)',
        active_validator_trial: activeTrial    ?? 'No active trial',
        recent_volume_events_12h: volumeEvents,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 6 — query_technical_filters
//
// RSI AUTHORITY NOTE: RSI values come from coin_metric_history (Stream D rolling
// history), NOT from unified_alerts.raw_data.rsi_matrix (Stream C payload).
// Stream C rsi_matrix is WRONG for RSI — it reflects the alert-trigger snapshot
// and is not kept up to date. coin_metric_history is updated every ~2 min from
// TradingView direct push and is the single source of truth for RSI m5/m15/m30/h1.
// ─────────────────────────────────────────────────────────────────────────────
async function queryTechnicalFilters(filters) {
    const scanRow = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    let scanResultsMap = {};
    if (scanRow) {
        const d = parseJson(scanRow.raw_data);
        if (d?.results) d.results.forEach(r => { scanResultsMap[r.ticker] = r.data || r; });
    }

    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
        SELECT ticker, raw_data FROM unified_alerts
        WHERE timestamp > ?
        GROUP BY ticker HAVING MAX(timestamp)
    `).all(last24h);

    // Pre-load latest RSI from coin_metric_history (Stream D — authoritative source)
    // This replaces the broken Stream C rsi_matrix lookups.
    const TF_COL = { m5: 'rsi_m5', m15: 'rsi_m15', m30: 'rsi_m30', h1: 'rsi_h1' };
    const cmhSince = Date.now() - 30 * 60 * 1000; // last 30 min
    const cmhRows = db.prepare(`
        WITH ranked AS (
            SELECT ticker, rsi_m5, rsi_m15, rsi_m30, rsi_h1,
                   ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) AS rn
            FROM coin_metric_history WHERE ts > ?
        )
        SELECT ticker, rsi_m5, rsi_m15, rsi_m30, rsi_h1 FROM ranked WHERE rn = 1
    `).all(cmhSince);
    const cmhMap = new Map(cmhRows.map(r => [r.ticker, r]));

    let matchedCoins = [];

    rows.forEach(row => {
        try {
            const data = parseJson(row.raw_data);
            let match = true;

            // RSI filter — source: coin_metric_history (Stream D ONLY)
            // coin_metric_history may be empty for new coins until first 2-min bucket arrives.
            if (filters.rsi?.timeframe && filters.rsi?.value !== undefined) {
                const col = TF_COL[filters.rsi.timeframe];
                if (!col) { match = false; }
                else {
                    const cmh = cmhMap.get(row.ticker);
                    const rsiVal = cmh?.[col] ?? null;
                    if (rsiVal == null) { match = false; }  // no Stream D data yet — skip coin
                    else {
                        const r = parseFloat(rsiVal);
                        if (filters.rsi.operator === '>' && r <= filters.rsi.value) match = false;
                        if (filters.rsi.operator === '<' && r >= filters.rsi.value) match = false;
                    }
                }
            }

            // EMA 200 filter
            if (match && filters.ema200?.timeframe && filters.ema200?.operator) {
                const rawEma = data.smart_levels?.emas_200?.[filters.ema200.timeframe];
                let emaVal = rawEma ? (rawEma.p ? parseFloat(rawEma.p) : parseFloat(rawEma)) : null;
                if (!emaVal && filters.ema200.timeframe === 'm5') {
                    const fb = data.smart_levels?.emas_200?.m15 ?? data.smart_levels?.emas_200?.h1;
                    if (fb) emaVal = fb.p ? parseFloat(fb.p) : parseFloat(fb);
                }
                const price = parseFloat(data.price || 0);
                if (!emaVal || price <= 0) { match = false; }
                else {
                    if (filters.ema200.operator === '>' && price <= emaVal) match = false;
                    if (filters.ema200.operator === '<' && price >= emaVal) match = false;
                }
            }

            // Volume filter
            if (match && filters.volume?.operator !== undefined) {
                const volVal = data.today_volume !== undefined
                    ? parseFloat(data.today_volume)
                    : parseFloat(data.volume?.day_vol ?? 'NaN');
                if (isNaN(volVal)) { match = false; }
                else {
                    if (filters.volume.operator === '>' && volVal <= filters.volume.value) match = false;
                    if (filters.volume.operator === '<' && volVal >= filters.volume.value) match = false;
                }
            }

            // Change % filter
            if (match && filters.change_pct?.operator !== undefined) {
                const chgVal = parseFloat(data.today_change_pct ?? 'NaN');
                if (isNaN(chgVal)) { match = false; }
                else {
                    if (filters.change_pct.operator === '>' && chgVal <= filters.change_pct.value) match = false;
                    if (filters.change_pct.operator === '<' && chgVal >= filters.change_pct.value) match = false;
                }
            }

            // Smart level proximity / confluence
            let matched_levels = [];
            if (match && filters.smart_level?.max_distance_pct !== undefined) {
                const breakers = RSIEngine.generateSpeedbreakers(data.price, data.smart_levels);
                const targetType = filters.smart_level.type || 'ANY';
                const minCount   = filters.smart_level.min_confluence || 1;
                for (const b of breakers) {
                    if ((targetType === 'ANY' || b.type === targetType) &&
                        Math.abs(b.distance_pct) <= filters.smart_level.max_distance_pct) {
                        matched_levels.push(b);
                    }
                }
                if (matched_levels.length < minCount) match = false;
            }

            // 26-column macro filter
            if (match && filters.macro_columns) {
                const macro_data = scanResultsMap[row.ticker];
                if (!macro_data) { match = false; }
                else {
                    for (const [key, rule] of Object.entries(filters.macro_columns)) {
                        const val = macro_data[key];
                        if (val === undefined) { match = false; break; }
                        if (typeof rule === 'object' && rule !== null) {
                            if (rule.operator === '>'  && val <= rule.value) { match = false; break; }
                            if (rule.operator === '<'  && val >= rule.value) { match = false; break; }
                            if (rule.operator === '==' && val !== rule.value) { match = false; break; }
                        } else if (val !== rule) { match = false; break; }
                    }
                }
            }

            if (match) {
                const allBreakers = RSIEngine.generateSpeedbreakers(data.price, data.smart_levels);
                const md = scanResultsMap[row.ticker];
                matchedCoins.push({
                    ticker:     row.ticker,
                    price:      data.price,
                    change_pct: data.today_change_pct,
                    volume:     data.today_volume ?? data.volume?.day_vol ?? null,
                    macro_context: md ? { score: md.score, breakout: md.breakout, volSpike: md.volSpike, momScore: md.momScore } : null,
                    rsi_matrix:           data.rsi_matrix,
                    smart_levels_matched: matched_levels.length > 0 ? matched_levels : null,
                    closest_levels:       allBreakers.slice(0, 3),
                });
            }
        } catch(e) {}
    });

    return {
        criteria_used:  filters,
        matched_count:  matchedCoins.length,
        coins:          matchedCoins,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 7 — get_database_schema  (ENHANCED: human-readable table descriptions)
// ─────────────────────────────────────────────────────────────────────────────
async function getDatabaseSchema() {
    const TABLE_DESCRIPTIONS = {
        scan_results:                 "Stream A — Raw TradingView 26-column macro scan results per cycle. raw_data is JSON {market_sentiment, results:[{ticker, data:{score,breakout,volSpike,momScore,...}}]}",
        scans:                        "Scan event registry — one row per scan cycle (id + timestamp + trigger source)",
        unified_alerts:               "Stream C normalised alerts — smart level touch events with strength score and direction (-1 BEAR / +1 BULL). WARNING: raw_data.rsi_matrix is Stream C data — do NOT use for RSI values. Use coin_metric_history instead.",
        smart_level_events:           "Raw Stream C ingestion — price interaction with smart levels (Mega Spot, EMA200 key TFs, Fib, Logic). raw_data has full smart_levels tree + trigger metadata",
        institutional_interest_events:"Stream A bar-anomaly detector — unusual bar-move events with bar_move_pct and today_volume",
        master_coin_store:            "V4 event-sourced ledger — every state change per coin across all 4 streams. stream_d_state is JSON EMA cascade matrix from TradingView direct push. trigger_source: STREAM_A|B|C|D. stream_c_state.today_change_pct = session change% (authoritative). stream_c_state.rsi_matrix = WRONG for RSI — use coin_metric_history.",
        coin_metric_history:          "*** PRIMARY SOURCE FOR RSI, RVOL, ATR, EMA-DISTANCE *** Rolling 8h history (2-min buckets, ~1200 rows max). Columns: ticker, ts (Unix ms), rsi_m5, rsi_m15, rsi_m30, rsi_h1, rvol_m15, rvol_h1, atr_m15, atr_h1, atr_h4, dist_m1, dist_m5, dist_m15, dist_h1, dist_h4. dist_* = (price - ema200) / ema200 * 100. Use get_coin_metrics tool to query this table.",
        volume_events:                "Unified volume event ledger — all volume spikes from every stream. source: STREAM_A_EDGE | STREAM_C_ALERT | STREAM_D_RVOL. strength: 1=normal, >1.5=strong spike. meta has price + direction",
        validation_trials:            "3rd Umpire Validator — each Stream C event spawns a trial. state machine: WATCHING→EARLY_FAVORABLE→CONFIRMED|FAILED. feature_snapshot is market context at detection",
        validation_state_log:         "Step-by-step rule evaluation log per trial. rule_snapshot shows pass/fail for each EMA cascade rule at every state transition",
        pattern_statistics:           "Pre-computed win rates by setup combination (direction × trigger_type × vol_filter × ema_align). win_rate_30m is primary edge metric",
        raw_market_sentiment_log:     "Timestamped Genie mood history — raw_mood_score (-100→+100) + label + breadth (bullish/bearish counts) per scan",
        coin_lifecycles:              "Coin maturity tracker — born_at (first seen), last_seen_at, death_at, status (ACTIVE|GHOST|DEAD)",
        ghost_approval_queue:         "Coins flagged for GHOST status pending manual approval. confidence_score + score_breakdown JSON",
        area1_scout_logs:             "Stream B scout activity — STABLE / ORPHANED_STABLE_RETRY / NEW coin state transitions in the watchlist pipeline",
        pulse_events:                 "High-level market pulse events (significant volume / alert combos)",
        market_context_logs:          "Stream B batch watchlist snapshot — payload_json.watchlist_active_snapshot[] has {short, price, change_pct, vol_raw}. change_pct here = session-based (midnight UTC reset). Use stream_c_state.today_change_pct for fresher per-coin data.",
        qualified_picks:              "Current active algo-qualified coin picks",
        qualified_picks_log:          "Historical log of all ever-qualified picks",
        system_settings:              "Key-value config store (telegram_enabled, auto_approve, etc.)",
        telegram_logs:                "Telegram delivery audit log",
    };

    const tables = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all();

    return tables.map(t => ({
        table:       t.name,
        description: TABLE_DESCRIPTIONS[t.name] ?? '(internal/undocumented table)',
        schema:      t.sql,
    }));
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 8 — run_readonly_sql_query
// ─────────────────────────────────────────────────────────────────────────────
async function runReadonlySqlQuery(query) {
    if (!query.trim().toUpperCase().startsWith('SELECT') && !query.trim().toUpperCase().startsWith('WITH')) {
        return { error: "Security Exception: Only SELECT statements are allowed via MCP." };
    }
    try {
        let safeQuery = query;
        if (!safeQuery.toUpperCase().includes('LIMIT')) safeQuery += ' LIMIT 100';
        const results = db.prepare(safeQuery).all();
        return { query_executed: safeQuery, returned_rows: results.length, data: results };
    } catch(err) {
        return { error: "SQL Execution Error: " + err.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 9 — get_volume_buildups
// ─────────────────────────────────────────────────────────────────────────────
async function getVolumeBuildup() {
    try {
        const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const rows = db.prepare(`
            SELECT sr.ticker, sr.score, sr.volSpike, sr.momScore, sr.breakout,
                   sr.price, sr.change_pct, sr.timestamp
            FROM scan_results sr
            INNER JOIN (
                SELECT ticker, MAX(timestamp) AS latest FROM scan_results WHERE timestamp > ? GROUP BY ticker
            ) latest ON sr.ticker = latest.ticker AND sr.timestamp = latest.latest
            WHERE sr.volSpike = 1
            ORDER BY sr.momScore DESC LIMIT 20
        `).all(cutoff);
        return {
            description: "Coins with active volume spike (volSpike=1) from latest scan — potential institutional accumulation",
            count: rows.length,
            coins: rows,
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 10 — get_validated_setups  (ENHANCED: inline latest rule_snapshot)
// ─────────────────────────────────────────────────────────────────────────────
async function getValidatedSetups(stateFilter) {
    try {
        const states = stateFilter && stateFilter !== 'ALL'
            ? [stateFilter]
            : ['WATCHING', 'EARLY_FAVORABLE', 'CONFIRMED'];

        const placeholders = states.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT trial_id, ticker, direction, trigger_type, level_type,
                   trigger_price, level_price, state, verdict,
                   detected_at, cooldown_until, watch_until,
                   latest_move, failure_reason, feature_snapshot, config_snapshot
            FROM validation_trials
            WHERE state IN (${placeholders})
            ORDER BY detected_at DESC LIMIT 30
        `).all(...states);

        // Attach the latest rule_snapshot from validation_state_log for each trial
        const enriched = rows.map(r => {
            const latestLog = db.prepare(`
                SELECT rule_snapshot, state, changed_at FROM validation_state_log
                WHERE trial_id = ? ORDER BY changed_at DESC LIMIT 1
            `).get(r.trial_id);

            return {
                ...r,
                feature_snapshot: parseJson(r.feature_snapshot),
                config_snapshot:  parseJson(r.config_snapshot),
                latest_rule_evaluation: latestLog ? {
                    evaluated_at: latestLog.changed_at,
                    state:        latestLog.state,
                    rules:        parseJson(latestLog.rule_snapshot),
                } : null,
            };
        });

        return {
            description: "Active 3rd Umpire Validator trials — EMA hierarchy validated setups",
            count: enriched.length,
            trials: enriched,
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 11 — get_upcoming_watchers
// ─────────────────────────────────────────────────────────────────────────────
async function getUpcomingWatchers() {
    try {
        const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const rows = db.prepare(`
            SELECT sr.ticker, sr.price, sr.timestamp, sr.smart_levels
            FROM scan_results sr
            INNER JOIN (
                SELECT ticker, MAX(timestamp) AS latest FROM scan_results WHERE timestamp > ? GROUP BY ticker
            ) latest ON sr.ticker = latest.ticker AND sr.timestamp = latest.latest
            WHERE sr.smart_levels IS NOT NULL
        `).all(cutoff);

        const results = [];
        for (const row of rows) {
            let sl; try { sl = JSON.parse(row.smart_levels); } catch { continue; }
            const price = row.price;
            if (!price) continue;

            const levels = [];
            if (sl.mega_spot?.p)           levels.push({ label: 'Mega Spot',  price: sl.mega_spot.p });
            if (sl.emas_200?.h4?.p)        levels.push({ label: '4H EMA200',  price: sl.emas_200.h4.p });
            if (sl.emas_200?.h1?.p)        levels.push({ label: '1H EMA200',  price: sl.emas_200.h1.p });
            if (sl.daily_logic?.base_res?.p)  levels.push({ label: 'Daily Res',  price: sl.daily_logic.base_res.p });
            if (sl.daily_logic?.base_supp?.p) levels.push({ label: 'Daily Supp', price: sl.daily_logic.base_supp.p });

            for (const lvl of levels) {
                const distPct = Math.abs((price - lvl.price) / lvl.price * 100);
                if (distPct <= 0.5) {
                    results.push({
                        ticker:            row.ticker,
                        current_price:     price,
                        level_label:       lvl.label,
                        level_price:       lvl.price,
                        distance_pct:      Math.round(distPct * 100) / 100,
                        expected_direction: price < lvl.price ? 'LONG' : 'SHORT',
                    });
                }
            }
        }

        results.sort((a, b) => a.distance_pct - b.distance_pct);
        return {
            description: "Tickers within 0.5% of a smart level — pre-alert positioning candidates",
            count: results.length,
            watchers: results.slice(0, 20),
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 12 — get_pattern_stats
// ─────────────────────────────────────────────────────────────────────────────
async function getPatternStats({ direction, trigger_type, min_samples = 3, min_win_rate = 0 } = {}) {
    try {
        let where = 'WHERE sample_count >= ?';
        const params = [min_samples];
        if (direction)    { where += ' AND direction = ?';      params.push(direction); }
        if (trigger_type) { where += ' AND trigger_type = ?';   params.push(trigger_type); }
        if (min_win_rate > 0) { where += ' AND win_rate_30m >= ?'; params.push(min_win_rate); }

        const rows = db.prepare(`
            SELECT stat_key, direction, trigger_type, vol_filter, ema_1h_align, ema_4h_align,
                   sample_count, win_rate_30m, avg_move_pct, confidence, last_updated
            FROM pattern_statistics
            ${where}
            ORDER BY sample_count DESC, win_rate_30m DESC LIMIT 30
        `).all(...params);

        return {
            description: "3rd Umpire Validator pre-computed win rates by setup combination",
            count: rows.length,
            filters_applied: { direction, trigger_type, min_samples, min_win_rate },
            stats: rows,
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 13 — get_trial_details
// ─────────────────────────────────────────────────────────────────────────────
async function getTrialDetails(trial_id) {
    if (!trial_id) return { error: "trial_id is required" };
    try {
        const trial = db.prepare('SELECT * FROM validation_trials WHERE trial_id = ?').get(trial_id);
        if (!trial) return { error: `Trial ${trial_id} not found` };

        trial.feature_snapshot  = parseJson(trial.feature_snapshot);
        trial.config_snapshot   = parseJson(trial.config_snapshot);
        trial.raw_trigger_blob  = parseJson(trial.raw_trigger_blob);

        const logs = db.prepare(
            'SELECT * FROM validation_state_log WHERE trial_id = ? ORDER BY changed_at ASC'
        ).all(trial_id).map(l => ({ ...l, rule_snapshot: parseJson(l.rule_snapshot) }));

        return { trial_summary: trial, state_transitions: logs };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 14 — get_coin_lifecycles
// ─────────────────────────────────────────────────────────────────────────────
async function getCoinLifecycles(status) {
    try {
        const rows = status && status !== 'ALL'
            ? db.prepare('SELECT * FROM coin_lifecycles WHERE status = ? ORDER BY born_at DESC LIMIT 50').all(status)
            : db.prepare('SELECT * FROM coin_lifecycles ORDER BY born_at DESC LIMIT 50').all();
        return { count: rows.length, lifecycles: rows };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 15 — get_ghost_approval_queue
// ─────────────────────────────────────────────────────────────────────────────
async function getGhostApprovalQueue() {
    try {
        const rows = db.prepare(
            'SELECT * FROM ghost_approval_queue WHERE is_approved = 0 ORDER BY queued_at DESC'
        ).all();
        return { count: rows.length, queue: rows };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 16 — query_master_coin_store
// ─────────────────────────────────────────────────────────────────────────────
async function queryMasterCoinStore(ticker, limit = 10) {
    if (!ticker) return { error: "Ticker string required (e.g. BTCUSDT.P)" };
    const cleanTicker = ticker.replace('BINANCE:', '');
    try {
        const rows = db.prepare(`
            SELECT timestamp, trigger_source, ingestion_source, price,
                   stream_a_state, stream_b_state, stream_c_state, stream_d_state, merged_state
            FROM master_coin_store WHERE ticker = ?
            ORDER BY timestamp DESC LIMIT ?
        `).all(cleanTicker, limit);

        return {
            description: "Historical event-sourced timeline from Master Coin Store (all 4 streams)",
            ticker: cleanTicker,
            snapshot_count: rows.length,
            timeline: rows.map(r => ({
                timestamp:       r.timestamp,
                trigger_source:  r.trigger_source,
                ingestion_source: r.ingestion_source,
                price:           r.price,
                stream_a:        parseJson(r.stream_a_state),
                stream_b:        parseJson(r.stream_b_state),
                stream_c:        parseJson(r.stream_c_state),
                stream_d:        r.stream_d_state ? normaliseStreamD(r.stream_d_state, cleanTicker, r.timestamp) : null,
                merged_context:  parseJson(r.merged_state),
            })),
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOL 17 — get_trial_full_context
// ─────────────────────────────────────────────────────────────────────────────
async function getTrialFullContext(trialId) {
    if (!trialId) return { error: "trial_id required (e.g. trial_BTCUSDT.P_1745580000000)" };
    try {
        const trial = db.prepare('SELECT * FROM validation_trials WHERE trial_id = ?').get(trialId);
        if (!trial) return { error: `Trial not found: ${trialId}` };

        trial.feature_snapshot = parseJson(trial.feature_snapshot);
        trial.config_snapshot  = parseJson(trial.config_snapshot);
        trial.raw_trigger_blob = parseJson(trial.raw_trigger_blob);

        const stateLog = db.prepare(`
            SELECT log_id, changed_at, state, rule_snapshot, current_price, unrealized_move_pct
            FROM validation_state_log WHERE trial_id = ? ORDER BY changed_at ASC
        `).all(trialId).map(r => ({ ...r, rule_snapshot: parseJson(r.rule_snapshot) }));

        const triggerSnap = db.prepare(`
            SELECT timestamp, price, ingestion_source, merged_state
            FROM master_coin_store WHERE ticker = ? AND timestamp <= ?
            ORDER BY timestamp DESC LIMIT 1
        `).get(trial.ticker, trial.detected_at);

        const triggerContext = triggerSnap ? {
            snapshot_at:      triggerSnap.timestamp,
            snapshot_price:   triggerSnap.price,
            ingestion_source: triggerSnap.ingestion_source,
            ...parseJson(triggerSnap.merged_state),
        } : null;

        const startISO = new Date(new Date(trial.detected_at).getTime() - 30 * 60 * 1000).toISOString();
        const endISO   = trial.resolved_at
            ? new Date(new Date(trial.resolved_at).getTime() + 30 * 60 * 1000).toISOString()
            : new Date().toISOString();

        const timeline = db.prepare(`
            SELECT timestamp, trigger_source, ingestion_source, price, merged_state
            FROM master_coin_store WHERE ticker = ? AND timestamp BETWEEN ? AND ?
            ORDER BY timestamp ASC
        `).all(trial.ticker, startISO, endISO).map(r => {
            const m = parseJson(r.merged_state);
            return {
                timestamp:        r.timestamp,
                trigger_source:   r.trigger_source,
                ingestion_source: r.ingestion_source,
                price:            r.price,
                stream_a: m?.stream_a ?? null,
                stream_b: m?.stream_b ?? null,
                stream_c: m?.stream_c ?? null,
            };
        });

        return {
            description:     "Complete forensic dossier for a single validation trial",
            trial,
            state_transitions: stateLog,
            trigger_context:  triggerContext,
            master_timeline:  timeline,
            window:           { from: startISO, to: endISO },
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW TOOL 18 — get_stream_d_matrix
// Returns the real-time multi-timeframe EMA + RSI matrix from Stream D
// (TradingView direct push every ~2 min). Useful for EMA cascade alignment queries.
// ─────────────────────────────────────────────────────────────────────────────
async function getStreamDMatrix(ticker) {
    try {
        if (ticker) {
            const cleanTicker = ticker.replace('BINANCE:', '');
            const row = db.prepare(`
                SELECT ticker, timestamp, stream_d_state FROM master_coin_store
                WHERE ticker = ? AND stream_d_state IS NOT NULL
                ORDER BY timestamp DESC LIMIT 1
            `).get(cleanTicker);
            if (!row) return { error: `No Stream D data found for ${cleanTicker}` };
            return {
                description: "Single-ticker Stream D EMA cascade + RSI matrix (latest push)",
                ...normaliseStreamD(row.stream_d_state, row.ticker, row.timestamp),
                ticker: row.ticker,
            };
        }

        // All tickers — return compact summary table
        const rows = db.prepare(`
            SELECT m.ticker, m.timestamp, m.stream_d_state
            FROM master_coin_store m
            INNER JOIN (
                SELECT ticker, MAX(timestamp) AS latest FROM master_coin_store
                WHERE stream_d_state IS NOT NULL GROUP BY ticker
            ) latest ON m.ticker = latest.ticker AND m.timestamp = latest.latest
            ORDER BY m.ticker
        `).all();

        return {
            description: "Latest Stream D EMA cascade matrix for all tickers (2-min push cadence). NOTE: for RSI queries prefer get_coin_metrics which reads from the authoritative coin_metric_history table.",
            count: rows.length,
            tickers: rows.map(r => {
                const nd = normaliseStreamD(r.stream_d_state, r.ticker, r.timestamp);
                if (!nd) return { ticker: r.ticker, error: 'parse_failed' };
                return {
                    ticker:                 r.ticker,
                    as_of:                  nd.as_of,
                    price:                  nd.price,
                    change_24h_pct:         nd.change_24h_pct,   // rolling 24h — NOT session change%
                    rsi_m5:                 nd.rsi.m5,
                    rsi_m15:                nd.rsi.m15,
                    rsi_m30:                nd.rsi.m30,
                    rsi_h1:                 nd.rsi.h1,
                    ema200_m1:              nd.ema_200.m1,
                    ema200_m5:              nd.ema_200.m5,
                    ema200_m15:             nd.ema_200.m15,
                    ema200_h1:              nd.ema_200.h1,
                    ema200_h4:              nd.ema_200.h4,
                    dist_pct_m5:            nd.ema_dist_pct.m5,
                    dist_pct_m15:           nd.ema_dist_pct.m15,
                    dist_pct_h1:            nd.ema_dist_pct.h1,
                    dist_pct_h4:            nd.ema_dist_pct.h4,
                    cascade_bull_short:     nd.ema_alignment.cascade_bullish_short,
                    cascade_bear_short:     nd.ema_alignment.cascade_bearish_short,
                    cascade_bull_long:      nd.ema_alignment.cascade_bullish_long,
                    cascade_bear_long:      nd.ema_alignment.cascade_bearish_long,
                    rvol_m15:               nd.relative_volume.m15,
                    rvol_h1:                nd.relative_volume.h1,
                    atr_pct_m15:            nd.atr_pct.m15,
                    atr_pct_h1:             nd.atr_pct.h1,
                    atr_pct_h4:             nd.atr_pct.h4,
                };
            }),
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW TOOL 19 — get_volume_events
// Queries the unified volume_events ledger with flexible filters
// ─────────────────────────────────────────────────────────────────────────────
async function getVolumeEvents({ ticker, source, min_strength, hours = 24 } = {}) {
    try {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        let where = 'WHERE ts > ?';
        const params = [cutoff];
        if (ticker)       { where += ' AND ticker = ?';    params.push(ticker.replace('BINANCE:', '')); }
        if (source)       { where += ' AND source = ?';    params.push(source); }
        if (min_strength) { where += ' AND strength >= ?'; params.push(min_strength); }

        const rows = db.prepare(`
            SELECT id, ticker, ts, source, strength, meta
            FROM volume_events ${where}
            ORDER BY ts DESC LIMIT 50
        `).all(...params);

        return {
            description: "Volume events from all streams (STREAM_A_EDGE, STREAM_C_ALERT). strength ≥ 1.5 = strong spike.",
            filters: { ticker, source, min_strength, hours },
            count: rows.length,
            events: rows.map(r => ({ ...r, meta: parseJson(r.meta) })),
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW TOOL 20 — get_market_regime
// Synthesises mood trend, breadth, stream activity, and validator state into
// a structured regime assessment with interpretation for the AI.
// ─────────────────────────────────────────────────────────────────────────────
async function getMarketRegime() {
    try {
        const sentimentHistory = db.prepare(`
            SELECT timestamp, raw_mood_score, raw_label, raw_bullish, raw_bearish
            FROM raw_market_sentiment_log ORDER BY timestamp DESC LIMIT 10
        `).all();

        const cutoff2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        const streamActivity = db.prepare(`
            SELECT source, COUNT(*) as count, ROUND(AVG(strength), 2) as avg_strength
            FROM volume_events WHERE ts > ?
            GROUP BY source ORDER BY count DESC
        `).all(cutoff2h);

        const activeTrials = db.prepare(`
            SELECT state, direction, COUNT(*) as count
            FROM validation_trials
            WHERE state IN ('WATCHING','EARLY_FAVORABLE','CONFIRMED')
            GROUP BY state, direction ORDER BY state, direction
        `).all();

        const latest = sentimentHistory[0];
        let trend = 'INSUFFICIENT_DATA';
        if (sentimentHistory.length >= 4) {
            const delta = (sentimentHistory[0].raw_mood_score ?? 0) - (sentimentHistory[3].raw_mood_score ?? 0);
            trend = delta > 5 ? 'IMPROVING' : delta < -5 ? 'DETERIORATING' : 'STABLE';
        }

        const score = latest?.raw_mood_score ?? 0;
        const interpretation = (() => {
            if (score >= 30)  return 'BULL REGIME — Momentum favors longs. Prefer BREAKOUT + vol_spike entries at pullbacks.';
            if (score >= 10)  return 'MILD BULL — Long bias but selective. Prefer strong confluence zones.';
            if (score <= -30) return 'BEAR REGIME — Momentum favors shorts. Avoid longs, watch for bull trap bounces.';
            if (score <= -10) return 'MILD BEAR — Cautious bias. Favor range-bound plays or wait for reversal confirmation.';
            return 'RANGING — Low conviction. Smart Level reactions carry higher edge than trend plays.';
        })();

        return {
            current_regime: {
                label:                latest?.raw_label ?? 'UNKNOWN',
                score,
                as_of:                latest?.timestamp,
                trend_vs_prev_4_ticks: trend,
            },
            breadth: {
                bullish: latest?.raw_bullish ?? 0,
                bearish: latest?.raw_bearish ?? 0,
            },
            sentiment_last_10_ticks: sentimentHistory,
            stream_activity_last_2h: streamActivity,
            active_validator_summary: activeTrials,
            ai_interpretation: interpretation,
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW TOOL 21 — get_smart_level_reactions
// Queries smart_level_events with ticker/direction/time filters
// ─────────────────────────────────────────────────────────────────────────────
async function getSmartLevelReactions({ ticker, direction, hours = 24, limit = 20 } = {}) {
    try {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
        let where = 'WHERE timestamp > ?';
        const params = [cutoff];
        if (ticker)    { where += ' AND ticker = ?';    params.push(ticker.replace('BINANCE:', '')); }
        if (direction !== undefined && direction !== null) {
            where += ' AND direction = ?';
            // Accept "BULL"/1/true or "BEAR"/-1/false
            const dirVal = (direction === 'BULL' || direction === 1 || direction === true) ? 1 : -1;
            params.push(dirVal);
        }

        const rows = db.prepare(`
            SELECT id, ticker, timestamp, price, direction, roc_pct, raw_data, ingestion_source
            FROM smart_level_events ${where}
            ORDER BY timestamp DESC LIMIT ?
        `).all(...params, limit);

        return {
            description: "Smart Level reaction events — price touching or crossing a key level",
            filters: { ticker, direction, hours },
            count: rows.length,
            reactions: rows.map(r => {
                const raw = parseJson(r.raw_data);
                return {
                    id:         r.id,
                    ticker:     r.ticker,
                    timestamp:  r.timestamp,
                    price:      r.price,
                    direction:  r.direction === 1 ? 'BULL' : r.direction === -1 ? 'BEAR' : 'NEUTRAL',
                    roc_pct:    r.roc_pct,
                    source:     r.ingestion_source,
                    level_type: raw?.level_type ?? null,
                    trigger_label: raw?.trigger_label ?? null,
                };
            }),
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW TOOL 22 — get_stream_health
// Derives the liveness of each data stream from DB ingestion timestamps
// ─────────────────────────────────────────────────────────────────────────────
async function getStreamHealth() {
    try {
        const getAge = (isoString) => {
            if (!isoString) return { last_seen: null, age_minutes: null, status: 'NO_DATA' };
            const mins = (Date.now() - new Date(isoString).getTime()) / 60000;
            return {
                last_seen:   isoString,
                age_minutes: Math.round(mins * 10) / 10,
                status:      mins < 5 ? 'LIVE' : mins < 30 ? 'FRESH' : mins < 120 ? 'STALE' : 'DEAD',
            };
        };

        const streamA = db.prepare(
            "SELECT MAX(timestamp) as ts FROM master_coin_store WHERE ingestion_source = 'SCAN_A'"
        ).get();
        const streamB = db.prepare(
            "SELECT MAX(timestamp) as ts FROM master_coin_store WHERE ingestion_source = 'SCOUT_B'"
        ).get();
        const streamC = db.prepare(
            "SELECT MAX(timestamp) as ts FROM master_coin_store WHERE ingestion_source = 'WEBHOOK' OR ingestion_source LIKE '%C%'"
        ).get();
        const streamD = db.prepare(
            "SELECT MAX(timestamp) as ts FROM master_coin_store WHERE ingestion_source = 'WATCHLIST_TECHNICALS'"
        ).get();

        // Also derive from volume_events for cross-check
        const volLatest = db.prepare(
            "SELECT source, MAX(ts) as ts FROM volume_events GROUP BY source"
        ).all();

        return {
            description: "Liveness of each data stream derived from DB ingestion timestamps",
            streams: {
                A_MACRO:    getAge(streamA?.ts),
                B_SCOUT:    getAge(streamB?.ts),
                C_ALERT:    getAge(streamC?.ts),
                D_REALTIME: getAge(streamD?.ts),
            },
            volume_event_sources: volLatest.map(r => ({ source: r.source, ...getAge(r.ts) })),
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW TOOL 23 — get_coin_metrics
//
// Queries coin_metric_history — the AUTHORITATIVE source for:
//   RSI (m5, m15, m30, h1)       ← Stream D rolling history, 2-min buckets
//   RVOL (m15, h1)               ← Relative Volume
//   ATR% (m15, h1, h4)           ← Average True Range %
//   EMA200 distance% (m1–h4)     ← (price - ema200) / ema200 × 100
//
// NEVER use unified_alerts.rsi_matrix or stream_c_state.rsi_matrix for RSI.
// Those are Stream C snapshot values captured at alert time — not kept current.
//
// Params:
//   ticker  (optional) — single ticker, e.g. "BTCUSDT.P". Omit for all.
//   hours   (default 0.5) — lookback window in hours (max 8 — table prunes beyond that)
//   latest_only (default true) — when true, returns only the most recent bucket per ticker
// ─────────────────────────────────────────────────────────────────────────────
async function getCoinMetrics({ ticker, hours = 0.5, latest_only = true } = {}) {
    try {
        const cutoffTs = Date.now() - Math.min(8, hours) * 60 * 60 * 1000;
        const cleanTicker = ticker ? ticker.replace('BINANCE:', '') : null;

        if (latest_only) {
            // Efficient: one row per ticker using window function
            let sql = `
                WITH ranked AS (
                    SELECT ticker, ts, rsi_m5, rsi_m15, rsi_m30, rsi_h1,
                           rvol_m15, rvol_h1, atr_m15, atr_h1, atr_h4,
                           dist_m1, dist_m5, dist_m15, dist_h1, dist_h4,
                           ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) AS rn
                    FROM coin_metric_history WHERE ts > ?
                    ${cleanTicker ? 'AND ticker = ?' : ''}
                )
                SELECT * FROM ranked WHERE rn = 1 ORDER BY ticker
            `;
            const params = cleanTicker ? [cutoffTs, cleanTicker] : [cutoffTs];
            const rows = db.prepare(sql).all(...params);

            const enriched = rows.map(r => ({
                ticker:   r.ticker,
                as_of_ms: r.ts,
                rsi:      { m5: r.rsi_m5, m15: r.rsi_m15, m30: r.rsi_m30, h1: r.rsi_h1 },
                rsi_cascade: (() => {
                    const { rsi_m15, rsi_m30, rsi_h1 } = r;
                    if (rsi_m15 < 30 && rsi_h1 < 40)    return 'MULTI_TF_OVERSOLD';
                    if (rsi_m15 > 70 && rsi_h1 > 60)    return 'MULTI_TF_OVERBOUGHT';
                    if (rsi_h1 < 30 && rsi_m30 < 30)    return 'BEAR_RSI_CASCADE';
                    if (rsi_h1 > 70 && rsi_m30 > 70)    return 'BULL_RSI_CASCADE';
                    if (rsi_m15 != null && rsi_m15 < 30) return 'OVERSOLD_15M';
                    if (rsi_m15 != null && rsi_m15 > 70) return 'OVERBOUGHT_15M';
                    return 'NEUTRAL';
                })(),
                rvol:     { m15: r.rvol_m15, h1: r.rvol_h1 },
                atr_pct:  { m15: r.atr_m15,  h1: r.atr_h1, h4: r.atr_h4 },
                ema_dist_pct: {
                    m1: r.dist_m1, m5: r.dist_m5, m15: r.dist_m15,
                    h1: r.dist_h1, h4: r.dist_h4,
                    // dist positive = price above EMA200 (bullish); negative = below (bearish)
                },
            }));

            return {
                description: "Latest RSI / RVOL / ATR / EMA-distance from coin_metric_history (Stream D, 2-min buckets). This is the AUTHORITATIVE source — do not use stream_c_state.rsi_matrix.",
                as_of_window_hours: hours,
                count: enriched.length,
                coins: cleanTicker ? (enriched[0] ?? { error: `No data for ${cleanTicker}` }) : enriched,
            };
        }

        // Time-series mode — return all buckets within window for one ticker
        if (!cleanTicker) return { error: "ticker is required when latest_only=false" };
        const series = db.prepare(`
            SELECT ts, rsi_m5, rsi_m15, rsi_m30, rsi_h1,
                   rvol_m15, rvol_h1, atr_m15, atr_h1, atr_h4,
                   dist_m15, dist_h1
            FROM coin_metric_history
            WHERE ticker = ? AND ts > ?
            ORDER BY ts ASC
        `).all(cleanTicker, cutoffTs);

        return {
            description: `Time-series RSI/RVOL/ATR history for ${cleanTicker} (last ${hours}h, 2-min buckets)`,
            ticker: cleanTicker,
            bucket_count: series.length,
            series,
        };
    } catch(e) { return { error: e.message }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
    getMarketSentiment,
    getMasterWatchlist,
    getTopCatalysts,
    getInstitutionalPulse,
    analyzeTarget,
    queryTechnicalFilters,
    getDatabaseSchema,
    runReadonlySqlQuery,
    getVolumeBuildup,
    getValidatedSetups,
    getUpcomingWatchers,
    getPatternStats,
    getTrialDetails,
    getCoinLifecycles,
    getGhostApprovalQueue,
    queryMasterCoinStore,
    getTrialFullContext,
    // NEW v2
    getStreamDMatrix,
    getVolumeEvents,
    getMarketRegime,
    getSmartLevelReactions,
    getStreamHealth,
    // NEW v3
    getCoinMetrics,
};
