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
        // PORT 5173: backend serves the built React client (client/dist) AND
        // Socket.IO on the same port — no proxy layer, no vite-preview needed.
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
