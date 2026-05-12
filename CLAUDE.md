# TV Recommendation Dashboard — Architecture & Design Reference

> Living document. Update whenever a design decision changes. Claude Code loads this automatically.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite, Zustand, Recharts, CSS Modules |
| Backend | Node.js / Express, Socket.IO, SQLite (better-sqlite3) |
| Process manager | PM2 (`tv-backend` id=0, `tv-client` id=1, `mcp-server` id=2) |
| Build | `vite build` in `client/`, served via `vite preview` on PM2 |

---

## Data Streams

| Stream | Purpose | Key Fields |
|---|---|---|
| Stream A | Edge signals, momentum scores | `momScore`, `netTrend`, `bias` |
| Stream C | Price structure, support/resistance | `supportDist`, `resistDist`, `breakout`, `volSpike` |
| Stream D | Technical indicators (multi-TF) | `ema_200Timeresolution<N>`, `averagetruerangepercent_14Timeresolution<N>`, RVOL |
| Stream D TF keys | Resolution mapping | `Timeresolution1`=1m, `5`=5m, `15`=15m, `60`=1h, `240`=4h |

Stream D h1/h4 EMA200 field names: `ema_200Timeresolution60` (h1), `ema_200Timeresolution240` (h4).

---

## Key APIs

| Endpoint | Purpose |
|---|---|
| `GET /api/ema-distance-board?limit=N&active_min=M` | Per-coin board — `atrs`, `emas`, `dists`, `sources` per TF |
| `GET /api/ema-cascade?ticker=X&window_min=W&interval=I` | Single-coin EMA200 time-series history |
| `POST /api/stream-d/technicals` | Stream D ingestion endpoint |
| `GET /api/volume-events?limit=N&source=S` | RVOL spike events with timestamps |

### Board API response per coin

```js
{
  ticker, cleanTicker, lastTs, price,
  emas:    { m1, m5, m15, h1, h4 },  // actual EMA200 price values
  dists:   { m1, m5, m15, h1, h4 },  // % distance: positive = price above EMA
  atrs:    { m15, h1, h4 },          // ATR% per TF
  sources: { m1, m5, m15, h1, h4 },  // STREAM_A / STREAM_C / STREAM_D
  ages:    { m1, m5, m15, h1, h4 },  // age in ms
  liveTfCount, anyStale
}
```

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

### Configurable series (user-defined in widget settings)

| Setting | Default | Options |
|---|---|---|
| Long-term series | `['h4', 'h1', 'm15']` | Any 2+ TFs, longest→shortest |
| Counter-trend series | `['m5', 'm1']` | Any 1+ TFs |
| Equal threshold | `0.2%` | Configurable in settings panel |

**Counter-trend uses ATR(15m) as noise filter (Option A):**
```
Counter signal is real only if:
|ema(m5) - ema(m1)| > ATR(15m) value of that coin

If the gap is smaller than ATR(15m) → treated as noise, not flagged.
```
This makes the filter self-adaptive — a $50k BTC needs a bigger $ move than a $1 altcoin.

### 4 Classification Groups

| Group | Condition | Use |
|---|---|---|
| **Long Bull** | `checkCascade(emas, longSeries) === 'bull'` | Dropdown border 🟢, race filter |
| **Long Bear** | `checkCascade(emas, longSeries) === 'bear'` | Dropdown border 🔴, race filter |
| **Temp Bull** | Long Bear cascade AND counter series checks BULL AND gap > ATR(15m) | ↗ reversal chip |
| **Temp Bear** | Long Bull cascade AND counter series checks BEAR AND gap > ATR(15m) | ↘ reversal chip |

**Distance to 15m EMA** shown as context on Temp chips — shows how far the counter move needs to travel before threatening the long-term trend.

### Components that use cascade settings (must stay consistent)

1. **EMACascadeMonitor dropdown** — cascade badges (🟢/🔴 borders per coin)
2. **EMACascadeMonitor reversal chips** (↗ Temp Bull / ↘ Temp Bear beside dropdown)
3. **ATR Race Widget** — 4 pre-built filter groups (Long Bull / Long Bear / Temp Bull / Temp Bear / Top 10)

All three read from the same persisted settings (`emaCascade_prefs` localStorage key).

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

## EMACascadeMonitor Widget

**File:** `client/src/components/AnalyticsWidgets/EMACascadeMonitor.jsx`

### Settings panel (gear icon in header)

```
Long-term series  (min 2):  [✓4h] [✓1h] [✓15m] [  5m] [  1m]
Counter-trend     (min 1):  [  4h] [  1h] [✓15m] [✓5m] [✓1m]
Equal threshold:  [0.2]%
                       [Reset defaults]  [Apply]
```

Saved under `emaCascade_prefs.longSeries`, `.shortSeries`, `.equalThreshold`.

### Searchable coin dropdown

- Fetches `/api/ema-distance-board?limit=50&active_min=120`
- Shows ALL active coins; searchable by ticker
- Bull/bear cascade border on trigger button reflects selected coin's status
- Cascade classification uses `b.emas` (EMA value stacking), NOT `b.dists`

### Reversal chips (beside dropdown)

- **↗ Temp Bull** chips: Long Bear + counter series bullish + gap > ATR(15m)
- **↘ Temp Bear** chips: Long Bull + counter series bearish + gap > ATR(15m)
- Clicking a chip loads that coin in the chart immediately
- Chips hidden when no qualifying coins found

### LocalStorage keys

| Key | Content |
|---|---|
| `emaCascade_prefs` | `{ windowMin, intervalMin, longSeries, shortSeries, equalThreshold }` |
| `emaCascade_ticker` | Last selected ticker string |

---

## ATR Race Widget (planned)

**File:** `client/src/components/AnalyticsWidgets/ATRRaceWidget.jsx`

### Concept

Multi-coin line chart showing ATR% (volatility momentum) across all active coins simultaneously — "car race" view to spot which coin is developing strongest moves at a glance.

### Data strategy — frontend ring buffer

- Poll `/api/ema-distance-board?limit=50&active_min=120` every **30s**
- Accumulate `atrs.m15` / `atrs.h1` per coin into `useRef` ring buffer (max 240 entries)
- Volume spike dots from `GET /api/volume-events?source=STREAM_D_RVOL` polled every 60s
- No new backend endpoints needed

### Chart

- **Y-axis:** ATR% (naturally normalized across coins, shows size of developing moves)
- **Lines:** one per coin, each with distinct color from 10-color palette
- **Spike dots:** `ReferenceDot` at `(ts, atr%)` when RVOL event matches coin + time bucket
- **X-axis:** time, controlled by slider (same pattern as MarketSentimentTimeline / LevelReactionWidget)
- Max 10 lines simultaneously (beyond that → unreadable)

### Time window slider

| TF mode | Poll interval | Slider range | Default |
|---|---|---|---|
| 15m | 30s | 15m → 2h (30–240 entries) | 2h |
| 1h | 2min | 30m → 8h | 2h |

Switching TF mode flushes ring buffer and starts fresh.

### Pre-built coin filter groups (shared cascade settings)

| Group | Badge | Coin selection |
|---|---|---|
| **Long Bull** | 🟢 | `checkCascade(emas, longSeries) === 'bull'`, top 10 by ATR% |
| **Long Bear** | 🔴 | `checkCascade(emas, longSeries) === 'bear'`, top 10 by ATR% |
| **Temp Bull** | ↗ | Long Bear + counter bullish + gap > ATR(15m) |
| **Temp Bear** | ↘ | Long Bull + counter bearish + gap > ATR(15m) |
| **Top 10** *(default)* | ⚡ | Highest current ATR(15m)%, any direction |

### Metric toggle

| Option | Y-axis | Spike threshold |
|---|---|---|
| ATR 15m | `atrs.m15` | RVOL event from `volume_events` |
| ATR 1h | `atrs.h1` | RVOL event from `volume_events` |

### LocalStorage key: `raceWidget_prefs`

```js
{
  filterGroup: 'top10',   // 'longBull' | 'longBear' | 'tempBull' | 'tempBear' | 'top10'
  metric: 'm15',          // 'm15' | 'h1'
  windowMin: 120,         // slider value
  tfMode: '15m'           // '15m' | '1h'
}
```

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

---

## Git Tags (restore points)

| Tag | State |
|---|---|
| `restore/theme-stable-v1` | After FOUC + CSS variable fixes |
| `restore/perf-stable-v2` | After equality guard + throttle |
| `restore/perf-stable-v3` | After LevelReaction decimation |
| `restore/perf-stable-v4` | After granular Zustand selectors |

Branch: `feat/smart-alerts-stable`

---

## CSS Variable System

All colors must use theme CSS variables — never hardcode `#hex` for structural colors:

```
--bg-app, --bg-panel, --border
--text-main, --text-muted
--accent-green, --accent-red, --accent-blue, --accent-orange
--success-bg, --success-text, --warning, --warning-bg, --warning-text
```

**Never use:** `var(--white)`, `var(--gray-200)`, `var(--gray-300)` — these are undefined in the theme system and render as white/broken.

Use `rgba(255,255,255,0.04)` overlays for subtle panel backgrounds instead.
