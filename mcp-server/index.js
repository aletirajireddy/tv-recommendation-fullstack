/**
 * Trade View Dashboard MCP Server — v3.0 (Agentic Edition)
 * ─────────────────────────────────────────────────────────────────────────────
 * Upgrades over v2 (all 12 enhancements):
 *   1. Streamable HTTP transport (modern MCP spec) alongside legacy SSE
 *   2. prompts/ capability — 6 pre-canned analysis templates
 *   3. Bearer token auth (env-toggled)
 *   4. Tool result cache + in-flight dedup (per-tool TTL)
 *   5. Live event subscriptions — notifications/resources/updated on scan ticks
 *   6. Tool annotations (readOnlyHint / destructiveHint / idempotentHint)
 *   7. write_journal_entry tool (only allowed write, separate DB)
 *   8. Per-session × per-tool sliding-window rate limiter
 *   9. outputSchema on every tool
 *  10. discover_tools_by_intent meta-tool
 *  11. Per-ticker resource templates (ticker://stream-d/{ticker} etc.)
 *  12. /.well-known/mcp.json connector manifest
 *
 * Backwards compatible: legacy SSE transport + all 22 v2 tools work unchanged.
 */

const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    ListResourcesRequestSchema,
    ListResourceTemplatesRequestSchema,
    ReadResourceRequestSchema,
    SubscribeRequestSchema,
    UnsubscribeRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const tools           = require('./tools');
const resources       = require('./resources');
const prompts         = require('./prompts');
const cache           = require('./cache');
const rateLimit       = require('./rateLimit');
const journal         = require('./journal');
const liveEvents      = require('./liveEvents');
const intentDiscovery = require('./intentDiscovery');
const manifest        = require('./manifest');
const auth            = require('./auth');
const { annotations, outputSchemas } = require('./toolMeta');

const app = express();
app.use(express.json({ limit: '4mb' }));

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Mcp-Session-Id', 'X-Request-Id', 'Last-Event-ID', 'MCP-Protocol-Version'],
    exposedHeaders: ['Mcp-Session-Id', 'X-Request-Id'],
}));

// Auth gate (no-op when MCP_AUTH_MODE=disabled — see auth.js)
app.use(auth.authMiddleware);

// ─── Discovery + monitoring (unauthenticated by design) ──────────────────────
app.get('/', (req, res) => res.redirect('/mcp'));

app.get('/mcp', (req, res) => {
    res.json({
        name: 'Trade View Dashboard MCP — v3 (Agentic Edition)',
        version: '3.0.0',
        status: 'Online',
        tools_count: TOOL_DEFINITIONS.length,
        prompts_count: prompts.list().length,
        streams: ['A:MACRO', 'B:SCOUT', 'C:ALERT', 'D:REALTIME'],
        transports: {
            streamable_http: '/mcp/http',
            sse:             '/mcp/sse',
            sse_message:     '/mcp/message',
        },
        endpoints: {
            health:   '/mcp/health',
            stats:    '/mcp/stats',
            manifest: '/.well-known/mcp.json',
        },
        auth_enabled: auth.isEnabled,
    });
});

app.get('/mcp/health', (req, res) => {
    res.json({ status: 'ok', engine: 'mcp-v3', timestamp: new Date().toISOString() });
});

app.get('/mcp/stats', (req, res) => {
    res.json({
        cache:       cache.stats(),
        rate_limit:  rateLimit.stats(),
        live_events: liveEvents.stats(),
        timestamp:   new Date().toISOString(),
    });
});

app.get('/.well-known/mcp.json', (req, res) => {
    const host = `${req.protocol}://${req.get('host')}`;
    res.json(manifest.build(host));
});

// ────────────────────────────────────────────────────────────────────────────
// TOOL DEFINITIONS — base list (kept identical to v2 for back-compat) +
// 2 new v3 tools: discover_tools_by_intent and write_journal_entry.
// Annotations + outputSchema are merged in below from toolMeta.js.
// ────────────────────────────────────────────────────────────────────────────
const TOOL_DEFINITIONS_BASE = [
    // ── MARKET OVERVIEW ──────────────────────────────────────────────────
    { name: 'get_market_sentiment', description: 'Returns current Genie mood score (-100 → +100), label (BULLISH/BEARISH/RANGING/EUPHORIC/PANIC), breadth (bull vs bear coin count), and the last 10 sentiment snapshots to show trend direction. Use this first to calibrate overall market bias before deep-dives.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_market_regime', description: 'Synthesises ALL available signals into a single regime assessment: mood trend, breadth, stream volume activity (last 2h), and active validator trial summary. Returns an ai_interpretation string ready for trading context. This is the fastest way to understand WHAT THE MARKET IS DOING RIGHT NOW.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_top_catalysts', description: 'Returns tickers currently printing Breakout signals (breakout=1) or High Momentum Volume Spikes (momScore≥2 AND volSpike=1) from the latest Stream A scan.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_institutional_pulse', description: 'Returns coins with the highest bar-move anomaly count in the last 24h (institutional footprint detector). High pulse_count + high max_move = strong hidden accumulation/distribution.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_stream_health', description: 'Returns the liveness status (LIVE/FRESH/STALE/DEAD) and last-seen timestamps for all 4 data streams: A (Macro/TradingView scan), B (Scout/watchlist), C (Smart level alerts), D (Real-time EMA push). Use this to check data freshness before making decisions.', inputSchema: { type: 'object', properties: {} } },

    // ── TARGET ANALYSIS ──────────────────────────────────────────────────
    { name: 'analyze_target', description: 'Deep-dive on a specific ticker. Returns: (1) 26-column macro scan status, (2) Stream D EMA cascade matrix with alignment flags (cascade_bullish/cascade_bearish), (3) nearest smart level speedbreakers, (4) active 3rd Umpire Validator trial if any, (5) last 12h volume events. This is the all-in-one single-ticker dossier.', inputSchema: { type: 'object', properties: { ticker: { type: 'string', description: 'Symbol e.g. BTCUSDT.P or SOLUSDT.P' } }, required: ['ticker'] } },
    { name: 'query_master_coin_store', description: 'Returns the event-sourced timeline for a coin (V4 Master Store). Each row is a state snapshot blending all 4 streams. stream_d is normalised EMA cascade matrix.', inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, limit: { type: 'number' } }, required: ['ticker'] } },

    // ── STREAM D / EMA CASCADE ───────────────────────────────────────────
    { name: 'get_stream_d_matrix', description: 'Returns the latest Stream D real-time EMA cascade matrix from TradingView (pushed every ~2 min). Pass a ticker for single-coin detail OR omit for compact summary table across ALL tickers.', inputSchema: { type: 'object', properties: { ticker: { type: 'string' } } } },

    // ── VOLUME & SMART LEVELS ────────────────────────────────────────────
    { name: 'get_volume_events', description: 'Queries the unified volume_events ledger across all streams. source: STREAM_A_EDGE | STREAM_C_ALERT. strength ≥ 1.5 = institutional-grade spike.', inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, source: { type: 'string' }, min_strength: { type: 'number' }, hours: { type: 'number' } } } },
    { name: 'get_volume_buildups', description: 'Returns coins with volSpike=1 from the latest Stream A scan, sorted by momScore. Pre-breakout positioning signals.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_smart_level_reactions', description: 'Queries smart_level_events for price reactions to key levels (Mega Spot, EMA200 key TFs, Fib levels).', inputSchema: { type: 'object', properties: { ticker: { type: 'string' }, direction: { type: 'string' }, hours: { type: 'number' }, limit: { type: 'number' } } } },
    { name: 'get_upcoming_watchers', description: 'Returns tickers within 0.5% of a smart level but NOT yet triggered a Stream C alert. Pre-alert setups.', inputSchema: { type: 'object', properties: {} } },

    // ── VALIDATOR / PATTERN EDGE ─────────────────────────────────────────
    { name: 'get_validated_setups', description: 'Returns active 3rd Umpire Validator trials (WATCHING / EARLY_FAVORABLE / CONFIRMED).', inputSchema: { type: 'object', properties: { state: { type: 'string' } } } },
    { name: 'get_trial_details', description: 'Deep dive into a specific trial. Returns full feature_snapshot + complete state transition log with each rule_snapshot.', inputSchema: { type: 'object', properties: { trial_id: { type: 'string' } }, required: ['trial_id'] } },
    { name: 'get_trial_full_context', description: 'Full forensic dossier for a single trial: trial row + all state transitions + master_coin_store snapshot AT trigger time + 30-min windowed timeline.', inputSchema: { type: 'object', properties: { trial_id: { type: 'string' } }, required: ['trial_id'] } },
    { name: 'get_pattern_stats', description: 'Pre-computed win rate statistics from the validator engine, grouped by direction × trigger_type × vol_filter × ema_align. Primary metric is win_rate_30m.', inputSchema: { type: 'object', properties: { direction: { type: 'string' }, trigger_type: { type: 'string' }, min_samples: { type: 'number' }, min_win_rate: { type: 'number' } } } },

    // ── WATCHLIST / LIFECYCLE ────────────────────────────────────────────
    { name: 'get_master_watchlist', description: 'Returns Stream B scout activity: STABLE-graduated coins, orphaned retries, and coins in the qualification pipeline.', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_coin_lifecycles', description: 'Returns coin maturity tracking: born_at, last_seen_at, death_at, status (ACTIVE / GHOST / DEAD).', inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
    { name: 'get_ghost_approval_queue', description: 'Returns coins awaiting manual GHOST approval with confidence_score and score_breakdown.', inputSchema: { type: 'object', properties: {} } },

    // ── POWER TOOLS ──────────────────────────────────────────────────────
    { name: 'query_technical_filters', description: 'Multi-criteria filter across the latest scan: RSI by TF, EMA200 price position, smart level proximity + confluence count, 26-column macro flags, volume, 24h change %.',
      inputSchema: { type: 'object', properties: {
        rsi:           { type: 'object', properties: { timeframe: { type: 'string' }, operator: { type: 'string' }, value: { type: 'number' } } },
        ema200:        { type: 'object', properties: { timeframe: { type: 'string' }, operator: { type: 'string' } } },
        smart_level:   { type: 'object', properties: { type: { type: 'string' }, max_distance_pct: { type: 'number' }, min_confluence: { type: 'number' } } },
        macro_columns: { type: 'object', additionalProperties: true },
        volume:        { type: 'object', properties: { operator: { type: 'string' }, value: { type: 'number' } } },
        change_pct:    { type: 'object', properties: { operator: { type: 'string' }, value: { type: 'number' } } },
    } } },
    { name: 'get_database_schema', description: 'Returns schema DDL + a human-readable description for every table in dashboard_v3.db. Essential before run_readonly_sql_query.', inputSchema: { type: 'object', properties: {} } },
    { name: 'run_readonly_sql_query', description: 'Executes any SQLite SELECT or WITH query against dashboard_v3.db. Auto-LIMIT 100 if not specified.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },

    // ── v3 ADDITIONS ─────────────────────────────────────────────────────
    {
        name: 'discover_tools_by_intent',
        description: "Meta-tool: pass a natural-language goal (e.g. 'find me a long setup' or 'morning brief') and receive an ordered execution plan listing the exact tools to call, in what order, and why. Cuts agent traces from 8 reasoning steps to 2.",
        inputSchema: { type: 'object', properties: { intent: { type: 'string', description: 'Plain-English description of what you want to know or do' } }, required: ['intent'] },
    },
    {
        name: 'write_journal_entry',
        description: 'Append-only agent memory. Persist observations, conclusions or todos that should survive across sessions. Stored in a separate database — cannot affect trading data. Use after completing analysis to save key insights for later recall.',
        inputSchema: {
            type: 'object',
            properties: {
                title:            { type: 'string', description: 'Short heading (max 200 chars)' },
                body:             { type: 'string', description: 'Markdown-supported body (max 8000 chars)' },
                category:         { type: 'string', description: 'observation | conclusion | todo | note (default: note)' },
                ticker:           { type: 'string', description: 'Optional pivot e.g. BTCUSDT.P — enables ticker-scoped recall' },
                tags:             { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering' },
                related_trial_id: { type: 'string', description: 'Optional trial_id this entry refers to' },
            },
            required: ['title', 'body'],
        },
    },
];

// Merge annotations + outputSchema onto each tool definition.
const TOOL_DEFINITIONS = TOOL_DEFINITIONS_BASE.map(t => ({
    ...t,
    annotations:  annotations[t.name],
    outputSchema: outputSchemas[t.name],
}));

// ────────────────────────────────────────────────────────────────────────────
// MCP SERVER FACTORY — one per transport connection
// ────────────────────────────────────────────────────────────────────────────
function createMcpServer(sessionId) {
    const server = new Server(
        { name: 'trade-view-dashboard', version: '3.0.0' },
        { capabilities: {
            tools:     { listChanged: false },
            resources: { listChanged: false, subscribe: true },
            prompts:   { listChanged: false },
        }}
    );

    // ── tools/list ──────────────────────────────────────────────────────────
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

    // ── prompts ─────────────────────────────────────────────────────────────
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: prompts.list() }));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        return prompts.get(name, args);
    });

    // ── resources ───────────────────────────────────────────────────────────
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [
            { uri: 'market://latest-snapshot',  name: 'Latest Market Snapshot', description: 'Full raw JSON of the latest Stream A scan.', mimeType: 'application/json' },
            { uri: 'market://recent-alerts',    name: 'Recent Pulse Alerts',    description: 'Last 2h of significant volume + smart-level events.', mimeType: 'application/json' },
            { uri: 'market://stream-health',    name: 'Stream Health Status',   description: 'Liveness for all 4 streams.', mimeType: 'application/json' },
            { uri: 'market://active-trials',    name: 'Active Validator Trials',description: 'WATCHING / EARLY_FAVORABLE / CONFIRMED trials.', mimeType: 'application/json' },
            { uri: 'market://journal/recent',   name: 'Recent Agent Journal',   description: 'Last 50 agent journal entries (cross-session memory).', mimeType: 'application/json' },
        ],
    }));

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
        resourceTemplates: resources.listResourceTemplates(),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
        const { uri } = req.params;
        // Try the new ticker:// resolver first
        const text = await resources.resolve(uri);
        if (text != null) return { contents: [{ uri, mimeType: 'application/json', text }] };

        // Legacy market://stream-health and market://active-trials are tool-backed
        if (uri === 'market://stream-health') {
            const r = await tools.getStreamHealth();
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(r, null, 2) }] };
        }
        if (uri === 'market://active-trials') {
            const r = await tools.getValidatedSetups('ALL');
            return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(r, null, 2) }] };
        }
        throw new Error(`Resource not found: ${uri}`);
    });

    // ── subscriptions ───────────────────────────────────────────────────────
    // We only need to ack subscribe/unsubscribe — the live-events module pushes
    // notifications/resources/updated to every active server.
    server.setRequestHandler(SubscribeRequestSchema,   async () => ({}));
    server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));
    liveEvents.subscribe(server);

    // ── tools/call dispatch ────────────────────────────────────────────────
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        // Rate-limit BEFORE anything else
        const rl = rateLimit.check(sessionId, name);
        if (!rl.ok) {
            return {
                isError: true,
                content: [{ type: 'text', text: JSON.stringify({ error: 'rate_limit', ...rl }, null, 2) }],
            };
        }

        try {
            const result = await cache.withCache(name, args, () => _executeTool(name, args, sessionId));
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
            return {
                isError: true,
                content: [{ type: 'text', text: `Error executing tool '${name}': ${err.message}` }],
            };
        }
    });

    return server;
}

// ── Pure tool dispatch (no cache, no rate-limit — those are wrapped above) ──
async function _executeTool(name, args, sessionId) {
    switch (name) {
        // Market overview
        case 'get_market_sentiment':    return await tools.getMarketSentiment();
        case 'get_market_regime':       return await tools.getMarketRegime();
        case 'get_top_catalysts':       return await tools.getTopCatalysts();
        case 'get_institutional_pulse': return await tools.getInstitutionalPulse();
        case 'get_stream_health':       return await tools.getStreamHealth();

        // Target analysis
        case 'analyze_target':          return await tools.analyzeTarget(args.ticker);
        case 'query_master_coin_store': return await tools.queryMasterCoinStore(args.ticker, args.limit);

        // Stream D
        case 'get_stream_d_matrix':     return await tools.getStreamDMatrix(args?.ticker);

        // Volume / smart levels
        case 'get_volume_events':       return await tools.getVolumeEvents(args || {});
        case 'get_volume_buildups':     return await tools.getVolumeBuildup();
        case 'get_smart_level_reactions': return await tools.getSmartLevelReactions(args || {});
        case 'get_upcoming_watchers':   return await tools.getUpcomingWatchers();

        // Validator
        case 'get_validated_setups':    return await tools.getValidatedSetups(args?.state);
        case 'get_trial_details':       return await tools.getTrialDetails(args.trial_id);
        case 'get_trial_full_context':  return await tools.getTrialFullContext(args.trial_id);
        case 'get_pattern_stats':       return await tools.getPatternStats(args || {});

        // Watchlist / lifecycle
        case 'get_master_watchlist':    return await tools.getMasterWatchlist();
        case 'get_coin_lifecycles':     return await tools.getCoinLifecycles(args?.status);
        case 'get_ghost_approval_queue':return await tools.getGhostApprovalQueue();

        // Power
        case 'query_technical_filters': return await tools.queryTechnicalFilters({
            rsi: args?.rsi, ema200: args?.ema200, smart_level: args?.smart_level,
            macro_columns: args?.macro_columns, volume: args?.volume, change_pct: args?.change_pct,
        });
        case 'get_database_schema':     return await tools.getDatabaseSchema();
        case 'run_readonly_sql_query':  return await tools.runReadonlySqlQuery(args.query);

        // v3 additions
        case 'discover_tools_by_intent': return intentDiscovery.discover(args?.intent);
        case 'write_journal_entry':      return journal.write(args || {}, sessionId);

        default: throw new Error(`Unknown tool: ${name}`);
    }
}

// ────────────────────────────────────────────────────────────────────────────
// TRANSPORT 1: Streamable HTTP (modern MCP spec, March 2025+)
// Stateful mode — session ID generated on initialize, returned in headers,
// reused across subsequent requests. One MCP server instance per session.
// ────────────────────────────────────────────────────────────────────────────
const _httpSessions = new Map();   // sessionId → { server, transport }

async function handleStreamableHttp(req, res) {
    try {
        const sessionId = req.get('mcp-session-id');

        // Existing session → reuse its transport
        if (sessionId && _httpSessions.has(sessionId)) {
            const { transport } = _httpSessions.get(sessionId);
            return await transport.handleRequest(req, res, req.body);
        }

        // No session yet — must be an initialize request to mint one
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
                const server = createMcpServer(sid);
                server.connect(transport).catch(err => console.error('[mcp:http] connect error:', err));
                _httpSessions.set(sid, { server, transport });
                console.log(`[mcp:http] session opened: ${sid}`);
            },
        });

        transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid && _httpSessions.has(sid)) {
                const entry = _httpSessions.get(sid);
                liveEvents.unsubscribe(entry.server);
                try { entry.server.close(); } catch {}
                _httpSessions.delete(sid);
                console.log(`[mcp:http] session closed: ${sid}`);
            }
        };

        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        console.error('[mcp:http] handler error:', err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
}

app.post('/mcp/http',   handleStreamableHttp);
app.get('/mcp/http',    handleStreamableHttp);   // server-initiated SSE stream
app.delete('/mcp/http', handleStreamableHttp);   // explicit session close

// ────────────────────────────────────────────────────────────────────────────
// TRANSPORT 2: Legacy SSE (kept for back-compat with v2 clients + Claude
// Desktop installations using the mcp-proxy.js bridge). One server per
// connection; sessionId derived from the SSE transport's internal id.
// ────────────────────────────────────────────────────────────────────────────
let _legacyMcpServer = null;
let _legacyTransport = null;

app.get('/mcp/sse', async (req, res) => {
    if (_legacyMcpServer) {
        try {
            liveEvents.unsubscribe(_legacyMcpServer);
            await _legacyMcpServer.close();
        } catch {}
    }
    const sessionId = `sse-${Date.now()}`;
    _legacyMcpServer = createMcpServer(sessionId);
    _legacyTransport = new SSEServerTransport('/mcp/message', res);
    await _legacyMcpServer.connect(_legacyTransport);
    console.log(`[mcp:sse] legacy session opened: ${sessionId}`);
});

app.post('/mcp/message', async (req, res) => {
    if (!_legacyTransport) return res.status(500).send('Transport not initialised. GET /mcp/sse first.');
    await _legacyTransport.handlePostMessage(req, res);
});

// ────────────────────────────────────────────────────────────────────────────
// BOOT
// ────────────────────────────────────────────────────────────────────────────
liveEvents.start();

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Trade View Dashboard MCP — v3.0 (Agentic Edition)`);
    console.log('═══════════════════════════════════════════════════════════════════');
    console.log(`  Listening on http://localhost:${PORT}`);
    console.log(`  Tools:    ${TOOL_DEFINITIONS.length}    (24 base + 0 reserved)`);
    console.log(`  Prompts:  ${prompts.list().length}`);
    console.log(`  Auth:     ${auth.isEnabled ? 'BEARER (enabled)' : 'OPEN (disabled)'}`);
    console.log('  Transports:');
    console.log(`    • Streamable HTTP : POST/GET/DELETE  /mcp/http`);
    console.log(`    • Legacy SSE      : GET /mcp/sse  +  POST /mcp/message`);
    console.log('  Discovery:');
    console.log(`    • /.well-known/mcp.json   (manifest)`);
    console.log(`    • /mcp/health             (liveness)`);
    console.log(`    • /mcp/stats              (cache + rate-limit + live-events)`);
    console.log(`  Journal DB: ${journal.dbPath}`);
    console.log('═══════════════════════════════════════════════════════════════════');
});

process.on('SIGTERM', () => { journal.close(); process.exit(0); });
process.on('SIGINT',  () => { journal.close(); process.exit(0); });
