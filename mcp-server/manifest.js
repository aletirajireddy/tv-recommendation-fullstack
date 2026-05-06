/**
 * /.well-known/mcp.json connector manifest
 * ─────────────────────────────────────────────────────────────────────────────
 * Discovery document consumed by the MCP Connector Registry and by clients that
 * support one-click install (Claude Desktop, Cursor, Smithery, etc). Returning
 * a complete manifest here means a user can paste your server URL and the
 * client auto-configures transport, auth, and capabilities.
 */

const auth = require('./auth');
const pkg = require('./package.json');

function build(host) {
    const base = host.replace(/\/$/, '');
    return {
        schema_version: '2025-03-26',
        name: 'trade-view-dashboard',
        display_name: 'Trade View Dashboard',
        description: 'Institutional-grade crypto market intelligence MCP server. 22 read-only tools across 4 data streams (Macro / Scout / Alert / Realtime), 6 pre-canned analysis prompts, journal write tool, and live event subscriptions.',
        version: pkg.version,
        vendor: {
            name: 'Trade View Dashboard',
            url: 'https://github.com/aletirajireddy/tv-recommendation-fullstack',
        },
        transports: [
            {
                type: 'http',
                name: 'streamable-http',
                url: `${base}/mcp`,
                description: 'Modern Streamable HTTP transport (MCP spec rev 2025-03-26). Use this for new clients.',
            },
            {
                type: 'sse',
                name: 'legacy-sse',
                url: `${base}/mcp/sse`,
                message_url: `${base}/mcp/message`,
                description: 'Legacy SSE transport for older clients.',
            },
        ],
        authentication: auth.isEnabled
            ? {
                type: 'bearer',
                description: 'Send Authorization: Bearer <token>. Obtain credentials from the operator.',
                in: 'header',
                name: 'Authorization',
              }
            : { type: 'none', description: 'Open access (no token required).' },
        capabilities: {
            tools: true,
            resources: true,
            resource_templates: true,
            prompts: true,
            subscriptions: true,
            logging: false,
            sampling: false,
        },
        endpoints: {
            health:  `${base}/mcp/health`,
            stats:   `${base}/mcp/stats`,
            sse:     `${base}/mcp/sse`,
            message: `${base}/mcp/message`,
            http:    `${base}/mcp`,
        },
        rate_limits: {
            short_window_seconds: 10,
            long_window_seconds:  3600,
            note: 'Per (session, tool). Heavy tools (run_readonly_sql_query, write_journal_entry) get tighter caps.',
        },
        suggested_clients: [
            { name: 'Claude Desktop', transport: 'streamable-http' },
            { name: 'Cursor',         transport: 'streamable-http' },
            { name: 'OpenAI MCP',     transport: 'streamable-http' },
            { name: 'n8n',            transport: 'streamable-http' },
            { name: 'LangGraph',      transport: 'streamable-http' },
            { name: 'Older clients',  transport: 'legacy-sse' },
        ],
    };
}

module.exports = { build };
