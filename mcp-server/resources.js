/**
 * MCP resources — read-only data exposed as URI-addressable blobs
 * ─────────────────────────────────────────────────────────────────────────────
 * Static resources (no params):
 *   market://latest-snapshot
 *   market://recent-alerts
 *   market://stream-health
 *   market://active-trials
 *   market://journal/recent
 *
 * Resource templates (parameterised):
 *   ticker://stream-d/{ticker}     — latest Stream D matrix for one ticker
 *   ticker://master/{ticker}       — latest master_coin_store snapshot for one ticker
 *   ticker://volume-events/{ticker}— last 24h volume events for one ticker
 *   ticker://journal/{ticker}      — agent journal entries pivoted to one ticker
 *
 * Why expose these as resources (not just tools)? Resource URIs can be attached
 * to a Claude Desktop / Cursor conversation as "context files" — the model
 * reads them as static input rather than tool-calling them. Cheaper tokens,
 * lower latency, and they show up natively in the UI's "@-mention" picker.
 */

const db = require('./database');
const journal = require('./journal');

// ── Static resources ────────────────────────────────────────────────────────
async function getLatestSnapshot() {
    const latestScan = db.prepare('SELECT raw_data FROM scan_results ORDER BY rowid DESC LIMIT 1').get();
    if (!latestScan) return JSON.stringify({ error: 'No market data available' });
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

async function getJournalRecent() {
    return JSON.stringify(journal.recent(50), null, 2);
}

// ── Per-ticker resource resolvers ───────────────────────────────────────────
function _normaliseTicker(t) {
    if (!t) return '';
    const upper = t.toUpperCase();
    // Best-effort: caller may pass plain "BTC" or full "BTCUSDT.P" — try as-is first
    return upper.includes('USDT') ? upper : upper + 'USDT.P';
}

async function getTickerStreamD(ticker) {
    const t = _normaliseTicker(ticker);
    const row = db.prepare(`
        SELECT ticker, timestamp, raw_data
        FROM stream_d_events
        WHERE ticker = ?
        ORDER BY timestamp DESC LIMIT 1
    `).get(t);
    if (!row) return JSON.stringify({ ticker: t, error: 'No Stream D data for this ticker' });
    return JSON.stringify({ ticker: row.ticker, timestamp: row.timestamp, raw_data: row.raw_data }, null, 2);
}

async function getTickerMaster(ticker) {
    const t = _normaliseTicker(ticker);
    const row = db.prepare(`
        SELECT ticker, timestamp, stream_a, stream_b, stream_c, stream_d
        FROM master_coin_store
        WHERE ticker = ?
        ORDER BY timestamp DESC LIMIT 1
    `).get(t);
    if (!row) return JSON.stringify({ ticker: t, error: 'No master_coin_store entry for this ticker' });
    return JSON.stringify(row, null, 2);
}

async function getTickerVolumeEvents(ticker) {
    const t = _normaliseTicker(ticker);
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const events = db.prepare(`
        SELECT ts, source, strength, meta
        FROM volume_events
        WHERE ticker = ? AND ts > ?
        ORDER BY ts DESC
    `).all(t, oneDayAgo);
    return JSON.stringify({ ticker: t, count: events.length, events }, null, 2);
}

async function getTickerJournal(ticker) {
    const t = _normaliseTicker(ticker);
    return JSON.stringify(journal.byTicker(t, 50), null, 2);
}

// ── URI router ──────────────────────────────────────────────────────────────
function listResourceTemplates() {
    return [
        {
            uriTemplate: 'ticker://stream-d/{ticker}',
            name:        'Stream D Matrix per Ticker',
            description: 'Latest TradingView Stream D real-time EMA cascade snapshot for a single ticker. Replace {ticker} with e.g. BTCUSDT.P.',
            mimeType:    'application/json',
        },
        {
            uriTemplate: 'ticker://master/{ticker}',
            name:        'Master Coin Store per Ticker',
            description: 'Latest event-sourced state snapshot blending all 4 streams for a single ticker.',
            mimeType:    'application/json',
        },
        {
            uriTemplate: 'ticker://volume-events/{ticker}',
            name:        'Volume Events per Ticker (24h)',
            description: 'Last 24 hours of volume_events for a single ticker, all stream sources.',
            mimeType:    'application/json',
        },
        {
            uriTemplate: 'ticker://journal/{ticker}',
            name:        'Agent Journal per Ticker',
            description: 'Past agent observations, conclusions and notes pivoted to a single ticker.',
            mimeType:    'application/json',
        },
    ];
}

/**
 * Resolve a URI to a JSON text blob. Returns null if the URI is unknown to
 * this module (caller falls back to other resolvers e.g. tools).
 */
async function resolve(uri) {
    if (uri === 'market://latest-snapshot')   return await getLatestSnapshot();
    if (uri === 'market://recent-alerts')     return await getRecentAlerts();
    if (uri === 'market://journal/recent')    return await getJournalRecent();

    const m1 = uri.match(/^ticker:\/\/stream-d\/(.+)$/);
    if (m1) return await getTickerStreamD(decodeURIComponent(m1[1]));

    const m2 = uri.match(/^ticker:\/\/master\/(.+)$/);
    if (m2) return await getTickerMaster(decodeURIComponent(m2[1]));

    const m3 = uri.match(/^ticker:\/\/volume-events\/(.+)$/);
    if (m3) return await getTickerVolumeEvents(decodeURIComponent(m3[1]));

    const m4 = uri.match(/^ticker:\/\/journal\/(.+)$/);
    if (m4) return await getTickerJournal(decodeURIComponent(m4[1]));

    return null;
}

module.exports = {
    getLatestSnapshot,
    getRecentAlerts,
    getJournalRecent,
    getTickerStreamD,
    getTickerMaster,
    getTickerVolumeEvents,
    getTickerJournal,
    listResourceTemplates,
    resolve,
};
