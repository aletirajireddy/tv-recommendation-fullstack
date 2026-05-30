// CLI for the Phase-1 backtest skeleton.
//   node src/backtest/runBacktest.js                       → default strategy, all archived history
//   node src/backtest/runBacktest.js strategies/foo.json   → specific strategy
//   node src/backtest/runBacktest.js strategies/foo.json 1440  → last N minutes only

const fs   = require('fs');
const path = require('path');
const { config } = require('../util/config');
const { openArchive, tableExists } = require('../db/connections');
const { backtest } = require('./engine');
const { log } = require('../util/log');

function loadStrategy(arg) {
    const p = arg
        ? (path.isAbsolute(arg) ? arg : path.resolve(config.root, arg))
        : path.resolve(config.root, 'strategies', 'cascade-pullback-at-level.json');
    if (!fs.existsSync(p)) throw new Error(`strategy file not found: ${p}`);
    return { cfg: JSON.parse(fs.readFileSync(p, 'utf8')), path: p };
}

function main() {
    const arg = process.argv[2];
    const windowMin = process.argv[3] ? Number(process.argv[3]) : null;
    const { cfg, path: sp } = loadStrategy(arg);

    const archive = openArchive(config.archiveDbPath);
    if (!tableExists(archive, 'coin_metric_history')) {
        log.err('archive has no coin_metric_history yet — run `npm run archive:once` first.');
        process.exit(1);
    }

    const sinceMs = windowMin ? Date.now() - windowMin * 60_000 : 0;
    log.info(`strategy: ${cfg.name} (${sp})`);
    log.info(`window  : ${windowMin ? windowMin + 'm' : 'all archived history'}`);

    const result = backtest(cfg, { archive, sinceMs });
    archive.close();

    console.log('\n=== backtest result ===');
    console.log(JSON.stringify(result, null, 2));
}

try { main(); } catch (e) { log.err(e.message); process.exit(1); }
