/**
 * discover_tools_by_intent — meta-tool that returns a recipe (ordered tool plan)
 * ─────────────────────────────────────────────────────────────────────────────
 * Cuts agent traces from 8 reasoning steps to 2: agent calls discover_tools_by_intent
 * with a natural-language goal; we keyword-match against intent recipes and return
 * a step-by-step plan (which tools, in what order, with hint args). The agent then
 * executes the plan directly.
 *
 * Pure CPU — no DB hit, no caching needed. Recipes are hand-tuned to the most
 * common analyst questions. Fall-through returns generic guidance pointing at
 * get_database_schema + run_readonly_sql_query.
 */

// Each recipe: keyword regex → ordered plan.
// Plans use { tool, why, args_hint? } so the agent knows WHY each step matters.
const RECIPES = [
    {
        match: /\b(morning|brief|overview|state of (the )?market|whats happening)\b/i,
        intent: 'morning_brief',
        plan: [
            { tool: 'get_market_regime',     why: 'Single synthesised view of regime + breadth + activity' },
            { tool: 'get_stream_health',     why: 'Flag any stale data sources before trusting the regime' },
            { tool: 'get_top_catalysts',     why: 'What is moving right now (breakouts + vol spikes)' },
            { tool: 'get_validated_setups',  why: 'Active validator trials = ready-to-trade setups', args_hint: { state: 'WATCHING' } },
        ],
    },
    {
        match: /\b(setup|opportunit|trade idea|what (should|can) i trade|find (me )?(a )?(long|short))\b/i,
        intent: 'find_setups',
        plan: [
            { tool: 'get_validated_setups', why: 'Live validator candidates ranked by latest_move',  args_hint: { state: 'WATCHING' } },
            { tool: 'get_validated_setups', why: 'Already-favourable trials — early entries available', args_hint: { state: 'EARLY_FAVORABLE' } },
            { tool: 'get_pattern_stats',    why: 'Cross-reference each candidate with historical win-rate', args_hint: { min_samples: 5 } },
            { tool: 'get_upcoming_watchers',why: 'Pre-alert tickers — position before the trigger fires' },
        ],
    },
    {
        match: /\b(why (did|does)|post.?mortem|forensic|what happened|fail|failure)\b.*\btrial\b/i,
        intent: 'trial_postmortem',
        plan: [
            { tool: 'get_trial_full_context', why: 'Single round-trip — trial row + state log + master snapshot + windowed timeline' },
            { tool: 'get_pattern_stats',      why: 'Was this setup statistically weak from the start?' },
        ],
    },
    {
        match: /\b(deep dive|analyze|analyse|tell me about|explain)\b.*\b([A-Z]{2,}USDT?\.?P?|[A-Z]{2,})\b/i,
        intent: 'ticker_dossier',
        plan: [
            { tool: 'analyze_target',          why: 'All-in-one ticker dossier (extract ticker from user prompt)' },
            { tool: 'get_stream_d_matrix',     why: 'EMA cascade detail at every TF' },
            { tool: 'get_volume_events',       why: 'Last 12h institutional / smart-level volume', args_hint: { hours: 12 } },
            { tool: 'query_master_coin_store', why: 'State evolution timeline', args_hint: { limit: 20 } },
        ],
    },
    {
        match: /\b(volume|spike|institutional|accumulation|distribution|big print)\b/i,
        intent: 'volume_hunt',
        plan: [
            { tool: 'get_volume_events',       why: 'Recent qualifying spikes', args_hint: { min_strength: 1.5, hours: 6 } },
            { tool: 'get_volume_buildups',     why: 'Coins building positions pre-breakout' },
            { tool: 'get_institutional_pulse', why: '24h footprint anomaly leaders' },
        ],
    },
    {
        match: /\b(squeez|tight|consolidat|range|coil)\b/i,
        intent: 'squeeze_scan',
        plan: [
            { tool: 'query_technical_filters', why: 'Multi-EMA proximity = squeeze condition', args_hint: {
                smart_level: { type: 'EMA200', max_distance_pct: 1, min_confluence: 2 }
            } },
            { tool: 'get_upcoming_watchers',   why: 'Tickers within 0.5% of a smart level' },
        ],
    },
    {
        match: /\b(risk|danger|expos|safe|stale|dead|broken)\b/i,
        intent: 'risk_check',
        plan: [
            { tool: 'get_stream_health',          why: 'Data integrity is the first risk — STALE = downgrade everything' },
            { tool: 'get_market_sentiment',       why: 'Trend array reveals sentiment volatility (rapid mood swings)' },
            { tool: 'get_ghost_approval_queue',   why: 'Mass coin de-activation = broad de-risking event' },
            { tool: 'get_validated_setups',       why: 'Compute confirmed/(confirmed+failed) ratio recently' },
        ],
    },
    {
        match: /\b(EMA|cascade|alignment|trend|HTF)\b/i,
        intent: 'ema_cascade_scan',
        plan: [
            { tool: 'get_stream_d_matrix',     why: 'Latest EMA cascade matrix across all coins' },
            { tool: 'query_technical_filters', why: 'Filter for price vs EMA condition + RSI guard', args_hint: {
                ema200: { timeframe: 'h1', operator: '>' },
                rsi:    { timeframe: 'h1', operator: '>', value: 50 }
            } },
        ],
    },
    {
        match: /\b(smart level|reaction|bounce|reject|break)\b/i,
        intent: 'level_reactions',
        plan: [
            { tool: 'get_smart_level_reactions', why: 'Recent BULL/BEAR reactions at key levels', args_hint: { hours: 6 } },
            { tool: 'get_upcoming_watchers',     why: 'Pre-trigger setups about to react' },
        ],
    },
    {
        match: /\b(SQL|query|database|table|column|join|raw data|schema)\b/i,
        intent: 'sql_explorer',
        plan: [
            { tool: 'get_database_schema',     why: 'ALWAYS inspect schema first to avoid hallucinated columns' },
            { tool: 'run_readonly_sql_query',  why: 'Issue a read-only SELECT or WITH query — auto-LIMIT 100 if you forget' },
        ],
    },
    {
        match: /\b(history|past|previous|note|journal|memory|remember)\b/i,
        intent: 'recall_or_journal',
        plan: [
            { tool: 'write_journal_entry', why: 'Persist conclusions across sessions (only after analysis is complete)' },
        ],
    },
];

const FALLBACK = {
    intent: 'unknown',
    plan: [
        { tool: 'get_market_regime',      why: 'Always-safe starting point for any market question' },
        { tool: 'get_database_schema',    why: 'For data questions — see what tables exist' },
        { tool: 'run_readonly_sql_query', why: 'Then craft a custom query if no purpose-built tool fits' },
    ],
};

function discover(intent) {
    if (!intent || typeof intent !== 'string') {
        return { intent: 'empty', recommended_plan: FALLBACK.plan, note: 'Pass a natural-language goal as `intent`.' };
    }
    const text = intent.trim();
    for (const r of RECIPES) {
        if (r.match.test(text)) {
            return {
                intent: r.intent,
                recommended_plan: r.plan.map((p, i) => ({ step: i + 1, ...p })),
                note: `Matched "${r.intent}" recipe — execute the steps in order.`,
            };
        }
    }
    return {
        intent: FALLBACK.intent,
        recommended_plan: FALLBACK.plan.map((p, i) => ({ step: i + 1, ...p })),
        note: 'No specialised recipe matched — start with the fallback plan and adapt.',
    };
}

module.exports = { discover, RECIPES };
