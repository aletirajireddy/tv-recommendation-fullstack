import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Supports both production (3000/3001) and dev (3010/3011) port configs.
// Set VITE_API_PORT and VITE_MCP_PORT in ecosystem.dev.config.js to override.
const API_PORT  = process.env.VITE_API_PORT  || 3000;
const MCP_PORT  = process.env.VITE_MCP_PORT  || 3001;
const DEV_PORT  = parseInt(process.env.PORT  || 5173);

export default defineConfig({
  plugins: [react()],
  server: {
    port: DEV_PORT,
    host: true,           // Expose to network (Tailscale/LAN)
    allowedHosts: true,   // Allow any host (fixes Tailscale block)
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true
      },
      '/socket.io': {
        target: `http://localhost:${API_PORT}`,
        ws: true
      },
      '/mcp': {
        target: `http://localhost:${MCP_PORT}`,
        changeOrigin: true,
        secure: false,
        headers: {
          'Connection': 'keep-alive',
          'Cache-Control': 'no-cache',
          'X-Accel-Buffering': 'no'
        }
      }
    }
  }
})
