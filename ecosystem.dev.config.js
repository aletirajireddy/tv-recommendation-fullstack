/**
 * Development PM2 config — runs alongside the production instance at E:\AI\tv_dashboard
 * without any port conflicts.
 *
 * Ports:
 *   Backend  : 3010  (production uses 3000)
 *   Frontend : 5174  (production uses 5173)
 *   MCP      : 3011  (production uses 3001)
 *
 * Usage:
 *   pm2 start ecosystem.dev.config.js
 *   pm2 stop  ecosystem.dev.config.js
 *   pm2 logs  tv-backend-dev
 */

module.exports = {
  apps: [
    {
      name: "tv-backend-dev",
      script: "index.js",
      cwd: "server",
      watch: ["index.js", "services", "utils", "validator"],
      ignore_watch: ["node_modules", "dashboard*.db", "dashboard*.db-journal", "*.log"],
      env: {
        NODE_ENV: "development",
        PORT: 3010
      }
    },
    {
      name: "tv-client-dev",
      script: "start_client.js",
      cwd: "client",
      watch: ["start_client.js", "vite.config.js"],
      ignore_watch: ["node_modules"],
      env: {
        NODE_ENV: "development",
        PORT: 5174,
        VITE_API_PORT: 3010,
        VITE_MCP_PORT: 3011
      }
    },
    {
      name: "mcp-server-dev",
      script: "index.js",
      cwd: "mcp-server",
      watch: true,
      ignore_watch: ["node_modules", "../*.db*", "../*.db-wal", "../*.db-shm"],
      env: {
        NODE_ENV: "development",
        PORT: 3011
      }
    }
  ]
};
