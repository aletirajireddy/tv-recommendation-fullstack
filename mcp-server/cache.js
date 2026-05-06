/**
 * Tool result cache + in-flight dedup
 * ─────────────────────────────────────────────────────────────────────────────
 * Mirrors the Tier-1 client-side pattern: same call within TTL → cached result;
 * concurrent callers → coalesced onto the same Promise (no duplicate DB scans).
 *
 * Why: agentic loops (LangGraph, OpenAI Agents SDK, Claude Desktop's reasoning
 * chains) frequently re-call read-only meta tools like `get_market_regime` 3-4×
 * inside a single user turn. Without this, every call hits SQLite. With this,
 * the second-Nth calls return in <1ms with zero DB load.
 *
 * Per-tool TTLs: chosen so cached data is never older than the underlying
 * scan/push cadence — never serve data more stale than the source.
 *
 * Tools omitted from the cache (TTL_BY_TOOL[name] === 0):
 *   - run_readonly_sql_query     : args are arbitrary; cache hit rate near zero
 *   - write_journal_entry        : write tool, must always execute
 *   - discover_tools_by_intent   : pure CPU, no DB hit, caching is overkill
 */

const DEFAULT_TTL_MS = 30_000;

const TTL_BY_TOOL = {
    // Market overview — refresh ~every scan cycle
    get_market_sentiment:        20_000,
    get_market_regime:           20_000,
    get_top_catalysts:           30_000,
    get_institutional_pulse:     60_000,
    get_stream_health:           10_000, // user often polls this — keep tight

    // Target / detail
    analyze_target:              15_000,
    query_master_coin_store:     15_000,
    get_stream_d_matrix:         15_000,

    // Volume / smart levels
    get_volume_events:           20_000,
    get_volume_buildups:         30_000,
    get_smart_level_reactions:   20_000,
    get_upcoming_watchers:       30_000,

    // Validator / pattern
    get_validated_setups:        10_000,
    get_trial_details:           60_000, // mostly historical
    get_trial_full_context:      60_000,
    get_pattern_stats:          120_000, // pre-computed, slow churn

    // Watchlist / lifecycle
    get_master_watchlist:        60_000,
    get_coin_lifecycles:        120_000,
    get_ghost_approval_queue:    30_000,

    // Power tools
    query_technical_filters:     20_000,
    get_database_schema:        600_000, // schema rarely changes

    // Never cache:
    run_readonly_sql_query:           0,
    write_journal_entry:              0,
    discover_tools_by_intent:         0,
};

const MAX_ENTRIES = 500;
const _cache    = new Map();   // key → { ts, value }
const _inflight = new Map();   // key → Promise<value>

let _hits = 0, _misses = 0, _coalesced = 0;

function _key(name, args) {
    // Stable JSON: sort top-level keys so {a:1,b:2} and {b:2,a:1} hit the same slot.
    if (!args || typeof args !== 'object') return name + ':' + JSON.stringify(args ?? null);
    const sorted = Object.keys(args).sort().reduce((o, k) => { o[k] = args[k]; return o; }, {});
    return name + ':' + JSON.stringify(sorted);
}

function _evictIfFull() {
    if (_cache.size < MAX_ENTRIES) return;
    // FIFO eviction — Map preserves insertion order.
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
}

/**
 * Wrap a tool execution with cache + dedup.
 * @param {string} toolName
 * @param {object|null} args
 * @param {() => Promise<any>} executor
 * @returns {Promise<any>}
 */
async function withCache(toolName, args, executor) {
    const ttl = TTL_BY_TOOL[toolName] ?? DEFAULT_TTL_MS;
    if (ttl === 0) return executor();

    const key = _key(toolName, args);

    // 1. Cache hit
    const cached = _cache.get(key);
    if (cached && (Date.now() - cached.ts) < ttl) {
        _hits++;
        // Move to end for LRU-ish freshness ordering
        _cache.delete(key);
        _cache.set(key, cached);
        return cached.value;
    }

    // 2. In-flight coalescence
    if (_inflight.has(key)) {
        _coalesced++;
        return _inflight.get(key);
    }

    // 3. Cold execute
    _misses++;
    const promise = (async () => {
        try {
            const value = await executor();
            _evictIfFull();
            _cache.set(key, { ts: Date.now(), value });
            return value;
        } finally {
            _inflight.delete(key);
        }
    })();
    _inflight.set(key, promise);
    return promise;
}

/**
 * Drop all cached entries for a given tool name (use on relevant data-change events).
 */
function invalidateTool(toolName) {
    const prefix = toolName + ':';
    for (const k of _cache.keys()) {
        if (k.startsWith(prefix)) _cache.delete(k);
    }
}

function invalidateAll() {
    _cache.clear();
}

function stats() {
    const total = _hits + _misses + _coalesced;
    return {
        size: _cache.size,
        inflight: _inflight.size,
        hits: _hits,
        misses: _misses,
        coalesced: _coalesced,
        hit_rate: total ? +(_hits / total * 100).toFixed(2) : 0,
    };
}

module.exports = { withCache, invalidateTool, invalidateAll, stats, TTL_BY_TOOL };
