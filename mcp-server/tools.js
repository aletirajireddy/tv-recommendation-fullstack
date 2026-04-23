const db = require('./database');
const path = require('path');
const RSIEngine = require(path.join(__dirname, '../server/services/RSIEngine'));

async function getMarketSentiment() {
    const latestScan = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    if (!latestScan) return { error: "No market data available" };
    
    try {
        const payload = JSON.parse(latestScan.raw_data);
        return payload.market_sentiment || { error: "Market sentiment not found in latest scan" };
    } catch(e) {
        return { error: "Failed to parse sentiment data" };
    }
}

async function getMasterWatchlist() {
    const now = Date.now();
    const activeList = [];
    const graduates = new Set();
    
    // Simplistic extraction of current active list from Area1 logs
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    const picks = db.prepare(`
        SELECT ticker, type FROM area1_scout_logs 
        WHERE timestamp > ? 
    `).all(twoHoursAgo);
    
    picks.forEach(p => {
        if (p.type === 'STABLE' || p.type === 'ORPHANED_STABLE_RETRY') graduates.add(p.ticker);
        else activeList.push(p.ticker);
    });

    return {
        recent_activity_count: picks.length,
        graduates: Array.from(graduates),
        in_pipeline: [...new Set(activeList)]
    };
}

async function getTopCatalysts() {
    const latestScan = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    if (!latestScan) return { error: "No market data available" };
    
    try {
        const payload = JSON.parse(latestScan.raw_data);
        const results = payload.results || [];
        
        const breakouts = results.filter(r => r.data && r.data.breakout === 1).map(r => r.ticker);
        const momentumSpikes = results.filter(r => r.data && r.data.momScore >= 2 && r.data.volSpike === 1).map(r => r.ticker);
        
        return {
            breakouts,
            momentumSpikes
        };
    } catch(e) {
        return { error: "Failed to parse market data" };
    }
}

async function getInstitutionalPulse() {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const events = db.prepare(`
        SELECT ticker, COUNT(*) as pulse_count, MAX(bar_move_pct) as max_move 
        FROM institutional_interest_events 
        WHERE timestamp > ?
        GROUP BY ticker
        ORDER BY pulse_count DESC
        LIMIT 10
    `).all(last24h);
    
    return events;
}

async function analyzeTarget(ticker) {
    if (!ticker) return { error: "Ticker string required (e.g. BTCUSDT.P)" };
    const cleanTicker = ticker.replace('BINANCE:', '');
    
    // 1. Get current score from latest scan
    const latestScan = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    let currentData = null;
    if (latestScan) {
        try {
            const payload = JSON.parse(latestScan.raw_data);
            const results = payload.results || [];
            currentData = results.find(r => r.ticker === cleanTicker || r.datakey === ticker || r.datakey === `BINANCE:${cleanTicker}`);
        } catch(e) {}
    }
    
    // 2. Get smart levels
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const levelEvent = db.prepare(`
        SELECT raw_data FROM smart_level_events 
        WHERE ticker = ? AND timestamp > ?
        ORDER BY timestamp DESC LIMIT 1
    `).get(cleanTicker, last24h);
    
    let smartLevelsObj = null;
    if (levelEvent) {
        try {
            const raw = JSON.parse(levelEvent.raw_data);
            smartLevelsObj = raw.smart_levels || null;
        } catch(e) {}
    }
    
    return {
        ticker: cleanTicker,
        current_status: currentData ? currentData.data : "Not currently mapped in active top scan",
        latest_smart_levels: smartLevelsObj || "No levels configured/triggered in last 24h"
    };
}

async function queryTechnicalFilters(filters) {
    // 1. Fetch latest Macro Scan (26 columns)
    const latestScanRow = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    let scanResultsMap = {};
    if (latestScanRow) {
        try {
            const scanData = JSON.parse(latestScanRow.raw_data);
            if (scanData.results) {
                scanData.results.forEach(r => {
                    scanResultsMap[r.ticker] = r.data || r;
                });
            }
        } catch(e) {}
    }

    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = db.prepare(`
        SELECT ticker, raw_data 
        FROM unified_alerts 
        WHERE timestamp > ?
        GROUP BY ticker
        HAVING MAX(timestamp)
    `).all(last24h);
    
    let matchedCoins = [];
    
    rows.forEach(row => {
        try {
            const data = JSON.parse(row.raw_data);
            let match = true;
            
            // 1. Check RSI Criteria
            if (filters.rsi && filters.rsi.timeframe && filters.rsi.value) {
                let rsiVal = null;
                const reqTf = filters.rsi.timeframe;
                
                if (data.rsi_matrix) {
                   rsiVal = data.rsi_matrix[reqTf];
                   // Fallback logic for missing exact timeframe
                   if (!rsiVal && reqTf === 'm15') {
                       if (data.rsi_matrix.m5 && data.rsi_matrix.m30) {
                           rsiVal = (parseFloat(data.rsi_matrix.m5) + parseFloat(data.rsi_matrix.m30)) / 2;
                       } else {
                           rsiVal = data.rsi_matrix.m5 || data.rsi_matrix.m30;
                       }
                   }
                }
                
                if (!rsiVal) {
                    match = false;
                } else {
                    const r = parseFloat(rsiVal);
                    if (filters.rsi.operator === '>') {
                        if (r <= filters.rsi.value) match = false;
                    } else if (filters.rsi.operator === '<') {
                        if (r >= filters.rsi.value) match = false;
                    }
                }
            }
            
            // 2. Check EMA Criteria
            if (match && filters.ema200 && filters.ema200.timeframe && filters.ema200.operator) {
                const reqTf = filters.ema200.timeframe;
                let emaVal = null;
                
                if (data.smart_levels && data.smart_levels.emas_200) {
                   const rawEma = data.smart_levels.emas_200[reqTf];
                   if (rawEma) {
                       emaVal = rawEma.p ? parseFloat(rawEma.p) : parseFloat(rawEma);
                   } else if (!rawEma && reqTf === 'm5') {
                       // Sometimes m5 is missing, safely fallback to next timeframe
                       const fallback = data.smart_levels.emas_200['m15'] || data.smart_levels.emas_200['h1'];
                       if (fallback) emaVal = fallback.p ? parseFloat(fallback.p) : parseFloat(fallback);
                   }
                }
                
                if (!emaVal) {
                    match = false; // Exclude if level is unmapped
                } else {
                    const price = parseFloat(data.price || 0);
                    if (price > 0) {
                        if (filters.ema200.operator === '>') {
                            if (price <= emaVal) match = false; // Looking for price > EMA
                        } else if (filters.ema200.operator === '<') {
                            if (price >= emaVal) match = false; // Looking for price < EMA
                        }
                    } else {
                        match = false;
                    }
                }
            }
            
            // 2.5 Check Volume & Change %
            if (match && filters.volume && filters.volume.operator !== undefined) {
                let volVal = null;
                if (data.today_volume !== undefined) volVal = parseFloat(data.today_volume);
                else if (data.volume && data.volume.day_vol !== undefined) volVal = parseFloat(data.volume.day_vol);
                
                if (volVal === null || isNaN(volVal)) {
                    match = false;
                } else {
                    if (filters.volume.operator === '>') {
                        if (volVal <= filters.volume.value) match = false;
                    } else if (filters.volume.operator === '<') {
                        if (volVal >= filters.volume.value) match = false;
                    }
                }
            }
            
            if (match && filters.change_pct && filters.change_pct.operator !== undefined) {
                let chgVal = null;
                if (data.today_change_pct !== undefined) chgVal = parseFloat(data.today_change_pct);
                
                if (chgVal === null || isNaN(chgVal)) {
                    match = false;
                } else {
                    if (filters.change_pct.operator === '>') {
                        if (chgVal <= filters.change_pct.value) match = false;
                    } else if (filters.change_pct.operator === '<') {
                        if (chgVal >= filters.change_pct.value) match = false;
                    }
                }
            }
            
            // 3. Check Smart Level Proximity (and Confluence)
            let matched_levels = [];
            if (match && filters.smart_level && filters.smart_level.max_distance_pct !== undefined) {
                const breakers = RSIEngine.generateSpeedbreakers(data.price, data.smart_levels);
                const targetType = filters.smart_level.type || 'ANY';
                const minCount = filters.smart_level.min_confluence || 1;
                
                for (let b of breakers) {
                    if (targetType === 'ANY' || b.type === targetType) {
                        if (Math.abs(b.distance_pct) <= filters.smart_level.max_distance_pct) {
                            matched_levels.push(b);
                        }
                    }
                }
                
                if (matched_levels.length < minCount) match = false;
            }
            
            // 4. Check 26-column Macro properties
            let macro_data = null;
            if (match && filters.macro_columns) {
                macro_data = scanResultsMap[row.ticker];
                if (!macro_data) {
                    match = false; // Could not find this coin in the latest macro scan
                } else {
                    for (const [key, rule] of Object.entries(filters.macro_columns)) {
                        const val = macro_data[key];
                        if (val === undefined) {
                            match = false;
                            break;
                        }
                        
                        if (typeof rule === 'object' && rule !== null) {
                            if (rule.operator === '>') {
                                if (val <= rule.value) match = false;
                            } else if (rule.operator === '<') {
                                if (val >= rule.value) match = false;
                            } else if (rule.operator === '==') {
                                if (val !== rule.value) match = false;
                            }
                        } else {
                            // Exact match
                            if (val !== rule) match = false;
                        }
                        
                        if (!match) break;
                    }
                }
            }
            
            if (match) {
                // Provide a full picture back to the AI
                const allBreakers = RSIEngine.generateSpeedbreakers(data.price, data.smart_levels);
                
                // Construct stripped-down macro context if available
                let macroContext = null;
                if (scanResultsMap[row.ticker]) {
                   const md = scanResultsMap[row.ticker];
                   macroContext = { score: md.score, breakout: md.breakout, volSpike: md.volSpike, momScore: md.momScore };
                }
                
                matchedCoins.push({
                    ticker: row.ticker,
                    price: data.price,
                    change_pct: data.today_change_pct,
                    volume: data.today_volume || (data.volume ? data.volume.day_vol : null),
                    macro_context: macroContext,
                    rsi_matrix: data.rsi_matrix,
                    smart_levels_matched: matched_levels.length > 0 ? matched_levels : null,
                    closest_levels: allBreakers.slice(0, 3) // Give Claude the 3 closest levels for context
                });
            }
        } catch(e) {}
    });
    
    return {
        criteria_used: filters,
        matched_count: matchedCoins.length,
        coins: matchedCoins
    };
}

async function getDatabaseSchema() {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'").all();
    return tables.map(t => ({ table: t.name, schema: t.sql }));
}

async function runReadonlySqlQuery(query) {
    // Basic sandboxing
    if (!query.trim().toUpperCase().startsWith('SELECT') && !query.trim().toUpperCase().startsWith('WITH')) {
         return { error: "Security Exception: Only SELECT statements are allowed via MCP." };
    }
    try {
         let safeQuery = query;
         if (!safeQuery.toUpperCase().includes('LIMIT')) {
             safeQuery += " LIMIT 100"; // Prevent MCP payload overflow
         }
         const results = db.prepare(safeQuery).all();
         return {
             query_executed: safeQuery,
             returned_rows: results.length,
             data: results
         };
    } catch(err) {
         return { error: "SQL Execution Error: " + err.message };
    }
}

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
            coins: rows
        };
    } catch(e) {
        return { error: e.message };
    }
}

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

        // Parse JSON blobs for better AI consumption
        const parsedRows = rows.map(r => ({
            ...r,
            feature_snapshot: r.feature_snapshot ? JSON.parse(r.feature_snapshot) : null,
            config_snapshot: r.config_snapshot ? JSON.parse(r.config_snapshot) : null
        }));

        return {
            description: "Active 3rd Umpire Validator trials — EMA hierarchy validated setups",
            count: parsedRows.length,
            trials: parsedRows
        };
    } catch(e) {
        return { error: e.message };
    }
}

async function getTrialDetails(trial_id) {
    if (!trial_id) return { error: "trial_id is required" };
    try {
        const trial = db.prepare('SELECT * FROM validation_trials WHERE trial_id = ?').get(trial_id);
        if (!trial) return { error: `Trial ${trial_id} not found` };

        const logs = db.prepare('SELECT * FROM validation_state_log WHERE trial_id = ? ORDER BY changed_at ASC').all(trial_id);

        trial.feature_snapshot = trial.feature_snapshot ? JSON.parse(trial.feature_snapshot) : null;
        trial.config_snapshot = trial.config_snapshot ? JSON.parse(trial.config_snapshot) : null;
        trial.raw_trigger_blob = trial.raw_trigger_blob ? JSON.parse(trial.raw_trigger_blob) : null;

        const parsedLogs = logs.map(l => ({
            ...l,
            rule_snapshot: l.rule_snapshot ? JSON.parse(l.rule_snapshot) : null
        }));

        return {
            trial_summary: trial,
            state_transitions: parsedLogs
        };
    } catch(e) {
        return { error: e.message };
    }
}

async function getCoinLifecycles(status) {
    try {
        let rows;
        if (status && status !== 'ALL') {
            rows = db.prepare('SELECT * FROM coin_lifecycles WHERE status = ? ORDER BY born_at DESC LIMIT 50').all(status);
        } else {
            rows = db.prepare('SELECT * FROM coin_lifecycles ORDER BY born_at DESC LIMIT 50').all();
        }
        return { count: rows.length, lifecycles: rows };
    } catch(e) {
        return { error: e.message };
    }
}

async function getGhostApprovalQueue() {
    try {
        const rows = db.prepare('SELECT * FROM ghost_approval_queue WHERE is_approved = 0 ORDER BY queued_at DESC').all();
        return { count: rows.length, queue: rows };
    } catch(e) {
        return { error: e.message };
    }
}

async function getUpcomingWatchers() {
    try {
        const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
        const latestScans = db.prepare(`
            SELECT sr.ticker, sr.price, sr.timestamp, sr.smart_levels
            FROM scan_results sr
            INNER JOIN (
                SELECT ticker, MAX(timestamp) AS latest FROM scan_results WHERE timestamp > ? GROUP BY ticker
            ) latest ON sr.ticker = latest.ticker AND sr.timestamp = latest.latest
            WHERE sr.smart_levels IS NOT NULL
        `).all(cutoff);

        const results = [];
        for (const row of latestScans) {
            let sl;
            try { sl = JSON.parse(row.smart_levels); } catch { continue; }
            const price = row.price;
            if (!price) continue;

            const levels = [];
            if (sl.mega_spot?.p) levels.push({ label: 'Mega Spot', price: sl.mega_spot.p });
            if (sl.emas_200?.h4?.p) levels.push({ label: '4H EMA200', price: sl.emas_200.h4.p });
            if (sl.emas_200?.h1?.p) levels.push({ label: '1H EMA200', price: sl.emas_200.h1.p });
            if (sl.daily_logic?.base_res?.p) levels.push({ label: 'Daily Res', price: sl.daily_logic.base_res.p });
            if (sl.daily_logic?.base_supp?.p) levels.push({ label: 'Daily Supp', price: sl.daily_logic.base_supp.p });

            for (const lvl of levels) {
                const distPct = Math.abs((price - lvl.price) / lvl.price * 100);
                if (distPct <= 0.5) {
                    const direction = price < lvl.price ? 'LONG' : 'SHORT';
                    results.push({
                        ticker: row.ticker,
                        current_price: price,
                        level_label: lvl.label,
                        level_price: lvl.price,
                        distance_pct: Math.round(distPct * 100) / 100,
                        expected_direction: direction
                    });
                }
            }
        }

        results.sort((a, b) => a.distance_pct - b.distance_pct);
        return {
            description: "Tickers within 0.5% of a smart level — pre-alert positioning candidates",
            count: results.length,
            watchers: results.slice(0, 20)
        };
    } catch(e) {
        return { error: e.message };
    }
}

async function getPatternStats({ direction, trigger_type, min_samples = 3, min_win_rate = 0 } = {}) {
    try {
        let where = 'WHERE sample_count >= ?';
        const params = [min_samples];

        if (direction) { where += ' AND direction = ?'; params.push(direction); }
        if (trigger_type) { where += ' AND trigger_type = ?'; params.push(trigger_type); }
        if (min_win_rate > 0) { where += ' AND win_rate_30m >= ?'; params.push(min_win_rate); }

        const rows = db.prepare(`
            SELECT stat_key, direction, trigger_type, vol_filter, ema_1h_align, ema_4h_align,
                   sample_count, win_rate_30m, avg_move_pct, confidence, last_updated
            FROM pattern_statistics
            ${where}
            ORDER BY sample_count DESC, win_rate_30m DESC
            LIMIT 30
        `).all(...params);

        return {
            description: "3rd Umpire Validator pre-computed win rates by setup combination",
            count: rows.length,
            filters_applied: { direction, trigger_type, min_samples, min_win_rate },
            stats: rows
        };
    } catch(e) {
        return { error: e.message };
    }
}

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
    getGhostApprovalQueue
};
