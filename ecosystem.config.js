/**
 * PM2 Ecosystem — Trade View Dashboard
 * ─────────────────────────────────────────────────────────────────────────────
 * Portable: works on Windows dev machine AND Linux/Ubuntu VM with NO changes.
 *
 * First-time VM setup (run ONCE):
 *   cp .env.example .env && nano .env   ← fill in secrets
 *   ./deploy.sh                          ← installs deps + starts everything
 *   pm2 startup && pm2 save             ← survive reboots
 *
 * Every subsequent deploy:
 *   ./deploy.sh                          ← pull + npm ci + pm2 reload
 *
 * Windows dev (no shell available):
 *   node deploy.js
 *
 * Reload with env changes only:
 *   pm2 reload ecosystem.config.js --update-env
 */

// Bring .env into process.env so this config file can read it.
// On a fresh machine without .env, fall back to defaults silently.
try {
    require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
} catch { /* dotenv not installed globally — server/node_modules has it */ }

const IS_PROD = (process.env.NODE_ENV || 'development') === 'production';

// Ensure the logs directory exists (PM2 won't create it)
const fs   = require('fs');
const path = require('path');
const LOGS = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS)) fs.mkdirSync(LOGS, { recursive: true });

// ── Shared resilience settings applied to every app ──────────────────────────
const SHARED = {
    autorestart:   true,
    max_restarts:  15,          // before PM2 gives up and marks as errored
    min_uptime:    '15s',       // must stay up at least 15s to count as a restart
    restart_delay: 3000,        // wait 3s between crash-restarts
    merge_logs:    true,
    kill_timeout:  8000,        // 8s for graceful shutdown before SIGKILL
    watch:         false,       // overridden per-app in dev below
};

module.exports = {
    apps: [

        // ── 1. Express backend ────────────────────────────────────────────────
        {
            ...SHARED,
            name:   'tv-backend',
            script: 'index.js',
            cwd:    'server',

            // Dev: watch source changes for hot-reload
            // Prod/VM: watch=false — deploy.sh handles restarts after pull
            watch:        !IS_PROD ? ['index.js', 'services', 'utils', 'validator'] : false,
            ignore_watch: [
                'node_modules', 'dashboard*.db', 'dashboard*.db-journal',
                'dashboard*.db-wal', 'dashboard*.db-shm', '*.log',
            ],

            max_memory_restart: '1G',

            env: {
                NODE_ENV:           process.env.NODE_ENV           || 'development',
                PORT:               process.env.PORT               || 3000,
                APP_ENV:            process.env.APP_ENV            || 'local',
                TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
                TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID   || '',
                TELEGRAM_ENABLED:   process.env.TELEGRAM_ENABLED   || 'false',
            },

            // PM2 ≥ 5.x: also load any remaining keys from .env directly
            env_file: '.env',

            error_file: 'logs/backend-error.log',
            out_file:   'logs/backend-out.log',
        },

        // ── 2. Vite dev client ────────────────────────────────────────────────
        // On a headless VM / production you typically build once with
        //   npm run build --prefix client
        // and serve via Nginx / Tailscale Funnel instead of running Vite.
        // This entry is kept so `pm2 reload` works identically on both machines.
        {
            ...SHARED,
            name:   'tv-client',
            script: 'start_client.js',
            cwd:    'client',

            watch:        !IS_PROD ? ['start_client.js', 'vite.config.js'] : false,
            ignore_watch: ['node_modules', 'dist'],

            max_memory_restart: '512M',

            env: {
                NODE_ENV: process.env.NODE_ENV  || 'development',
                PORT:     process.env.VITE_PORT || 5173,
                // Bind to all interfaces so Tailscale / remote browsers can reach Vite
                HOST:     '0.0.0.0',
            },

            env_file: '.env',

            error_file: 'logs/client-error.log',
            out_file:   'logs/client-out.log',
        },

        // ── 3. MCP Server v3 — Agentic Edition ───────────────────────────────
        {
            ...SHARED,
            name:   'mcp-server',
            script: 'index.js',
            cwd:    'mcp-server',

            // IMPORTANT: never watch *.db / *.db-wal inside mcp-server/ — the
            // journal DB (mcp_journal.db) is written at runtime and would cause
            // an infinite restart loop if watch sees it change.
            watch:        !IS_PROD ? [
                'index.js', 'tools.js', 'resources.js',
                'prompts.js', 'cache.js', 'intentDiscovery.js',
                'toolMeta.js', 'liveEvents.js', 'manifest.js',
                'auth.js', 'rateLimit.js', 'journal.js',
            ] : false,
            ignore_watch: [
                'node_modules',
                '*.db', '*.db-wal', '*.db-shm', '*.db-journal',
                'mcp_journal.db',
                '../*.db*',
            ],

            max_memory_restart: '256M',

            env: {
                NODE_ENV: process.env.NODE_ENV   || 'development',
                PORT:     process.env.MCP_PORT   || 3001,

                // ── MCP v3 bearer auth ─────────────────────────────────────
                // Set MCP_AUTH_MODE=bearer + MCP_AUTH_TOKEN=<32-char-hex> in .env
                // to protect the MCP endpoints. Leave MCP_AUTH_MODE=disabled for
                // local / Tailscale-only deployments.
                MCP_AUTH_MODE:  process.env.MCP_AUTH_MODE  || 'disabled',
                MCP_AUTH_TOKEN: process.env.MCP_AUTH_TOKEN || '',
            },

            env_file: '.env',

            error_file: 'logs/mcp-error.log',
            out_file:   'logs/mcp-out.log',
        },
    ],

    // ── pm2 deploy (optional — for `pm2 deploy production setup / deploy`) ────
    // Simpler day-to-day: just use deploy.sh (see below). This section lets
    // you also use `pm2 deploy ecosystem.config.js production` from your local
    // machine to push to the VM over SSH without sshing in manually.
    deploy: {
        production: {
            user:         process.env.DEPLOY_USER || 'ubuntu',
            host:         process.env.DEPLOY_HOST || 'YOUR_VM_IP_OR_HOSTNAME',
            ref:          'origin/feature/mcp-agentic-v3',
            repo:         'git@github.com:aletirajireddy/tv-recommendation-fullstack.git',
            path:         process.env.DEPLOY_PATH || '/home/ubuntu/tv-dashboard',
            'pre-deploy': 'git fetch --all',
            'post-deploy': [
                'npm ci --prefix server',
                'npm ci --prefix client',
                'npm ci --prefix mcp-server',
                'cp -n .env.example .env 2>/dev/null || true',
                'pm2 reload ecosystem.config.js --update-env',
                'pm2 save',
            ].join(' && '),
            env: { NODE_ENV: 'production' },
        },
    },
};
