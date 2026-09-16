const express = require('express');
const cors = require('cors');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const tools = require('./tools');
const resources = require('./resources');

const app = express();

// 1. Enhanced CORS for Cloud/AI Connectors
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Mcp-Session-Id', 'X-Request-Id'],
    exposedHeaders: ['Mcp-Session-Id', 'X-Request-Id']
}));

app.get('/mcp', (req, res) => {
    res.json({
        name: "Trade View Dashboard MCP — v4",
        version: "4.0.0",
        status: "Online",
        tools_count: 28,
        streams: ["A:MACRO", "B:SCOUT", "C:ALERT", "D:REALTIME"],
        endpoints: { sse: "/mcp/sse", message: "/mcp/message", health: "/mcp/health" },
        transport: "sse",
        v4_additions: [
            "get_momentum_pulse",
            "get_rsi_cascade_grid",
            "get_cascade_chip_summary",
            "get_ema_distance_board",
            "get_smart_alerts_list",
        ],
    });
});

app.get('/mcp/health', (req, res) => {
    res.json({ status: 'ok', engine: 'mcp-sse-v2', timestamp: new Date() });
});

let mcpServer = null;
let transport = null;

function createMcpServer() {
    const server = new Server({
        name: "trade-view-dashboard",
        version: "2.0.0"
    }, {
        capabilities: { tools: {}, resources: {} }
    });

    // ── TOOL REGISTRY ────────────────────────────────────────────────────────
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            // ── MARKET OVERVIEW ──────────────────────────────────────────────
            {
                name: "get_market_sentiment",
                description: "Returns current Genie mood score (-100 → +100), label (BULLISH/BEARISH/RANGING/EUPHORIC/PANIC), breadth (bull vs bear coin count), and the last 10 sentiment snapshots to show trend direction. Use this first to calibrate overall market bias before deep-dives.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_market_regime",
                description: "Synthesises ALL available signals into a single regime assessment: mood trend, breadth, stream volume activity (last 2h), and active validator trial summary. Returns an ai_interpretation string ready for trading context. This is the fastest way to understand WHAT THE MARKET IS DOING RIGHT NOW.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_top_catalysts",
                description: "Returns tickers currently printing Breakout signals (breakout=1) or High Momentum Volume Spikes (momScore≥2 AND volSpike=1) from the latest Stream A scan.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_institutional_pulse",
                description: "Returns coins with the highest bar-move anomaly count in the last 24h (institutional footprint detector). High pulse_count + high max_move = strong hidden accumulation/distribution.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_stream_health",
                description: "Returns the liveness status (LIVE/FRESH/STALE/DEAD) and last-seen timestamps for all 4 data streams: A (Macro/TradingView scan), B (Scout/watchlist), C (Smart level alerts), D (Real-time EMA push). Use this to check data freshness before making decisions.",
                inputSchema: { type: "object", properties: {} }
            },

            // ── TARGET ANALYSIS ──────────────────────────────────────────────
            {
                name: "analyze_target",
                description: "Deep-dive on a specific ticker. Returns: (1) 26-column macro scan status, (2) Stream D EMA cascade matrix with alignment flags (cascade_bullish/cascade_bearish), (3) nearest smart level speedbreakers, (4) active 3rd Umpire Validator trial if any, (5) last 12h volume events. This is the all-in-one single-ticker dossier.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ticker: { type: "string", description: "Symbol e.g. BTCUSDT.P or SOLUSDT.P" }
                    },
                    required: ["ticker"]
                }
            },
            {
                name: "query_master_coin_store",
                description: "Returns the event-sourced timeline for a coin (V4 Master Store). Each row is a state snapshot blending all 4 streams. stream_d is normalised EMA cascade matrix. Use this for historical context — 'what happened to BTCUSDT.P in the last hour across all streams?'",
                inputSchema: {
                    type: "object",
                    properties: {
                        ticker: { type: "string", description: "Symbol e.g. BTCUSDT.P" },
                        limit:  { type: "number", description: "Number of snapshots (default 10, max 100)" }
                    },
                    required: ["ticker"]
                }
            },

            // ── STREAM D / EMA CASCADE ───────────────────────────────────────
            {
                name: "get_stream_d_matrix",
                description: "Returns the latest Stream D real-time EMA cascade matrix from TradingView (pushed every ~2 min). Fields: price, rsi (m5/m15), ema_200 (m1/m5/m15), ema_alignment (cascade_bullish / cascade_bearish / pct_vs_ema200_m5), relative_volume_1h, atr_pct. Pass a ticker for single-coin detail OR omit for compact summary table across ALL tickers. Critical for answering 'is EMA cascade aligned for LONG/SHORT?'",
                inputSchema: {
                    type: "object",
                    properties: {
                        ticker: { type: "string", description: "Optional. Symbol e.g. BTCUSDT.P. Omit to get all tickers." }
                    }
                }
            },

            // ── VOLUME & SMART LEVELS ────────────────────────────────────────
            {
                name: "get_volume_events",
                description: "Queries the unified volume_events ledger across all streams. source: STREAM_A_EDGE (macro bar anomaly) | STREAM_C_ALERT (smart level reaction). strength ≥ 1.5 = institutional-grade spike. meta has price + direction. Use to answer 'which coins had strong volume in the last N hours?' or 'show me all STREAM_C volume events today'.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ticker:       { type: "string", description: "Optional — filter by ticker symbol" },
                        source:       { type: "string", description: "Optional — STREAM_A_EDGE or STREAM_C_ALERT" },
                        min_strength: { type: "number", description: "Optional — minimum strength score (e.g. 1.5 for strong spikes only)" },
                        hours:        { type: "number", description: "Time window in hours (default 24)" }
                    }
                }
            },
            {
                name: "get_volume_buildups",
                description: "Returns coins with volSpike=1 from the latest Stream A scan, sorted by momScore. These are institutional accumulation candidates in active build-up — pre-breakout positioning signals.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_smart_level_reactions",
                description: "Queries smart_level_events for price reactions to key levels (Mega Spot, EMA200 key TFs, Fib levels). Each event has ticker, timestamp, price, direction (BULL/BEAR), roc_pct (rate of change), and level_type. Use to answer 'which coins bounced from smart levels today?' or 'show all BEAR reactions in the last 6 hours'.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ticker:    { type: "string", description: "Optional — filter by ticker" },
                        direction: { type: "string", description: "Optional — BULL or BEAR" },
                        hours:     { type: "number", description: "Time window in hours (default 24)" },
                        limit:     { type: "number", description: "Max results (default 20)" }
                    }
                }
            },
            {
                name: "get_upcoming_watchers",
                description: "Returns tickers within 0.5% of a smart level (Mega Spot, 4H EMA200, 1H EMA200, Daily Res/Supp) but NOT yet triggered a Stream C alert. These are pre-alert setups to position before the event fires.",
                inputSchema: { type: "object", properties: {} }
            },

            // ── VALIDATOR / PATTERN EDGE ─────────────────────────────────────
            {
                name: "get_validated_setups",
                description: "Returns active 3rd Umpire Validator trials (WATCHING / EARLY_FAVORABLE / CONFIRMED). Each trial has direction, trigger_type (BREAKOUT/BOUNCE), level_type, trigger_price, latest_move (P&L), AND the latest rule_snapshot showing which EMA cascade rules passed/failed. These are actionable setups with defined entry and invalidation.",
                inputSchema: {
                    type: "object",
                    properties: {
                        state: { type: "string", description: "WATCHING | EARLY_FAVORABLE | CONFIRMED | ALL (default ALL active)" }
                    }
                }
            },
            {
                name: "get_trial_details",
                description: "Deep dive into a specific trial. Returns full feature_snapshot (market context at detection) + complete state transition log with each rule_snapshot. Use this for 'why did this trial fail?' forensics.",
                inputSchema: {
                    type: "object",
                    properties: {
                        trial_id: { type: "string", description: "trial_id from get_validated_setups" }
                    },
                    required: ["trial_id"]
                }
            },
            {
                name: "get_trial_full_context",
                description: "Full forensic dossier for a single trial: trial row + all state transitions (rule snapshots) + master_coin_store snapshot AT trigger time + 30-min windowed timeline before/after. Use this to ask 'what was the market doing when this trial triggered and why did it resolve the way it did?' — single round-trip, all context.",
                inputSchema: {
                    type: "object",
                    properties: {
                        trial_id: { type: "string", description: "Trial identifier e.g. trial_BTCUSDT.P_1745580000000" }
                    },
                    required: ["trial_id"]
                }
            },
            {
                name: "get_pattern_stats",
                description: "Pre-computed win rate statistics from the validator engine, grouped by direction × trigger_type × vol_filter × ema_align. Primary metric is win_rate_30m. Use this to assess historical edge for a setup combination BEFORE entering. E.g. 'what is the win rate for LONG BOUNCE setups with vol_filter=1?'",
                inputSchema: {
                    type: "object",
                    properties: {
                        direction:    { type: "string", description: "LONG or SHORT" },
                        trigger_type: { type: "string", description: "BREAKOUT or BOUNCE" },
                        min_samples:  { type: "number", description: "Minimum sample count for statistical reliability (default 3)" },
                        min_win_rate: { type: "number", description: "Minimum win_rate_30m % to include (default 0)" }
                    }
                }
            },

            // ── WATCHLIST / LIFECYCLE ────────────────────────────────────────
            {
                name: "get_master_watchlist",
                description: "Returns Stream B scout activity: coins graduated to STABLE status (confirmed watchlist), orphaned retries, and coins currently in the qualification pipeline (last 2h of area1_scout_logs).",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_coin_lifecycles",
                description: "Returns coin maturity tracking: born_at, last_seen_at, death_at, status (ACTIVE / GHOST / DEAD). Use to answer 'how long has BTCUSDT.P been tracked?' or 'which coins are currently ghosted?'",
                inputSchema: {
                    type: "object",
                    properties: {
                        status: { type: "string", description: "ACTIVE | GHOST | DEAD | ALL (default ALL)" }
                    }
                }
            },
            {
                name: "get_ghost_approval_queue",
                description: "Returns coins that failed their confidence-clock judgment (Frozen / Sustained Low Score / Ghost Volume / no momentum) and are sitting in a shared ghost_hours redemption window (default 36h) before a final outcome.\n\n2026-09-16 redesign: this window now applies in BOTH ghost_auto_approve modes -- it is NOT 'awaiting manual approval' by itself. Each row includes age_min, remaining_min, and outcome_at_expiry ('removed from watchlist' | 'recycled (clock resets, stays on watchlist)' | 'protected (whitelisted -- immune)') so you can tell exactly what happens and when, per coin. Top-level ghost_auto_approve and ghost_hours give the mode/window currently in effect. Use get_watchdog_settings for the full settle/ghost/momentum/gap-tolerance picture.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_watchdog_settings",
                description: "Returns the confidence-clock / ghost-window settings in one call: settle_hours (age before a coin is ever judged), ghost_hours (redemption window after failing judgment -- both ghost_auto_approve modes as of 2026-09-16), momentum_hours (post-graduation grace window), gap_tolerance_min (scan gap that triggers a system-wide clock reset), ghost_auto_approve, fresh_session_veto_mode, and total_window_hours_if_auto (settle+ghost combined -- the worst-case time from a coin's own clock start to actual removal when auto-prune is ON).",
                inputSchema: { type: "object", properties: {} }
            },

            // ── STREAM D METRICS (RSI / RVOL / ATR / EMA-DIST) ───────────────
            {
                name: "get_coin_metrics",
                description: "*** PRIMARY TOOL FOR RSI, RVOL, ATR, EMA-DISTANCE QUERIES ***\n\nReads from coin_metric_history — the authoritative Stream D rolling table (2-min buckets, 8h window). Returns RSI m5/m15/m30/h1, RVOL m15/h1, ATR% m15/h1/h4, and EMA200 distance% m1–h4 (positive = price above EMA).\n\nIncludes a pre-computed rsi_cascade field: MULTI_TF_OVERSOLD | MULTI_TF_OVERBOUGHT | BEAR_RSI_CASCADE | BULL_RSI_CASCADE | OVERSOLD_15M | OVERBOUGHT_15M | NEUTRAL.\n\nCRITICAL: Do NOT use unified_alerts.rsi_matrix or stream_c_state.rsi_matrix for RSI — those are Stream C snapshot values frozen at alert time. This table is the ONLY correct RSI source.\n\nUse get_stream_d_matrix for raw EMA cascade price values (for stacking direction). Use this tool for zone/threshold RSI queries.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ticker:      { type: "string", description: "Optional. e.g. BTCUSDT.P — omit to get all active coins" },
                        hours:       { type: "number", description: "Lookback window in hours (default 0.5, max 8). Table is pruned beyond 8h." },
                        latest_only: { type: "boolean", description: "true (default) = one row per ticker (current state). false = full time-series for one ticker (requires ticker param)." }
                    }
                }
            },

            // ── COMPOSITE MOMENTUM & CASCADE (v4) ────────────────────────────
            {
                name: "get_momentum_pulse",
                description: "*** MOST ACTIONABLE TOOL FOR 'WHAT SHOULD I TRADE RIGHT NOW?' ***\n\nReturns coins with pre-computed composite momentum signals: SURGING (rvolPersist≥5 + change>2% + dist>1%), BUILDING (rvolPersist≥3 + change>0), RSI_OS (multi-TF oversold bounce), RSI_OB (multi-TF overbought fade), FADING (losing volume), EXTENDED (>4% above EMA without volume — mean-reversion risk), STRETCHED (capitulation low), AT_EMA (decision zone), WATCH.\n\nCombines Stream C session metrics (today_change_pct, today_volume, momentum.roc_pct) with Stream D rolling history (rvol_m15 persistence, atr_m15, dist_m15, RSI). Sorted by signal strength then |change%|.\n\nUse this FIRST when looking for active setups.",
                inputSchema: {
                    type: "object",
                    properties: {
                        signal:         { type: "string", description: "Optional — filter by exact signal: SURGING | BUILDING | RSI_OS | RSI_OB | FADING | EXTENDED | STRETCHED | AT_EMA | WATCH" },
                        min_change_pct: { type: "number", description: "Optional — minimum |today_change_pct|" },
                        rvol_thresh:    { type: "number", description: "RVOL threshold for persistence calculation (default 1.2)" },
                        limit:          { type: "number", description: "Max results (default 50)" }
                    }
                }
            },
            {
                name: "get_rsi_cascade_grid",
                description: "Per-coin RSI cascade state across multiple TFs (default h1+m30 series, m15 temp). Returns:\n• BEAR_CASCADE — ALL series TFs oversold (<30) — strong bearish alignment\n• BULL_CASCADE — ALL series TFs overbought (>70) — strong bullish alignment\n• PARTIAL_BEAR / PARTIAL_BULL — partial alignment\n• NEUTRAL\n• pullback flag = cascade active AND temp TF RSI near 50 (potential trend-continuation entry)\n\nUse for trend-alignment screening (e.g. 'find all coins in BEAR_CASCADE with a pullback' for short-the-bounce setups).",
                inputSchema: {
                    type: "object",
                    properties: {
                        series_tfs:    { type: "string", description: "Comma-separated cascade TFs (default 'h1,m30'). Options: m5, m15, m30, h1" },
                        temp_tf:       { type: "string", description: "Temp/wick TF (default 'm15')" },
                        oversold:      { type: "number", description: "Oversold threshold (default 30)" },
                        overbought:    { type: "number", description: "Overbought threshold (default 70)" },
                        pullback_zone: { type: "number", description: "Pullback distance from RSI 50 (default 5)" },
                        filter:        { type: "string", description: "Optional — 'bear' | 'bull' | 'pullback' to filter results" }
                    }
                }
            },
            {
                name: "get_cascade_chip_summary",
                description: "Snapshot of the 4 EMA cascade chip categories (matches Cascade Flow widget):\n• LONG BULL — h4→h1→m15 bullish cascade\n• LONG BEAR — h4→h1→m15 bearish cascade\n• SHORT BULL ↗ — m5→m1 bullish (counter-rally or aligned)\n• SHORT BEAR ↘ — m5→m1 bearish (pullback or aligned)\n\nA coin can appear in BOTH a long AND a short chip — e.g. Long Bull + Short Bear = pullback inside uptrend (institutional accumulation pattern).\n\nReturns regime score (-100 to +100 weighted), Wyckoff-style phase (BULL_DOMINANCE / BEAR_DOMINANCE / TRANSITION / CONSOLIDATION), and the actual ticker lists in each chip. Use to assess overall market regime.",
                inputSchema: {
                    type: "object",
                    properties: {
                        long_series:     { type: "string", description: "Comma-separated long cascade TFs (default 'h4,h1,m15')" },
                        short_series:    { type: "string", description: "Comma-separated short cascade TFs (default 'm5,m1')" },
                        equal_threshold: { type: "number", description: "% threshold for treating adjacent EMAs as equal (default 0.2)" }
                    }
                }
            },
            {
                name: "get_ema_distance_board",
                description: "Multi-coin EMA200 distance % across all 5 timeframes (m1, m5, m15, h1, h4). Positive = price above EMA200 (bullish), negative = below (bearish). Sorted by overall bullish bias. Optionally filter to coins near their EMA (low max_dist_pct) for mean-reversion candidates, or far above/below for extended setups.\n\nUse for board-style screening: 'find coins close to all their EMAs' (low volatility coil) or 'find coins extended on all TFs' (overextension).",
                inputSchema: {
                    type: "object",
                    properties: {
                        ticker:        { type: "string", description: "Optional — single ticker. Omit for all." },
                        max_dist_pct:  { type: "number", description: "Filter: max absolute distance % on any TF (default 10)" },
                        active_min:    { type: "number", description: "Only include coins with data in last N minutes (default 60)" },
                        limit:         { type: "number", description: "Max results (default 60)" }
                    }
                }
            },
            {
                name: "get_smart_alerts_list",
                description: "Returns user-created Smart Alerts — custom alerts on price, RSI, EMA distance, volume, or any combination tracked across all 4 streams. State machine: ACTIVE (watching) → TRIGGERED (fired) → DISMISSED (manually removed). Use this to see what conditions the user is actively monitoring.",
                inputSchema: {
                    type: "object",
                    properties: {
                        state: { type: "string", description: "ACTIVE | TRIGGERED | DISMISSED | ALL (default ACTIVE)" },
                        limit: { type: "number", description: "Max results (default 50)" }
                    }
                }
            },

            // ── POWER TOOLS ──────────────────────────────────────────────────
            {
                name: "query_technical_filters",
                description: "Multi-criteria filter across active coins. RSI filter reads from coin_metric_history (Stream D — correct). Supports: RSI by timeframe (m5/m15/m30/h1), EMA200 price position (above/below by TF), smart level proximity + confluence count, 26-column macro flags (breakout/volSpike/momScore), volume filter, and 24h change %. Combine criteria to find setups like 'RSI < 35 on m15 AND within 2% of any smart level'.",
                inputSchema: {
                    type: "object",
                    properties: {
                        rsi: {
                            type: "object",
                            description: "RSI filter",
                            properties: {
                                timeframe: { type: "string", description: "m5 | m15 | m30 | h1 | h4" },
                                operator:  { type: "string", description: "> or <" },
                                value:     { type: "number" }
                            }
                        },
                        ema200: {
                            type: "object",
                            description: "EMA200 price-vs-level filter",
                            properties: {
                                timeframe: { type: "string", description: "m5 | m15 | h1 | h4" },
                                operator:  { type: "string", description: "> (price above EMA) or < (price below EMA)" }
                            }
                        },
                        smart_level: {
                            type: "object",
                            description: "Smart Level proximity + optional confluence count",
                            properties: {
                                type:            { type: "string", description: "MEGA_SPOT | EMA200 | EMA50 | FIB | LOGIC | ANY" },
                                max_distance_pct: { type: "number", description: "Max absolute distance % (e.g. 2 = within ±2%)" },
                                min_confluence:  { type: "number", description: "Min number of levels within distance (e.g. 2 = strong confluence block)" }
                            }
                        },
                        macro_columns: {
                            type: "object",
                            description: "Match 26-column macro flags from latest scan. Pass exact value (e.g. { breakout: 1 }) or operator (e.g. { momScore: { operator: '>', value: 1 } })",
                            additionalProperties: true
                        },
                        volume: {
                            type: "object",
                            description: "24h volume filter",
                            properties: {
                                operator: { type: "string", description: "> or <" },
                                value:    { type: "number" }
                            }
                        },
                        change_pct: {
                            type: "object",
                            description: "24h price change % filter",
                            properties: {
                                operator: { type: "string", description: "> or <" },
                                value:    { type: "number" }
                            }
                        }
                    }
                }
            },
            {
                name: "get_database_schema",
                description: "Returns schema DDL + a human-readable description for every table in dashboard_v3.db. Use this to understand what data is available before writing a custom SQL query. Essential starting point for run_readonly_sql_query.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "run_readonly_sql_query",
                description: "Executes any SQLite SELECT (or WITH CTE) query against dashboard_v3.db. Auto-appended LIMIT 100 if not specified. Use for complex historical patterns, cross-table joins, or ad-hoc analysis not covered by other tools. Always call get_database_schema first if unsure of table/column names.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "A valid SQLite SELECT or WITH statement" }
                    },
                    required: ["query"]
                }
            },
        ]
    }));

    // ── RESOURCE REGISTRY ────────────────────────────────────────────────────
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [
            {
                uri:         "market://latest-snapshot",
                name:        "Latest Market Snapshot",
                description: "Full raw JSON blob of the latest active Stream A market sweep (all tickers + 26-column data)."
            },
            {
                uri:         "market://recent-alerts",
                name:        "Recent Pulse Alerts",
                description: "Summary of the last 2 hours of significant volume alerts and smart level events."
            },
            {
                uri:         "market://stream-health",
                name:        "Stream Health Status",
                description: "Liveness of all 4 data streams (A/B/C/D) from ingestion timestamps — LIVE / FRESH / STALE / DEAD."
            },
            {
                uri:         "market://active-trials",
                name:        "Active Validator Trials",
                description: "All currently WATCHING / EARLY_FAVORABLE / CONFIRMED 3rd Umpire Validator trials with inline rule evaluations."
            },
        ]
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;

        if (uri === "market://latest-snapshot") {
            const text = await resources.getLatestSnapshot();
            return { contents: [{ uri, mimeType: "application/json", text }] };
        }
        if (uri === "market://recent-alerts") {
            const text = await resources.getRecentAlerts();
            return { contents: [{ uri, mimeType: "application/json", text }] };
        }
        if (uri === "market://stream-health") {
            const result = await tools.getStreamHealth();
            return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }] };
        }
        if (uri === "market://active-trials") {
            const result = await tools.getValidatedSetups('ALL');
            return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(result, null, 2) }] };
        }

        throw new Error(`Resource not found: ${uri}`);
    });

    // ── TOOL DISPATCH ────────────────────────────────────────────────────────
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        let result = null;

        try {
            switch (name) {
                // Market overview
                case 'get_market_sentiment':    result = await tools.getMarketSentiment(); break;
                case 'get_market_regime':       result = await tools.getMarketRegime(); break;
                case 'get_top_catalysts':       result = await tools.getTopCatalysts(); break;
                case 'get_institutional_pulse': result = await tools.getInstitutionalPulse(); break;
                case 'get_stream_health':       result = await tools.getStreamHealth(); break;

                // Target analysis
                case 'analyze_target':          result = await tools.analyzeTarget(args.ticker); break;
                case 'query_master_coin_store': result = await tools.queryMasterCoinStore(args.ticker, args.limit); break;

                // Stream D / EMA cascade
                case 'get_stream_d_matrix':     result = await tools.getStreamDMatrix(args?.ticker); break;

                // Volume & smart levels
                case 'get_volume_events':       result = await tools.getVolumeEvents(args || {}); break;
                case 'get_volume_buildups':     result = await tools.getVolumeBuildup(); break;
                case 'get_smart_level_reactions': result = await tools.getSmartLevelReactions(args || {}); break;
                case 'get_upcoming_watchers':   result = await tools.getUpcomingWatchers(); break;

                // Validator / pattern edge
                case 'get_validated_setups':    result = await tools.getValidatedSetups(args?.state); break;
                case 'get_trial_details':       result = await tools.getTrialDetails(args.trial_id); break;
                case 'get_trial_full_context':  result = await tools.getTrialFullContext(args.trial_id); break;
                case 'get_pattern_stats':       result = await tools.getPatternStats(args || {}); break;

                // Watchlist / lifecycle
                case 'get_master_watchlist':    result = await tools.getMasterWatchlist(); break;
                case 'get_coin_lifecycles':     result = await tools.getCoinLifecycles(args?.status); break;
                case 'get_ghost_approval_queue': result = await tools.getGhostApprovalQueue(); break;
                case 'get_watchdog_settings':    result = await tools.getWatchdogSettings(); break;

                // NEW v4 — Composite momentum & cascade
                case 'get_momentum_pulse':       result = await tools.getMomentumPulse(args || {}); break;
                case 'get_rsi_cascade_grid':     result = await tools.getRsiCascadeGrid(args || {}); break;
                case 'get_cascade_chip_summary': result = await tools.getCascadeChipSummary(args || {}); break;
                case 'get_ema_distance_board':   result = await tools.getEmaDistanceBoard(args || {}); break;
                case 'get_smart_alerts_list':    result = await tools.getSmartAlertsList(args || {}); break;

                // Power tools
                case 'query_technical_filters': result = await tools.queryTechnicalFilters({
                    rsi:           args?.rsi,
                    ema200:        args?.ema200,
                    smart_level:   args?.smart_level,
                    macro_columns: args?.macro_columns,
                    volume:        args?.volume,
                    change_pct:    args?.change_pct,
                }); break;
                case 'get_coin_metrics':        result = await tools.getCoinMetrics(args || {}); break;
                case 'get_database_schema':     result = await tools.getDatabaseSchema(); break;
                case 'run_readonly_sql_query':  result = await tools.runReadonlySqlQuery(args.query); break;

                default:
                    throw new Error(`Unknown tool: ${name}`);
            }

            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch(err) {
            return {
                isError: true,
                content: [{ type: "text", text: `Error executing tool '${name}': ${err.message}` }]
            };
        }
    });

    return server;
}

// ── SSE TRANSPORT ────────────────────────────────────────────────────────────
app.get('/mcp/sse', async (req, res) => {
    if (mcpServer) {
        try { await mcpServer.close(); } catch(e) {}
    }
    mcpServer = createMcpServer();
    transport = new SSEServerTransport('/mcp/message', res);
    await mcpServer.connect(transport);
});

app.post('/mcp/message', async (req, res) => {
    if (!transport) {
        return res.status(500).send("Transport not initialized. Connect to /mcp/sse first.");
    }
    await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 MCP Express Server v4 running on HTTP!`);
    console.log(`👉 SSE endpoint: http://localhost:${PORT}/mcp/sse`);
    console.log(`📡 28 tools registered across 4 stream sources (A/B/C/D)`);
    console.log(`   + v4: momentum_pulse, rsi_cascade_grid, cascade_chip_summary, ema_distance_board, smart_alerts_list`);
    console.log(`🌐 Tailscale: route Funnel to localhost:${PORT}`);
});
