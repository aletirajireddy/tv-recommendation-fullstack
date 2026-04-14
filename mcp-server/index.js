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
    origin: '*', // Allow Perplexity/OpenAI/Claude to connect
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Mcp-Session-Id', 'X-Request-Id'],
    exposedHeaders: ['Mcp-Session-Id', 'X-Request-Id']
}));

// 2. Add a Landing Page/Root for /mcp to avoid 404 HTML errors
app.get('/mcp', (req, res) => {
    res.json({
        name: "Trade View Dashboard MCP",
        status: "Online",
        endpoints: {
            sse: "/mcp/sse",
            message: "/mcp/message",
            health: "/mcp/health"
        },
        transport: "sse"
    });
});

app.get('/mcp/health', (req, res) => {
    res.json({ status: 'ok', engine: 'mcp-sse', timestamp: new Date() });
});

let mcpServer = null;
let transport = null;

function createMcpServer() {
    const server = new Server({
        name: "trade-view-dashboard",
        version: "1.0.0"
    }, {
        capabilities: {
            tools: {},
            resources: {}
        }
    });

    // Configure MCP Tools
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "get_market_sentiment",
                description: "Gets the current market mood, sentiment score, and breadth analysis (number of bullish vs bearish coins) as defined by the Genie Math.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_master_watchlist",
                description: "Returns the active list of coins being tracked by the dashboard and those that have recently graduated the Momentum Prune engine.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_top_catalysts",
                description: "Returns lists of tickers currently printing Breakout signals or possessing High Momentum Vol Spikes.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_institutional_pulse",
                description: "Summarizes the institutional footprint by returning coins with the highest volume and bar movement anomalies in the last 24h.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "analyze_target",
                description: "Analyzes a specific ticker symbol (like 'BTCUSDT.P' or 'SOLUSDT.P') returning current score, technical flags, and Smart levels support/resistance mapped out.",
                inputSchema: {
                    type: "object",
                    properties: {
                        ticker: { type: "string", description: "The symbol to analyze, e.g. BTCUSDT.P" }
                    },
                    required: ["ticker"]
                }
            },
            {
                name: "query_technical_filters",
                description: "Queries the database for coins matching specific technical indicator criteria (e.g. RSI > 50 in m15, price < EMA200 in m5). Retrieves filtered lists to answer complex technical setups.",
                inputSchema: {
                    type: "object",
                    properties: {
                        rsi: {
                            type: "object",
                            description: "RSI filter criteria",
                            properties: {
                                timeframe: { type: "string", description: "Timeframe: m5, m15, m30, h1, h4" },
                                operator: { type: "string", description: "> or <" },
                                value: { type: "number" }
                            }
                        },
                        ema200: {
                            type: "object",
                            description: "EMA 200 filter criteria (price vs ema)",
                            properties: {
                                timeframe: { type: "string", description: "Timeframe: m5, m15, h1, h4" },
                                operator: { type: "string", description: "> or < (where > means price is above EMA, < means price is below EMA)" }
                            }
                        },
                        smart_level: {
                            type: "object",
                            description: "Smart Level proximity filter. Supports Confluence hunting.",
                            properties: {
                                type: { type: "string", description: "Type of level to match exactly (e.g. MEGA_SPOT, EMA200, EMA50, FIB, LOGIC, or ANY)" },
                                max_distance_pct: { type: "number", description: "Maximum absolute distance in percentage (e.g. 2 for within +/- 2%)" },
                                min_confluence: { type: "number", description: "Minimum number of dynamic levels within the max_distance_pct (e.g. 2 for strong confluence blocks)" }
                            }
                        },
                        macro_columns: {
                            type: "object",
                            description: "Matches any of the 26-column macro indicators from the latest TradingView scan (e.g. breakout, momScore, volSpike). Pass exact matches (e.g. { breakout: 1 }) or operators (e.g. { momScore: { operator: '>', value: 1 } })",
                            additionalProperties: true
                        },
                        volume: {
                            type: "object",
                            description: "Filter by 24h total trade volume",
                            properties: {
                                operator: { type: "string", description: "> or <" },
                                value: { type: "number" }
                            }
                        },
                        change_pct: {
                            type: "object",
                            description: "Filter by 24h percentage change",
                            properties: {
                                operator: { type: "string", description: "> or <" },
                                value: { type: "number" }
                            }
                        }
                    }
                }
            },
            {
                name: "get_database_schema",
                description: "Returns the DDL schemas for all tables and views in the dashboard_v3.db database.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "run_readonly_sql_query",
                description: "Executes a custom SQLite SELECT query against dashboard_v3.db. Use this securely for complex historical patterns, cross-table joins, or deep raw data extraction.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "The SQLite SELECT statement to execute (e.g. SELECT * FROM unified_alerts WHERE price > 10)" }
                    },
                    required: ["query"]
                }
            }
        ]
    }));

    // Configure MCP Resources
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: [
            {
                uri: "market://latest-snapshot",
                name: "Latest Market Snapshot",
                description: "The full raw JSON blob of the latest active market sweep."
            },
            {
                uri: "market://recent-alerts",
                name: "Recent Pulse Alerts",
                description: "A summary of the last 2 hours of significant volume alerts and smart level events."
            }
        ]
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const { uri } = request.params;
        
        if (uri === "market://latest-snapshot") {
            const text = await resources.getLatestSnapshot();
            return {
                contents: [{ uri, mimeType: "application/json", text }]
            };
        } else if (uri === "market://recent-alerts") {
            const text = await resources.getRecentAlerts();
            return {
                contents: [{ uri, mimeType: "application/json", text }]
            };
        }
        
        throw new Error(`Resource not found: ${uri}`);
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        let result = null;
        
        try {
            switch (name) {
                case 'get_market_sentiment':
                    result = await tools.getMarketSentiment();
                    break;
                case 'get_master_watchlist':
                    result = await tools.getMasterWatchlist();
                    break;
                case 'get_top_catalysts':
                    result = await tools.getTopCatalysts();
                    break;
                case 'get_institutional_pulse':
                    result = await tools.getInstitutionalPulse();
                    break;
                case 'analyze_target':
                    result = await tools.analyzeTarget(args.ticker);
                    break;
                case 'query_technical_filters':
                    result = await tools.queryTechnicalFilters({ 
                        rsi: args.rsi, 
                        ema200: args.ema200, 
                        smart_level: args.smart_level,
                        macro_columns: args.macro_columns,
                        volume: args.volume,
                        change_pct: args.change_pct
                    });
                    break;
                case 'get_database_schema':
                    result = await tools.getDatabaseSchema();
                    break;
                case 'run_readonly_sql_query':
                    result = await tools.runReadonlySqlQuery(args.query);
                    break;
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }

            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
            };
        } catch(err) {
            return {
                isError: true,
                content: [{ type: "text", text: `Error executing tool: ${err.message}` }]
            }
        }
    });

    return server;
}

app.get('/mcp/sse', async (req, res) => {
    // If a transport exists from a previous crash/timeout, close it heavily!
    if (mcpServer) {
        try { await mcpServer.close(); } catch(e) {}
    }
    
    // Create an entirely clean Server and Transport for this connection
    mcpServer = createMcpServer();
    transport = new SSEServerTransport('/mcp/message', res);
    
    // Connect them
    await mcpServer.connect(transport);
});

app.post('/mcp/message', async (req, res) => {
    if (!transport) {
        return res.status(500).send("Transport not initialized. Connect to /mcp/sse first.");
    }
    await transport.handlePostMessage(req, res);
});

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`🚀 MCP Express Server running on HTTP!`);
    console.log(`👉 Connect MCP clients to SSE endpoint: http://localhost:${PORT}/mcp/sse`);
    console.log(`🌐 If using Tailscale, route your Funnel to localhost:${PORT} OR through Vite Proxy`);
});
