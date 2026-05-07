# Performance Engineering Reference

**Project**: Ultra Scalper Dashboard
**Last Updated**: May 7, 2026
**Purpose**: Comprehensive engineering notes on every non-obvious performance decision made during the Analytics Widget Layer build. Written as a reference for future developers so that the same problems are not rediscovered.

---

## 1. SQLite Backend Optimizations

### 1.1 Hoist Prepared Statements to Module Scope

**Problem**: `better-sqlite3` statement preparation is non-trivial. If you call `db.prepare(sql)` inside a request handler, the statement is compiled from scratch on every request.

**Fix**: Prepare all hot-path statements once at module load time and reuse them.

```js
// BAD — prepared on every request
app.get('/api/foo', (req, res) => {
  const rows = db.prepare('SELECT * FROM master_coin_store WHERE ticker = ?').all(ticker);
});

// GOOD — prepared once at module scope
const stmtGetByTicker = db.prepare('SELECT * FROM master_coin_store WHERE ticker = ? ORDER BY timestamp DESC LIMIT ?');

app.get('/api/foo', (req, res) => {
  const rows = stmtGetByTicker.all(ticker, limit);
});
```

**Rule**: Any SQL that runs more than once per second should be a module-scope prepared statement.

---

### 1.2 Composite Indexes on All Hot Query Paths

Three indexes were added after profiling identified slow scans:

| Index Name | Columns | Covers |
|------------|---------|--------|
| `idx_master_source_ticker_time` | `(source, ticker, timestamp DESC)` | Stream-filtered timeline queries in EMA cascade, OHLC builder |
| `idx_master_ticker_time` | `(ticker, timestamp DESC)` | Per-coin queries in level-reactions, trial mini-chart |
| `idx_vol_ticker_ts` | `(ticker, ts DESC)` | Volume events batch queries |

**Creation SQL**:
```sql
CREATE INDEX IF NOT EXISTS idx_master_source_ticker_time
  ON master_coin_store(source, ticker, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_master_ticker_time
  ON master_coin_store(ticker, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_vol_ticker_ts
  ON volume_events(ticker, ts DESC);
```

**Note**: The `timestamp DESC` direction matters. SQLite's query planner uses the index direction when the query includes `ORDER BY timestamp DESC LIMIT N`. Without the DESC hint, the planner may perform a full index scan then sort.

---

### 1.3 Transaction-Wrapped Batch Inserts

**Problem**: Without an explicit transaction, SQLite begins and commits a transaction for every individual `INSERT` statement. Each commit triggers an fsync to disk. For a backfill of thousands of rows, this produces thousands of fsyncs — orders of magnitude slower than a single transaction.

**Benchmark**: VolumeEventService historical backfill: ~50–100× speedup by wrapping the entire backfill in a single transaction.

```js
// BAD — one transaction (implicit) per row = thousands of fsyncs
for (const event of events) {
  stmtInsertVolEvent.run(event);
}

// GOOD — one transaction total = one fsync
const insertMany = db.transaction((events) => {
  for (const event of events) {
    stmtInsertVolEvent.run(event);
  }
});
insertMany(events);
```

**Rule**: Any loop that calls `INSERT` on more than ~10 rows must be wrapped in `db.transaction(...)`.

---

### 1.4 EMA Distance Board — Eliminate N+1 Queries

**Problem**: `/api/ema-distance-board` originally fetched EMA data by querying the database individually for each active coin × each timeframe. With 40 coins × 5 timeframes = up to 200 queries per request, and with some timeframe variants (last N rows to compute EMA), it reached as high as 640 queries per request. Measured latency: ~1.5s.

**Fix**: Replace per-ticker/per-TF queries with 3 batched queries using `GROUP BY` on the indexed columns.

```sql
-- Batch 1: latest master_coin_store row per ticker
SELECT ticker, MAX(timestamp) as max_ts, price
FROM master_coin_store
GROUP BY ticker;

-- Batch 2: latest stream_d_state per ticker (contains EMA200 per TF)
SELECT ticker, stream_d_state
FROM master_coin_store
WHERE (ticker, timestamp) IN (
  SELECT ticker, MAX(timestamp)
  FROM master_coin_store
  WHERE stream_d_state IS NOT NULL
  GROUP BY ticker
);

-- Batch 3: coin lifecycle active status
SELECT ticker, status, last_seen_at
FROM coin_lifecycles
WHERE status = 'ACTIVE';
```

**Result**: ~30ms response time vs ~1.5s. Three queries total regardless of how many coins are active.

---

### 1.5 Calendar Daily — CTE + ROW_NUMBER() Replaces Correlated Subqueries

**Problem**: The `/api/calendar/daily` endpoint needed the open price (first row of the day per ticker) and close price (last row of the day per ticker). The original implementation used correlated subqueries:

```sql
-- BAD — correlated subquery runs once per coin per day
SELECT
  ticker,
  (SELECT price FROM master_coin_store m2
   WHERE m2.ticker = m1.ticker AND DATE(m2.timestamp/1000, 'unixepoch') = the_date
   ORDER BY timestamp ASC LIMIT 1) as open_price,
  (SELECT price FROM master_coin_store m2
   WHERE m2.ticker = m1.ticker AND DATE(m2.timestamp/1000, 'unixepoch') = the_date
   ORDER BY timestamp DESC LIMIT 1) as close_price
FROM ...
```

This caused "today" to return blank results because the correlated subquery's index could not use the composite index efficiently on the most recent (partial) day.

**Fix**: Single-pass CTE with `ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY timestamp ASC/DESC)`:

```sql
-- GOOD — single table scan, window functions
WITH ranked AS (
  SELECT
    ticker,
    price,
    timestamp,
    DATE(timestamp/1000, 'unixepoch') as trade_date,
    ROW_NUMBER() OVER (PARTITION BY ticker, DATE(timestamp/1000, 'unixepoch') ORDER BY timestamp ASC) as rn_asc,
    ROW_NUMBER() OVER (PARTITION BY ticker, DATE(timestamp/1000, 'unixepoch') ORDER BY timestamp DESC) as rn_desc
  FROM master_coin_store
  WHERE timestamp >= ? AND timestamp <= ?
)
SELECT
  ticker,
  trade_date,
  MAX(CASE WHEN rn_asc = 1 THEN price END) as open_price,
  MAX(CASE WHEN rn_desc = 1 THEN price END) as close_price
FROM ranked
GROUP BY ticker, trade_date;
```

**Result**: Fixed the "today shows blank" bug. Single table scan instead of N correlated subqueries.

---

### 1.6 Volume Events Multi-Ticker Batch Mode

**Problem**: `LevelReactionWidget` and `EMACascadeMonitor` both need volume events for potentially 12+ tickers simultaneously. The naive approach makes one `GET /api/volume-events?ticker=X` request per ticker = N sequential HTTP round-trips, each requiring its own DB query.

**Fix**: Added batch mode to the endpoint:

```
GET /api/volume-events?tickers=BTC,ETH,SOL,AVAX&since_min=120
```

Backend uses a single `IN` clause:
```sql
SELECT * FROM volume_events
WHERE ticker IN (?, ?, ?, ?)
AND ts >= ?
ORDER BY ts DESC;
```

**Result**: O(1) HTTP round-trips vs O(N). For 12 lanes in LevelReactionWidget: 1 request vs 12 sequential requests.

---

## 2. Price Parsing Bug (Critical — Affects All Streams)

### 2.1 The Bug

JavaScript's `parseFloat()` does not handle thousands-separator commas. It stops parsing at the first non-numeric character that is not `.` or `e`:

```js
parseFloat("77,000.00")  // Returns 77, not 77000
parseFloat("1,234.56")   // Returns 1, not 1234.56
```

TradingView screener data returns prices in locale-formatted strings with commas (e.g., `"77,000.00"` for BTC). This caused BTC to show as **$77** instead of **$77,000** across all widgets.

### 2.2 The Fix

A `parsePrice()` helper function strips all commas before calling `parseFloat`:

```js
function parsePrice(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return raw;
  // Strip thousands-separator commas, then parse
  return parseFloat(String(raw).replace(/,/g, ''));
}
```

### 2.3 Where It Was Applied

The fix was applied at **6 ingest points** — every place raw string price data enters the system:

1. `POST /scan-report` handler (Stream A) — screener table price column
2. `POST /api/stream/b-heartbeat` handler (Stream B) — individual coin price
3. `POST /api/stream/c-alert` handler (Stream C) — alert trigger price
4. `POST /api/stream/d-technicals` handler (Stream D) — per-TF price
5. `MasterStoreService.js` EMA cascade bucket builder — price used for chart history
6. `level-reactions` endpoint — level price and current price fields

**Rule**: Any code path that ingests price from an external source (webhook payload, scraped DOM, CSV) MUST use `parsePrice()`. Never use `parseFloat()` directly on raw price strings.

---

## 3. React Frontend Performance Patterns

### 3.1 `usePolledFetch` Custom Hook

All 6 analytics widgets share a single custom hook for their polling lifecycle. The naive approach (using `useEffect` + `setInterval`) has multiple pitfalls:

**Pitfall A — Interval churn on dependency changes**: If `useEffect` dependencies change (e.g., the ticker the user selected), a new interval is created, but the old one may still fire once with stale closure values before cleanup.

**Pitfall B — Fetch overlap**: If a slow fetch takes longer than the poll interval, the next fetch starts before the previous one completes, leading to race conditions and out-of-order state updates.

**Pitfall C — Background tab waste**: Polling continues at full rate when the browser tab is hidden, wasting network and CPU.

**The `usePolledFetch` solution**:

```js
function usePolledFetch(fetcher, intervalMs, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Ref pattern: interval callback always closes over latest deps
  // without causing interval to be re-registered on every dep change
  const fetcherRef = useRef(fetcher);
  useEffect(() => { fetcherRef.current = fetcher; }, [fetcher]);

  useEffect(() => {
    let abortController = new AbortController();
    let intervalId;

    const doFetch = async () => {
      if (document.hidden) return; // Page Visibility API — skip when tab hidden
      abortController.abort();     // Cancel any in-flight request
      abortController = new AbortController();
      try {
        const result = await fetcherRef.current(abortController.signal);
        setData(result);
        setError(null);
      } catch (e) {
        if (e.name !== 'AbortError') setError(e);
        // On error: keep stale data, set error state for banner
      } finally {
        setLoading(false);
      }
    };

    doFetch(); // Immediate first fetch
    intervalId = setInterval(doFetch, intervalMs);

    return () => {
      clearInterval(intervalId);
      abortController.abort();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps); // Only re-register interval when deps (e.g., ticker) actually change

  return { data, error, loading };
}
```

**Key properties**:
- `fetcherRef` pattern: the latest fetcher closure is always available without re-registering the interval
- `AbortController` per fetch: each new fetch cancels the previous one before starting
- Page Visibility API: skips fetches when tab is hidden — no background polling waste
- On error: data state is preserved (stale data visible), error state set for banner

---

### 3.2 React.memo on Expensive Lane Components

**Problem**: `LevelReactionWidget` renders 12 `ReactionLane` components. Each lane contains an area chart (Recharts) which is expensive to render. When the user toggles a filter (Support/Resistance/ALL), React re-renders the parent component, which by default causes all 12 lanes to re-render — even lanes whose data has not changed.

**Fix**: Wrap `ReactionLane` in `React.memo`:

```js
const ReactionLane = React.memo(function ReactionLane({ lane, volEvents }) {
  // ... chart rendering
});
```

**Caveat**: `React.memo` uses shallow reference equality. Passing `volEvents={lane.volEvents || []}` creates a new array reference on every render (the `|| []` creates a new `[]` each time), which breaks memo. See Section 3.4.

**Result**: Filter state changes cause parent to re-render, which re-renders only the lanes that pass the new filter — not all 12. Observed: ~12× fewer chart re-renders on filter toggle.

---

### 3.3 `useMemo` for Hot Computation Paths in Charts

Recharts series data, Y-axis domains, filtered event lists, and transition dot positions are all computed values that can be expensive when the underlying array is large. These must be memoized.

```js
// Recharts series: recompute only when history or stackNow changes
const series = useMemo(() => buildChartSeries(history, stackNow), [history, stackNow]);

// Y-axis domain: must account for all EMA lines + price range
const yDomain = useMemo(() => computeYDomain(series, volEvents), [series, volEvents]);

// Filtered vol events: cap at MAX_VOL_PINS to avoid render cliff
const cappedVolEvents = useMemo(
  () => (volEvents || []).slice(0, MAX_VOL_PINS),
  [volEvents]
);

// Transition dots: capped at MAX_TR_DOTS
const cappedTransitions = useMemo(
  () => (transitions || []).slice(0, MAX_TR_DOTS),
  [transitions]
);
```

**Rule**: Any derived value that involves `.map()`, `.filter()`, `.reduce()`, or domain computation inside a component render must be in `useMemo`.

---

### 3.4 Prop Stability and React.memo Correctness

**Problem**: A subtle React.memo pitfall that caused all memoized `ReactionLane` components to always re-render despite no data changes:

```js
// BAD — creates new array reference on every parent render
<ReactionLane lane={lane} volEvents={lane.volEvents || []} />
```

The `|| []` fallback creates a brand-new `[]` object on every render. Since `React.memo` uses `Object.is` (reference equality) for arrays, the prop always looks "changed" and memo never fires.

**Fix**: Pass `undefined` and handle the fallback inside the memoized child:

```js
// GOOD — stable prop (undefined === undefined)
<ReactionLane lane={lane} volEvents={lane.volEvents} />

// Inside ReactionLane (memo'd component)
const ReactionLane = React.memo(function ReactionLane({ lane, volEvents }) {
  const safeVolEvents = volEvents || []; // Handled internally — no new ref created at parent
  // ...
});
```

**Rule**: Never use `|| []`, `|| {}`, or any expression that creates a new object/array as a prop value when that prop is passed to a `React.memo` component. Always handle the fallback inside the child or use `useMemo` in the parent to create a stable reference.

---

### 3.5 Recharts Reference Element Caps (MAX_VOL_PINS, MAX_TR_DOTS)

**Problem**: Recharts renders `ReferenceDot` and `ReferenceLine` as individual SVG elements. When a coin has many volume spikes in a long window, the number of dots can exceed 100. Beyond approximately 40 SVG elements per chart, Recharts rendering time increases super-linearly (close to quadratic), causing frame drops and input lag.

**Fix**: Cap all reference element arrays before passing to Recharts:

```js
const MAX_VOL_PINS = 40;
const MAX_TR_DOTS = 40;

// In the chart component
const cappedPins = cappedVolEvents.slice(0, MAX_VOL_PINS);
const cappedDots = cappedTransitions.slice(0, MAX_TR_DOTS);
```

**Observed cliff**: At ~100 ReferenceDots in a single Recharts chart, render time jumps from ~8ms to ~150ms per frame on a mid-range system.

**Important**: When capping, prefer keeping the most recent events (slice from the end, not the start) since charts are time-ascending and recent events are more relevant.

---

### 3.6 Non-Blocking Error Display Pattern

**Problem**: A common React pattern is to replace the entire component with an error message when a fetch fails:

```js
// BAD — hides stale data that may still be useful
if (error) return <ErrorMessage />;
return <Chart data={data} />;
```

This means a single failed poll (network blip, temporary 500) wipes the entire widget, removing valid data the user was looking at.

**Fix**: Show error as a non-blocking banner above stale data:

```js
// GOOD — stale data stays visible, error is additive
return (
  <div>
    {error && (
      <div className={styles.errorBanner}>
        Failed to refresh — showing last known data
      </div>
    )}
    {data && <Chart data={data} />}
    {!data && !error && <Spinner />}
  </div>
);
```

**Rule**: Error states should be **additive** — append information, don't replace existing content. The only time a blank/error-only state is appropriate is when there has never been a successful fetch (initial load failure).

---

## 4. Ghost Scoring — Regime Label Normalization

### 4.1 The Bug

The `GhostScoringEngine` applies a regime multiplier to the base win rate:

```js
const REGIME_MULTIPLIERS = {
  STRONGLY_BULLISH: 1.2,
  BULLISH: 1.1,
  NEUTRAL_BULLISH: 1.05,
  NEUTRAL: 1.0,
  NEUTRAL_BEARISH: 0.9,
  BEARISH: 0.85,
  STRONGLY_BEARISH: 0.7,
};
```

Raw mood labels from `raw_market_sentiment_log` are written by the Stream A scanner as human-readable strings: `"STRONGLY BEARISH"` (space-separated, not underscore-separated). The lookup `REGIME_MULTIPLIERS["STRONGLY BEARISH"]` returns `undefined`, and the fallback `?? REGIME_MULTIPLIERS['NEUTRAL']` silently returns `1.0`.

**Symptom**: During a strongly bearish regime, all ghost scores were inflated. Coins that should have been auto-pruned at multiplier 0.7 survived with multiplier 1.0.

### 4.2 The Fix

Normalize the label before lookup:

```js
function getRegimeMultiplier(rawLabel) {
  if (!rawLabel) return REGIME_MULTIPLIERS['NEUTRAL'];
  const normalized = rawLabel
    .trim()
    .replace(/\s+/g, '_')
    .toUpperCase();
  return REGIME_MULTIPLIERS[normalized] ?? REGIME_MULTIPLIERS['NEUTRAL'];
}
```

**Rule**: Any time an externally-sourced string label is used as a dictionary key, normalize it first. Never trust that the source writes strings in exactly the expected format.

---

### 4.3 Per-Ticker vs Shared Pattern Statistics

**Original bug**: All ghosts in the same direction category (e.g., LONG + BULLISH regime) shared a single `pattern_statistics` row and therefore had identical confidence scores. This made the approval queue useless — the ranking between coins was random.

**Fix**: Priority-1 scoring queries `validation_trials` directly for the specific ticker:

```sql
SELECT
  verdict,
  resolved_at,
  (julianday('now') - julianday(resolved_at/1000, 'unixepoch')) as days_ago
FROM validation_trials
WHERE ticker = ?
AND verdict IN ('CONFIRMED', 'FAILED')
ORDER BY resolved_at DESC
LIMIT 50;
```

Recency-weighted win rate uses exponential decay (14-day half-life):

```js
function recencyWeightedWinRate(trials) {
  const HALF_LIFE = 14; // days
  let weightedWins = 0;
  let totalWeight = 0;
  for (const trial of trials) {
    const weight = Math.exp(-trial.days_ago / HALF_LIFE);
    if (trial.verdict === 'CONFIRMED') weightedWins += weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedWins / totalWeight : null;
}
```

Falls back to `pattern_statistics` only when the ticker has fewer than 3 resolved trials.

---

## 5. Volume Spike UX — lastVolEventMs

### 5.1 The Problem

Users reported that EMACascadeMonitor showed "no volume spikes" for BTC even though BTC had clear volume activity earlier in the session. The issue: the chart window was 120 minutes, but the last BTC volume spike was 128 minutes ago — just outside the window.

The `/api/ema-cascade` query was `WHERE ts >= now - window_ms`, so the spike was excluded from `volEvents`. The frontend had no way to know a spike had recently happened outside the window.

### 5.2 The Fix

The backend always computes `lastVolEventMs` using an all-time query regardless of the window parameter:

```js
const lastVolEvent = db.prepare(
  'SELECT ts FROM volume_events WHERE ticker = ? ORDER BY ts DESC LIMIT 1'
).get(ticker);

// Included in response always, even if outside the chart window
const lastVolEventMs = lastVolEvent?.ts ?? null;
```

The frontend uses this to render a status chip in the source health strip:

```js
const lastVolAgo = lastVolEventMs ? Date.now() - lastVolEventMs : null;
const volChipLabel = lastVolAgo !== null
  ? `▾vol·${formatAge(lastVolAgo)} ago`
  : '▾vol·never';

// The chip is always rendered — it just updates its "ago" label
<span className={styles.volChip}>{volChipLabel}</span>
```

**Rule**: When a widget shows "recent events", always provide a `lastEventMs` field in the API response that covers all time — not just the requested window. This prevents the "nothing happened" false-negative when the most recent event is just outside the display window.

---

## 6. MarketHeartbeatIndicator — ECG Chart Performance

### 6.1 400-Point Sampling Cap

**Problem**: The header ECG chart reads the full `timeline` from `useTimeStore`. On a 30-day sandbox, this can be 20,000+ scan entries. Recharts rendering 20,000 data points freezes the main thread for several seconds on initial load and on every re-render.

**Fix**: Sample the timeline before passing to Recharts:

```js
const MAX_PTS = 400;
let data = timeline.map(scan => {
  const rawMood = scan.mood == null ? lastMood : scan.mood;
  lastMood = rawMood;
  return { ts: scan.timestamp, rawMood, bullArea: Math.max(0, rawMood), bearArea: Math.min(0, rawMood) };
});

if (data.length > MAX_PTS) {
  const step = Math.ceil(data.length / MAX_PTS);
  const sampled = data.filter((_, i) => i % step === 0);
  // Always keep the last point (most recent market state)
  if (sampled[sampled.length - 1] !== data[data.length - 1]) {
    sampled.push(data[data.length - 1]);
  }
  data = sampled;
}
```

**Result**: Chart renders in ~8ms regardless of timeline length. Maximum 401 points passed to Recharts.

**Rule**: Any chart that reads from a long-lived timeline (DVR sandbox) must sample before rendering. 400 points is sufficient for visual fidelity in a header-sized chart.

---

### 6.2 Carry-Forward Null Mood Pattern

**Problem**: When a scan has `mood: null` (backend calculated no mood — e.g., during a gap), the naive `scan.mood || 0` converts it to 0. On the ECG chart, this creates spike artifacts: the area chart drops to 0 then immediately jumps back to the actual mood value, producing false sharp transitions.

**Fix**: Carry forward the previous non-null value:

```js
let lastMood = 0;
const data = timeline.map(scan => {
  const rawMood = scan.mood == null ? lastMood : scan.mood;
  lastMood = rawMood; // Only update when non-null
  return { ts: scan.timestamp, rawMood };
});
```

**Rule**: When visualizing a time series that has nullable values representing "no change", carry the previous value forward rather than substituting 0. The `|| 0` pattern is only valid when 0 is a semantically meaningful value.

---

## 7. Push-First Socket Architecture

### 7.1 The Problem

All widgets used `setInterval` polling with a fixed N-second interval. This creates:
- **Staleness**: Data displayed is up to N seconds old after a live scan arrives.
- **Redundant requests**: API is hammered during quiet periods with no new data.
- **Latency stacking**: Over Tailscale (remote tunnel), each request adds ~50–200ms. N requests per minute = real UX latency.

### 7.2 The Solution

Widgets subscribe to the Socket.IO `scan-update` event emitted by the backend immediately after Stream A ingestion. On receipt, the widget calls `fetchData()` immediately.

```js
useEffect(() => {
  const off = socketService.on('scan-update', () => {
    if (document.hidden) return; // Page Visibility API — skip background tab
    fetchData();
  });
  return () => off(); // Clean up on unmount
}, [fetchData]);
```

The existing `setInterval` fallback remains as a safety net for when the socket connection drops or reconnects.

**Result**: Widgets update within ~200ms of a scan arriving (socket latency), not within N seconds of the next poll interval.

**Rule**: Any widget that displays data from Stream A should subscribe to `scan-update` for immediate updates. The interval fallback should have a longer period (e.g., 90–120s) since it's a safety net, not the primary path.

---

## 8. Code Splitting & Lazy Loading

### 8.1 The Problem

Eager imports of all 7 analytics widgets caused the initial JS bundle to include all chart code. On mobile or slow connections:
- 2–4 second blank screen while all chunks downloaded simultaneously
- Recharts rendering all charts immediately — high CPU spike during initial load
- Mobile main thread freeze when processing large datasets across multiple charts at once

### 8.2 LazyWidget + React.lazy Solution

**`LazyWidget` component** wraps each widget section in an `IntersectionObserver`:

```jsx
function LazyWidget({ children, rootMargin = '400px 0px' }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { root: null, rootMargin } // root: null = window viewport
    );
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, [rootMargin]);

  return <div ref={ref}>{visible ? children : <WidgetSkeleton />}</div>;
}
```

**`React.lazy` imports** in `App.jsx`:
```js
const EMACascadeMonitor = lazy(() => import('./components/AnalyticsWidgets/EMACascadeMonitor'));
const SmartAlertsWidget  = lazy(() => import('./components/AnalyticsWidgets/SmartAlertsWidget'));
// ... all other widgets
```

**Sidebar prefetch** on hover:
```js
navItems.forEach(item => {
  item.ref.addEventListener('mouseenter', () => item.prefetch?.());
});
// item.prefetch = () => import('./components/AnalyticsWidgets/EMACascadeMonitor')
// Module system caches the promise — second call is free
```

**Result**: Initial bundle is 40–60% smaller. Widgets load progressively as the user scrolls. Mobile initial render time drops from ~4s to ~0.8s.

**Rule**: Any analytics widget that is not the first visible element must be wrapped in `LazyWidget` + imported via `React.lazy`. Above-fold widgets use `rootMargin="200px 0px"` for early preload.

---

## 9. Summary: Rules for Future Developers

| # | Rule | Category |
|---|------|----------|
| 1 | Hoist all hot `db.prepare()` calls to module scope | SQLite |
| 2 | All batch inserts run inside `db.transaction(fn)` | SQLite |
| 3 | Always add composite indexes matching your most common `WHERE + ORDER BY` patterns | SQLite |
| 4 | Replace N+1 per-ticker queries with batched `GROUP BY` or `IN (...)` queries | SQLite |
| 5 | Use `parsePrice()` on all raw string price values from external sources | Data Parsing |
| 6 | Never use `parseFloat()` directly on locale-formatted price strings | Data Parsing |
| 7 | Normalize string keys with `.replace(/\s+/g, '_').toUpperCase()` before dict lookups | Data Parsing |
| 8 | Use `usePolledFetch` for all widget polling — never raw `setInterval` + `useEffect` | React |
| 9 | Wrap expensive repeating components in `React.memo` | React |
| 10 | Never use `|| []` or `|| {}` as prop values to memo'd components — handle fallback inside the child | React |
| 11 | Put all `.map()`, `.filter()`, domain computations in `useMemo` | React |
| 12 | Cap Recharts ReferenceDot/ReferenceLine arrays at MAX=40 per chart | React/Recharts |
| 13 | Show errors as banners above stale data, not as replacements for the whole widget | React UX |
| 14 | Always include `lastVolEventMs` (or equivalent) in API responses — covers all time, not just request window | API Design |
| 15 | Use CTE + `ROW_NUMBER() OVER (PARTITION BY)` for first/last-per-group queries, not correlated subqueries | SQLite |
| 16 | Any chart reading from a long-lived timeline must sample to ≤400 points before rendering | Recharts |
| 17 | Carry forward null values in time series instead of substituting 0 — prevents spike artifacts | React/Recharts |
| 18 | Subscribe to `scan-update` socket event for immediate widget refresh — keep poll interval as fallback only | React/Socket |
| 19 | Wrap analytics widgets in `LazyWidget` + `React.lazy` — only load chunks when scrolled into view | React |
| 20 | Widget user preferences (ticker, window, filter) must be persisted via `localStorage` with try/catch guards | React UX |
