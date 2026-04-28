# TradingView Dashboard: System Architecture & Context Guide for AI

**Version**: 3.0 (Includes Analytics Widget Layer, Volume Event Service, Ghost Scoring Engine, Performance Audit)
**Last Updated**: April 27, 2026
**Branch**: `feature/master-coin-store-v4_validator-context-calendar`
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
    *   `coin_scanner.js` (Stream B): Isolated scout that pings specific qualified individual coins. Sends heartbeats to `/api/stream/b-heartbeat`.
    *   `technical_watchlist_coin_scanner.js` (Stream D): Technical screener — RSI, ATR, RelVol, EMA200 per timeframe. Sends to `/api/stream/d-technicals`.
    *   `TradingView Webhooks` (Stream C): Remote alerts (Smart Levels, Institutional Volumes) sent from the TV Cloud directly to the public funnel URL. Highest-truth volume signal. Also `institutional_interest_events`.
    *   **Fallback Rehydrator** (`email_rehydrator/`): A standalone Node.js daemon using the Gmail API (OAuth 2.0). If webhooks fail, it reads raw TradingView alerts directly from the user's inbox, deduplicates them against the DB, and injects any missing data. It acts as an unbreakable historical safety net.

### Pillar 3: The Presentation Layer (`client/`)
*   **Role**: The UI & External Ingress Proxy.
*   **Tech**: React, Vite, Zustand (State Management), Recharts.
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
        *   `query_master_coin_store` (V4 Materialized timeline spanning all streams).
        *   `get_volume_buildups`, `get_validated_setups`, `get_upcoming_watchers`, `get_pattern_stats`.

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

### Data Stream Summary

| Stream | Script | Ingest Endpoint | Signal Type |
|--------|--------|-----------------|-------------|
| A | `symbol_market_scanner.js` | `POST /scan-report` | 40-coin screener table, 26-column technical schema |
| B | `coin_scanner.js` | `POST /api/stream/b-heartbeat` | Individual coin scout heartbeats |
| C | TradingView Cloud Webhooks | `POST /api/stream/c-alert` | Smart-level alerts, institutional interest events — highest-truth volume signal |
| D | `technical_watchlist_coin_scanner.js` | `POST /api/stream/d-technicals` | RSI, ATR, RelVol, EMA200 per timeframe |

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

**Version**: 1.0 (All phases complete)
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
| `server/validator/UmpireEngine.js` | Event-driven state machine. Hooks: `onStreamA`, `onStreamC`, `checkTimers`. Trial lifecycle management. |
| `server/validator/statisticsEngine.js` | Pattern_statistics rebuild from resolved trials |
| `server/validator/settingsManager.js` | 15 configurable keys, seeded into `system_settings` on first boot |
| `server/validator/rules.js` | 7 rule evaluators |

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
|--------|--------|---------------------|
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
A centralized, event-sourced materialized timeline that unifies all asynchronous data streams (A, B, C, D) into a single, queryable historical record per coin. Designed specifically for deep AI forensics and complex historical backtesting.

### Key Components
*   **Database Table**: `master_coin_store` — stores full JSON state slices per stream and a merged_context.
*   **Schema**: `ticker, timestamp, price, stream_a_state JSON, stream_b_state JSON, stream_c_state JSON, stream_d_state JSON, trigger_source, payload_hash`
*   **Engine**: `server/services/MasterStoreService.js`. Implements a **point-in-time** merge strategy: when a backfilled email-rehydrated event is ingested, the merge uses stream states `WHERE timestamp <= resolved_timestamp` — not "latest known" — so historical inserts do not corrupt the timeline with future data.
*   **EMA200 Stack Merge**: MasterStoreService merges EMA200 readings from all streams, building the full 1m/5m/15m/1h/4h ladder per coin timeline row.
*   **Source Health Heartbeats**: Each stream's last-seen time is tracked per ticker. Frontend source health chips derive age from these.
*   **Pruning**: Built-in 30-day automated rolling prune engine to bound database growth.
*   **Ingestion Hooks**: Fire-and-forget `setImmediate` injections in `server/index.js` ensuring zero impact on live data flows.
*   **MCP Integration**: `query_master_coin_store` tool for LLM consumption.

---

## Pillar 1 Extension: Volume Event Service

**Version**: 1.0 (Live)
**Module**: `server/services/VolumeEventService.js`

### What it is
A discrete volume spike event log that aggregates signals from all three active streams into a single normalized table. Separates "volume happened" (discrete event) from "current volume state" (MasterStore field), enabling time-series queries that are independent of scan cadence.

### DB Table: `volume_events`
| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PK | Auto-increment |
| `ticker` | TEXT | Coin symbol (uppercase) |
| `ts` | INTEGER | Unix ms timestamp |
| `source` | TEXT | `STREAM_C_ALERT`, `STREAM_A_EDGE`, `STREAM_D_RVOL` |
| `strength` | REAL | Normalized strength (e.g., RelVol multiplier or raw vol spike value) |
| `meta` | JSON | Source-specific payload (price at event, direction, level context, etc.) |

### Source Classification
| Source | Trigger Condition | Notes |
|--------|-------------------|-------|
| `STREAM_C_ALERT` | Any Stream C smart-level or institutional interest webhook | Highest truth — direct TV cloud alert |
| `STREAM_A_EDGE` | Rising-edge detection: `volSpike` field transitions false→true in Stream A scan | Debounced — only records the edge, not sustained vol |
| `STREAM_D_RVOL` | Stream D RelVol crosses configurable threshold (default ≥ 1.5) | Per-timeframe; meta includes which TF triggered |

### Backfill Strategy
- On service startup, VolumeEventService performs a historical backfill by scanning `master_coin_store` for vol spikes that predate the `volume_events` table.
- Backfill runs inside a single SQLite transaction — eliminates per-row implicit-commit fsyncs, resulting in 50–100× speedup vs row-by-row insertion.

### API Endpoints
- `GET /api/volume-events?ticker=BTC&since_min=120` — single ticker, last N minutes
- `GET /api/volume-events?tickers=BTC,ETH,SOL&since_min=60` — batch multi-ticker, single IN-clause query, O(1) vs O(N) round-trips

### `lastVolEventMs` Field
All `/api/ema-cascade` responses include a top-level `lastVolEventMs` field that returns the timestamp of the last volume event for that ticker regardless of the requested chart window. This ensures the UI can always show "vol spike happened Xm ago" even when the most recent spike falls outside the current view window.

---

## Pillar 1 Extension: Ghost Scoring Engine

**Version**: 1.0 (Live)
**Module**: `server/services/GhostScoringEngine.js`

### What it is
A confidence scoring system for coins in the ghost approval queue — coins that are leaving the active watchlist and awaiting re-approval before being dropped entirely. Prevents good setups from being silently pruned during low-activity periods.

### DB Table: `ghost_approval_queue`
| Column | Type | Description |
|--------|------|-------------|
| `ticker` | TEXT | Coin symbol |
| `ghosted_at` | INTEGER | When coin entered ghost state |
| `confidence_score` | REAL | 0.0–1.0 current confidence |
| `base_win_rate` | REAL | Per-ticker historical win rate |
| `regime_mood` | TEXT | Current market mood label (normalized) |
| `regime_multiplier` | REAL | Mood-to-multiplier mapping value |
| `sample_count` | INTEGER | Number of resolved trials this ticker has |
| `last_scored_at` | INTEGER | When score was last recomputed |

### Scoring Algorithm
1. **Priority 1 — Per-Ticker Trial History**: Query `validation_trials` for resolved trials matching the ticker, compute recency-weighted win rate using exponential decay with a 14-day half-life. Weight = `exp(-days_ago / 14)`.
2. **Priority 2 — Pattern Statistics Fallback**: If fewer than 3 resolved trials exist for the ticker, fall back to the pre-aggregated `pattern_statistics` row matching the ticker's current direction/vol/EMA combination.
3. **Regime Multiplier**: The final score is multiplied by a market mood factor derived from `raw_market_sentiment_log`. Raw labels are normalized with `.replace(/\s+/g, '_').toUpperCase()` before lookup — prevents `STRONGLY BEARISH` vs `STRONGLY_BEARISH` mismatch silently falling through to NEUTRAL.

### Critical Fix: Label Normalization
All raw mood labels MUST be normalized before regime multiplier lookup:
```js
const normalizedLabel = rawLabel.replace(/\s+/g, '_').toUpperCase();
const multiplier = REGIME_MULTIPLIERS[normalizedLabel] ?? REGIME_MULTIPLIERS['NEUTRAL'];
```
Without this, multi-word labels like `STRONGLY BEARISH` silently resolve to NEUTRAL multiplier (1.0), inflating confidence scores during bear regimes.

### API Endpoints
- `GET /api/ghosts/queue` — returns full queue with freshly re-scored confidence per coin
- `POST /api/ghosts/approve` — approve a coin back into active watchlist
- `POST /api/ghosts/prune` — remove a coin from the queue and lifecycle
- `POST /api/ghosts/prune-all` — bulk prune all ghosts below threshold
- `POST /api/ghosts/approve-all` — bulk approve all ghosts above threshold

---

## Database Schema Reference (Complete)

### Core Ingestion Tables
| Table | Purpose |
|-------|---------|
| `scans` | Master scan records (scan_id, timestamp, mood, score) |
| `scan_results` | V3 JSON blob per scan (26-column screener payload) |
| `smart_level_events` | Stream C smart-level webhook records |
| `institutional_interest_events` | Stream C institutional volume webhook records |
| `raw_market_sentiment_log` | Raw mood labels per scan (BULLISH, BEARISH, etc.) |

### Master Timeline Table
| Table | Purpose |
|-------|---------|
| `master_coin_store` | Unified per-coin timeline rows (ticker, timestamp, price, stream_a_state, stream_b_state, stream_c_state, stream_d_state, trigger_source, payload_hash) |

### Volume & Events Tables
| Table | Purpose |
|-------|---------|
| `volume_events` | Discrete volume spike events (ticker, ts, source, strength, meta JSON) |
| `coin_lifecycles` | Born_at, last_seen_at, status per coin — lifecycle tracking |

### Validator Tables
| Table | Purpose |
|-------|---------|
| `validation_trials` | One row per 3rd Umpire trial — full feature snapshot at detection |
| `validation_state_log` | State transition tape (WATCHING → COOLDOWN → CONFIRMED/FAILED) |
| `pattern_statistics` | Pre-aggregated win rates by direction/vol/EMA combinations |

### Ghost & Config Tables
| Table | Purpose |
|-------|---------|
| `ghost_approval_queue` | Coins in ghost state with confidence scores and score breakdown |
| `system_settings` | Validator + system config keys (15 configurable keys) |

### Composite Indexes (Performance Critical)
| Index | Columns | Used By |
|-------|---------|---------|
| `idx_master_source_ticker_time` | `(source, ticker, timestamp DESC)` | Stream-filtered timeline queries |
| `idx_master_ticker_time` | `(ticker, timestamp DESC)` | Per-coin cascade, OHLC, level reactions |
| `idx_vol_ticker_ts` | `(ticker, ts DESC)` | Volume events batch queries |

---

## Analytics Widget Layer (`client/src/components/AnalyticsWidgets/`)

The Analytics Widget Layer is a collection of standalone React components that each independently poll the backend API and render a specific market intelligence view. All widgets follow the same operational contract:

- Poll on a fixed interval via `usePolledFetch` custom hook
- Use `AbortController` to cancel in-flight requests on unmount or interval churn
- Pause polling when the browser tab is hidden (Page Visibility API)
- Show stale data + non-blocking error banner on fetch failure (never blank the widget)

### Widget 1: EMACascadeMonitor (`EMACascadeMonitor.jsx`)

**Purpose**: Display the full 1m/5m/15m/1h/4h EMA200 ladder for a single ticker, including price history, volume spikes, and regime classification.

**API Endpoint**: `GET /api/ema-cascade?ticker=BTC&window_min=120&interval=2`

**Response Shape**:
```json
{
  "history": [{ "ts": 1714000000000, "price": 77000.5, "bucketVol": 1200 }],
  "volEvents": [{ "ts": 1714000000000, "source": "STREAM_C_ALERT", "strength": 2.4 }],
  "lastVolEventMs": 1714000000000,
  "transitions": [{ "ts": 1714000000000, "tf": "5m", "from": "ABOVE", "to": "TESTING" }],
  "defenseLevelNow": { "tf": "5m", "ema": 76800.0 },
  "lastBreak": { "ts": 1714000000000, "tf": "1h", "direction": "BULL" },
  "gaps": [{ "from": 1714000000000, "to": 1714003600000 }],
  "sourceHealth": { "A": 45000, "C": 128000, "D": 30000 },
  "stackNow": {
    "1m": { "ema": 76900, "state": "ABOVE", "distPct": 0.13 },
    "5m": { "ema": 76800, "state": "TESTING", "distPct": 0.26 },
    "15m": { "ema": 76500, "state": "ABOVE", "distPct": 0.65 },
    "1h": { "ema": 75000, "state": "ABOVE", "distPct": 2.67 },
    "4h": { "ema": 72000, "state": "ABOVE", "distPct": 6.94 }
  },
  "regime": "BULL",
  "bullDefenseTf": "5m",
  "bearCeilingTf": null
}
```

**Key Features**:
- Recharts ComposedChart: price line + 5 EMA lines colour-coded by timeframe + volume spike pins (ReferenceDot, colour by source) + transition event dots
- EMA ladder: 5 TF badges showing EMA price, cascade state (ABOVE/TESTING/BELOW), distPct sublabel
- State strip: BULL/BEAR/MIXED regime badge, bull defense TF, bear ceiling TF, source health chips showing age (A/C/D), last vol spike chip `▾vol·Xm ago` — shown even when no events in current window (uses `lastVolEventMs`)
- Controls: ticker input + quick chips (BTC/ETH/SOL/BNB/XRP), window selector (1h/2h/4h/8h), bucket interval (1m/2m/5m)
- Poll interval: 60s

### Widget 2: DistanceTracker (`DistanceTracker.jsx`)

**Purpose**: Cross-coin sortable table showing every active coin's % distance from 200 EMA across all 5 timeframes. Used to spot coins approaching or testing EMA200 at any timeframe simultaneously.

**API Endpoint**: `GET /api/ema-distance-board?limit=50&max_dist=10&active_min=30`

**Response Shape**:
```json
{
  "coins": [
    {
      "ticker": "BTC",
      "price": 77000.5,
      "source": "STREAM_D",
      "distances": {
        "1m": -0.13,
        "5m": 0.26,
        "15m": 0.65,
        "1h": 2.67,
        "4h": 6.94
      },
      "closest": { "tf": "5m", "distPct": 0.26 },
      "last_seen_ms": 1714000000000
    }
  ]
}
```

**Key Features**:
- Columns: Coin | Price | Closest (vs EMA200) | 1m % | 5m % | 15m % | 1h % | 4h %
- Colour coding: green < 0.5%, amber 0.5–2%, red > 2%
- Source dot: colour maps to Stream D (purple) / C (amber) / A (blue)
- Column header tooltip: "% distance from Xm 200 EMA (+ = above, − = below)"
- Filter toggle: ±1% / ±3% / ±5% / ±10% range
- Sort: click any column header (stable sort, ascending/descending)
- Performance: backed by 3 batched queries using indexed GROUP BY — ~30ms vs ~1.5s for prior N+1 approach
- Poll interval: 60s

### Widget 3: LevelReactionWidget (`LevelReactionWidget.jsx`)

**Purpose**: 12-lane swim-lane chart showing coins currently near structural support/resistance levels. Each lane is a single coin with a mini area chart normalized to the level price, plus full contextual metadata.

**API Endpoints**:
- `GET /api/level-reactions?window_min=120&interval=5&limit=12&max_dist=1.5`
- `GET /api/volume-events?tickers=BTC,ETH,...&since_min=120` (batch, secondary call)

**Level Reactions Response Shape**:
```json
{
  "lanes": [
    {
      "ticker": "BTC",
      "levelType": "SUPPORT",
      "levelPrice": 76800.0,
      "distPct": 0.26,
      "direction": "LONG",
      "reaction": "TESTING",
      "trendFlow": "UPTREND",
      "streamD": { "rsi": 52.3, "atr": 180.5, "relVol": 1.8 },
      "history": [{ "ts": 1714000000000, "normPrice": 0.0013 }]
    }
  ]
}
```

**Key Features**:
- 12-lane swim lane layout; each lane = one coin
- Lane header: TICKER | S/R badge | level type | price | distPct sublabel + rich tooltip | direction badge | trend flow label | Stream D chips (RSI, ATR, RelVol) | VOL badge (source-aware: C/A/D + age) | reaction badge (BOUNCE/REJECT/BREAK_BULL/BREAK_BEAR/TESTING/APPROACHING)
- Lane chart: area chart (green fill = above level, red fill = below), level=0 reference line, ±0.3% touch bands, volume spike pins coloured by source (C=amber, A=blue, D=purple)
- Filters: Support / Resistance / ALL toggle, reaction type multi-select
- Error handling: non-blocking error banner above stale lanes during fetch errors — never blanks the widget
- Performance: `React.memo` on `ReactionLane` prevents all 12 lanes re-rendering when only filter state changes
- Poll interval: 90s

### Widget 4: TrialMiniChart (`TrialMiniChart.jsx`)

**Purpose**: Embedded price chart within each 3rd Umpire trial card, showing the real price from `master_coin_store` for the trial's coin and timeframe. Provides visual confirmation of whether a trial's verdict was correct.

**API Endpoints**:
- `GET /api/validator/trial/:id/ohlc?interval=5` — OHLC candles for the trial's coin/TF
- `GET /api/volume-events?ticker=BTC&since_min=240` — volume spike pins

**Key Features**:
- Reference lines: trigger price (white dashed), smart level (orange dashed), 5m EMA200 (blue dotted)
- Zones: COOLDOWN period (grey fill), WATCHING period (blue tint fill)
- Verdict marker: vertical line at verdict timestamp (green = CONFIRMED, red = FAILED)
- Volume spike pins from `/api/volume-events` coloured by source
- `smartFmt(price)` dynamic decimal precision: 2 decimals for >$100, 4 decimals for >$1, 6 decimals for <$1 assets
- No standalone polling — re-renders when parent `ValidatorTimelineWidget` refreshes trial list

### Widget 5: DailyCalendarWidget (`DailyCalendarWidget.jsx`)

**Purpose**: 7-day performance calendar showing aggregate market mood and trial outcomes per day, with drilldown into a per-coin heatmap for any selected day.

**API Endpoints**:
- `GET /api/calendar/daily?days=7` — 7-day summary grid
- `GET /api/calendar/day/:date` — per-day coin heatmap (date format: `YYYY-MM-DD`)

**Daily Summary Response Shape**:
```json
{
  "days": [
    {
      "date": "2026-04-27",
      "mood": "BULLISH",
      "moodScore": 72,
      "trialCount": 14,
      "winRate": 0.71,
      "topGainer": { "ticker": "SOL", "changePct": 3.2 },
      "topLoser": { "ticker": "AVAX", "changePct": -1.8 }
    }
  ]
}
```

**Day Heatmap Response Shape**:
```json
{
  "date": "2026-04-27",
  "coins": [
    {
      "ticker": "BTC",
      "open": 76500.0,
      "close": 77200.0,
      "dayChangePct": 0.91,
      "rangePct": 1.4,
      "trials": 3,
      "longs": 2,
      "shorts": 1,
      "winRate": 0.67,
      "verdictMix": { "confirmed": 2, "failed": 1, "pending": 0 }
    }
  ]
}
```

**Key Features**:
- 7-cell grid: date, mood label, mood score, trial count, win rate (green/amber/red), top gainer/loser labels
- Click cell → `DayDrillModal` opens with full coin heatmap table
- Heatmap columns: Ticker | Open→Close | Day Δ% | Range % | Trials | L/S | Win Rate | Verdict Mix (✓✗·)
- All heatmap columns sortable
- `DrillErrorBoundary` wraps the modal — prevents a single bad row from blanking the entire drilldown page
- Query optimization: single-pass CTE + `ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp ASC)` / `DESC` replaces N correlated subqueries — fixes "today shows blank" issue when open/close correlated subqueries returned NULL for the most recent day
- Auto-refresh: 5 min poll interval

### Widget 6: GhostCoinWidget (`GhostCoinWidget.jsx`)

**Purpose**: Manages the ghost approval queue — coins leaving the active watchlist that need a confidence review before being permanently dropped.

**API Endpoints**:
- `GET /api/ghosts/queue` — full queue with re-scored confidence
- `POST /api/ghosts/approve` — approve a single coin
- `POST /api/ghosts/prune` — prune a single coin
- `POST /api/ghosts/prune-all` — bulk prune below threshold
- `POST /api/ghosts/approve-all` — bulk approve above threshold

**Queue Response Shape**:
```json
{
  "queue": [
    {
      "ticker": "AVAX",
      "ghosted_at": 1714000000000,
      "confidence_score": 0.61,
      "base_win_rate": 0.68,
      "regime_mood": "NEUTRAL_BULLISH",
      "regime_multiplier": 0.9,
      "sample_count": 7,
      "last_scored_at": 1714003600000
    }
  ]
}
```

**Key Features**:
- Confidence score bar per coin (0–100%) with score breakdown tooltip: base_win_rate, regime_mood, regime_multiplier, sample_count
- Per-ticker scoring: queries `validation_trials` directly (recency-weighted, 14-day half-life) before falling back to `pattern_statistics`
- Auto-Prune toggle: when enabled, coins below confidence threshold are pruned automatically on next ghost check cycle
- Prune All / Approve All bulk action buttons with confirmation prompt
- Poll interval: 60s

---

## Key API Endpoint Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/scan-report` | Stream A ingest (40-coin screener payload) |
| POST | `/api/stream/b-heartbeat` | Stream B individual coin heartbeat |
| POST | `/api/stream/c-alert` | Stream C smart-level or institutional webhook |
| POST | `/api/stream/d-technicals` | Stream D technical screener (RSI/ATR/RelVol/EMA200) |
| GET | `/api/ema-cascade` | EMA200 cascade chart: history, volEvents, lastVolEventMs, transitions, regime, sourceHealth, stackNow |
| GET | `/api/ema-distance-board` | Cross-coin EMA200 distance board (all 5 TFs) |
| GET | `/api/level-reactions` | Coins near structural levels with price history |
| GET | `/api/volume-events` | Discrete volume spike events (single ticker or batch) |
| GET | `/api/validator/trials` | Active + recently resolved trials |
| GET | `/api/validator/trial/:id/ohlc` | OHLC candles for one trial's mini-chart |
| GET | `/api/calendar/daily` | 7-day performance calendar |
| GET | `/api/calendar/day/:date` | Per-day coin heatmap |
| GET | `/api/ghosts/queue` | Ghost approval queue with re-scored confidence |
| POST | `/api/ghosts/approve` | Approve ghost coin back to active watchlist |
| POST | `/api/ghosts/prune` | Remove ghost coin permanently |

---

## Development Environment Setup

### Port Assignments
| Service | Production Port | Dev Port |
|---------|----------------|---------|
| Backend | **3000** | 3010 |
| Frontend | **5173** | 5174 |
| MCP Server | **3001** | 3011 |

This repo (`E:\AI\claude_project\tv-recommendation-fullstack`) is the **active working repo** and runs on the standard ports. The old repo at `E:\AI\tv_dashboard` is retired — its PM2 processes have been removed.

### Starting / Stopping
```bash
# From E:\AI\claude_project\tv-recommendation-fullstack

# Production
pm2 start ecosystem.config.js      # start all 3 services
pm2 restart ecosystem.config.js    # restart after code changes
pm2 stop ecosystem.config.js       # stop all
pm2 logs tv-backend --lines 30     # view backend logs

# Development (watch mode, non-conflicting ports)
pm2 start ecosystem.dev.config.js
```

### Env-Driven Port Config
All three services read their port from `process.env.PORT` (defaults: 3000 / 5173 / 3001). Vite reads `VITE_API_PORT` and `VITE_MCP_PORT` for proxy targets (both default to the standard ports).
