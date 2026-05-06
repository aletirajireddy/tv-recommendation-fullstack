#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Trade View Dashboard — one-command deploy script
# Works on any Linux/macOS/WSL machine.
#
# First time on a fresh VM:
#   chmod +x deploy.sh
#   cp .env.example .env && nano .env   ← fill in secrets
#   ./deploy.sh                          ← installs everything + starts PM2
#   pm2 startup                          ← follow the printed command to enable
#   pm2 save                             ← persist process list across reboots
#
# Every subsequent deploy (git pull + restart):
#   ./deploy.sh
#
# To deploy from your LOCAL machine to the VM over SSH (no manual ssh needed):
#   pm2 deploy ecosystem.config.js production setup   ← first time
#   pm2 deploy ecosystem.config.js production         ← every subsequent time
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

LINE="═══════════════════════════════════════════════════════════"

echo "$LINE"
echo "  Trade View Dashboard — Deploy"
echo "  $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "$LINE"

# ── 1. Git pull ───────────────────────────────────────────────────────────────
echo ""
echo "▶ 1/5  Git pull"
git pull --ff-only
echo "       ✓ $(git log -1 --pretty='%h %s')"

# ── 2. Install / update npm dependencies (each sub-package separately) ────────
# `npm ci` is used instead of `npm install`:
#   - Deterministic (uses package-lock.json)
#   - Rebuilds native modules (better-sqlite3) for the current OS/arch
#   - 2-3× faster than npm install on a warm cache
# If node_modules doesn't exist yet npm ci creates it from scratch.

echo ""
echo "▶ 2/5  Install server deps  (better-sqlite3, express, socket.io …)"
npm ci --prefix "$ROOT/server"

echo ""
echo "▶ 3/5  Install client deps  (vite, react …)"
npm ci --prefix "$ROOT/client"

echo ""
echo "▶ 4/5  Install mcp-server deps  (@modelcontextprotocol/sdk …)"
npm ci --prefix "$ROOT/mcp-server"

# ── 3. Create .env if missing (first-time VM setup) ──────────────────────────
if [ ! -f "$ROOT/.env" ]; then
    echo ""
    echo "▶ .env not found — creating from .env.example"
    cp "$ROOT/.env.example" "$ROOT/.env"
    echo ""
    echo "  ⚠️  IMPORTANT: open .env and fill in your secrets before continuing:"
    echo "      Telegram: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID"
    echo "      MCP auth: MCP_AUTH_MODE, MCP_AUTH_TOKEN (optional)"
    echo ""
    read -rp "  Press ENTER when done, or Ctrl-C to abort …"
fi

# ── 4. Ensure logs directory exists ──────────────────────────────────────────
mkdir -p "$ROOT/logs"

# ── 5. PM2 reload (graceful — zero downtime, preserves socket connections) ────
echo ""
echo "▶ 5/5  PM2 reload"
if pm2 pid tv-backend > /dev/null 2>&1; then
    # Processes already running — graceful reload
    pm2 reload "$ROOT/ecosystem.config.js" --update-env
else
    # First boot — start everything
    pm2 start "$ROOT/ecosystem.config.js"
fi
pm2 save

echo ""
echo "$LINE"
echo "  ✅  Deploy complete!"
echo "$LINE"
echo ""
pm2 status
echo ""
echo "  Useful commands:"
echo "    pm2 logs              — tail all logs"
echo "    pm2 logs mcp-server   — MCP server only"
echo "    pm2 monit             — live CPU/RAM monitor"
echo "    pm2 restart tv-backend --update-env   — restart one app"
echo ""
