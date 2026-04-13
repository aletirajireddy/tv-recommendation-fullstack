const db = require('./database');

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

module.exports = {
    getMarketSentiment,
    getMasterWatchlist,
    getTopCatalysts,
    getInstitutionalPulse,
    analyzeTarget
};
