const db = require('./database');

async function getLatestSnapshot() {
    const latestScan = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    if (!latestScan) return "No market data available";
    return latestScan.raw_data; // Pre-stringified JSON blob
}

async function getRecentAlerts() {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const alerts = db.prepare(`
        SELECT timestamp, origin, ticker, strength, direction, price
        FROM unified_alerts 
        WHERE timestamp > ?
        ORDER BY timestamp DESC
    `).all(twoHoursAgo);
    
    return JSON.stringify(alerts, null, 2);
}

module.exports = {
    getLatestSnapshot,
    getRecentAlerts
};
