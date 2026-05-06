/**
 * Bearer token auth gate
 * ─────────────────────────────────────────────────────────────────────────────
 * Why: previously `cors: '*'` + no auth meant anyone on the Tailscale tail-net
 * (or anyone who guessed the Funnel URL) could call `run_readonly_sql_query`
 * against your live trading database. This middleware closes that gap.
 *
 * Mode selection (env-driven, no breaking change):
 *   MCP_AUTH_MODE=disabled   → open access (legacy v2 behaviour, default)
 *   MCP_AUTH_MODE=bearer     → require `Authorization: Bearer <MCP_AUTH_TOKEN>`
 *
 * For full OAuth 2.1 / PKCE you would plug in @modelcontextprotocol/sdk's auth
 * helpers; bearer is the 80/20 win that works with every current MCP client
 * (Claude Desktop, Cursor, OpenAI MCP, n8n, LangGraph) without code changes
 * on their side — just paste the token in their connector config.
 *
 * Hardening notes:
 *  - Constant-time compare (timingSafeEqual) avoids timing-attack token leaks
 *  - Tokens shorter than 24 chars are rejected at boot (config error, not runtime)
 *  - Health endpoints (/mcp, /mcp/health, /.well-known/*) stay open so monitoring
 *    and discovery work without a token
 */

const crypto = require('crypto');

const MODE = (process.env.MCP_AUTH_MODE || 'disabled').toLowerCase();
const TOKEN = process.env.MCP_AUTH_TOKEN || '';

if (MODE === 'bearer') {
    if (!TOKEN) {
        console.error('[mcp:auth] FATAL: MCP_AUTH_MODE=bearer but MCP_AUTH_TOKEN is empty.');
        console.error('[mcp:auth] Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
        process.exit(1);
    }
    if (TOKEN.length < 24) {
        console.error('[mcp:auth] FATAL: MCP_AUTH_TOKEN must be ≥24 chars (got ' + TOKEN.length + ').');
        process.exit(1);
    }
    console.log('[mcp:auth] Bearer auth ENABLED — clients must send Authorization: Bearer <token>');
} else {
    console.log('[mcp:auth] Bearer auth DISABLED (MCP_AUTH_MODE=' + MODE + '). Set MCP_AUTH_MODE=bearer + MCP_AUTH_TOKEN to enable.');
}

// Paths that bypass auth (discovery / monitoring / OAuth handshake surface).
const OPEN_PATHS = new Set([
    '/',
    '/mcp',
    '/mcp/health',
    '/mcp/stats',
    '/.well-known/mcp.json',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
]);

function _safeEqual(a, b) {
    const ab = Buffer.from(a || '', 'utf8');
    const bb = Buffer.from(b || '', 'utf8');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

function authMiddleware(req, res, next) {
    if (MODE === 'disabled') return next();
    if (OPEN_PATHS.has(req.path)) return next();

    const hdr = req.get('authorization') || '';
    const match = /^Bearer\s+(.+)$/i.exec(hdr);
    if (!match || !_safeEqual(match[1].trim(), TOKEN)) {
        // RFC 6750 challenge so MCP clients display a helpful error
        res.set('WWW-Authenticate', 'Bearer realm="trade-view-mcp", error="invalid_token"');
        return res.status(401).json({
            error: 'unauthorized',
            message: 'Provide Authorization: Bearer <token>. Contact admin for credentials.',
        });
    }
    next();
}

module.exports = { authMiddleware, MODE, isEnabled: MODE === 'bearer' };
