module.exports = {
  apps: [
    {
      name: "tv-backend",
      script: "index.js",
      cwd: "server",
      watch: ["index.js", "services", "utils", "validator"], // Watch mode for BE source
      ignore_watch: ["node_modules", "dashboard*.db", "dashboard*.db-journal", "*.log"],
      env: {
        NODE_ENV: "development",
        // PORT 5173: backend now also serves the built React client from client/dist.
        // vite-preview (tv-client) is no longer needed — Socket.IO + API + static files
        // all run on the same port, eliminating the proxy layer that caused timeouts.
        PORT: 5173
      }
    },
    // tv-client (vite preview) retired — backend now serves client/dist directly.
    // Run `npm run build` in client/ after any frontend change, then restart tv-backend.
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
