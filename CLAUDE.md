# TV Recommendation Dashboard — Architecture & Design Reference

> Living document. Update whenever a design decision changes. Claude Code loads this automatically.
> Last major update: 2026-05-13 (Stream D RSI columns, RSIGridWall widget, MomentumPulse data-source redesign)

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite, Zustand, Recharts, CSS Modules |
| Backend | Node.js / Express, Socket.IO, SQLite (better-sqlite3) |
| Process manager | PM2 (`tv-client` id=1, `mcp-server` id=2, `tv-backend` id=3) |
| Build | `vite build` in `client/`, served via `vite preview` on PM2 |

> **PM2 ID note**: tv-backend is id=3 (was id=0 before port 3000 conflict required process deletion and re-registration). Always verify with `pm2 list` before using numeric IDs.

---

## Database

**File:** `dashboard_v3.db` — at the **project root** (`E:\AI\claude_project\tv-recommendation-fullstack\dashboard_v3.db`)

> `server/database.db` and `server/dashboard.db` are 0-byte placeholder files — ignore them.

**Path in code:** `path.resolve(__dirname, '..', 'dashboard_v3.db')` (see `server/database.js` line 5)

**PRAGMAs:** WAL mode, 64MB cache, mmap 300MB, temp_store=MEMORY, synchronous=NORMAL

### All Tables

| # | Table | Purpose | Key Columns |
|---|---|---|---|
| 1 | `scans` | Stream A scan index | `id TEXT PK`, `timestamp TEXT`, `trigger TEXT` |
| 2 | `scan_results` | Full Stream A blob | `scan_id TEXT PK`, `raw_data JSON` |
| 3 | `pulse_events` | Alert events from Stream A | `id TEXT PK`, `ticker`, `type`, `payload_json JSON` |
| 4 | `qualified_picks` | Stream B coin picks | `ticker`, `price`, `timestamp`, `raw_data JSON` |
| 4B | `qualified_picks_log` | Stream B picks log/test table | `ticker`, `type` (VELOCITY\|STABLE), `raw_data JSON` |
| 5 | `system_settings` | Key-value persistence | `key TEXT PK`, `value TEXT` |
| 6 | `raw_market_sentiment_log` | Pre-server-overwrite sentiment | `scan_id PK`, `raw_mood_score`, `raw_label` |
| 7 | `smart_level_events` | Stream C webhooks (technical) | `ticker`, `price`, `direction`, `roc_pct`, `raw_data JSON` |
| 8 | `institutional_interest_events` | Stream C webhooks (institutional) | `ticker`, `bar_move_pct`, `today_change_pct`, `today_volume` |
| 9 | `unified_alerts` | **VIEW** merging tables 7+8 | `id`, `ticker`, `timestamp`, `strength`, `origin` |
| 10 | `ghost_approval_queue` | Coins awaiting prune approval | `ticker PK`, `reason`, `is_approved`, `confidence_score` |
| 11 | `coin_lifecycles` | Long-term coin age tracking | `ticker PK`, `born_at`, `last_seen_at`, `status` |
| 12 | `validation_trials` | 3rd Umpire trial records | `trial_id PK`, `ticker`, `direction`, `state`, `verdict` |
| 13 | `validation_state_log` | Trial state transition tape | `trial_id FK`, `changed_at`, `state`, `current_price` |
| 14 | `pattern_statistics` | Pre-computed win rates | `stat_key PK`, `win_rate_15m/30m/1h`, `sample_count` |
| 15 | `master_coin_store` | **V4 unified event store** | `snapshot_id PK`, `ticker`, `trigger_source`, `stream_c_state JSON` |
| 16 | `market_context_logs` | Stream B batch watchlist snapshots | `id INTEGER PK`, `timestamp`, `payload_json TEXT` |
| 17 | `volume_events` | Discrete RVOL spike events | `ticker`, `ts`, `source`, `strength`, `payload_hash` |
| 18 | `coin_metric_history` | **Rolling 8h Stream D metrics** | see full schema below |

### `coin_metric_history` — Full Schema (post-migration 2026-05-13)

```sql
CREATE TABLE coin_metric_history (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ticker   TEXT    NOT NULL,
    ts       INTEGER NOT NULL,   -- Unix ms, floored to 2-min bucket
    atr_m15  REAL,               -- ATR% 15m
    atr_h1   REAL,               -- ATR% 1h
    atr_h4   REAL,               -- ATR% 4h   ← added migration
    rvol_m15 REAL,               -- Relative Volume 15m
    rvol_h1  REAL,               -- Relative Volume 1h
    dist_m15 REAL,               -- % distance price to EMA200 15m
    dist_h1  REAL,               -- % distance price to EMA200 1h
    dist_m1  REAL,               -- % distance price to EMA200 1m  ← added migration
    dist_m5  REAL,               -- % distance price to EMA200 5m  ← added migration
    dist_h4  REAL,               -- % distance price to EMA200 4h  ← added migration
    rsi_m5   REAL,               -- RSI 14 on 5m  ← added migration
    rsi_m15  REAL,               -- RSI 14 on 15m ← added migration
    rsi_m30  REAL,               -- RSI 14 on 30m ← added migration
    rsi_h1   REAL                -- RSI 14 on 1h  ← added migration
);
CREATE INDEX idx_cmh_ticker_ts ON coin_metric_history(ticker, ts DESC);
```

**Dedup rule:** `INSERT OR REPLACE` with bucket key `(ticker, ts)`. `ts` is floored to nearest 2-minute boundary via `Math.floor(tsMs / 120000) * 120000`.

**Pruning:** Rows older than 8 hours deleted inline every write. Max ~1,200 rows at 50 coins × 2-min buckets.

### `master_coin_store` — Stream C State Structure

```js
// stream_c_state JSON field — parsed in endpoints
{
    price: "77000.00",
    today_change_pct: 2.34,   // ← USE THIS (session-based change%)
    today_volume: 45000000,   // ← USE THIS (today's dollar volume)
    rsi_matrix: { ... },      // ← NEVER USE FOR RSI (use coin_metric_history instead)
    momentum: {
        roc_pct: 1.45,        // rate-of-change %
        direction: 1          // 1=up, -1=down, 0=flat
    },
    support_dist: 1.23,
    resist_dist: -0.8,
    ...
}
```

---

## Data Streams — Authoritative Reference

### Stream A — Macro Scan (TradingView Screener)
- **Endpoint:** `POST /scan-report`
- **Source:** Browser Tampermonkey script scanning all coins
- **Stores to:** `scans`, `scan_results`, `pulse_events`, `master_coin_store` (trigger_source='STREAM_A')
- **Frequency:** ~1-5 min, batch
- **Key fields:** `momScore`, `netTrend`, `bias`, `volSpike`, `breakout`

### Stream B — Watchlist Context (Coin Scanner)
- **Endpoint:** `POST /api/market-context`
- **Source:** TradingView watchlist screener
- **Stores to:** `market_context_logs`, `master_coin_store` (trigger_source='STREAM_B')
- **Frequency:** Batch snapshot, less frequent than C
- **Key fields in `payload_json.watchlist_active_snapshot[]`:**
  - `short` (ticker), `price`, `change_pct`, `vol_raw`
- **IMPORTANT:** `change_pct` here is session-based (midnight UTC reset). Fresher per-coin data comes from Stream C.

### Stream C — Per-Coin Alerts (Smart Levels Webhook)
- **Endpoint:** `POST /api/webhook/smart-levels`
- **Source:** TradingView webhook alerts, fires per coin on scan/alert events
- **Stores to:** `smart_level_events`, `institutional_interest_events`, `master_coin_store` (trigger_source='STREAM_C'), `unified_alerts` (view)
- **Frequency:** Per-coin, on trigger — fresher than Stream B
- **Key fields:**
  - `today_change_pct` — session change% (midnight UTC reset) ← **USE THIS for change%**
  - `today_volume` — today's session volume ← **USE THIS for volume**
  - `roc_pct`, `direction` — momentum rate-of-change
- **NOTE:** Stream C also contains `rsi_matrix` — **NEVER use this for RSI values**. Only `coin_metric_history` (Stream D) has correct RSI.

### Stream D — Technical Indicators (Multi-TF Screener)
- **Endpoint:** `POST /api/stream-d/technicals`
- **Source:** TradingView multi-TF screener, pushed per coin with indicator values
- **Stores to:** `coin_metric_history` via `writeCoinMetric()`
- **Frequency:** ~2 minutes per coin
- **Field naming pattern:** `{indicatorName}Timeresolution{N}` where N = minutes (1, 5, 15, 30, 60, 240)

#### Stream D Field Names (exact)

| Data | Field pattern | Example |
|---|---|---|
| EMA 200 | `ema_200Timeresolution{N}` | `ema_200Timeresolution60` = EMA200 1h |
| ATR% | `averagetruerangepercent_14Timeresolution{N}` | `averagetruerangepercent_14Timeresolution15` = ATR% 15m |
| RSI 14 | `relativestrengthindex_14Timeresolution{N}` | `relativestrengthindex_14Timeresolution30` = RSI 30m |
| RVOL | `relative_volume_at_time_Timeresolution{N}` (primary) | Falls back to `relativevolume_liveTimeresolution{N}`, `relativeattime_14Timeresolution{N}`, `relativevolumecexTimeresolution{N}` |

#### Stream D TF Resolution Map

| Short | N (minutes) |
|---|---|
| m1 | 1 |
| m5 | 5 |
| m15 | 15 |
| m30 | 30 |
| h1 | 60 |
| h4 | 240 |

#### Stream D Extraction Function

```js
// server/index.js — _extractStreamDField()
function _extractStreamDField(data, pattern, resolutionMin) {
    const re = new RegExp(pattern + resolutionMin + '$', 'i');
    for (const key of Object.keys(data)) {
        if (re.test(key)) {
            const v = parseFloat(data[key]);
            return isFinite(v) ? v : null;
        }
    }
    return null;
}

// EMA distance: ((price - ema200) / ema200) × 100
// positive = price above EMA (bullish), negative = price below EMA (bearish)
```

---

## Critical Data Source Rules

> These rules are non-negotiable. Violating them produces wrong data.

1. **RSI values** — ONLY from `coin_metric_history` (`rsi_m5`, `rsi_m15`, `rsi_m30`, `rsi_h1`). **Never from `stream_c_state.rsi_matrix`.**
2. **EMA 200 values** — ONLY from `coin_metric_history` (`dist_m1` through `dist_h4`). **Never from Stream C.**
3. **Today's change%** — From `stream_c_state.today_change_pct` (Stream C, per-coin, fresher). Fallback: `market_context_logs` watchlist `change_pct` (Stream B, batch).
4. **Today's volume** — From `stream_c_state.today_volume` (Stream C). Fallback: Stream B `vol_raw`.
5. **Stream D change%** (`changecryptoInterval24h`) — Rolling 24h window (CMC-style). **Never equals** Stream B/C change% which resets at midnight UTC. Do not compare them.
6. **RVOL** — From `coin_metric_history` (`rvol_m15`, `rvol_h1`). Stream D only.

---

## Key API Endpoints

### Ingestion (Write)

| Endpoint | Method | Purpose |
|---|---|---|
| `/scan-report` | POST | Stream A: macro scan batch |
| `/api/market-context` | POST | Stream B: watchlist context snapshot |
| `/api/stream-d/technicals` | POST | Stream D: multi-TF indicators per coin |
| `/api/webhook/smart-levels` | POST | Stream C: per-coin alert webhook |

### Read Endpoints

| Endpoint | Params | Purpose |
|---|---|---|
| `/health` | — | Basic health check |
| `/api/system/health` | — | Stream A/B/C last timestamps (30s cache) |
| `/api/source-health` | — | Per-stream freshness for GlobalHeader |
| `/api/ema-distance-board` | `limit`, `active_min` | Per-coin EMA board (atrs, emas, dists per TF) |
| `/api/ema-cascade` | `ticker`, `window_min`, `interval` | Single-coin EMA200 time-series |
| `/api/ema-stack` | — | Latest EMA200 stack for all active coins |
| `/api/coin-metric-history` | `ticker`, `hours` | Raw rolling history for one coin |
| `/api/volume-events` | `limit`, `source` | RVOL spike discrete events |
| `/api/analytics/participation-pulse` | `window_min`, `interval_min` | Breadth of active coins over time |
| `/api/analytics/pulse` | various | Full analytics (scenarios, mood, alerts) |
| `/api/analytics/alpha-squad` | — | Institutional activity coins |
| `/api/analytics/research` | — | Research/recommendations feed |
| `/api/fusion/dashboard` | — | Fusion Command aggregated view |
| `/api/rsi-grid-wall` | `series_tfs`, `temp_tf`, `oversold`, `overbought`, `pullback_zone` | RSI cascade grid per coin |
| `/api/momentum-pulse` | `rvol_thresh`, `hist` | Momentum signals (Stream C+D) |
| `/api/smart-mood-chart` | `hours`, `interval_min` | Market mood timeline |
| `/api/level-reactions` | various | Level reaction events |
| `/api/validator/trials` | various | 3rd Umpire trial list |
| `/api/validator/stats` | — | Win rate statistics |
| `/api/calendar/daily` | — | Daily calendar events |
| `/api/calendar/day/:date` | — | Single-day detail |
| `/api/coins/age` | — | Coin lifecycle ages |
| `/api/ghosts/queue` | — | Ghost coins pending approval |
| `/api/ai/history` | — | AI recommendations history |
| `/api/smart-alerts/*` | — | Smart alerts CRUD (via smartAlertsRouter) |

### `/api/rsi-grid-wall` — Response Structure

```js
{
  coins: [{
    ticker: "BTCUSDT.P",
    clean: "BTC",
    ts: 1715000000000,
    rsi: { m5: 45.2, m15: 38.1, m30: 35.4, h1: 32.0 },
    cascadeState: "BEAR_CASCADE",   // BEAR_CASCADE | BULL_CASCADE | PARTIAL_BEAR | PARTIAL_BULL | NEUTRAL
    tempZone: "middle",             // oversold | middle | overbought
    tempDir: "down",                // up | down | flat (±0.5 threshold between buckets)
    prevTempZone: "oversold",
    pullback: false                 // true when cascade active + tempTF RSI near 50
  }],
  config: { seriesTFs, tempTF, oversold, overbought, pullbackZone }
}
```

### `/api/momentum-pulse` — Response Structure

```js
{
  coins: [{
    ticker: "BTCUSDT.P",
    clean: "BTC",
    price: 77000,
    changePct: 2.34,       // from Stream C today_change_pct (or Stream B fallback)
    volume: 45000000,      // from Stream C today_volume (or Stream B fallback)
    rocPct: 1.45,          // Stream C momentum.roc_pct
    direction: 1,
    rvolNow: 1.42,         // Stream D rvol_m15
    atrNow: 0.82,          // Stream D atr_m15
    distNow: 1.23,         // Stream D dist_m15 (% above/below EMA200 15m)
    rsi_m15: 38.1,         // Stream D ONLY — never Stream C
    rsi_m30: 35.4,         // Stream D ONLY
    rsi_h1: 32.0,          // Stream D ONLY
    rvolPersist: 7,        // consecutive 2-min buckets above rvolThresh
    rvolTrend: "rising",   // rising | fading | flat
    distState: "above",    // extended_high | above | near_ema | below | extended_low | neutral
    signal: "BUILDING",    // SURGING | BUILDING | RSI_OS | RSI_OB | FADING | EXTENDED | STRETCHED | AT EMA | WATCH
    rvolSpark: [...],      // last 15 rvol_m15 values for sparkline
    src: "STREAM_C",       // STREAM_C | STREAM_B (data origin for change%/volume)
    scTs: "2026-05-13T..."
  }],
  ts: 1715000000000,
  rvolThresh: 1.2
}
```

**Signal definitions:**
- `SURGING`: rvolPersist ≥ 5 AND change% > 2% AND dist > 1%
- `BUILDING`: rvolPersist ≥ 3 AND change% > 0
- `RSI_OS`: rsi_m15 < 30 AND rsi_h1 < 40 (multi-TF oversold from Stream D)
- `RSI_OB`: rsi_m15 > 70 AND rsi_h1 > 60 (multi-TF overbought from Stream D)
- `FADING`: rvolTrend=fading AND dist > 2%
- `EXTENDED`: dist > 4% AND rvol < 1 (stretched without volume)
- `STRETCHED`: dist < -4% AND rvol < 1
- `AT EMA`: |dist| < 0.5%

---

## All Widgets — Reference

| Widget | Section ID | File | localStorage Key | Data Source |
|---|---|---|---|---|
| 3rd Umpire | `section-umpire` | `ValidatorTimelineWidget.jsx` | `validatorTimeline_prefs` | `/api/validator/trials` |
| Levels Monitor | `section-levels` | `LevelReactionWidget.jsx` | `levelReaction_prefs` | `/api/level-reactions` |
| EMA Cascade | `section-cascade` | `EMACascadeMonitor.jsx` | `emaCascade_prefs`, `emaCascade_ticker` | `/api/ema-distance-board`, `/api/ema-cascade` |
| Participation | `section-scout` | `ParticipationPulseWidget.jsx` | `participation_prefs` | `/api/analytics/participation-pulse` |
| Alpha Squad | `section-alpha` | `AlphaScatter.jsx` | — | `/api/analytics/alpha-squad` |
| Distance Board | `section-dist` | `DistanceTracker.jsx` | `distanceTracker_prefs` | `/api/ema-distance-board` |
| Cascade Board | `section-race` | `ATRRaceWidget.jsx` | `raceWidget_prefs` | `/api/ema-distance-board`, `/api/volume-events` |
| Smart Alerts | `section-alerts` | `SmartAlertsWidget.jsx` | — | `/api/smart-alerts/*` |
| Fusion Command | `section-fusion` | `FusionDashboard.jsx` | — | `/api/fusion/dashboard` |
| RSI Distribution | `section-rsi-dist` | `RSIDistributionWidget.jsx` | — | `/api/analytics/pulse` |
| Market Structure | `section-market-structure` | `MarketStructureWidget.jsx` | — | `/api/analytics/pulse` |
| Confluence Grid | `section-confluence` | `ConfluenceGrid.jsx` | `confluence_prefs` | `/api/analytics/pulse` |
| Alerts Analyzer | `section-alerts-analyzer` | `AlertsAnalyzer.jsx` | — | `/api/analytics/pulse` |
| Recommendations | `section-recommendations` | `RecommendationsFeed.jsx` | — | `/api/analytics/research` |
| RSI Grid Wall | `section-rsi-grid` | `RSIGridWall.jsx` | `rsiGridWall_prefs` | `/api/rsi-grid-wall` |
| Momentum Pulse | `section-momentum-pulse` | `MomentumPulse.jsx` | `momentumPulse_prefs` | `/api/momentum-pulse` |
| Smart Mood | `section-smart-mood` | `SmartMoodChart.jsx` | `smartMood_prefs` | `/api/smart-mood-chart` |
| Daily Calendar | `section-calendar` | `DailyCalendarWidget.jsx` | `dailyCalendar_prefs` | `/api/calendar/daily` |
| Ghost Coins | live-only, no anchor | `GhostCoinWidget.jsx` | — | `/api/ghosts/queue` |
| Coin Age | `section-coin-age` (live-only) | `CoinAgeWidget.jsx` | — | `/api/coins/age` |

### RSI Grid Wall Widget Details

**File:** `client/src/components/AnalyticsWidgets/RSIGridWall.jsx`

**Concept:** Per-coin 4-column card grid where each coin shows an RSI "candle" on a 0-100 scale.

**RSI Candle SVG (W=48, H=88):**
- Zone backgrounds: red zone (0–oversold), green zone (overbought–100), gray middle
- Body rect: spans between `y(rsiSeries[0])` and `y(rsiSeries[1])` (configured cascade TFs)
  - Red body = both series oversold (BEAR_CASCADE)
  - Green body = both series overbought (BULL_CASCADE)
  - Gray = partial or neutral
- White horizontal line: position of tempTF RSI (default 15m)
- Direction arrow polygon: ▲ if rising, ▼ if falling based on prev bucket
- Amber glow border (`cardPulse` animation): when cascadeActive AND tempTF near 50

**Default settings (`rsiGridWall_prefs`):**
```js
{
  seriesTFs: ['h1', 'm30'],   // cascade body TFs (longest→shortest)
  tempTF: 'm15',              // white line TF
  oversold: 30,
  overbought: 70,
  pullbackZone: 5,            // distance from 50 that qualifies as pullback
  filter: 'all'               // all | bear | bull | pullback
}
```

**Sort order:** BEAR_CASCADE → BULL_CASCADE → PARTIAL_BEAR → PARTIAL_BULL → NEUTRAL. Pullback coins float up within group.

**Data readiness:** RSI columns were added to `coin_metric_history` 2026-05-13. On fresh install, widget shows "waiting for Stream D" until the first 2-min scan cycle.

### Momentum Pulse Widget Details

**File:** `client/src/components/AnalyticsWidgets/MomentumPulse.jsx`

**Data hierarchy:**
1. `today_change_pct` / `today_volume` → Stream C (`master_coin_store.stream_c_state`)
2. Fallback for coins not in Stream C → Stream B (`market_context_logs` watchlist)
3. `rsi_m15`, `rsi_m30`, `rsi_h1`, `rvol_m15`, `atr_m15`, `dist_m15` → Stream D ONLY (`coin_metric_history`)

**Filters:** all, surging, building, rsi, fading, extended, stretched

**Sort keys:** changePct, rvolNow, rvolPersist, distNow, rsi_m15, rsi_h1

**Source indicator column:** shows `C·Xm` (Stream C, age in minutes) or `B` (Stream B fallback)

---

## EMA Cascade Logic (CORRECT DEFINITION)

### Core concept — EMA value stacking, NOT price-to-EMA distance

The cascade is determined by comparing actual **EMA200 price values** across timeframes, not whether price is above/below each EMA (`dists`).

**In an uptrend, shorter-TF EMAs are higher** (they react faster to rising price):
```
Bull cascade: ema(4h) < ema(1h) < ema(15m)
              $15       $17       $18       ✓

Bear cascade: ema(4h) > ema(1h) > ema(15m)
              $20       $17       $15       ✓
```

### Equal-level threshold

If two adjacent EMA values are within **0.2%** of each other they are treated as equal — the cascade is still valid through that level.

```js
const pctDiff = ((emaShorter - emaLonger) / emaLonger) * 100;
// Within ±threshold → treated as equal, cascade continues
```

### Cascade check function (universal, works for any TF series)

```js
// seriesTFs: ordered longest → shortest, e.g. ['h4', 'h1', 'm15']
// Returns 'bull' | 'bear' | 'neutral'
function checkCascade(emas, seriesTFs, threshold = 0.2) {
    let isBull = true, isBear = true;
    for (let i = 0; i < seriesTFs.length - 1; i++) {
        const emaLonger  = emas[seriesTFs[i]];
        const emaShorter = emas[seriesTFs[i + 1]];
        if (!emaLonger || !emaShorter) return 'neutral';
        const pctDiff = ((emaShorter - emaLonger) / emaLonger) * 100;
        if (pctDiff < -threshold) isBull = false;
        if (pctDiff > threshold)  isBear = false;
    }
    if (isBull && !isBear) return 'bull';
    if (isBear && !isBull) return 'bear';
    return 'neutral';
}
```

### Configurable series

| Setting | Default | Options |
|---|---|---|
| Long-term series | `['h4', 'h1', 'm15']` | Any 2+ TFs, longest→shortest |
| Counter-trend series | `['m5', 'm1']` | Any 1+ TFs |
| Equal threshold | `0.2%` | Configurable in settings panel |

**Counter-trend uses ATR(15m) as noise filter:**
```
Counter signal is real only if:
|ema(m5) - ema(m1)| > ATR(15m) value of that coin
```

### 4 Classification Groups

| Group | Condition |
|---|---|
| **Long Bull** | `checkCascade(emas, longSeries) === 'bull'` |
| **Long Bear** | `checkCascade(emas, longSeries) === 'bear'` |
| **Temp Bull** | Long Bear cascade AND counter series bullish AND gap > ATR(15m) |
| **Temp Bear** | Long Bull cascade AND counter series bearish AND gap > ATR(15m) |

### Components sharing cascade settings (`emaCascade_prefs`)

1. EMACascadeMonitor dropdown — cascade badges
2. EMACascadeMonitor reversal chips (↗ Temp Bull / ↘ Temp Bear)
3. ATR Race Widget — 4 pre-built filter groups

---

## RSI Grid Wall Cascade (Different from EMA Cascade)

RSI cascade is INDEPENDENT from EMA cascade. It measures RSI zone alignment across TFs:

| State | Condition |
|---|---|
| `BEAR_CASCADE` | ALL series TFs in oversold zone (< oversold threshold) |
| `BULL_CASCADE` | ALL series TFs in overbought zone (> overbought threshold) |
| `PARTIAL_BEAR` | SOME series TFs oversold |
| `PARTIAL_BULL` | SOME series TFs overbought |
| `NEUTRAL` | None of the above |

**Pullback condition:** cascadeActive (BEAR or BULL) AND tempTF RSI is in middle zone AND |tempRSI - 50| ≤ pullbackZone+5

---

## Widget Persistence Pattern

Every widget saves user selections to localStorage and restores on reload.

```js
const LS_KEY = 'widgetName_prefs';
const DEFAULTS = { windowMin: 120, intervalMin: 2 };

function loadPrefs() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_KEY));
        return s ? { ...DEFAULTS, ...s } : { ...DEFAULTS };
    } catch { return { ...DEFAULTS }; }
}

// Save on change:
localStorage.setItem(LS_KEY, JSON.stringify(newPrefs));

// Reset: remove key, revert state to DEFAULTS
localStorage.removeItem(LS_KEY);
```

Reset button always restores pristine defaults and clears localStorage.

---

## `usePolledFetch` Hook Pattern

```js
// Takes a URL factory function so deps can trigger re-fetch automatically
const { data, loading, error } = usePolledFetch(
    () => `/api/rsi-grid-wall?${new URLSearchParams(params)}`,
    { intervalMs: 30_000, deps: [apiUrl] }
);

// When deps change (e.g. user changes TF selection → apiUrl changes),
// hook auto-cancels pending fetch and fires immediately.
```

---

## Sidebar Navigation

**File:** `client/src/components/Sidebar.jsx`

All 20 widgets have sidebar entries. Menu items specify `id` (matches `section-{id}` in `App.jsx`) and `prefetch` (lazy import triggered on hover for zero skeleton flash on scroll).

**Collapse behavior:**
- Desktop: instant width collapse (no animation), labels hidden via `display:none`
- Mobile (≤1024px or `pointer:coarse`): full-height fixed drawer, slides from left

**Mobile state:** controlled via `useTimeStore` `mobileMenuOpen` / `setMobileMenuOpen`. ESC key closes the drawer. Body scroll locked when open.

---

## Performance Patterns

### FOUC prevention

Synchronous inline `<script>` in `client/index.html` `<head>` reads `dashboard-theme-storage` from localStorage and applies CSS vars before React first paint.

### Zustand granular selectors

```js
// Always use field selectors, never bare useTimeStore()
const activeScan = useTimeStore(s => s.activeScan);  // ✓
const store = useTimeStore();                          // ✗ subscribes to everything
```

### Leading-edge throttle on socket pushes

`_lastPushMs` + `_bumpDataPush(set)` in `useTimeStore.js` — 500ms minimum between `lastDataPush` updates. Prevents cascading re-renders on rapid socket events.

### `usePolledFetch` equality guard

```js
setData(prev => JSON.stringify(prev) === JSON.stringify(payload) ? prev : payload);
```
Skips re-render when socket delivers identical data.

### Series decimation (LevelReactionWidget pattern)

```js
if (points.length <= 120) return points;
const step = Math.ceil(points.length / 120);
return points.filter((_, i) => i % step === 0 || i === points.length - 1);
```

### Recharts performance defaults

Always set on every chart: `isAnimationActive={false}`, `dot={false}` on Line, `hide` on unused YAxis.

### Vol event marker cap

Cap `ReferenceLine`/`ReferenceDot` arrays to 40 max before passing to Recharts:
```js
const volEvents = useMemo(() => (data?.volEvents || []).slice(-40), [data]);
```

### SQLite window function for latest-N-per-ticker

```sql
-- Efficient pattern used in rsi-grid-wall and momentum-pulse endpoints
WITH ranked AS (
    SELECT ticker, ts, ...,
           ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY ts DESC) AS rn
    FROM coin_metric_history
    WHERE ts > ?
)
SELECT r1.*, r2.rsi_m15 AS prev_m15  -- current + previous row
FROM ranked r1
LEFT JOIN ranked r2 ON r1.ticker = r2.ticker AND r2.rn = 2
WHERE r1.rn = 1
```

---

## Common Operational Tasks

### Restart backend after code change

```powershell
pm2 restart tv-backend   # id=3
```

### Port 3000 conflict (EADDRINUSE)

```powershell
netstat -ano | findstr ":3000"
Stop-Process -Id <PID> -Force
pm2 restart tv-backend
```

### Rebuild client

```powershell
pm2 stop tv-client       # release dist folder lock on Windows
cd client
npm run build
pm2 start tv-client
```

### Run DB migrations (adding columns safely)

```js
// Pattern used in database.js — safe for production (ignores if exists)
function _safeAddColumn(table, columnDef, columnName) {
    try {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        if (!cols.find(c => c.name === columnName)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
        }
    } catch (e) { console.error(`Migration error:`, e.message); }
}
```

### Find real database path

`server/database.js` line 5: `path.resolve(__dirname, '..', 'dashboard_v3.db')` → project root.

Do NOT use `server/database.db` or `server/dashboard.db` — they are 0-byte placeholder files.

### Query latest per-ticker (avoid scan_results id column trap)

`scan_results` has NO `id` column — only `scan_id` and `raw_data`. Use `ORDER BY rowid DESC` for latest row.

---

## CSS Variable System

All colors must use theme CSS variables — never hardcode `#hex` for structural colors:

```
--bg-app, --bg-panel, --bg-header, --bg-active, --border
--text-main, --text-muted
--accent-green, --accent-red, --accent-blue, --accent-orange
--header-height, --sidebar-width-expanded, --sidebar-width-collapsed, --widget-gap
--success-bg, --success-text, --warning, --warning-bg, --warning-text
```

**Never use:** `var(--white)`, `var(--gray-200)`, `var(--gray-300)` — undefined in the theme system.

Use `rgba(255,255,255,0.04)` overlays for subtle panel backgrounds instead.

---

## Git Tags (restore points)

| Tag | State |
|---|---|
| `restore/theme-stable-v1` | After FOUC + CSS variable fixes |
| `restore/perf-stable-v2` | After equality guard + throttle |
| `restore/perf-stable-v3` | After LevelReaction decimation |
| `restore/perf-stable-v4` | After granular Zustand selectors |

Branch: `feat/smart-alerts-stable`
