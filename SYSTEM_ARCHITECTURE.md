# TradingView Dashboard: System Architecture & Context Guide for AI

**Version**: 2.2 (Includes Playback Hardening & Performance Optimization)
**Last Updated**: April 23, 2026
**Purpose**: This document serves as the absolute "Single Source of Truth" regarding the architecture of the TV Dashboard. Any AI assistant entering this project must read this to understand how data flows, where truth is derived, and how the 4 core pillars interact safely.

---

## The 4 Pillars of the Ecosystem

The system is designed with a strict separation of concerns. It follows a "Pass-Through and Sanitize" philosophy, meaning data originates from browser scraping (Pillar 2), is sanitized and governed by the Backend (Pillar 1), visualized by the Frontend (Pillar 3), and finally exposed to external AI Agents (Pillar 4).

### Pillar 1: The Core Backend (`server/`)
*   **Role**: The Governor & Data Ingestion Hub.
*   **Tech**: Node.js, Express, `better-sqlite3`, Socket.io.
*   **Port**: `3000`
*   **Database**: `dashboard_v3.db` (WAL mode enabled for high concurrency).
*   **Core Responsibilities**:
    *   **Data Ingestion**: Receives HTTP POST payloads from local browser scripts and remote webhooks.
    *   **The "Genie Truth"**: It **does not** blindly trust browser math. At the `/scan-report` ingress, the server recalculates "Genie Scores" and Market Sentiment (Net Flow of Bulls vs Bears). This "Sanitized Truth" is stored directly as full JSON blobs in `scan_results`.
    *   **Socket Hub**: Emits real-time `scan-update` and `ledger-update` events to the React frontend.
    *   **Watchlist 5+2 Engine**: Maintains the state of which coins are "Ghosting", "Graduates", or "Protected".

### Pillar 2: The Data Harvesters (`scripts/`)
*   **Role**: The Eyes (Browser Automation & Webhooks).
*   **Tech**: Tampermonkey/Greasemonkey scripts natively injected into TradingView.
*   **Core Scripts**:
    *   `symbol_market_scanner.js` (Stream A): Scrapes the massive 40-coin overview table. Captures the 26-column technical schema (Support/Resistance levels, Momentum, Breakouts). Sends payloads directly to Backend Port `3000`.
    *   `coin_scanner.js` (Stream B): Isolated scout that pings specific qualified individual coins.
    *   `TradingView Webhooks` (Stream C): Remote alerts (Smart Levels, Institutional Volumes) sent from the TV Cloud directly to the public funnel URL.
    *   **Fallback Rehydrator** (`email_rehydrator/`): A standalone Node.js daemon using the Gmail API (OAuth 2.0). If webhooks fail, it reads raw TradingView alerts directly from the user's inbox, deduplicates them against the DB, and injects any missing data. It acts as an unbreakable historical safety net.

### Pillar 3: The Presentation Layer (`client/`)
*   **Role**: The UI & External Ingress Proxy.
*   **Tech**: React, Vite, Zustand (State Management).
*   **Port**: `5173` (The primary port exposed to Tailscale Funnel).
*   **Core Responsibilities**:
    *   **The Traffic Cop (Vite Proxy)**: Because Tailscale maps the public internet URL to port `5173`, the `vite.config.js` proxy handles routing:
        *   `/api/*` -> Forwards strictly to Backend (`3000`).
        *   `/socket.io/*` -> Forwards strictly to Backend (`3000`).
        *   `/mcp/*` -> Forwards strictly to MCP Server (`3001`).
    *   **Time Normalization**: Receives UTC ISO dates and forces them into local UI time.
    *   **The Time-Mirror Protocol**: All components are bound by the temporal state of the `activeScan`. Future-data is mathematically purged from historical replay views.
    *   **Local State**: Uses `useTimeStore.js` to manage the "Playback Engine" (DVR sliding through historical market snapshots).
    *   **Closed-Loop Playback**: Implements backpressure in the media player to wait for server responses (`isLoading`) before advancing frames, preventing UI lockups and network congestion.
    *   **Analytical Window Decoupling**: The "Lookback Slider" acts as a magnification lens relative to the scrubber's current reference time, rather than truncating the timeline sandbox.

### Pillar 4: The AI Intelligence Layer (`mcp-server/`)
*   **Role**: The Extensible Agentic API.
*   **Tech**: Node.js, Express, `@modelcontextprotocol/sdk`.
*   **Port**: `3001`
*   **Transport**: Server-Sent Events (SSE) located at `/mcp/sse`.
*   **Core Responsibilities**:
    *   To allow external AIs (like Claude Desktop) to "plug in" remotely via the Tailscale Funnel and query the system safely.
    *   **Absolute Safety**: Connects to `dashboard_v3.db` strictly in `readonly: true` mode. It is physically impossible for the MCP pillar to interrupt or corrupt the Backend ingestion process.
    *   **High-Level Agent Tools**: Instead of returning raw SQL, it provides pre-calculated, human-readable insights:
        *   `get_market_sentiment` (Broad market flow).
        *   `get_master_watchlist` (Active actionable coins).
        *   `get_top_catalysts` (Breakouts and Volume Spikes).
        *   `get_institutional_pulse` (Whale footprint tracking).
        *   `analyze_target` (Deep dive on one ticker).

---

## System Flow & Networking (The Funnel Diagram)

When the system is exposed over Tailscale (`https://desktop-xxxx.tailxxxx.ts.net`), here is exactly how traffic routes:

```text
[EXTERNAL INTERNET / CLOUD / CLAUDE DESKTOP]
       │
       ▼
[TAILSCALE FUNNEL]
       │
       ▼
[VITE CLIENT PROXY : PORT 5173]
       │
       ├──► IF path starts with `/api` --------► [BACKEND SERVER : PORT 3000] (Webhooks/Ingest)
       │
       ├──► IF path starts with `/mcp` --------► [MCP SERVER : PORT 3001] (AI Context Protocol)
       │
       └──► IF path is anything else ----------► [REACT UI] (Your Visual Dashboard)
```

---

## Core Tenets for Future Development / Integration

If an AI is asked to integrate a new tool, widget, or capability, it MUST adhere to these architectural laws:

### 1. The Schema is Sacred
The 26-column data structure originating from TradingView PineScript is the root logic. Do not attempt to re-invent Momentum or Retrace mechanics in JS. If the logic changes, it changes in PineScript first.

### 2. Zero Collision State
*   If you need to add new Ingestion (e.g., scraping Twitter sentiment), it goes in **Pillar 1** (`server/`).
*   If you need to add a new UI Widget, it goes in **Pillar 3** (`client/`).
*   If you want to feed data to another AI or build an Auto-Trader on top of the DB, it goes in **Pillar 4** (`mcp-server/`).

### 3. Asymmetric Time (The "Offline Gap")
The system is built to handle missing data. TradingView tabs close. Desktops sleep. Data ingestion is bursty. 
*   **Do not** rely on absolute sequential time gaps.
*   **Always** check data staleness. A coin isn't a "Ghost" if the system was offline for 12 hours; it just woke up. 

### 4. Single Point of Failure Prevention
Because of the Vite Proxy router, all external API integrations (Webhooks, AI Agents, Mobile Apps) can hit the exact same Tailscale URL. Ensure all new routes in `client/vite.config.js` are strictly scoped by prefixes (`/api`, `/mcp`, `/mobile`, etc.) to prevent route swallowing.

### 5. Temporal Hermeticism (The "Eagle Eye" Standard)
A backtest is only valid if it is clean. 
*   **Rule**: Any component fetching data for a past timestamp MUST use a backward-facing lookback lens. 
*   **Safety**: If a user scrubs to 2 days ago, the entire dashboard becomes a snapshot of the market's mind at that exact microsecond.
