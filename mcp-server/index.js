const express = require('express');
const cors = require('cors');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const tools = require('./tools');
const resources = require('./resources');

const app = express();
app.use(cors());

// Initialize MCP Server
const mcpServer = new Server({
    name: "trade-view-dashboard",
    version: "1.0.0"
}, {
    capabilities: {
        tools: {},
        resources: {}
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', engine: 'mcp-sse', timestamp: new Date() });
});

let transport = null;

app.get('/mcp/sse', async (req, res) => {
    transport = new SSEServerTransport('/mcp/message', res);
    await mcpServer.connect(transport);
});

app.post('/mcp/message', async (req, res) => {
    if (!transport) {
        return res.status(500).send("Transport not initialized. Connect to /mcp/sse first.");
    }
    await transport.handlePostMessage(req, res);
});

// Configure MCP Tools
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
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
        }
    ]
}));

// Configure MCP Resources
mcpServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
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

mcpServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
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

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
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

const PORT = 3001;
app.listen(PORT, () => {
    console.log(`🚀 MCP Express Server running on HTTP!`);
    console.log(`👉 Connect MCP clients to SSE endpoint: http://localhost:${PORT}/mcp/sse`);
    console.log(`🌐 If using Tailscale, route your Funnel to localhost:${PORT} OR through Vite Proxy`);
});
