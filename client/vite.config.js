import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // Expose to network (Tailscale/LAN)
    allowedHosts: true, // Allow any host (fixes Tailscale block)
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true
      },
      '/mcp': {
        target: 'http://localhost:3001',
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
