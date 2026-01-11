# Institutional Pulse & Market Scanner Dashboard
## Technical Requirements & Architecture Document

### 1. Executive Summary
This project is a **Real-Time Market Analytics Dashboard** designed to ingest, store, and visualize high-frequency trading data from TradingView. It bridges the gap between TradingView's raw screener data/alerts and institutional-grade analytics by extracting data via local userscripts, storing it in a structured database, and presenting it via a responsive React dashboard.

### 2. System Architecture

#### 2.1 High-Level Data Flow
```mermaid
graph TD
    TV[TradingView Browser Tab]
    TM_S[Tampermonkey: Symbol Scanner (Master)]
    TM_A[Tampermonkey: Alert Scanner (Slave)]
    
    subgraph Client Workstation
        TM_S -- "1. Wake Up Signal (3m)" --> TM_A
        TM_A -- "2. Force Toggle (Simulate Click)" --> TV
        TM_A -- "3. Buffer Alerts" --> TM_S
        TM_S -- "4. POST Payload" --> API[Node.js API (Port 3000)]
        
        API -- Write --> DB[(SQLite Database)]
        API -- WebSocket (Socket.IO) --> FE[React Client (Port 5173)]
        
        FE -- HTTP GET --> API
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
*   **Database**: SQLite (`server/dashboard.db`).
    *   *Tables*: `scans` (Master Record), `scan_entries` (Individual tickers), `pulse_events` (Alerts), `market_states` (Sentiment).
*   **Real-Time**: Socket.IO emits `scan-update` events to connected clients immediately upon data ingestion.

**C. Frontend Layer (React/Vite)**
*   **Client**: Single Page Application (SPA) running on Port 5173.
*   **State Management**: Zustand (`useTimeStore`) for handling timeline playback and live data switching.
*   **Visualization**: Recharts for trend analysis, CSS Modules for responsive component styling.
*   **Views**:
    *   **Monitor Mode**: Historical playback, "DVR-style" rewinding of market scans.
    *   **Analytics Mode**: High-level grids (`ConfluenceGrid`, `TrendFlowChart`) showing market breadth and signal confluence.

### 3. Technical Implementation Details

#### 3.1 Port Configuration
*   **Backend (`tv-api`)**: `http://localhost:3000`
    *   endpoints: `/scan-report` (POST), `/api/history` (GET), `/api/scan/:id` (GET)
*   **Frontend (`tv-client`)**: `http://localhost:5173`
    *   Served via `vite preview` for production-like performance.

#### 3.2 Process Management (PM2)
The application runs as two persistent background services on Windows:
1.  **`tv-api`**: Launches `server/index.js`.
2.  **`tv-client`**: Launches `client/start_client.js` (Custom loader for Vite).

### 4. Quick Run Guide

#### Prerequisites
*   Node.js (v18+)
*   PM2 (`npm install -g pm2`)
*   Tampermonkey Extension installed in Browser.

#### Installation
```bash
# 1. Install Dependencies
cd server && npm install
cd ../client && npm install

# 2. Build Frontend
cd client && npm run build
```

#### Starting the System
```bash
# Start both services via PM2
pm2 start server/index.js --name tv-api
pm2 start client/start_client.js --name tv-client

# Save process list for reboot persistence
pm2 save
```

### 5. Features Checklist
- [x] **Live Ingestion**: Sub-second latency from TradingView to Dashboard.
- [x] **Time Travel**: "DVR" playback of previous market scans.
- [x] **Institutional Pulse**: Detection of "Burst" and "Wave" alert clusters.
- [x] **Confluence Grid**: Visual heatmap of overlapping indicators (RSI + Momentum + Pattern).
- [x] **Floating Media Player**: Persistent controls for timeline navigation.
- [x] **Dual-Monitor Ready**: Responsive grid layout that adapts to large screens.
