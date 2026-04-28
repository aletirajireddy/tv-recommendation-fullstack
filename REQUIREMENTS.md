# Institutional Pulse & Market Scanner Dashboard
## Technical Requirements & Architecture Document

### 1. Executive Summary
This project is a **Real-Time Market Analytics Dashboard** designed to ingest, store, and visualize high-frequency trading data from TradingView. It bridges the gap between TradingView's raw screener data/alerts and institutional-grade analytics by extracting data via local userscripts, storing it in a structured database, and presenting it via a responsive React dashboard.

**Current Branch**: `feature/master-coin-store-v4_validator-context-calendar`

### 2. System Architecture

#### 2.1 High-Level Data Flow
```mermaid
graph TD
    TV[TradingView Browser Tab]
    TM_S[Tampermonkey: Symbol Scanner - Stream A]
    TM_A[Tampermonkey: Coin Scanner - Stream B]
    TM_D[Tampermonkey: Technical Watchlist Scanner - Stream D]
    TV_W[TradingView Cloud Webhook - Stream C]

    subgraph Client Workstation
        TV --> TM_S
        TV --> TM_A
        TV --> TM_D

        TM_S -- "1. POST /scan-report" --> API[Node.js API (Port 3000)]
        TM_A -- "2. POST /api/stream/b-heartbeat" --> API
        TM_D -- "4. POST /api/stream/d-technicals" --> API

        API -- Write --> DB[(SQLite V3 Database)]
        API -- WebSocket (Socket.IO) --> FE[React Client (Port 5173)]

        FE -- HTTP GET --> API
    end

    subgraph Ingress Layer
        TV_W -- "3. POST /api/stream/c-alert" --> TS[Tailscale Funnel]
        TS -- "https://desktop-c92c19n.../api/*" --> Proxy[Vite Proxy: Port 5173]
        Proxy -- "Forward /api" --> API
    end
```

#### 2.2 Core Components

**A. Data Ingestion Layer (Tampermonkey)**
1.  **`symbol_market_scanner.js`** (Stream A): The primary orchestrator.
    *   Scrapes the TradingView Screener table DOM for 40 coins.
    *   Captures the full 26-column technical schema (Support/Resistance, Momentum, Breakout, EMA distances, volSpike, direction, etc.).
    *   Sends unified payload to `POST /scan-report`.
2.  **`coin_scanner.js`** (Stream B): Isolated individual coin scout.
    *   Pings specific qualified coins; sends heartbeats to `POST /api/stream/b-heartbeat`.
3.  **`technical_watchlist_coin_scanner.js`** (Stream D): Technical screener.
    *   RSI, ATR, RelVol, EMA200 per timeframe per watchlisted coin.
    *   Sends to `POST /api/stream/d-technicals`.
4.  **TradingView Cloud Webhooks** (Stream C): Smart-level and institutional interest alerts.
    *   Highest-truth volume signal — sourced directly from TradingView cloud.
    *   Sends to `POST /api/stream/c-alert`.
5.  **Fallback Rehydrator** (`email_rehydrator/`): Gmail API (OAuth 2.0) daemon.
    *   Reads TradingView alerts from inbox when webhooks fail.
    *   Deduplicates against DB via `payload_hash`.
    *   Acts as unbreakable historical safety net.

**B. Backend Layer (Node.js/Express)**
*   **Server**: Express.js running on Port 3000.
*   **Database**: SQLite (`dashboard_v3.db`, WAL mode).
*   **Real-Time**: Socket.IO emits `scan-update` and `scan-update` events to connected clients immediately upon data ingestion.
*   **Core Services**:
    *   `MasterStoreService.js` — unified per-coin timeline store, EMA200 stack merge, sourceHealth heartbeats
    *   `VolumeEventService.js` — discrete volume spike event table, rising-edge detection, crossing detection
    *   `GhostScoringEngine.js` — confidence scoring for ghost approval queue
    *   `TimestampResolver.js` — canonical timestamp resolution across all 4 streams

**C. Frontend Layer (React/Vite)**
*   **Client**: Single Page Application (SPA) running on Port 5173.
*   **State Management**: Zustand (`useTimeStore`) for timeline playback and live data switching.
*   **Visualization**: Recharts for charts, CSS Modules for component styling.
*   **Polling**: `usePolledFetch` custom hook (ref-pattern stable interval, AbortController, Page Visibility API).
*   **Views**:
    *   **Monitor Mode**: Historical playback, "DVR-style" rewinding of market scans.
    *   **Eagle Eye Hardening**: Institutional-grade temporal isolation. All widgets are bound to the DVR scrubber to prevent future-data leakage.
    *   **Analytics Mode**: High-level grids and the full Analytics Widget Layer.

**D. MCP AI Layer (Node.js/Express)**
*   **Server**: Express.js running on Port 3001.
*   **Transport**: SSE at `/mcp/sse`.
*   **Safety**: Readonly SQLite connection — cannot modify production data.
*   **Tools**: `get_market_sentiment`, `get_master_watchlist`, `get_top_catalysts`, `get_institutional_pulse`, `analyze_target`, `query_master_coin_store`, `get_volume_buildups`, `get_validated_setups`, `get_upcoming_watchers`, `get_pattern_stats`, `get_trial_details`, `get_coin_lifecycles`, `get_ghost_approval_queue`.

### 3. Technical Implementation Details

#### 3.1 Port Configuration & Proxy
*   **Backend (`tv-api`)**: `http://localhost:3000`
*   **Frontend (`tv-client`)**: `http://localhost:5173`
*   **MCP Server (`tv-mcp`)**: `http://localhost:3001`
*   **Ingress Proxy**: Vite's `server.proxy` routes `/api/*` and `/socket.io/*` to backend, `/mcp/*` to MCP server.
*   **Tailscale Funnel**: Frontend exposed at `https://desktop-c92c19n.tailbf6529.ts.net/`.

#### 3.2 Process Management
```bash
# Production
pm2 start ecosystem.config.js

# Development (watch mode, non-conflicting ports 3010/5174/3011)
pm2 start ecosystem.dev.config.js
```

### 4. Quick Run Guide

#### Prerequisites
*   Node.js (v18+)
*   PM2 (`npm install -g pm2`)
*   Tampermonkey Extension installed in Browser
*   Tailscale Configured for Funnel

#### Start the Ecosystem
```bash
# Option 1: Development Runner
node start_all.js

# Option 2: PM2 Production
pm2 start ecosystem.config.js
pm2 save
```

---

### 5. Features Checklist

#### 5.1 Core Platform
- [x] **Live Ingestion**: Sub-second latency from TradingView to Dashboard.
- [x] **Time Travel**: "DVR" playback of previous market scans.
- [x] **Institutional Backtesting**: Hermetic temporal isolation (No future-data leakage).
- [x] **Live/Replay Indicator**: Visual state feedback (LIVE vs REPLAY).
- [x] **Institutional Pulse**: Detection of "Burst" and "Wave" alert clusters.
- [x] **Confluence Grid**: Visual heatmap of overlapping indicators (RSI + Momentum + Pattern).
- [x] **Floating Media Player**: Persistent controls for timeline navigation.
- [x] **Dual-Monitor Ready**: Responsive grid layout that adapts to large screens.

#### 5.2 3rd Umpire Validator (branch: `feature/market-observer-validator`)
- [x] **DB Schema**: `validation_trials`, `validation_state_log`, `pattern_statistics` tables added (non-destructive).
- [x] **Settings Persistence**: 15 configurable keys in `system_settings` (cooldown, watch window, EMA roles, thresholds).
- [x] **Engine Skeleton**: `UmpireEngine` wired into Stream A and C ingestion hooks (fire-and-forget).
- [x] **Trigger Detection**: Opens trials on Stream C smart-level events (BOUNCE + BREAKOUT).
- [x] **Rule Evaluation**: 7 rules (5m/15m/1h/4h EMA, volume, reactive zone) evaluated per Stream A tick.
- [x] **Verdict Resolution**: CONFIRMED / FAILED / NEUTRAL_TIMEOUT / EARLY_FAVORABLE.
- [x] **DVR-Aware Widget**: `ValidatorTimelineWidget.jsx` — top row, replays state at any historical refTime.
- [x] **Settings Modal**: UI gear icon exposes all 15 config keys without code changes.
- [x] **Stats Panel**: Win-rate table + bar chart by stream/EMA/vol combination.
- [x] **CSV Export**: Date-picker download of `training_features` for future offline ML.
- [x] **Enriched Telegram**: Phase-2 verdict alerts with context, win-rate history, next level, invalidation.
- [x] **MCP Tools**: `get_volume_buildups`, `get_validated_setups`, `get_upcoming_watchers`, `get_pattern_stats`.

#### 5.3 Master Coin Store V4 (Materialized Timeline)
- [x] **DB Schema**: `master_coin_store` table added for unified stream merging.
- [x] **Ingestion Engine**: `MasterStoreService.js` for asynchronous state delta merging.
- [x] **EMA200 Stack Merge**: Full 1m/5m/15m/1h/4h EMA ladder merged per timeline row.
- [x] **Source Health Heartbeats**: Per-stream, per-ticker last-seen tracking.
- [x] **Rolling Prune Engine**: 30-day automated historical cleanup for DB size bounding.
- [x] **AI Forensics**: `query_master_coin_store` tool exposed in MCP server for timeline extraction.

#### 5.4 Timestamp Policy & Deduplication
- [x] **TimestampResolver**: Canonical timestamp resolution across all 4 streams.
- [x] **Stream C Bar-Close Pivot**: Email-rehydrated alerts use bar-close logic with late-arrival detection.
- [x] **Hash-Based Deduplication**: SHA256 `payload_hash` computed at ingest, unique indexes on event tables.
- [x] **Provenance Flag**: `ingestion_source` (WEBHOOK/EMAIL/SCAN_A/SCOUT_B) on all event rows.

#### 5.5 Volume Event Service
- [x] **DB Schema**: `volume_events` table (ticker, ts, source, strength, meta JSON).
- [x] **Stream A Rising-Edge Detection**: Records `STREAM_A_EDGE` events on volSpike transitions false→true.
- [x] **Stream C Integration**: All Stream C alerts recorded as `STREAM_C_ALERT` events.
- [x] **Stream D RelVol Crossing**: Records `STREAM_D_RVOL` when RelVol crosses threshold.
- [x] **Backfill**: Historical backfill from `master_coin_store` on startup (transaction-wrapped, fast).
- [x] **Batch API**: `?tickers=BTC,ETH,SOL` multi-ticker query in O(1) round-trips.
- [x] **`lastVolEventMs`**: Always returned in `/api/ema-cascade` regardless of window — prevents "no vol pins" UX confusion.

#### 5.6 Ghost Scoring Engine
- [x] **DB Schema**: `ghost_approval_queue` table with confidence score + breakdown columns.
- [x] **Per-Ticker Trial History**: Priority-1 scoring from `validation_trials` with recency-weighted win rate (14-day half-life exponential decay).
- [x] **Pattern Statistics Fallback**: Falls back to `pattern_statistics` when fewer than 3 resolved trials exist.
- [x] **Regime Multiplier**: Market mood multiplied into final score after label normalization.
- [x] **Label Normalization Fix**: `.replace(/\s+/g, '_').toUpperCase()` prevents `STRONGLY BEARISH` from silently resolving to NEUTRAL.
- [x] **Auto-Prune Toggle**: Configurable threshold for automatic ghost pruning.
- [x] **Bulk Actions**: Prune All / Approve All with confirmation.

#### 5.7 Dev Environment
- [x] **Zero-conflict ports**: Dev runs on 3010/5174/3011 alongside production 3000/5173/3001.
- [x] **`ecosystem.dev.config.js`**: Single command starts all three dev services in watch mode.
- [x] **Env-driven ports**: All services read PORT from environment — no hardcoded values.

---

### 6. Analytics Dashboard (New Widget Layer)

All widgets live in `client/src/components/AnalyticsWidgets/` and follow the same operational contract: `usePolledFetch` hook, AbortController cleanup, Page Visibility pause, non-blocking error banner.

#### 6.1 EMACascadeMonitor
- [x] **EMA Ladder**: 1m/5m/15m/1h/4h TF badges with cascade state (ABOVE/TESTING/BELOW) and distPct.
- [x] **Chart**: Price line + 5 colour-coded EMA lines + volume spike pins (by source) + transition event dots.
- [x] **State Strip**: BULL/BEAR/MIXED regime, bull defense TF, bear ceiling TF, source health chips, last vol spike chip.
- [x] **`lastVolEventMs`**: Vol chip shown even when last spike is outside current chart window.
- [x] **Controls**: Ticker input, quick chips (BTC/ETH/SOL/BNB/XRP), window (1h/2h/4h/8h), interval (1m/2m/5m).
- [x] **Poll**: 60s, AbortController, tab-visibility pause.

#### 6.2 DistanceTracker
- [x] **Cross-coin table**: All active coins × 5 TFs, % distance from EMA200.
- [x] **Colour coding**: Green (<0.5%), amber (0.5–2%), red (>2%).
- [x] **Source dot**: Stream D/C/A colour indicator per coin.
- [x] **Column tooltips**: "% distance from Xm 200 EMA (+ = above, − = below)".
- [x] **Range filter toggle**: ±1% / ±3% / ±5% / ±10%.
- [x] **Sortable**: Click any column header.
- [x] **Performance**: 3 batched queries (was N+1 up to 640 queries) — ~30ms response.
- [x] **Poll**: 60s.

#### 6.3 LevelReactionWidget
- [x] **12-lane swim-lane chart**: Each lane = one coin near a structural level.
- [x] **Lane header**: Ticker, S/R badge, level type, price, distPct, direction, trend flow, Stream D chips (RSI/ATR/RelVol), VOL badge, reaction badge.
- [x] **Lane chart**: Area chart (green above/red below level), level=0 line, ±0.3% touch bands, vol spike pins by source.
- [x] **Reaction types**: BOUNCE/REJECT/BREAK_BULL/BREAK_BEAR/TESTING/APPROACHING.
- [x] **Filters**: Support/Resistance/ALL toggle + reaction type multi-select.
- [x] **Non-blocking error**: Banner + stale lanes shown on fetch failure.
- [x] **React.memo**: `ReactionLane` memoized — prevents 12-lane re-render on filter changes.
- [x] **Poll**: 90s.

#### 6.4 TrialMiniChart
- [x] **Embedded chart**: Real price from `master_coin_store` for trial's coin/TF.
- [x] **Reference lines**: Trigger price (white dashed), smart level (orange dashed), EMA200 (blue dotted).
- [x] **Zones**: COOLDOWN (grey), WATCHING (blue tint).
- [x] **Verdict line**: Vertical line at verdict timestamp (green=CONFIRMED, red=FAILED).
- [x] **Vol spike pins**: Fetched from `/api/volume-events`, coloured by source.
- [x] **smartFmt**: Dynamic decimal precision based on asset price magnitude.

#### 6.5 DailyCalendarWidget
- [x] **7-day grid**: Date, mood label, mood score, trial count + win rate, top gainer/loser.
- [x] **DayDrillModal**: Full coin heatmap (Open/Close/Day Δ%/Range%/Trials/L|S/Win Rate/Verdict Mix), all columns sortable.
- [x] **DrillErrorBoundary**: Prevents single bad row from blanking the modal.
- [x] **CTE query optimization**: Single-pass `ROW_NUMBER() OVER (PARTITION BY ticker)` replaces N correlated subqueries — fixes "today blank" issue.
- [x] **Poll**: 5 min auto-refresh.

#### 6.6 GhostCoinWidget
- [x] **Confidence score bar**: Per coin with breakdown tooltip (base_win_rate, regime_mood, regime_multiplier, sample_count).
- [x] **Per-ticker scoring**: `validation_trials` direct query with recency-weighted win rate (priority), falls back to `pattern_statistics`.
- [x] **Auto-Prune toggle**: Configurable automatic ghost pruning.
- [x] **Bulk actions**: Prune All / Approve All buttons.
- [x] **Poll**: 60s.

---

### 7. Performance Engineering (Completed)

- [x] **Hot prepared statements**: All hot `better-sqlite3` statements hoisted to module scope — avoid re-prepare overhead on every request.
- [x] **Composite indexes**: `idx_master_source_ticker_time`, `idx_master_ticker_time`, `idx_vol_ticker_ts` on all hot query paths.
- [x] **Transaction-wrapped backfill**: VolumeEventService backfill inside single transaction — 50–100× speedup vs per-row implicit-commit.
- [x] **EMA distance board N+1 fix**: 3 batched queries via indexed GROUP BY (was up to 640 separate queries per request).
- [x] **Calendar CTE fix**: CTE + ROW_NUMBER() OVER (PARTITION BY ticker) for open/close — eliminates correlated subqueries, fixes today-blank bug.
- [x] **Volume events batch mode**: Single IN-clause query for multi-ticker requests — O(1) vs O(N) round-trips.
- [x] **Price parsing bug (critical)**: `parsePrice()` helper strips commas before parseFloat — fixes BTC showing as $77 instead of $77,000.
- [x] **`usePolledFetch` hook**: Ref-pattern stable interval, AbortController per fetch, Page Visibility API pause.
- [x] **React.memo on ReactionLane**: Prevents all 12 lanes re-rendering on filter state changes.
- [x] **useMemo for chart series**: Hot paths (series, Y-domain, volEvents, transitions) memoized in all chart widgets.
- [x] **Recharts pin cap**: MAX_VOL_PINS=40, MAX_TR_DOTS=40 — avoids ~100-marker render cliff.
- [x] **Prop stability fix**: Pass `undefined` not `|| []` to memo'd components — `|| []` creates a new array ref every render, breaking React.memo.
- [x] **Non-blocking error pattern**: `error && <banner>` above stale data, not `error ? <replacement> : data`.
