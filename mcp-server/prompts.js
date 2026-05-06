/**
 * Pre-canned analysis prompts
 * ─────────────────────────────────────────────────────────────────────────────
 * Exposed via MCP `prompts/` capability. Claude Desktop surfaces these as
 * slash commands (e.g. `/market_morning_brief`); Cursor exposes them in the
 * model picker. Massive UX win for non-technical users.
 *
 * Each prompt returns a "messages" array (MCP spec) — a multi-turn skeleton
 * the model fills in by calling the suggested tools. The `arguments` field
 * lets users template values (e.g. {ticker} → BTCUSDT.P).
 */

const PROMPTS = [
    {
        name: 'market_morning_brief',
        description: 'A 60-second morning market brief: regime, breadth, top catalysts, active validator setups, and notable risk events. Use this as the first prompt of a trading session.',
        arguments: [],
        build: () => ([
            { role: 'user', content: { type: 'text', text:
`Give me a concise morning market brief in this exact order:

1. **Regime** — Call get_market_regime and report the regime label + ai_interpretation.
2. **Breadth** — From get_market_sentiment: how many coins are bullish vs bearish? What's the trend over the last 10 snapshots?
3. **Stream Health** — Call get_stream_health. If anything is STALE or DEAD, flag it as DATA RISK at the top.
4. **Top Catalysts** — From get_top_catalysts: list breakouts and high-momentum vol spikes.
5. **Active Setups** — From get_validated_setups: list every WATCHING / EARLY_FAVORABLE / CONFIRMED trial with direction + latest_move.
6. **Bottom line** — One sentence: what should I be doing in the next hour?

Format as markdown with headers. Keep it under 400 words total.` } }
        ])
    },

    {
        name: 'explain_ticker',
        description: 'Full forensic dossier for a single ticker — macro state, EMA cascade, smart levels, active trials, recent volume events, and an AI-generated bias. Replaces 6 separate tool calls.',
        arguments: [
            { name: 'ticker', description: 'Symbol (e.g. BTCUSDT.P)', required: true }
        ],
        build: ({ ticker }) => ([
            { role: 'user', content: { type: 'text', text:
`Build a complete dossier for ${ticker}:

1. Call analyze_target("${ticker}") for the all-in-one snapshot.
2. Call get_stream_d_matrix("${ticker}") for the EMA cascade detail.
3. Call get_volume_events({ ticker: "${ticker}", hours: 12 }) for the last 12h volume.
4. Call query_master_coin_store({ ticker: "${ticker}", limit: 20 }) for recent state evolution.

Then synthesise into:
- **Position vs Key Levels** (price relative to Mega Spot / EMA200 / Fib)
- **EMA Cascade Verdict** (bullish-aligned / bearish-aligned / mixed — cite which TFs)
- **Volume Profile** (any institutional spikes? source mix?)
- **Active Trial** (if any: state, latest_move, rules passing/failing)
- **Tactical Bias** (LONG / SHORT / WAIT — single sentence with invalidation level)

If any data stream is STALE for this ticker, flag it explicitly.` } }
        ])
    },

    {
        name: 'find_setups_now',
        description: 'Scan all live data and surface the 3 highest-probability setups (long and short) right now, ranked by edge. Combines validator output + pattern stats.',
        arguments: [
            { name: 'direction', description: 'LONG, SHORT, or BOTH (default BOTH)', required: false }
        ],
        build: ({ direction = 'BOTH' } = {}) => ([
            { role: 'user', content: { type: 'text', text:
`Find me the top 3 ${direction === 'BOTH' ? 'LONG or SHORT' : direction} setups available right now.

Procedure:
1. Call get_validated_setups("WATCHING") and ("EARLY_FAVORABLE").
2. For each candidate, call get_pattern_stats with its (direction, trigger_type) to get historical win_rate_30m.
3. Rank candidates by: latest_move momentum × win_rate_30m × number of passing rules.
4. Filter out anything with win_rate_30m < 50% or sample_count < 5.
5. Return the top 3 with: ticker, direction, trigger_price, level, win rate, current move, and the single most important rule that just passed/failed.

Output as a markdown table. Tie-break by recency.` } }
        ])
    },

    {
        name: 'why_did_trial_fail',
        description: 'Forensic post-mortem for a single trial — what state transitions happened, which rules failed when, and what the market context was at each step.',
        arguments: [
            { name: 'trial_id', description: 'Trial identifier from get_validated_setups', required: true }
        ],
        build: ({ trial_id }) => ([
            { role: 'user', content: { type: 'text', text:
`Run a forensic post-mortem for trial ${trial_id}.

1. Call get_trial_full_context("${trial_id}") for the complete dossier (trial row + state log + master snapshot at trigger + 30-min windowed timeline).
2. Walk through the state_log chronologically. For each transition, identify which rule(s) flipped and what the price action was doing in the 30-min window context.
3. Identify the single failure point — the moment the trial's outcome was sealed.
4. Compare the master_state at trigger vs at resolution: what changed materially?
5. End with a one-line lesson: "Next time, look for X before entering Y setups."

Be specific with prices, percentages, and timestamps.` } }
        ])
    },

    {
        name: 'risk_check',
        description: 'Quick risk scan: stream health, mood swings, ghost queue, and any rapid sentiment reversals. Use before sizing up positions.',
        arguments: [],
        build: () => ([
            { role: 'user', content: { type: 'text', text:
`Run a 4-point risk check before I size positions.

1. **Data integrity** — get_stream_health. Any STALE/DEAD stream is an immediate downgrade.
2. **Sentiment volatility** — get_market_sentiment trend array. Look at the delta between snapshot[0] and snapshot[9]. Any move >40 points = unstable conditions.
3. **Ghost queue** — get_ghost_approval_queue. Coins becoming inactive en masse signals broad de-risking.
4. **Active vs resolved trial mix** — get_validated_setups("ALL"). Compute confirmed_pct = CONFIRMED / (CONFIRMED+FAILED) over the last few resolved. <40% means setups are not paying — tighten filters.

Output: one of GREEN / YELLOW / RED with one-sentence justification per point.` } }
        ])
    },

    {
        name: 'sql_explorer',
        description: 'Guides the model to safely answer ad-hoc data questions using the read-only SQL tool. Always inspects schema first.',
        arguments: [
            { name: 'question', description: 'Plain-English question about the data', required: true }
        ],
        build: ({ question }) => ([
            { role: 'user', content: { type: 'text', text:
`Answer this question using the database: "${question}"

Procedure (don't skip):
1. Call get_database_schema first if you don't already know the relevant tables.
2. Write a single CTE-based read-only SQL query.
3. Call run_readonly_sql_query with it.
4. Interpret the rows in plain English (include numbers, not just narrative).
5. If the result is empty or surprising, suggest a one-line follow-up query.

Never invent column names — if unsure, re-check the schema.` } }
        ])
    },
];

const _byName = new Map(PROMPTS.map(p => [p.name, p]));

function list() {
    return PROMPTS.map(p => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
    }));
}

function get(name, args) {
    const p = _byName.get(name);
    if (!p) throw new Error(`Unknown prompt: ${name}`);
    // Validate required args
    for (const a of p.arguments) {
        if (a.required && (args == null || args[a.name] == null || args[a.name] === '')) {
            throw new Error(`Prompt "${name}" requires argument: ${a.name}`);
        }
    }
    return {
        description: p.description,
        messages: p.build(args || {}),
    };
}

module.exports = { list, get, PROMPTS };
