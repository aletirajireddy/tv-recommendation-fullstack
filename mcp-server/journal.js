/**
 * Agent journal — the single allowed write surface
 * ─────────────────────────────────────────────────────────────────────────────
 * Append-only ledger of agent observations, conclusions, and notes that should
 * persist across sessions. Lets a Claude Desktop / Cursor agent build a
 * memory of past analyses without polluting the trading database.
 *
 * Stored in a SEPARATE SQLite file (`mcp_journal.db`) so the read-only main
 * database connection stays read-only and can never be corrupted by journal
 * writes. Two-DB design also makes the journal trivially backupable / wipeable.
 */

const path = require('path');
const Database = require('better-sqlite3');

const journalPath = path.resolve(__dirname, 'mcp_journal.db');
const jdb = new Database(journalPath);
jdb.pragma('journal_mode = WAL');
jdb.pragma('synchronous = NORMAL');

jdb.exec(`
    CREATE TABLE IF NOT EXISTS agent_notes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        written_at  TEXT NOT NULL,
        session_id  TEXT,
        category    TEXT,           -- e.g. "observation", "conclusion", "todo"
        ticker      TEXT,           -- optional pivot for retrieval
        title       TEXT NOT NULL,
        body        TEXT NOT NULL,  -- markdown ok
        tags        TEXT,           -- comma-separated
        related_trial_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_notes_written  ON agent_notes(written_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notes_ticker   ON agent_notes(ticker);
    CREATE INDEX IF NOT EXISTS idx_notes_category ON agent_notes(category);
`);

const _insert = jdb.prepare(`
    INSERT INTO agent_notes (written_at, session_id, category, ticker, title, body, tags, related_trial_id)
    VALUES (@written_at, @session_id, @category, @ticker, @title, @body, @tags, @related_trial_id)
`);

const _recent = jdb.prepare(`
    SELECT * FROM agent_notes ORDER BY written_at DESC LIMIT ?
`);

const _byTicker = jdb.prepare(`
    SELECT * FROM agent_notes WHERE ticker = ? ORDER BY written_at DESC LIMIT ?
`);

/**
 * Append a single journal entry.
 * @param {object}  entry
 * @param {string}  entry.title              required, ≤200 chars
 * @param {string}  entry.body               required, markdown-ok, ≤8000 chars
 * @param {string} [entry.category]          observation | conclusion | todo | note
 * @param {string} [entry.ticker]            optional pivot
 * @param {string[]|string} [entry.tags]     comma-joined or array
 * @param {string} [entry.related_trial_id]
 * @param {string} [sessionId]               populated by index.js from transport
 */
function write(entry, sessionId) {
    if (!entry || typeof entry !== 'object') throw new Error('Entry payload required');
    if (!entry.title || !entry.title.trim()) throw new Error('title is required');
    if (!entry.body  || !entry.body.trim())  throw new Error('body is required');
    if (entry.title.length > 200)            throw new Error('title too long (max 200 chars)');
    if (entry.body.length  > 8000)           throw new Error('body too long (max 8000 chars)');

    const tags = Array.isArray(entry.tags) ? entry.tags.join(',') : (entry.tags || null);
    const written_at = new Date().toISOString();

    const result = _insert.run({
        written_at,
        session_id:        sessionId || null,
        category:          entry.category || 'note',
        ticker:            entry.ticker || null,
        title:             entry.title.trim(),
        body:              entry.body.trim(),
        tags,
        related_trial_id:  entry.related_trial_id || null,
    });

    return {
        id: result.lastInsertRowid,
        written_at,
        session_id: sessionId || null,
    };
}

function recent(limit = 20) {
    return _recent.all(Math.min(Math.max(parseInt(limit) || 20, 1), 200));
}

function byTicker(ticker, limit = 20) {
    return _byTicker.all(ticker, Math.min(Math.max(parseInt(limit) || 20, 1), 200));
}

function close() {
    try { jdb.close(); } catch { /* noop */ }
}

module.exports = { write, recent, byTicker, close, dbPath: journalPath };
