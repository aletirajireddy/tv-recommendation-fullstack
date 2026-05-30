// Database connections. The live DB is ALWAYS opened read-only — this module is
// the single chokepoint that guarantees the lab can never write to your live data.
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');
const { log } = require('../util/log');

/** Open the live trading DB strictly read-only. Throws if the file is missing. */
function openLive(liveDbPath) {
    if (!fs.existsSync(liveDbPath)) {
        throw new Error(`Live DB not found at: ${liveDbPath}\n` +
            `Set LIVE_DB_PATH in .env (point it at the db or a COPY of it).`);
    }
    // readonly + fileMustExist — hard guarantee of no writes / no creation.
    return new Database(liveDbPath, { readonly: true, fileMustExist: true });
}

/** Open (or create) the lab's own archive DB read-write. */
function openArchive(archiveDbPath) {
    fs.mkdirSync(path.dirname(archiveDbPath), { recursive: true });
    const db = new Database(archiveDbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    return db;
}

/** True if a table exists in the given connection. */
function tableExists(db, name) {
    return !!db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
    ).get(name);
}

module.exports = { openLive, openArchive, tableExists, log };
