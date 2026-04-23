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

---

## Pillar 1 Extension: 3rd Umpire Validator (`server/validator/`)

**Version**: 1.0 (Step 1 complete — skeleton active)  
**Branch**: `feature/market-observer-validator`

### What it is
An event-driven trial state machine that judges Stream C smart-level events against a configurable 7-rule checklist. Verdicts: `CONFIRMED | FAILED | NEUTRAL_TIMEOUT | EARLY_FAVORABLE`. Runs entirely inside the existing `tv-backend` process — no new services, no new TradingView calls.

### New DB Tables (additive — zero existing tables modified)
| Table | Purpose |
|---|---|
| `validation_trials` | One row per detected setup — full feature + config snapshot at detection |
| `validation_state_log` | State transition tape — enables DVR-aware replay (Rule #19 compliance) |
| `pattern_statistics` | Pre-computed win rates by stream/EMA/vol combination — powers MCP low-token answers |

### New Modules
| File | Purpose |
|---|---|
| `server/validator/UmpireEngine.js` | Event-driven state machine. Hooks: `onStreamA`, `onStreamC`, `checkTimers` |
| `server/validator/settingsManager.js` | 15 configurable keys, seeded into `system_settings` on first boot |
| `server/validator/rules.js` | 7 rule evaluators (skeleton — Step 3 implements logic) |

### The 7 Rules (EMA Hierarchy)
| Rule | Role | Timeframe |
|---|---|---|
| Trigger valid | Required | — |
| 5m EMA200 hold | **GATE** (must pass) | Entry |
| 15m EMA200 sustain | **GATE** (must pass within 15m) | Sustain |
| 1h EMA200 align | MINOR (weight only) | Trend |
| 4h EMA200 align | **MAJOR** (can veto) | Macro |
| Volume confirm | Weight | volSpike on retest |
| Reactive zone touch | Structure | 0.3–0.5% retest band |

### Integration Points (zero disturbance)
*   `server/index.js` line after Stream A ingest: `setImmediate(() => umpire.onStreamA(payload))`
*   `server/index.js` line after Stream C ingest: `setImmediate(() => umpire.onStreamC(payload))`
*   Both are fire-and-forget — they never block the HTTP response or affect existing logic.

### Telegram Behaviour
*   **Live mode**: Phase-2 verdict alerts with full context (rules, mood, win-rate, next level, invalidation)
*   **Replay mode**: Silent — no alerts fired during DVR scrubbing

### Implementation Phases
| Phase | Status | Description |
|---|---|---|
| 1 — DB + Skeleton | ✅ Complete | Tables created, engine wired, settings seeded on boot |
| 2 — Trigger Detection | ⬜ Next | `onStreamC` creates trials, state machine transitions |
| 3 — Rule Evaluation | ⬜ Pending | 7 rules evaluated per Stream A tick, verdicts resolved |
| 4 — Frontend Widget | ⬜ Pending | `ValidatorTimelineWidget.jsx` — top row, DVR-aware |
| 5 — Telegram + MCP + Stats | ⬜ Pending | Enriched alerts, 4 MCP tools, pattern_statistics rebuild |

---

## Development Environment Setup

### Port Assignments
| Service | Port |
|---|---|
| Backend | **3000** |
| Frontend | **5173** |
| MCP Server | **3001** |

This repo (`E:\AI\claude_project\tv-recommendation-fullstack`) is the **active working repo** and runs on the standard ports. The old repo at `E:\AI\tv_dashboard` is retired — its PM2 processes have been removed.

### Starting / Stopping
```bash
# From E:\AI\claude_project\tv-recommendation-fullstack
pm2 start ecosystem.config.js      # start all 3 services
pm2 restart ecosystem.config.js    # restart after code changes
pm2 stop ecosystem.config.js       # stop all
pm2 logs tv-backend --lines 30     # view backend logs
```

### Env-Driven Port Config
All three services read their port from `process.env.PORT` (defaults: 3000 / 5173 / 3001). Vite reads `VITE_API_PORT` and `VITE_MCP_PORT` for proxy targets (both default to the standard ports).
