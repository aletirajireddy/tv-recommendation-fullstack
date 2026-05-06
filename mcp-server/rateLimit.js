/**
 * Per-session + per-tool sliding-window rate limiter
 * ─────────────────────────────────────────────────────────────────────────────
 * Defends against runaway agentic loops (e.g. an OpenAI Agents SDK chain that
 * mis-plans and pings `run_readonly_sql_query` 200×/sec). Prevents one rogue
 * client from starving every other connected agent.
 *
 * Two independent buckets per (session, tool):
 *   - SHORT  : burst limiter   (e.g. 30 calls / 10s)
 *   - LONG   : sustained limit (e.g. 600 calls / 1h)
 *
 * Heavy tools get tighter caps. Sessions are identified by Mcp-Session-Id
 * header (StreamableHTTP) or socket id (SSE). Anonymous sessions share one
 * bucket — that's a feature, not a bug: it makes the open-mode default safe.
 */

const SHORT_WINDOW_MS = 10_000;
const LONG_WINDOW_MS  = 60 * 60_000;

// limits = [shortMax, longMax]
const LIMITS_BY_TOOL = {
    // SQL is the dangerous one — strict
    run_readonly_sql_query:  [10,  300],
    write_journal_entry:     [ 5,  100],

    // Heavy joins / forensics
    get_trial_full_context:  [15,  600],
    analyze_target:          [20,  900],

    // Default for everything else
    __default__:             [30, 1800],
};

// state[sessionId][tool] = { short: number[], long: number[] }
const _state = new Map();

function _getBuckets(session, tool) {
    let toolMap = _state.get(session);
    if (!toolMap) { toolMap = new Map(); _state.set(session, toolMap); }
    let b = toolMap.get(tool);
    if (!b) { b = { short: [], long: [] }; toolMap.set(tool, b); }
    return b;
}

function _prune(arr, now, window) {
    const cutoff = now - window;
    while (arr.length && arr[0] < cutoff) arr.shift();
}

/**
 * Returns { ok: true } or { ok: false, reason, retry_after_ms }.
 * Records the call (in the ok-path) so callers don't need to.
 */
function check(sessionId, toolName) {
    const session = sessionId || 'anonymous';
    const limits = LIMITS_BY_TOOL[toolName] || LIMITS_BY_TOOL.__default__;
    const [shortMax, longMax] = limits;
    const b = _getBuckets(session, toolName);
    const now = Date.now();

    _prune(b.short, now, SHORT_WINDOW_MS);
    _prune(b.long,  now, LONG_WINDOW_MS);

    if (b.short.length >= shortMax) {
        return {
            ok: false,
            reason: `Rate limit: ${shortMax} ${toolName} calls per ${SHORT_WINDOW_MS / 1000}s exceeded`,
            retry_after_ms: SHORT_WINDOW_MS - (now - b.short[0]),
        };
    }
    if (b.long.length >= longMax) {
        return {
            ok: false,
            reason: `Hourly cap: ${longMax} ${toolName} calls per hour exceeded`,
            retry_after_ms: LONG_WINDOW_MS - (now - b.long[0]),
        };
    }

    b.short.push(now);
    b.long.push(now);
    return { ok: true };
}

// Periodic GC: drop sessions with no recent activity (1h idle)
setInterval(() => {
    const cutoff = Date.now() - LONG_WINDOW_MS;
    for (const [sid, toolMap] of _state) {
        let allEmpty = true;
        for (const b of toolMap.values()) {
            _prune(b.short, Date.now(), SHORT_WINDOW_MS);
            _prune(b.long,  Date.now(), LONG_WINDOW_MS);
            if (b.short.length || b.long.length) { allEmpty = false; break; }
        }
        if (allEmpty) _state.delete(sid);
    }
}, 5 * 60_000).unref();

function stats() {
    let sessions = 0, totalRecent = 0;
    for (const toolMap of _state.values()) {
        sessions++;
        for (const b of toolMap.values()) totalRecent += b.short.length;
    }
    return { active_sessions: sessions, calls_in_short_window: totalRecent };
}

module.exports = { check, stats, LIMITS_BY_TOOL };
