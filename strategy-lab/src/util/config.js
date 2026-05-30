// Config loader. Precedence: environment (.env) > config/default.json > built-in.
// Paths are resolved relative to the strategy-lab ROOT so the folder is portable.
const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const ROOT = path.resolve(__dirname, '..', '..');

let fileCfg = {};
try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'default.json'), 'utf8'));
} catch { /* defaults below */ }

const bool = (v, d) => (v == null ? d : String(v).toLowerCase() === 'true');
const list = (v, d) => (v == null || v === '' ? d : String(v).split(',').map(s => s.trim()).filter(Boolean));
const num  = (v, d) => (v == null || v === '' ? d : Number(v));

// Resolve a possibly-relative path against ROOT so cwd doesn't matter.
const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(ROOT, p));

const config = {
    root: ROOT,
    liveDbPath:         resolve(process.env.LIVE_DB_PATH    || fileCfg.liveDbPath    || '../dashboard_v3.db'),
    archiveDbPath:      resolve(process.env.ARCHIVE_DB_PATH || fileCfg.archiveDbPath || './data/analytics_archive.db'),
    archiveIntervalSec: num(process.env.ARCHIVE_INTERVAL_SEC, fileCfg.archiveIntervalSec ?? 120),
    incrementalTables:  list(process.env.ARCHIVE_INCREMENTAL_TABLES, fileCfg.incrementalTables || ['coin_metric_history', 'market_context_logs']),
    snapshotTables:     list(process.env.ARCHIVE_SNAPSHOT_TABLES,    fileCfg.snapshotTables    || ['validation_trials', 'validation_state_log', 'pattern_statistics']),
    archiveEnabled:     bool(process.env.ARCHIVE_ENABLED, fileCfg.archiveEnabled ?? false),
};

module.exports = { config };
