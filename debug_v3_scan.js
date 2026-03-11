const db = require('./server/database.js');

try {
    const latestScan = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    if (latestScan) {
        const scanData = JSON.parse(latestScan.raw_data);
        console.log("Total Results:", scanData.results ? scanData.results.length : 0);

        let masterList = [];
        let pruneList = [];

        scanData.results.forEach(item => {
            const d = item.data || item;

            if (d.score >= 60 || d.breakout === 1) {
                masterList.push(item.ticker);
            }
            if (d.score < 20 || d.freeze === 1) {
                pruneList.push(item.ticker);
            }
        });

        console.log("Master List Count:", masterList.length);
        console.log("Prune List Count:", pruneList.length);
        console.log("Sample Data Entry:");
        console.log(JSON.stringify(scanData.results[0], null, 2));

    } else {
        console.log("No scans found.");
    }
} catch (e) {
    console.error(e);
}
