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
        *   `query_master_coin_store` (V4 Materialized timeline spanning Stream A, B, and C).

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
| 2 — Trigger Detection | ✅ Complete | `onStreamC` creates trials, state machine transitions |
| 3 — Rule Evaluation | ✅ Complete | 7 rules evaluated per Stream A tick, verdicts resolved |
| 4 — Frontend Widget | ✅ Complete | `ValidatorTimelineWidget.jsx` — scrollable, top row, DVR-aware |
| 5 — Telegram + MCP + Stats | ✅ Complete | Enriched alerts, 7 MCP tools, pattern_statistics rebuild |

---

## Pillar 1 Extension: Timestamp Policy & Single Source of Truth

**Version**: 1.0 (Locked 2026-04-25)
**Module**: `server/services/TimestampResolver.js`

### Why this exists
Every record across `smart_level_events`, `institutional_interest_events`, and `master_coin_store` carries a `timestamp` column. Historically each ingest path computed its own — leading to three discrepancies:
1.  `MasterStoreService` invented its own `new Date()` instead of using the webhook's receive time.
2.  `UmpireEngine` used `payload.timestamp` (TradingView's bar-open time, lags 3–5 min).
3.  `email_rehydrator` used Gmail `internalDate` for everything (no late-arrival adjustment).

This caused the validator widget, calendar widget, and MCP queries to disagree on "what time did X happen?". **The fix is single-source resolution before insert.**

### The Resolver (`TimestampResolver.resolve`)
| Stream | Source | Canonical Timestamp |
|---|---|---|
| **A** (Tampermonkey scanner) | `SCAN_A` | `payload.timestamp` (browser is ground truth) |
| **B** (Coin scout) | `SCOUT_B` | `payload.timestamp` |
| **C** | `WEBHOOK` | Server receive time (`new Date()`). NOT `payload.timestamp`. |
| **C** | `EMAIL` (rehydrator) | Bar-close pivot logic — see below |

### Stream C Email Rehydration — Bar-Close Pivot
For each email-rehydrated alert:

```
bar_open       = payload.timestamp                    (TradingView {{time}})
bar_size       = derived from payload.interval/timeframe (default: 5m)
bar_close      = bar_open + bar_size
email_received = Gmail internalDate

IF email_received > bar_close + 5 min   → use bar_close   (email arrived LATE)
ELSE IF email_received in (bar_open, bar_close + 5m]  → use email_received
ELSE (clock skew)                       → fallback to bar_close
```

Supported bar sizes: `1m, 3m, 5m, 15m, 30m, 1h, 4h, 1d`. Default when undetectable: **5m**.

### Hash-Based Deduplication
- `payload_hash = SHA256(canonical_json(payload, minus_volatile_fields))` is computed at every ingest.
- Volatile fields stripped before hashing: `timestamp, time, fire_time, received_at, server_time, id, alert_id, message_id`.
- **Behavior on dup**: SKIP entirely (no insert, no update). Webhook beats email if it arrives first; email beats webhook only when webhook is missing.
- Unique indexes on `smart_level_events.payload_hash` and `institutional_interest_events.payload_hash` enforce this at the DB level.

### Provenance Flag (`ingestion_source`)
Every row in the three tables now carries one of: `WEBHOOK | EMAIL | SCAN_A | SCOUT_B`. Widgets can filter or visually mark "this trial was backfilled from email" vs "live webhook".

### Architectural Rules (binding for all future widgets / endpoints)
1.  **NEVER** call `new Date()` inside `MasterStoreService` — always pass `timestampISO` from caller.
2.  **NEVER** use `payload.timestamp` directly in `UmpireEngine` or any consumer — always pass `resolvedTimestampISO` through `opts`.
3.  **NEVER** recompute timestamps in the frontend — trust the `timestamp` column.
4.  **ALWAYS** call `TimestampResolver.resolve(...)` once at the ingestion boundary (webhook handler / rehydrator loop / scan handler) and propagate the result to every downstream sink.
5.  **ALWAYS** compute `payload_hash` once per ingest and pass it through to all sinks for cross-table dedup.

---

## Pillar 1 Extension: Master Coin Store V4

**Version**: 1.0 (Live)  
**Branch**: `feature/master-coin-store-v4`

### What it is
A centralized, event-sourced materialized timeline that unifies all asynchronous data streams (A, B, C) into a single, queryable historical record per coin. Designed specifically for deep AI forensics and complex historical backtesting.

### Key Components
*   **Database Table**: `master_coin_store` (stores full JSON state slices and a merged_context).
*   **Engine**: `server/services/MasterStoreService.js`. Implements a **point-in-time** merge strategy: when a backfilled email-rehydrated event is ingested, the merge uses stream states `WHERE timestamp <= resolved_timestamp` — not "latest known" — so historical inserts do not corrupt the timeline with future data.
*   **Pruning**: Built-in 30-day automated rolling prune engine to bound database growth.
*   **Ingestion Hooks**: Fire-and-forget `setImmediate` injections in `server/index.js` ensuring zero impact on live data flows.
*   **MCP Integration**: `query_master_coin_store` tool for LLM consumption.

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
