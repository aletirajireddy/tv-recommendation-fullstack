/**
 * Live event subscriptions
 * ─────────────────────────────────────────────────────────────────────────────
 * Polls the read-only DB for new rows in the high-signal tables and emits MCP
 * `notifications/resources/updated` whenever something changes. Agentic loops
 * (LangGraph, Mastra) can subscribe and react INSTEAD of polling tools every
 * 5 seconds — lower latency, lower DB load.
 *
 * Why poll (not file-watch / triggers)? The MCP server is read-only and runs
 * in a separate process from the writer (server/index.js). Polling MAX(rowid)
 * is the lightest cross-process change-detection that doesn't need IPC. With
 * 4 tables × 5s = 0.8 queries/sec, this is negligible.
 *
 * Subscribed resources (matches resources.js URIs):
 *   market://latest-snapshot   ← scans table grows
 *   market://recent-alerts     ← unified_alerts table grows
 *   market://stream-health     ← any of (scans, scan_results, smart_level_events,
 *                                stream_d_events) gets a new row
 *   market://active-trials     ← validator_trials gets a new row OR a state log row
 *
 * Emission triggers cache invalidation for related tools too — so a subscriber
 * that re-fetches gets fresh data, not the last cached blob.
 */

const db = require('./database');
const cache = require('./cache');

const POLL_INTERVAL_MS = 5_000;

// Per-resource max(rowid) watermarks. Bootstrapped on first poll so no
// "everything-just-changed" notification storm at startup.
const _watermarks = {
    scans: -1,
    unified_alerts: -1,
    smart_level_events: -1,
    validator_trials: -1,
    validator_state_log: -1,
};

// Subscriber registry — Map<uri, Set<{ server, sessionId }>>
// Actually we don't track per-session in MCP SDK; we just call notify on every
// active server instance. Index.js wires us up.
const _subscribers = new Set();   // Set<Server>

function subscribe(serverInstance) {
    _subscribers.add(serverInstance);
}
function unsubscribe(serverInstance) {
    _subscribers.delete(serverInstance);
}

async function _notifyAll(uri) {
    for (const srv of _subscribers) {
        try {
            // MCP spec: notifications/resources/updated { uri }
            // Newer SDKs expose server.notification(...) directly; older ones expose
            // server.sendResourceUpdated(uri). Try both for forward/back-compat.
            if (typeof srv.sendResourceUpdated === 'function') {
                await srv.sendResourceUpdated({ uri });
            } else if (typeof srv.notification === 'function') {
                await srv.notification({ method: 'notifications/resources/updated', params: { uri } });
            }
        } catch (e) {
            // Subscriber probably disconnected — drop it.
            _subscribers.delete(srv);
        }
    }
}

// Returns max rowid for a table or -1 if table missing/empty.
function _maxRowId(table) {
    try {
        const row = db.prepare(`SELECT MAX(rowid) AS m FROM ${table}`).get();
        return row?.m ?? -1;
    } catch {
        return -1;
    }
}

async function _pollOnce() {
    if (_subscribers.size === 0) return;   // nothing to do

    // First-poll bootstrap: just record the watermark, don't fire notifications.
    const bootstrap = _watermarks.scans === -1;

    const newScans      = _maxRowId('scans');
    const newAlerts     = _maxRowId('unified_alerts');
    const newSmartLevel = _maxRowId('smart_level_events');
    const newTrials     = _maxRowId('validator_trials');
    const newStateLog   = _maxRowId('validator_state_log');

    if (!bootstrap) {
        const tasks = [];

        if (newScans > _watermarks.scans) {
            cache.invalidateTool('get_market_sentiment');
            cache.invalidateTool('get_market_regime');
            cache.invalidateTool('get_top_catalysts');
            cache.invalidateTool('query_technical_filters');
            tasks.push(_notifyAll('market://latest-snapshot'));
            tasks.push(_notifyAll('market://stream-health'));
        }
        if (newAlerts > _watermarks.unified_alerts) {
            tasks.push(_notifyAll('market://recent-alerts'));
        }
        if (newSmartLevel > _watermarks.smart_level_events) {
            cache.invalidateTool('get_smart_level_reactions');
            cache.invalidateTool('get_upcoming_watchers');
            tasks.push(_notifyAll('market://stream-health'));
        }
        if (newTrials > _watermarks.validator_trials || newStateLog > _watermarks.validator_state_log) {
            cache.invalidateTool('get_validated_setups');
            cache.invalidateTool('get_trial_details');
            cache.invalidateTool('get_trial_full_context');
            tasks.push(_notifyAll('market://active-trials'));
        }

        await Promise.allSettled(tasks);
    }

    _watermarks.scans              = newScans;
    _watermarks.unified_alerts     = newAlerts;
    _watermarks.smart_level_events = newSmartLevel;
    _watermarks.validator_trials   = newTrials;
    _watermarks.validator_state_log= newStateLog;
}

let _timer = null;

function start() {
    if (_timer) return;
    _timer = setInterval(() => {
        _pollOnce().catch(err => console.error('[mcp:liveEvents] poll error:', err.message));
    }, POLL_INTERVAL_MS);
    _timer.unref();
    console.log(`[mcp:liveEvents] watcher started (poll ${POLL_INTERVAL_MS}ms)`);
}

function stats() {
    return {
        subscribers: _subscribers.size,
        watermarks: { ..._watermarks },
        poll_interval_ms: POLL_INTERVAL_MS,
    };
}

module.exports = { start, subscribe, unsubscribe, stats };
