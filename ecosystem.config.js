module.exports = {
  apps: [
    {
      name: "tv-backend",
      script: "index.js",
      cwd: "server",
      // Watch DISABLED — watch mode restarts the process on every file save,
      // causing a brief port-unavailable window that Tailscale's proxy returns
      // as a 502. Restart manually with `pm2 restart tv-backend` after changes.
      watch: false,
      env: {
        NODE_ENV: "development",
        PORT: 3000
      }
    },
    {
      name: "tv-client",
      script: "start_client.js",
      cwd: "client",
      env: {
        NODE_ENV: "development",
        PORT: 5173
      }
    },
    {
      name: "mcp-server",
      script: "index.js",
      cwd: "mcp-server",
      watch: true,
      ignore_watch: ["node_modules", "../*.db*", "../*.db-wal", "../*.db-shm"],
      env: {
        NODE_ENV: "development",
        PORT: 3001
      }
    }
  ]
};
