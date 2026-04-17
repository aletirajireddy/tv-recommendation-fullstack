# Institutional Pulse & Market Scanner Dashboard
## Technical Requirements & Architecture Document

### 1. Executive Summary
This project is a **Real-Time Market Analytics Dashboard** designed to ingest, store, and visualize high-frequency trading data from TradingView. It bridges the gap between TradingView's raw screener data/alerts and institutional-grade analytics by extracting data via local userscripts, storing it in a structured database, and presenting it via a responsive React dashboard.

### 2. System Architecture

#### 2.1 High-Level Data Flow
```mermaid
graph TD
    TV[TradingView Browser Tab]
    TM_S[Tampermonkey: Symbol Scanner - Stream A]
    TM_A[Tampermonkey: Coin Scanner - Stream B]
    TV_W[TradingView Cloud Webhook - Stream C]
    
    subgraph Client Workstation
        TV --> TM_S
        TV --> TM_A
        
        TM_S -- "1. POST Payload" --> API[Node.js API (Port 3000)]
        TM_A -- "2. POST Heartbeat" --> API
        
        API -- Write --> DB[(SQLite V3 Database)]
        API -- WebSocket (Socket.IO) --> FE[React Client (Port 5173)]
        
        FE -- HTTP GET --> API
    end
    
    subgraph Ingress Layer
        TV_W -- "3. POST Alert payload" --> TS[Tailscale Funnel]
        TS -- "https://desktop-c92c19n.../api/*" --> Proxy[Vite Proxy: Port 5173]
        Proxy -- "Forward /api" --> API
    end
```

#### 2.2 Core Components

**A. Data Ingestion Layer (Tampermonkey)**
1.  **`symbol_market_scanner.js`**: The primary orchestrator.
    *   Scrapes the TradingView Screener table DOM.
    *   Calculates "Market Mood" and Opportunity Scores.
    *   **Pass-Through Logic**: Picks up buffered alert data from the Alert Scanner.
    *   Sends a unified payload to `http://localhost:3000/scan-report`.
2.  **`alert_scanner.js`**: The "Institutional Pulse" listener.
    *   Monitors TradingView Toasts and Sidebar Alerts.
    *   Extracts "Ultra Scalp" and "Institutional" signals.
    *   Buffers data to `unsafeWindow` for the main scanner to consume (Pass-Through Architecture).

**B. Backend Layer (Node.js/Express)**
*   **Server**: Express.js running on Port 3000.
*   **Database**: SQLite (`server/dashboard_v3.db`).
    *   *Core Tables*: `scans` (Master Record), `scan_results` (V3 JSON Blob Payload), `pulse_events`, `smart_level_events` (Stream C Webhooks).
*   **Real-Time**: Socket.IO emits `scan-update` and `smart-level-update` events to connected clients immediately upon data ingestion.

**C. Frontend Layer (React/Vite)**
*   **Client**: Single Page Application (SPA) running on Port 5173.
*   **State Management**: Zustand (`useTimeStore`) for handling timeline playback and live data switching.
*   **Visualization**: Recharts for trend analysis, CSS Modules for responsive component styling.
*   **Views**:
*   **Views**:
    *   **Monitor Mode**: Historical playback, "DVR-style" rewinding of market scans.
    *   **Eagle Eye Hardening**: Institutional-grade temporal isolation. All widgets (Pulse, TrendFlow, Heartbeat) are mathematically bound to the DVR scrubber to prevent future-data leakage.
    *   **Analytics Mode**: High-level grids (`ConfluenceGrid`, `TrendFlowChart`) showing market breadth and signal confluence.

### 3. Technical Implementation Details

#### 3.1 Port Configuration & Proxy
*   **Backend (`tv-api`)**: `http://localhost:3000`
    *   endpoints: `/scan-report` (POST), `/api/fusion/dashboard` (GET)
*   **Frontend (`tv-client`)**: `http://localhost:5173`
    *   Served via `npm run dev` with Vite.
*   **Ingress Proxy**: Vite's `server.proxy` automatically routes requests mapped to `/api/*` and `/socket.io/*` directly to the backend.
*   **Tailscale Funnel**: The frontend is exposed to the internet securely at `https://desktop-c92c19n.tailbf6529.ts.net/`, allowing public webhook ingestion.

#### 3.2 Process Management
The application ecosystem runs as two persistent background services managed by PM2 via a configuration file (`ecosystem.config.js`) or custom Node spawn script (`start_all.js`).
1.  **`tv-backend`**: Launches `server/index.js`.
2.  **`tv-client`**: Launches `client/start_client.js` (Custom loader that directly spawns the Vite binary avoiding cmd shells).

### 4. Quick Run Guide

#### Prerequisites
*   Node.js (v18+)
*   PM2 (`npm install -g pm2`)
*   Tampermonkey Extension installed in Browser.
*   Tailscale Configured for Funnel.

#### Start the Ecosystem
```bash
# Option 1: Development Runner
node start_all.js

# Option 2: PM2 Production
pm2 start ecosystem.config.js
pm2 save
```

### 5. Features Checklist
- [x] **Live Ingestion**: Sub-second latency from TradingView to Dashboard.
- [x] **Time Travel**: "DVR" playback of previous market scans.
- [x] **Institutional Backtesting**: Hermetic temporal isolation (No future-data leakage).
- [x] **Live/Replay Indicator**: Visual state feedback (🔴 LIVE vs ⏪ REPLAY).
- [x] **Institutional Pulse**: Detection of "Burst" and "Wave" alert clusters.
- [x] **Confluence Grid**: Visual heatmap of overlapping indicators (RSI + Momentum + Pattern).
- [x] **Floating Media Player**: Persistent controls for timeline navigation.
- [x] **Dual-Monitor Ready**: Responsive grid layout that adapts to large screens.
