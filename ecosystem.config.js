module.exports = {
  apps: [
    {
      name: "tv-backend",
      script: "index.js",
      cwd: "server",
      watch: ["index.js", "services", "utils"], // Watch mode for BE source
      ignore_watch: ["node_modules", "dashboard*.db", "dashboard*.db-journal", "*.log"],
      env: {
        NODE_ENV: "development",
        PORT: 3000
      }
    },
    {
      name: "tv-client",
      script: "start_client.js",
      cwd: "client",
      watch: ["start_client.js", "vite.config.js"], 
      ignore_watch: ["node_modules"],
      env: {
        NODE_ENV: "development",
        PORT: 5173
      }
    }
  ]
};
