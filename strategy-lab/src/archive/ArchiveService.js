// ArchiveService — Phase 0 of the roadmap.
//
// Copies rows from the LIVE db (read-only) into the lab's OWN archive db before
// the live writer prunes them (Stream D / coin_metric_history is pruned to ~8h).
// Generic, schema-agnostic: it reads each table's CREATE statement from the live
// db and recreates it in the archive, then copies rows. No column names are
// hardcoded, so it survives live-schema migrations.
//
// Two modes per table:
//   • incremental — high-water mark on `id` (or a chosen column); only new rows.
//   • snapshot    — small tables copied in full each run (INSERT OR REPLACE).
//
// SAFETY: live connection is read-only (see connections.js). This service only
// ever SELECTs from live and writes to the separate archive file.

const { openLive, openArchive, tableExists } = require('../db/connections');
const { log } = require('../util/log');

function ensureArchiveTable(live, archive, table) {
    const row = live.prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table);
    if (!row?.sql) return false;
    // Recreate with IF NOT EXISTS so we never clobber accumulated archive data.
    const createSql = row.sql.replace(/^CREATE TABLE/i, 'CREATE TABLE IF NOT EXISTS');
    archive.exec(createSql);
    return true;
}

function columnsOf(db, table) {
    return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

/**
 * Pick a monotonic watermark column for incremental copying.
 * Prefers an INTEGER PRIMARY KEY (rowid alias) of any name — tables here use
 * `id`, `log_id`, `snapshot_id`, etc. Falls back to a literal `id` column.
 * Returns null when no suitable column exists (caller then does a full snapshot).
 */
function pickWatermark(db, table, preferred) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    if (preferred && info.some(c => c.name === preferred)) return preferred;
    const intPk = info.find(c => c.pk === 1 && /INT/i.test(c.type || ''));
    if (intPk) return intPk.name;
    const plainId = info.find(c => c.name === 'id');
    return plainId ? 'id' : null;
}

/** Copy only rows newer than what's already archived, keyed on a watermark column. */
function mirrorIncremental(live, archive, table, watermarkCol = null) {
    if (!tableExists(live, table)) { log.warn(`skip ${table} (not in live db)`); return 0; }
    if (!ensureArchiveTable(live, archive, table)) return 0;

    const cols = columnsOf(live, table);
    watermarkCol = pickWatermark(live, table, watermarkCol);
    if (!watermarkCol) {
        log.warn(`${table}: no monotonic key — falling back to full snapshot`);
        return snapshotFull(live, archive, table);
    }

    const hw = archive.prepare(`SELECT MAX(${watermarkCol}) AS m FROM ${table}`).get().m;
    const rows = hw == null
        ? live.prepare(`SELECT * FROM ${table}`).all()
        : live.prepare(`SELECT * FROM ${table} WHERE ${watermarkCol} > ?`).all(hw);

    if (!rows.length) return 0;

    const colList = cols.join(',');
    const ph = cols.map(() => '?').join(',');
    const ins = archive.prepare(`INSERT OR IGNORE INTO ${table} (${colList}) VALUES (${ph})`);
    const tx = archive.transaction(rs => { for (const r of rs) ins.run(cols.map(c => r[c])); });
    tx(rows);
    return rows.length;
}

/** Copy a (small) table in full, replacing existing rows by primary key. */
function snapshotFull(live, archive, table) {
    if (!tableExists(live, table)) { log.warn(`skip ${table} (not in live db)`); return 0; }
    if (!ensureArchiveTable(live, archive, table)) return 0;

    const cols = columnsOf(live, table);
    const rows = live.prepare(`SELECT * FROM ${table}`).all();
    if (!rows.length) return 0;

    const colList = cols.join(',');
    const ph = cols.map(() => '?').join(',');
    const ins = archive.prepare(`INSERT OR REPLACE INTO ${table} (${colList}) VALUES (${ph})`);
    const tx = archive.transaction(rs => { for (const r of rs) ins.run(cols.map(c => r[c])); });
    tx(rows);
    return rows.length;
}

function ensureMeta(archive) {
    archive.exec(`
        CREATE TABLE IF NOT EXISTS _archive_runs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            ran_at      TEXT NOT NULL,
            table_name  TEXT NOT NULL,
            mode        TEXT NOT NULL,
            rows_copied INTEGER NOT NULL
        )
    `);
}

/**
 * Run one archival pass. Returns a per-table summary.
 * @param {object} config  resolved config from util/config.js
 */
function runOnce(config) {
    const live = openLive(config.liveDbPath);
    const archive = openArchive(config.archiveDbPath);
    ensureMeta(archive);
    const ranAt = new Date().toISOString();
    const summary = {};
    const recordRun = archive.prepare(
        'INSERT INTO _archive_runs (ran_at, table_name, mode, rows_copied) VALUES (?,?,?,?)'
    );

    try {
        for (const t of config.incrementalTables) {
            const n = mirrorIncremental(live, archive, t);
            summary[t] = { mode: 'incremental', rows: n };
            recordRun.run(ranAt, t, 'incremental', n);
        }
        for (const t of config.snapshotTables) {
            const n = snapshotFull(live, archive, t);
            summary[t] = { mode: 'snapshot', rows: n };
            recordRun.run(ranAt, t, 'snapshot', n);
        }
    } finally {
        live.close();
        archive.close();
    }
    return summary;
}

module.exports = { runOnce, mirrorIncremental, snapshotFull };
