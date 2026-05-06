/**
 * Tool annotations + output schemas
 * ─────────────────────────────────────────────────────────────────────────────
 * Centralised metadata so index.js stays readable.
 *
 * `annotations` (MCP spec field): UI hints that let clients auto-approve safe
 * reads, mark destructive ops, and route results correctly. Without these,
 * Claude Desktop / Cursor pop a confirmation dialog on every single call —
 * murders the UX of agentic loops.
 *
 * `outputSchemas`: JSON-Schema for each tool's return value. OpenAI Agents SDK,
 * Mastra, LangGraph all use this to validate output and route on it. Without
 * it they fall back to free-text parsing of stringified JSON.
 *
 * One source of truth — index.js merges these into the ListToolsResponse.
 */

// Default annotation for read-only DB tools (the vast majority).
const READ_ONLY = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,   // DB is closed-world (our schema) — agents don't need to retry on novel results
};

// SQL passthrough — read-only but NOT idempotent (clock-dependent results).
const READ_ONLY_NON_IDEMPOTENT = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};

// The single write tool.
const WRITE_NON_DESTRUCTIVE = {
    readOnlyHint: false,
    destructiveHint: false,   // append-only — never overwrites prior data
    idempotentHint: false,
    openWorldHint: false,
};

const annotations = {
    // Market overview
    get_market_sentiment:        { ...READ_ONLY, title: 'Market Sentiment (Genie Mood)' },
    get_market_regime:           { ...READ_ONLY, title: 'Market Regime Synthesis' },
    get_top_catalysts:           { ...READ_ONLY, title: 'Top Catalysts (Breakouts + Vol Spikes)' },
    get_institutional_pulse:     { ...READ_ONLY, title: 'Institutional Pulse (24h)' },
    get_stream_health:           { ...READ_ONLY, title: 'Stream Health (A/B/C/D)' },

    // Target / detail
    analyze_target:              { ...READ_ONLY, title: 'Single-Ticker Dossier' },
    query_master_coin_store:     { ...READ_ONLY, title: 'Master Coin Store Timeline' },
    get_stream_d_matrix:         { ...READ_ONLY, title: 'Stream D EMA Cascade Matrix' },

    // Volume / smart levels
    get_volume_events:           { ...READ_ONLY, title: 'Volume Events Ledger' },
    get_volume_buildups:         { ...READ_ONLY, title: 'Volume Build-up Candidates' },
    get_smart_level_reactions:   { ...READ_ONLY, title: 'Smart Level Reactions' },
    get_upcoming_watchers:       { ...READ_ONLY, title: 'Pre-Alert Watchers (Within 0.5%)' },

    // Validator / pattern
    get_validated_setups:        { ...READ_ONLY, title: 'Active Validator Trials' },
    get_trial_details:           { ...READ_ONLY, title: 'Trial Forensics' },
    get_trial_full_context:      { ...READ_ONLY, title: 'Trial Full Context Dossier' },
    get_pattern_stats:           { ...READ_ONLY, title: 'Pattern Win-Rate Stats' },

    // Watchlist / lifecycle
    get_master_watchlist:        { ...READ_ONLY, title: 'Master Watchlist (Stream B)' },
    get_coin_lifecycles:         { ...READ_ONLY, title: 'Coin Lifecycles' },
    get_ghost_approval_queue:    { ...READ_ONLY, title: 'Ghost Approval Queue' },

    // Power tools
    query_technical_filters:     { ...READ_ONLY, title: 'Multi-Criteria Technical Filter' },
    get_database_schema:         { ...READ_ONLY, title: 'Database Schema Inspector' },
    run_readonly_sql_query:      { ...READ_ONLY_NON_IDEMPOTENT, title: 'Ad-hoc SQL (read-only)' },

    // v3 additions
    discover_tools_by_intent:    { ...READ_ONLY, title: 'Tool Discovery by Intent' },
    write_journal_entry:         { ...WRITE_NON_DESTRUCTIVE, title: 'Append Agent Journal Entry' },
};

// ─── OUTPUT SCHEMAS ──────────────────────────────────────────────────────────
// These describe the JSON payload inside `content[0].text` (we always serialise
// JSON). Clients that honour outputSchema can validate / route on shape.
const ARRAY_OF_OBJECTS = { type: 'array', items: { type: 'object' } };

const outputSchemas = {
    get_market_sentiment: {
        type: 'object',
        properties: {
            score:      { type: 'number' },
            label:      { type: 'string' },
            breadth:    { type: 'object' },
            trend:      ARRAY_OF_OBJECTS,
        },
    },
    get_market_regime: {
        type: 'object',
        properties: {
            regime:            { type: 'string' },
            ai_interpretation: { type: 'string' },
            mood:              { type: 'object' },
            breadth:           { type: 'object' },
            stream_activity:   { type: 'object' },
            active_trials:     { type: 'object' },
        },
    },
    get_stream_health: {
        type: 'object',
        properties: {
            stream_a: { type: 'object' },
            stream_b: { type: 'object' },
            stream_c: { type: 'object' },
            stream_d: { type: 'object' },
        },
    },
    get_top_catalysts:        { type: 'object', properties: { breakouts: ARRAY_OF_OBJECTS, momentum_vol: ARRAY_OF_OBJECTS } },
    get_institutional_pulse:  { type: 'object', properties: { coins: ARRAY_OF_OBJECTS } },
    get_volume_events:        { type: 'object', properties: { events: ARRAY_OF_OBJECTS, count: { type: 'number' } } },
    get_volume_buildups:      { type: 'object', properties: { buildups: ARRAY_OF_OBJECTS } },
    get_smart_level_reactions:{ type: 'object', properties: { events: ARRAY_OF_OBJECTS } },
    get_upcoming_watchers:    { type: 'object', properties: { watchers: ARRAY_OF_OBJECTS } },
    get_validated_setups:     { type: 'object', properties: { trials: ARRAY_OF_OBJECTS } },
    get_master_watchlist:     { type: 'object' },
    get_coin_lifecycles:      { type: 'object', properties: { coins: ARRAY_OF_OBJECTS } },
    get_ghost_approval_queue: { type: 'object', properties: { queue: ARRAY_OF_OBJECTS } },
    query_technical_filters:  { type: 'object', properties: { matches: ARRAY_OF_OBJECTS, count: { type: 'number' } } },
    get_database_schema:      { type: 'object' },
    run_readonly_sql_query:   { type: 'object', properties: { rows: ARRAY_OF_OBJECTS, row_count: { type: 'number' } } },
    analyze_target:           { type: 'object' },
    query_master_coin_store:  { type: 'object', properties: { snapshots: ARRAY_OF_OBJECTS } },
    get_stream_d_matrix:      { type: 'object' },
    get_trial_details:        { type: 'object' },
    get_trial_full_context:   { type: 'object' },
    get_pattern_stats:        { type: 'object', properties: { stats: ARRAY_OF_OBJECTS } },

    discover_tools_by_intent: {
        type: 'object',
        properties: {
            intent:           { type: 'string' },
            recommended_plan: { type: 'array', items: { type: 'object', properties: {
                step: { type: 'number' }, tool: { type: 'string' }, why: { type: 'string' }, args_hint: { type: 'object' }
            }}},
        },
    },
    write_journal_entry: {
        type: 'object',
        properties: {
            id:        { type: 'number' },
            written_at:{ type: 'string' },
            session_id:{ type: 'string' },
        },
    },
};

module.exports = { annotations, outputSchemas };
