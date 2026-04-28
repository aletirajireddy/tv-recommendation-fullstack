# Ultra Scalper Dashboard — Client

**Version**: 3.0
**Stack**: React 18 + Vite + Recharts + Zustand
**Port**: 5173 (production), 5174 (dev)
**Backend**: Node.js/Express on port 3000
**MCP AI Server**: Node.js/Express on port 3001

This is the frontend for the Ultra Scalper Dashboard — a real-time crypto trading analytics dashboard built on top of TradingView screener data. It proxies all `/api/*` requests to the backend (port 3000) and all `/mcp/*` requests to the MCP AI server (port 3001) via Vite's dev proxy.

---

## Quick Start

### Prerequisites
- Node.js v18+
- PM2 (`npm install -g pm2`) for production mode
- Backend running on port 3000
- Tailscale Funnel configured (for remote webhook ingestion)

### Development

```bash
# From the project root
cd client
npm install
npm run dev
# Client available at http://localhost:5173
```

Or start everything at once from the project root:

```bash
# Start all 3 services (backend 3000, client 5173, MCP 3001)
node start_all.js

# Or with PM2 (production)
pm2 start ecosystem.config.js

# Dev mode (non-conflicting ports 3010/5174/3011, with watch)
pm2 start ecosystem.dev.config.js
```

### Build

```bash
cd client
npm run build
npm run preview   # preview the production build locally
```

---

## What This Project Is

The Ultra Scalper Dashboard ingests live technical data from TradingView via four parallel data streams and consolidates it into a unified SQLite timeline. The frontend visualizes this data across multiple analytics widgets, a 3rd Umpire trade validator, and a performance calendar.

The system is designed around four architectural pillars:

### Pillar 1 — The Backend (`server/`)
The Governor. Ingests data from all 4 streams, runs the 3rd Umpire validator state machine, maintains the Master Coin Store materialized timeline, scores ghost coins, and exposes REST APIs for all analytics widgets. Uses `better-sqlite3` in WAL mode.

### Pillar 2 — The Data Harvesters (`scripts/`)
The Eyes. Tampermonkey scripts injected into TradingView scrape live screener data and send it to the backend over HTTP. TradingView cloud webhooks deliver institutional-grade smart-level alerts. A Gmail API rehydrator ensures zero data loss when webhooks are delayed.

### Pillar 3 — The Frontend (`client/`) — this directory
The Dashboard. React/Vite SPA that displays all analytics widgets. Acts as the Vite proxy router for external traffic — routes `/api/*` to the backend and `/mcp/*` to the MCP server. All widgets poll independently, are resilient to temporary backend failures, and show stale data rather than going blank.

### Pillar 4 — The MCP AI Server (`mcp-server/`)
The Intelligence Layer. Exposes the database as a read-only Model Context Protocol (MCP) server for Claude Desktop and other AI agents. Provides structured tools that return pre-calculated insights (market sentiment, validated setups, pattern stats) rather than raw SQL.

---

## Stream Data Flow

Four parallel data streams feed the system:

| Stream | Script | Endpoint | Signal |
|--------|--------|----------|--------|
| **A** | `symbol_market_scanner.js` (Tampermonkey) | `POST /scan-report` | 40-coin screener — 26-column technical schema (support/resistance, momentum, breakout, EMA distances, volSpike, direction) |
| **B** | `coin_scanner.js` (Tampermonkey) | `POST /api/stream/b-heartbeat` | Individual coin scout heartbeats |
| **C** | TradingView Cloud Webhooks | `POST /api/stream/c-alert` | Smart-level alerts + institutional interest events — highest-truth volume signal |
| **D** | `technical_watchlist_coin_scanner.js` (Tampermonkey) | `POST /api/stream/d-technicals` | RSI, ATR, RelVol, EMA200 per timeframe for watchlist coins |

All streams merge into the `master_coin_store` SQLite table via `MasterStoreService.js`. Volume spikes from all streams are discretized into the `volume_events` table via `VolumeEventService.js`.

---

## Project Structure (Client)

```
client/
├── src/
│   ├── components/
│   │   ├── AnalyticsWidgets/          # 6 analytics widgets (see below)
│   │   │   ├── EMACascadeMonitor.jsx
│   │   │   ├── DistanceTracker.jsx
│   │   │   ├── LevelReactionWidget.jsx
│   │   │   ├── TrialMiniChart.jsx
│   │   │   ├── DailyCalendarWidget.jsx
│   │   │   ├── GhostCoinWidget.jsx
│   │   │   └── ... (other widgets)
│   │   ├── Shared/                    # Shared UI primitives
│   │   ├── FloatingMediaPlayer.jsx    # DVR timeline controls
│   │   └── ValidatorTimelineWidget.jsx # 3rd Umpire trial list
│   ├── hooks/
│   │   └── usePolledFetch.js          # Shared polling hook (all analytics widgets)
│   ├── store/
│   │   └── useTimeStore.js            # Zustand store — DVR playback state
│   └── App.jsx
├── vite.config.js                     # Proxy config: /api → 3000, /mcp → 3001
├── package.json
└── README.md                          # This file
```

---

## Analytics Widgets

All analytics widgets live in `src/components/AnalyticsWidgets/`. Each widget independently polls its API endpoint, handles errors non-destructively (stale data stays visible), and pauses when the browser tab is hidden.

### 1. EMACascadeMonitor
**File**: `EMACascadeMonitor.jsx` | **API**: `GET /api/ema-cascade` | **Poll**: 60s

Shows the 1m/5m/15m/1h/4h EMA200 ladder for a single coin. Includes a price line chart with all 5 EMA lines overlaid (colour-coded by timeframe), volume spike pins (coloured by source: C=amber, A=blue, D=purple), and EMA state transition dots. A regime strip shows BULL/BEAR/MIXED classification, source health age chips, and a "last vol spike Xm ago" chip that shows even when the spike is outside the chart window.

Controls: ticker input, quick chips (BTC/ETH/SOL/BNB/XRP), window (1h/2h/4h/8h), bucket interval (1m/2m/5m).

### 2. DistanceTracker
**File**: `DistanceTracker.jsx` | **API**: `GET /api/ema-distance-board` | **Poll**: 60s

Cross-coin sortable table showing percentage distance from EMA200 for every active coin across all 5 timeframes. Cells are colour-coded: green (<0.5%), amber (0.5–2%), red (>2%). Filter by ±1/3/5/10% range. Sort by any column. Source dot indicates which stream provided the EMA data.

### 3. LevelReactionWidget
**File**: `LevelReactionWidget.jsx` | **API**: `GET /api/level-reactions` + `GET /api/volume-events` | **Poll**: 90s

12-lane swim-lane chart showing coins near structural support/resistance levels. Each lane has a mini area chart (normalized to the level price = 0), Stream D technical chips (RSI/ATR/RelVol), a vol badge with source and age, and a reaction classification badge (BOUNCE/REJECT/BREAK_BULL/BREAK_BEAR/TESTING/APPROACHING). Filter by level type and reaction type.

### 4. TrialMiniChart
**File**: `TrialMiniChart.jsx` | **API**: `GET /api/validator/trial/:id/ohlc` + `GET /api/volume-events`

Embedded inside each 3rd Umpire trial card. Shows real price data for the trial's coin and timeframe with overlaid reference lines (trigger price, smart level, EMA200), coloured zone fills (COOLDOWN=grey, WATCHING=blue), verdict line (green=CONFIRMED, red=FAILED), and volume spike pins.

### 5. DailyCalendarWidget
**File**: `DailyCalendarWidget.jsx` | **API**: `GET /api/calendar/daily` + `GET /api/calendar/day/:date` | **Poll**: 5 min

7-day performance calendar. Each day cell shows market mood, mood score, trial count, win rate, and top gainer/loser. Clicking a cell opens a drill modal with a full per-coin heatmap (open/close/day change/range/trials/win rate/verdict mix), all sortable. A `DrillErrorBoundary` prevents single bad rows from blanking the modal.

### 6. GhostCoinWidget
**File**: `GhostCoinWidget.jsx` | **API**: `GET /api/ghosts/queue` + mutating POST endpoints | **Poll**: 60s

Ghost approval queue for coins leaving the active watchlist. Each coin has a confidence score bar with a breakdown tooltip (base win rate, regime mood, multiplier, sample count). Scores are computed per-ticker from actual trial history (recency-weighted, 14-day half-life exponential decay) with fallback to pattern statistics. Supports single approve/prune actions and bulk Approve All / Prune All with confirmation.

---

## API Quick Reference

| Method | Endpoint | Widget |
|--------|----------|--------|
| POST | `/scan-report` | Stream A ingest |
| POST | `/api/stream/b-heartbeat` | Stream B ingest |
| POST | `/api/stream/c-alert` | Stream C ingest |
| POST | `/api/stream/d-technicals` | Stream D ingest |
| GET | `/api/ema-cascade?ticker&window_min&interval` | EMACascadeMonitor |
| GET | `/api/ema-distance-board?limit&max_dist&active_min` | DistanceTracker |
| GET | `/api/level-reactions?window_min&interval&limit&max_dist` | LevelReactionWidget |
| GET | `/api/volume-events?ticker&since_min` | TrialMiniChart, LevelReactionWidget |
| GET | `/api/volume-events?tickers=BTC,ETH&since_min` | LevelReactionWidget (batch) |
| GET | `/api/validator/trials` | ValidatorTimelineWidget |
| GET | `/api/validator/trial/:id/ohlc?interval` | TrialMiniChart |
| GET | `/api/calendar/daily?days=7` | DailyCalendarWidget |
| GET | `/api/calendar/day/:date` | DailyCalendarWidget (drill) |
| GET | `/api/ghosts/queue` | GhostCoinWidget |
| POST | `/api/ghosts/approve` | GhostCoinWidget |
| POST | `/api/ghosts/prune` | GhostCoinWidget |
| POST | `/api/ghosts/prune-all` | GhostCoinWidget |
| POST | `/api/ghosts/approve-all` | GhostCoinWidget |

---

## Key Frontend Patterns

### usePolledFetch Hook
All analytics widgets use the `usePolledFetch` custom hook (`src/hooks/usePolledFetch.js`) for polling. Key behaviours:
- Ref-pattern stable interval (no interval churn on dependency changes)
- `AbortController` per fetch cycle — previous in-flight request cancelled on each new cycle
- Page Visibility API — polling pauses when the tab is hidden
- Error: stale data is preserved, error state is set for a non-blocking banner

### Non-Blocking Error Pattern
Errors never replace widget content. They appear as banners above the last known data:
```jsx
{error && <div className={styles.errorBanner}>Refresh failed — showing last known data</div>}
{data && <WidgetContent data={data} />}
```

### Price Formatting
Use `smartFmt(price)` for all displayed price values. This applies dynamic decimal precision (2 decimals for large-cap prices, 4–6 for low-value assets) and handles the `parsePrice()` safety net at the ingest layer (strips thousands-separator commas before `parseFloat`).

---

## Vite Proxy Configuration

The `vite.config.js` routes external traffic to the correct backend service:

```js
// vite.config.js (abbreviated)
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true },
      '/mcp': { target: 'http://localhost:3001', changeOrigin: true },
    }
  }
});
```

Because the Tailscale Funnel maps the public URL to port 5173, all external traffic (webhooks, Claude Desktop MCP, mobile access) enters through this proxy. This is the **single ingress point** for the entire system.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_PORT` | `3000` | Backend port for Vite proxy target |
| `VITE_MCP_PORT` | `3001` | MCP server port for Vite proxy target |

Set in `.env` or `.env.local` at the `client/` directory level.

---

## Database (Backend Reference)

The backend uses `dashboard_v3.db` (SQLite, WAL mode) in the project root. Key tables relevant to frontend widget APIs:

| Table | Used By |
|-------|---------|
| `master_coin_store` | EMACascadeMonitor, LevelReactionWidget, TrialMiniChart, DailyCalendarWidget |
| `volume_events` | EMACascadeMonitor, LevelReactionWidget, TrialMiniChart |
| `validation_trials` | ValidatorTimelineWidget, TrialMiniChart, GhostCoinWidget |
| `pattern_statistics` | GhostCoinWidget (fallback scoring) |
| `ghost_approval_queue` | GhostCoinWidget |
| `coin_lifecycles` | DistanceTracker (active coin filter) |

---

## Architecture Reference

For the full system architecture including all 4 pillars, data stream details, DB schema, timestamp policy, and backend service documentation, see:

- `SYSTEM_ARCHITECTURE.md` — complete architecture reference (version 3.0)
- `REQUIREMENTS.md` — feature checklist with completion status
- `PERFORMANCE.md` — engineering notes on all performance decisions
- `WIDGETS.md` — full widget catalogue with API contracts and render notes
