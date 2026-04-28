# Analytics Widget Catalogue

**Project**: Ultra Scalper Dashboard
**Widget Directory**: `client/src/components/AnalyticsWidgets/`
**Last Updated**: April 27, 2026
**Purpose**: Full reference for each of the 6 analytics widgets — API contracts, response shapes, component props/state, render logic, and performance notes.

---

## Operational Contract (All Widgets)

Every widget in the Analytics Widget Layer follows the same lifecycle contract:

1. **Polling**: Uses the `usePolledFetch` custom hook with a fixed interval.
2. **Cancellation**: Each poll cycle creates a new `AbortController`. The previous in-flight request is aborted before the new one starts.
3. **Tab Visibility**: Polling is paused when `document.hidden === true` (Page Visibility API). Resumes on tab focus.
4. **Error Handling**: On fetch failure, stale data remains visible. A non-blocking error banner is appended above the widget — the widget is never replaced with an error screen.
5. **Loading State**: Initial load shows a spinner. Subsequent refreshes do not show a loading indicator (stale data stays visible during refresh).

---

## Widget 1: EMACascadeMonitor

**File**: `client/src/components/AnalyticsWidgets/EMACascadeMonitor.jsx`
**CSS**: `EMACascadeMonitor.module.css`

### Purpose

Displays the full 1m/5m/15m/1h/4h EMA200 ladder for a single user-selected ticker. Shows current price relative to each EMA200, historical price as a line chart with all 5 EMA lines overlaid, discrete volume spike event pins, and EMA transition dots. Provides regime classification (BULL/BEAR/MIXED) and source health visibility.

### API Endpoint

```
GET /api/ema-cascade?ticker={ticker}&window_min={window_min}&interval={interval}
```

**Query Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `ticker` | string | `BTC` | Coin symbol (uppercase) |
| `window_min` | integer | `120` | Lookback window in minutes |
| `interval` | integer | `2` | Bucket size in minutes for price history |

### API Response Shape

```json
{
  "history": [
    { "ts": 1714000000000, "price": 77000.5, "bucketVol": 1200 }
  ],
  "volEvents": [
    { "ts": 1714000000000, "source": "STREAM_C_ALERT", "strength": 2.4, "meta": {} }
  ],
  "lastVolEventMs": 1714000000000,
  "transitions": [
    { "ts": 1714000000000, "tf": "5m", "from": "ABOVE", "to": "TESTING" }
  ],
  "defenseLevelNow": { "tf": "5m", "ema": 76800.0 },
  "lastBreak": { "ts": 1714000000000, "tf": "1h", "direction": "BULL" },
  "gaps": [
    { "from": 1714000000000, "to": 1714003600000 }
  ],
  "sourceHealth": { "A": 45000, "C": 128000, "D": 30000 },
  "stackNow": {
    "1m": { "ema": 76900.0, "state": "ABOVE", "distPct": 0.13 },
    "5m": { "ema": 76800.0, "state": "TESTING", "distPct": 0.26 },
    "15m": { "ema": 76500.0, "state": "ABOVE", "distPct": 0.65 },
    "1h": { "ema": 75000.0, "state": "ABOVE", "distPct": 2.67 },
    "4h": { "ema": 72000.0, "state": "ABOVE", "distPct": 6.94 }
  },
  "regime": "BULL",
  "bullDefenseTf": "5m",
  "bearCeilingTf": null
}
```

**Field Notes**:
- `history`: Time-bucketed price history. Bucket size = `interval` parameter. Used as X-axis data for the Recharts chart.
- `volEvents`: All discrete volume spike events within the window. Rendered as `ReferenceDot` pins on the chart, coloured by `source`.
- `lastVolEventMs`: The timestamp of the most recent volume event for this ticker regardless of the `window_min` parameter. Always present. Used to display "vol·Xm ago" chip even when the last event is outside the current window.
- `transitions`: EMA200 state changes (ABOVE↔TESTING↔BELOW) for any TF within the window. Rendered as small dots on the chart at the transition timestamp.
- `sourceHealth`: Milliseconds since last data receipt from each stream. `{ A: ms, C: ms, D: ms }`. Used to render source health chips labelled with age (e.g., "A·45s", "C·2m ago").
- `stackNow`: The current snapshot of the EMA200 ladder. Used for the 5-badge EMA ladder UI below the chart.
- `regime`: `"BULL"` (price above majority of EMAs), `"BEAR"`, or `"MIXED"`.
- `bullDefenseTf`/`bearCeilingTf`: The most important timeframe to watch — null when not applicable.

### Key Component State

| State | Type | Description |
|-------|------|-------------|
| `ticker` | string | Currently monitored ticker |
| `window` | string | Selected window: `"1h"`, `"2h"`, `"4h"`, `"8h"` |
| `interval` | string | Selected bucket: `"1m"`, `"2m"`, `"5m"` |
| `data` | object or null | Last successful API response |
| `error` | Error or null | Last fetch error |

### Render Structure

1. **Header row**: Widget title, ticker input box, quick chip buttons (BTC, ETH, SOL, BNB, XRP)
2. **Controls row**: Window selector buttons, interval selector buttons
3. **Regime strip**: BULL/BEAR/MIXED badge, bull defense TF label, bear ceiling TF label, source health chips (A/C/D), last vol event chip (`▾vol·Xm ago`)
4. **ComposedChart (Recharts)**:
   - `LineChart` or `ComposedChart`
   - One `Line` for price
   - Five `Line` elements for EMA200 per TF (colour-coded: 1m=white, 5m=cyan, 15m=yellow, 1h=orange, 4h=red)
   - `ReferenceDot` per vol event (capped at `MAX_VOL_PINS=40`) — colour by source (C=amber, A=blue, D=purple)
   - `ReferenceDot` per transition event (capped at `MAX_TR_DOTS=40`) — small dot at TF EMA price level
5. **EMA Ladder**: 5 TF badges showing EMA price, cascade state badge (ABOVE/TESTING/BELOW), distPct sublabel (`+0.26% vs EMA200`)

### Performance Notes

- `series`, `yDomain`, `cappedVolEvents`, `cappedTransitions` all computed with `useMemo`.
- `MAX_VOL_PINS=40`, `MAX_TR_DOTS=40` hard caps on Recharts reference elements.
- Poll: 60s.
- Ticker/window/interval changes abort in-flight requests via AbortController before re-fetching.

---

## Widget 2: DistanceTracker

**File**: `client/src/components/AnalyticsWidgets/DistanceTracker.jsx`
**CSS**: `DistanceTracker.module.css`

### Purpose

A cross-coin sortable table showing every active coin's percentage distance from its 200 EMA across all 5 timeframes simultaneously. Used to quickly identify which coins are approaching or testing EMA200 support/resistance at any timeframe.

### API Endpoint

```
GET /api/ema-distance-board?limit={limit}&max_dist={max_dist}&active_min={active_min}
```

**Query Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | integer | `50` | Max number of coins to return |
| `max_dist` | number | `10` | Maximum absolute distance % filter |
| `active_min` | integer | `30` | Only include coins seen within this many minutes |

### API Response Shape

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
      "closest": {
        "tf": "5m",
        "distPct": 0.26
      },
      "last_seen_ms": 1714000000000
    }
  ],
  "generated_at": 1714003600000
}
```

**Field Notes**:
- `distances`: Signed percentage distance. Positive = above EMA200, negative = below. Negative values should be coloured as "coin is below EMA" not "bad" — context matters.
- `closest`: The TF where this coin is nearest to its EMA200 (smallest absolute `distPct`). Used for the "Closest" column.
- `source`: Which stream provided the most recent EMA200 data for this coin. Determines the source dot colour.

### Key Component State

| State | Type | Description |
|-------|------|-------------|
| `sortCol` | string | Currently sorted column (`"ticker"`, `"closest"`, `"1m"`, `"5m"`, etc.) |
| `sortDir` | string | `"asc"` or `"desc"` |
| `rangeFilter` | number | Active range filter: `1`, `3`, `5`, or `10` (percent) |
| `data` | object or null | Last successful API response |
| `error` | Error or null | Last fetch error |

### Render Structure

1. **Toolbar**: Range filter toggle buttons (±1%, ±3%, ±5%, ±10%)
2. **Error banner** (conditional): Non-blocking, above table
3. **Sortable table**:
   - Column headers: Coin, Price, Closest (vs EMA200), 1m %, 5m %, 15m %, 1h %, 4h %
   - Each header is clickable for sort (alternates asc/desc, same column = flip direction)
   - Column header tooltip: "% distance from Xm 200 EMA (+ = above, − = below)"
   - Per-cell colour coding: green if `|dist| < 0.5`, amber if `0.5 ≤ |dist| < 2`, red if `|dist| ≥ 2`
   - Source dot: colour by `source` field (purple=D, amber=C, blue=A)

### Filter Logic

Range filter applies to the "Closest" column value:

```js
const filtered = coins.filter(coin => Math.abs(coin.closest.distPct) <= rangeFilter);
```

### Performance Notes

- Backend uses 3 batched queries (indexed GROUP BY) — ~30ms response regardless of active coin count.
- Table rendered with stable `key={coin.ticker}`.
- `useMemo` for sorted+filtered coin list.
- Poll: 60s.

---

## Widget 3: LevelReactionWidget

**File**: `client/src/components/AnalyticsWidgets/LevelReactionWidget.jsx`
**CSS**: `LevelReactionWidget.module.css`

### Purpose

Shows up to 12 coins currently near structural support or resistance levels in a vertical swim-lane layout. Each lane provides a complete contextual picture: price history normalized to the level, Stream D technicals, volume spike events, and a reaction classification.

### API Endpoints

**Primary** (lane data):
```
GET /api/level-reactions?window_min={window_min}&interval={interval}&limit={limit}&max_dist={max_dist}
```

**Secondary** (volume events, batch):
```
GET /api/volume-events?tickers={BTC,ETH,...}&since_min={window_min}
```

The secondary call is made once after the primary call resolves, using the list of tickers from the primary response.

### Primary Response Shape

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
      "streamD": {
        "rsi": 52.3,
        "atr": 180.5,
        "relVol": 1.8
      },
      "history": [
        { "ts": 1714000000000, "normPrice": 0.0013 }
      ]
    }
  ],
  "generated_at": 1714003600000
}
```

**Field Notes**:
- `normPrice`: Price normalized to zero at the level price. `normPrice = (price - levelPrice) / levelPrice`. Used as Y-axis data so the level always appears at Y=0.
- `distPct`: Absolute percentage distance from current price to the level. Used for filtering and the distance sublabel.
- `reaction`: One of `BOUNCE`, `REJECT`, `BREAK_BULL`, `BREAK_BEAR`, `TESTING`, `APPROACHING`.
- `trendFlow`: Current trend direction from a higher timeframe perspective.

### Volume Events Response Shape (Secondary)

```json
{
  "events": {
    "BTC": [
      { "ts": 1714000000000, "source": "STREAM_C_ALERT", "strength": 2.4 }
    ],
    "ETH": []
  }
}
```

Events are keyed by ticker for O(1) lookup when distributing to lanes.

### Key Component State

| State | Type | Description |
|-------|------|-------------|
| `levelFilter` | string | `"ALL"`, `"SUPPORT"`, or `"RESISTANCE"` |
| `reactionFilter` | string[] | Selected reaction types (empty = all) |
| `lanes` | array or null | Last successful lane data |
| `volEventsByTicker` | object | Keyed by ticker from secondary call |
| `error` | Error or null | Last fetch error (non-blocking) |

### ReactionLane Sub-Component

The `ReactionLane` component renders one lane and is wrapped in `React.memo`. Each lane renders:

1. **Lane header** (left to right):
   - Ticker label
   - S/R type badge (green=SUPPORT, red=RESISTANCE)
   - Level type label (e.g., "Smart Level", "Structural")
   - Level price with distPct sublabel (`+0.26% vs level`) and rich tooltip (shows level context)
   - Direction badge (LONG/SHORT)
   - Trend flow label (UPTREND/DOWNTREND/RANGING)
   - Stream D chips: RSI value, ATR value, RelVol value (colour-coded individually)
   - VOL badge: most recent vol spike for this ticker — shows source colour + age (C=amber, A=blue, D=purple)
   - Reaction badge (BOUNCE/REJECT/BREAK_BULL/BREAK_BEAR/TESTING/APPROACHING)

2. **Lane chart** (Recharts AreaChart):
   - X-axis: time
   - Y-axis: `normPrice` (0 = level price)
   - Area fill: green gradient when `normPrice > 0` (above level), red gradient when `normPrice < 0` (below level)
   - `ReferenceLine` at Y=0 (the level itself)
   - Two `ReferenceLine` elements at Y=+0.003 and Y=-0.003 (±0.3% touch bands)
   - `ReferenceDot` per vol event in the window (coloured by source, capped at MAX_VOL_PINS)

### Filter Logic

```js
const visibleLanes = lanes.filter(lane => {
  if (levelFilter !== 'ALL' && lane.levelType !== levelFilter) return false;
  if (reactionFilter.length > 0 && !reactionFilter.includes(lane.reaction)) return false;
  return true;
});
```

### Performance Notes

- `React.memo` on `ReactionLane` — filter changes re-render parent, not all 12 lanes.
- `volEvents` prop passed as `undefined` (not `|| []`) to preserve memo stability — see PERFORMANCE.md §3.4.
- `useMemo` for filtered lane list, vol event chart arrays.
- `MAX_VOL_PINS=40` per lane.
- Error handling: `error && <banner>` — stale lanes visible during temporary failures.
- Poll: 90s.
- Secondary volume-events call uses batch mode (`?tickers=...`) — 1 request for all lanes.

---

## Widget 4: TrialMiniChart

**File**: `client/src/components/AnalyticsWidgets/TrialMiniChart.jsx`

### Purpose

An embedded price chart rendered inside each 3rd Umpire trial card within `ValidatorTimelineWidget`. Shows real price data from `master_coin_store` for the trial's specific coin and timeframe, with trial-specific annotations (trigger price, smart level, verdict) overlaid.

### API Endpoints

**OHLC data**:
```
GET /api/validator/trial/{trialId}/ohlc?interval={interval}
```

**Volume events**:
```
GET /api/volume-events?ticker={ticker}&since_min={window}
```

Both calls are made independently when the component mounts or when `trialId` changes.

### OHLC Response Shape

```json
{
  "ticker": "BTC",
  "trialId": 42,
  "interval": 5,
  "candles": [
    { "ts": 1714000000000, "open": 76900.0, "high": 77100.0, "low": 76800.0, "close": 77000.0 }
  ],
  "triggerPrice": 76800.0,
  "smartLevel": 76750.0,
  "ema200_5m": 76700.0,
  "trialStartMs": 1714000000000,
  "cooldownEndMs": 1714001800000,
  "watchEndMs": 1714003600000,
  "verdictMs": 1714002400000,
  "verdict": "CONFIRMED"
}
```

**Field Notes**:
- `triggerPrice`: Price at which the Stream C alert fired and opened this trial.
- `smartLevel`: The structural level being defended/tested (from the Stream C alert).
- `ema200_5m`: The 5-minute EMA200 value at trial start. Displayed as a static horizontal reference line.
- `cooldownEndMs`: End of the cooldown period (grey zone on chart).
- `watchEndMs`: End of the watching period (blue tint zone on chart).
- `verdictMs`: When the verdict was resolved. May be `null` for still-active trials.

### Key Props

| Prop | Type | Description |
|------|------|-------------|
| `trialId` | number | The trial ID to fetch OHLC for |
| `ticker` | string | Coin symbol |
| `interval` | number | Candle interval in minutes |
| `compact` | boolean | If true, render in compact mode (smaller height, no axis labels) |

### Render Structure

1. **Recharts ComposedChart** (no explicit axes when `compact=true`):
   - `Line` for close price (white solid)
   - `ReferenceLine` for trigger price (white dashed, labelled "ENTRY")
   - `ReferenceLine` for smart level (orange dashed, labelled "LEVEL")
   - `ReferenceLine` for EMA200 5m (blue dotted, labelled "EMA200")
   - `ReferenceArea` for COOLDOWN period (grey fill, `from=trialStartMs`, `to=cooldownEndMs`)
   - `ReferenceArea` for WATCHING period (blue transparent fill, `from=cooldownEndMs`, `to=watchEndMs`)
   - `ReferenceLine` for verdict timestamp (green if CONFIRMED, red if FAILED) — omitted for active trials
   - `ReferenceDot` per vol event (coloured by source, capped at MAX_VOL_PINS=40)

### `smartFmt` Function

Dynamic decimal precision formatter applied to all price labels:

```js
function smartFmt(price) {
  if (price === null || price === undefined) return '—';
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (price >= 100) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}
```

### Performance Notes

- No standalone polling — re-mounts or updates when parent `ValidatorTimelineWidget` re-renders with new trial list.
- `candles` data converted to Recharts format with `useMemo`.
- `MAX_VOL_PINS=40` applied to vol events from secondary call.

---

## Widget 5: DailyCalendarWidget

**File**: `client/src/components/AnalyticsWidgets/DailyCalendarWidget.jsx`
**CSS**: `DailyCalendarWidget.module.css`

### Purpose

A 7-day performance calendar that provides a daily summary of market mood and trial outcomes. Clicking any day opens a detailed coin heatmap showing per-coin open/close prices, day change, and trial win rates for that day.

### API Endpoints

**7-day summary**:
```
GET /api/calendar/daily?days=7
```

**Per-day heatmap** (on cell click):
```
GET /api/calendar/day/{date}
```
Date format: `YYYY-MM-DD` (e.g., `2026-04-27`).

### Daily Summary Response Shape

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

### Day Heatmap Response Shape

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
      "verdictMix": {
        "confirmed": 2,
        "failed": 1,
        "pending": 0
      }
    }
  ]
}
```

**Field Notes**:
- `moodScore`: Numeric representation of the mood (e.g., 0–100 scale mapped from raw sentiment).
- `verdictMix`: Counts of trial outcomes for the coin on that day. `pending` counts trials that had no verdict by end of day.
- `rangePct`: `(dayHigh - dayLow) / dayOpen * 100` — a measure of daily volatility.

### Key Component State

| State | Type | Description |
|-------|------|-------------|
| `days` | array or null | 7-day summary data |
| `selectedDate` | string or null | Date of the currently open drill modal |
| `drillData` | object or null | Heatmap data for selected date |
| `drillLoading` | boolean | Loading state for drill modal |
| `drillError` | Error or null | Drill fetch error |
| `heatmapSortCol` | string | Sort column for heatmap table |
| `heatmapSortDir` | string | Sort direction |

### Render Structure

1. **7-cell calendar grid**:
   - Each cell: date label, mood label, mood score badge, trial count + win rate (colour-coded: green ≥ 0.65, amber 0.4–0.65, red < 0.4), top gainer/loser tickers with change %
   - Click handler opens `DayDrillModal`

2. **DayDrillModal** (rendered in portal or overlay):
   - Wrapped in `DrillErrorBoundary`
   - Date header, close button
   - Sortable table with columns: Ticker | Open → Close | Day Δ% | Range % | Trials | L/S | Win Rate | Verdict Mix (✓ ✗ ·)
   - Verdict Mix rendered as coloured pill row: green checkmarks, red X marks, grey dots for pending
   - All columns sortable via header click

### DrillErrorBoundary

```jsx
class DrillErrorBoundary extends React.Component {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      return <div className={styles.drillError}>Failed to render day details.</div>;
    }
    return this.props.children;
  }
}
```

Prevents a single malformed coin row from crashing the entire drill modal.

### Query Optimization (Backend)

The `/api/calendar/day/:date` endpoint uses a CTE + window functions to compute open and close prices per coin in a single table scan:

```sql
WITH ranked AS (
  SELECT
    ticker, price, timestamp,
    ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp ASC) as rn_asc,
    ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp DESC) as rn_desc
  FROM master_coin_store
  WHERE timestamp BETWEEN day_start_ms AND day_end_ms
)
SELECT
  ticker,
  MAX(CASE WHEN rn_asc = 1 THEN price END) AS open_price,
  MAX(CASE WHEN rn_desc = 1 THEN price END) AS close_price
FROM ranked
GROUP BY ticker;
```

This replaces two correlated subqueries per coin that caused "today" to show blank (the planner failed to use indexes efficiently on the partial-day boundary).

### Performance Notes

- Poll: 5 minutes for the 7-day summary grid.
- Drill data fetched on demand (no pre-fetching).
- `useMemo` for sorted+filtered heatmap rows.
- `DrillErrorBoundary` isolates rendering failures.

---

## Widget 6: GhostCoinWidget

**File**: `client/src/components/AnalyticsWidgets/GhostCoinWidget.jsx`
**CSS**: `GhostCoinWidget.module.css`

### Purpose

Manages the ghost approval queue — a holding area for coins that have left active trading but are not yet permanently removed from the system. Each ghost coin has a confidence score derived from its personal trading history, allowing informed approval or pruning decisions.

### API Endpoints

**Queue data**:
```
GET /api/ghosts/queue
```

**Single coin approve**:
```
POST /api/ghosts/approve
Body: { "ticker": "AVAX" }
```

**Single coin prune**:
```
POST /api/ghosts/prune
Body: { "ticker": "AVAX" }
```

**Bulk prune** (all below threshold):
```
POST /api/ghosts/prune-all
Body: { "threshold": 0.5 }
```

**Bulk approve** (all above threshold):
```
POST /api/ghosts/approve-all
Body: { "threshold": 0.65 }
```

### Queue Response Shape

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
  ],
  "auto_prune_threshold": 0.4,
  "auto_prune_enabled": false
}
```

**Field Notes**:
- `confidence_score`: Final blended score (0.0–1.0). Computed as `recencyWeightedWinRate * regimeMultiplier`, clamped to [0, 1].
- `base_win_rate`: The per-ticker recency-weighted win rate from `validation_trials` (priority 1) or `pattern_statistics` (fallback). May differ from raw `winRate` due to exponential decay weighting.
- `regime_multiplier`: Applied to `base_win_rate` to account for current market conditions. Derived from normalized `regime_mood` label.
- `sample_count`: Number of resolved trials used to compute `base_win_rate`. Below 3 = fallback to `pattern_statistics`.
- `auto_prune_threshold`: The system_settings threshold for automatic pruning (only applied when `auto_prune_enabled` is true).

### Key Component State

| State | Type | Description |
|-------|------|-------------|
| `queue` | array or null | Ghost queue data |
| `autoPruneEnabled` | boolean | Toggle state for auto-prune feature |
| `pendingAction` | string or null | Ticker currently being approved/pruned (for loading state) |
| `error` | Error or null | Last operation error |

### Render Structure

1. **Header**: Widget title, coin count badge
2. **Action bar**: Auto-Prune toggle switch, "Prune All" button (below threshold), "Approve All" button (above threshold)
3. **Ghost coin list**: One row per coin:
   - Ticker label
   - Confidence score bar: horizontal bar (0–100%), colour-coded (green ≥ 0.65, amber 0.4–0.65, red < 0.4)
   - Score percentage label (e.g., "61%")
   - Score breakdown tooltip (hover): base_win_rate, regime_mood, regime_multiplier, sample_count, ghosted_at
   - "Approve" button (green)
   - "Prune" button (red)
   - Ghosted-since label (age since `ghosted_at`)

### Scoring Algorithm Reference

The `GhostScoringEngine` (backend, `server/services/GhostScoringEngine.js`) scores coins as follows:

1. **Priority 1 — Per-ticker trial history** (requires ≥ 3 resolved trials):
   ```
   weight_i = exp(-days_ago_i / 14)
   score = Σ(weight_i * isConfirmed_i) / Σ(weight_i)
   ```
   Half-life = 14 days. More recent trials have higher weight.

2. **Priority 2 — Pattern statistics fallback**:
   ```
   score = pattern_statistics.win_rate
         WHERE direction = ticker.direction
           AND has_vol = ticker.has_vol
           AND ema_state = ticker.ema_state
   ```

3. **Regime multiplier** (applied to both paths):
   ```
   normalized_mood = rawMood.replace(/\s+/g, '_').toUpperCase()
   multiplier = REGIME_MULTIPLIERS[normalized_mood] ?? 1.0
   final_score = clamp(score * multiplier, 0, 1)
   ```

### Performance Notes

- Poll: 60s.
- Approve/Prune actions call mutating POST endpoints then immediately re-fetch the queue (optimistic update not used — server is source of truth for re-score).
- Bulk actions include confirmation via `window.confirm` before sending the request.
- Scores are re-computed server-side on every `GET /api/ghosts/queue` call — always fresh.
