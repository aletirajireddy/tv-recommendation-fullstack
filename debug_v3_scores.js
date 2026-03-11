const db = require('./server/database.js');

try {
    const latestScan = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    if (latestScan) {
        const scanData = JSON.parse(latestScan.raw_data);
        console.log("All Scores in latest scan:");
        scanData.results.forEach(item => {
            const d = item.data || item;
            console.log(`${item.ticker}: Score=${d.score}, Breakout=${d.breakout}, Freeze=${d.freeze}`);
        });

    } else {
        console.log("No scans found.");
    }
} catch (e) {
    console.error(e);
}
