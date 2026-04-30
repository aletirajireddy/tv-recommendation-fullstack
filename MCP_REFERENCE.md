# MCP Server — Tool Reference (v2.0)

**Version**: 2.0.0  
**Last Updated**: April 30, 2026  
**Endpoint**: `http://localhost:3001/mcp/sse` (SSE transport)  
**Tools registered**: 22  
**Database access**: `dashboard_v3.db` — **read-only** (physically impossible to corrupt ingestion path)

---

## Quick-Start Workflow for AI Agents

```
1. get_stream_health          → confirm data is live before trusting any analysis
2. get_market_regime          → single-call regime assessment with ai_interpretation
3. get_top_catalysts          → tickers printing breakout / momentum signals NOW
4. analyze_target <ticker>    → full dossier on any specific coin
5. get_validated_setups       → actionable trials with EMA rule pass/fail inline
6. get_pattern_stats          → historical edge (win rate) for the setup combination
```

---

## Tool Categories

### A. Market Overview (5 tools)
### B. Target Analysis (2 tools)
### C. Stream D / EMA Cascade (1 tool)
### D. Volume & Smart Levels (4 tools)
### E. Validator / Pattern Edge (4 tools)
### F. Watchlist / Lifecycle (3 tools)
### G. Power Tools (3 tools)

---

## A. Market Overview

### `get_market_sentiment`
Returns current Genie mood score (−100 → +100), mood label, breadth (bull vs bear count), and the **last 10 snapshots** for trend direction.

**Input**: none  
**Key output fields**:
```json
{
  "current": {
    "label": "RANGING",
    "score": -8,
    "bullish_count": 0,
    "bearish_count": 2,
    "trend_vs_prev_4_snapshots": "IMPROVING"
  },
  "recent_10_snapshots": [...]
}
```
**Use when**: calibrating overall market bias before any deeper analysis.

---

### `get_market_regime`
**Best first call.** Synthesises ALL signals into a structured regime assessment:
- Mood trend (last 10 ticks)
- Breadth
- Stream volume activity (last 2h by source)
- Active validator trial summary
- Plain-English `ai_interpretation`

**Input**: none  
**Key output fields**:
```json
{
  "current_regime": { "label": "RANGING", "score": -8, "trend_vs_prev_4_ticks": "IMPROVING" },
  "breadth": { "bullish": 0, "bearish": 2 },
  "stream_activity_last_2h": [{ "source": "STREAM_A_EDGE", "count": 36, "avg_strength": 1 }],
  "active_validator_summary": [...],
  "ai_interpretation": "RANGING — Low conviction. Smart Level reactions carry higher edge than trend plays."
}
```
**Use when**: answering "what is the market doing right now?" — single round-trip.

---

### `get_top_catalysts`
Returns tickers currently printing **Breakout** signals (`breakout=1`) or **High Momentum Volume Spikes** (`momScore≥2 AND volSpike=1`) from the latest Stream A scan.

**Input**: none  
**Key output**:
```json
{ "breakouts": ["BTCUSDT.P", "SOLUSDT.P"], "momentumSpikes": ["ETHUSDT.P"] }
```

---

### `get_institutional_pulse`
Returns coins with the highest **bar-move anomaly count** in the last 24h.  
High `pulse_count` + high `max_move` = strong institutional accumulation or distribution.

**Input**: none  
**Key output**: `[{ "ticker": "BTCUSDT.P", "pulse_count": 4, "max_move": 2.8 }]`

---

### `get_stream_health`
Returns liveness status (`LIVE` / `FRESH` / `STALE` / `DEAD`) and last-seen timestamps for all 4 data streams, derived from actual DB ingestion timestamps.

**Status thresholds**: `< 5 min = LIVE`, `< 30 min = FRESH`, `< 2h = STALE`, `else = DEAD`

**Input**: none  
**Key output**:
```json
{
  "streams": {
    "A_MACRO":    { "last_seen": "...", "age_minutes": 1.2, "status": "LIVE" },
    "B_SCOUT":    { "last_seen": "...", "age_minutes": 112, "status": "STALE" },
    "C_ALERT":    { "last_seen": "...", "age_minutes": 0.1, "status": "LIVE" },
    "D_REALTIME": { "last_seen": "...", "age_minutes": 2.5, "status": "LIVE" }
  },
  "volume_event_sources": [...]
}
```
**Use when**: verifying data freshness before making decisions. Always call this first if stale data is a concern.

---

## B. Target Analysis

### `analyze_target`
**All-in-one single-ticker dossier.** Five data sources in one call:

1. 26-column macro scan status (Stream A score, breakout, volSpike, momScore)
2. Stream D EMA cascade matrix with alignment flags (`cascade_bullish` / `cascade_bearish`, `pct_vs_ema200_m5`)
3. Nearest smart level speedbreakers (up to 6 levels with distance %)
4. Active 3rd Umpire Validator trial (state, direction, trigger_price, latest_move)
5. Last 12h volume events for the ticker

**Input**:
```json
{ "ticker": "BTCUSDT.P" }
```
**Key output**:
```json
{
  "ticker": "BTCUSDT.P",
  "current_scan_status": { "score": 4, "breakout": 1, "volSpike": 1, "momScore": 2 },
  "stream_d_matrix": {
    "price": 43250,
    "ema_alignment": { "cascade_bullish": true, "cascade_bearish": false, "pct_vs_ema200_m5": "+0.8%" }
  },
  "nearest_smart_levels": [{ "label": "1H EMA200", "price": 42800, "distance_pct": -1.04, "type": "SUPPORT" }],
  "active_validator_trial": { "trial_id": "...", "state": "WATCHING", "direction": "LONG" },
  "recent_volume_events_12h": [...]
}
```

---

### `query_master_coin_store`
Returns the **event-sourced timeline** for a coin from the V4 Master Store. Each row is a state snapshot blending all 4 streams.  
`stream_d` field is normalised EMA cascade matrix.

**Input**:
```json
{ "ticker": "BTCUSDT.P", "limit": 10 }
```
**Use when**: "What happened to BTCUSDT.P in the last hour across all streams?"

---

## C. Stream D / EMA Cascade

### `get_stream_d_matrix`
Returns the latest **Stream D real-time EMA cascade matrix** from TradingView (pushed every ~2 min).

Fields: `price`, `rsi` (m5/m15), `ema_200` (m1/m5/m15), `ema_alignment` (cascade_bullish / cascade_bearish / pct_vs_ema200_m5), `relative_volume_1h`, `atr_pct`.

**Input**:
```json
{ "ticker": "BTCUSDT.P" }   // omit for all-ticker compact summary table
```

**Omit `ticker`** to get a compact summary table across ALL tickers — useful for screening EMA-aligned coins:
```json
{
  "count": 25,
  "tickers": [
    { "ticker": "BTCUSDT.P", "cascade_bullish": true, "pct_vs_ema200_m5": "+0.8%", "rsi_m5": 62.3 },
    ...
  ]
}
```
**Use when**: "Is EMA cascade aligned for LONG/SHORT on BTCUSDT.P?" or "Which coins are above all 3 EMA200 timeframes?"

---

## D. Volume & Smart Levels

### `get_volume_events`
Queries the **unified `volume_events` ledger** with flexible filters.

**Sources**:
- `STREAM_A_EDGE` — rising edge of a volSpike run (macro bar anomaly)
- `STREAM_C_ALERT` — authoritative spike moment from TradingView webhook
- `STREAM_D_RVOL` — relative-volume crossing from screener

**Strength**: 1.0 = normal, ≥ 1.5 = strong spike, ≥ 3.0 = institutional grade

**Input**:
```json
{
  "ticker": "BTCUSDT.P",        // optional
  "source": "STREAM_C_ALERT",   // optional
  "min_strength": 1.5,          // optional
  "hours": 24                   // default 24
}
```
**Use when**: "Which coins had strong volume in the last 6 hours?" or "Show STREAM_C volume events today."

---

### `get_volume_buildups`
Returns coins with `volSpike=1` from the **latest Stream A scan**, sorted by `momScore`.  
These are institutional accumulation candidates in active build-up — pre-breakout positioning signals.

**Input**: none

---

### `get_smart_level_reactions`
Queries `smart_level_events` for price reactions to key levels (Mega Spot, EMA200 key TFs, Fib).

**Input**:
```json
{
  "ticker": "BTCUSDT.P",   // optional
  "direction": "BULL",     // optional — BULL or BEAR
  "hours": 24,             // default 24
  "limit": 20              // default 20
}
```
**Key output per reaction**:
```json
{ "ticker": "BTCUSDT.P", "direction": "BULL", "roc_pct": 1.2, "price": 43100, "level_type": "EMA200_1H" }
```
**Use when**: "Which coins bounced from smart levels today?" or "Show all BEAR reactions in the last 6 hours."

---

### `get_upcoming_watchers`
Returns tickers **within 0.5% of a smart level** (Mega Spot, 4H EMA200, 1H EMA200, Daily Res/Supp) but not yet triggered a Stream C alert.  
These are **pre-alert setups** — position before the event fires.

**Input**: none  
**Key output**: `[{ "ticker": "BTCUSDT.P", "level_label": "1H EMA200", "distance_pct": 0.28, "expected_direction": "LONG" }]`

---

## E. Validator / Pattern Edge

### `get_validated_setups`
Returns active 3rd Umpire Validator trials with state + **inline `latest_rule_evaluation`** showing which EMA cascade rules passed/failed at the last state transition.

**States**: `WATCHING → EARLY_FAVORABLE → CONFIRMED | FAILED | NEUTRAL_TIMEOUT`

**Input**:
```json
{ "state": "ALL" }   // WATCHING | EARLY_FAVORABLE | CONFIRMED | ALL
```
**Key addition vs v1**: each trial now includes:
```json
{
  "latest_rule_evaluation": {
    "evaluated_at": "2026-04-30T07:12:00Z",
    "state": "EARLY_FAVORABLE",
    "rules": {
      "EMA_5M_HOLD":     { "passed": true,  "observed": "$43,210" },
      "EMA_15M_SUSTAIN": { "passed": true,  "observed": "$42,980" },
      "EMA_1H_ALIGN":    { "passed": false, "observed": "$43,500" }
    }
  }
}
```

---

### `get_trial_details`
Deep dive into a specific trial. Returns `feature_snapshot` (market context at detection) + complete state transition log with each `rule_snapshot`.

**Input**: `{ "trial_id": "trial_BTCUSDT.P_1745580000000" }`  
**Use when**: "Why did this trial fail?"

---

### `get_trial_full_context`
**Full forensic dossier.** Joins three sources in a single call:
1. Trial row + feature_snapshot + raw_trigger_blob
2. All state transitions with rule snapshots
3. Master Coin Store snapshot AT trigger time + windowed timeline (−30m before → resolved_at +30m)

**Input**: `{ "trial_id": "trial_BTCUSDT.P_1745580000000" }`  
**Use when**: "What was the market doing when this trial triggered and why did it resolve the way it did?"

---

### `get_pattern_stats`
Pre-computed win rate statistics from the validator engine, grouped by `direction × trigger_type × vol_filter × ema_align`.

**Primary metric**: `win_rate_30m`

**Input**:
```json
{
  "direction": "LONG",
  "trigger_type": "BOUNCE",
  "min_samples": 5,
  "min_win_rate": 60
}
```
**Use when**: "What is the historical edge for LONG BOUNCE setups with volume confirmed?"

---

## F. Watchlist / Lifecycle

### `get_master_watchlist`
Returns Stream B scout activity from the last 2h: coins graduated to **STABLE** status, orphaned retries, and coins in the qualification pipeline.

**Input**: none

---

### `get_coin_lifecycles`
Returns coin maturity tracking: `born_at`, `last_seen_at`, `death_at`, `status`.

**Status values**: `ACTIVE` | `GHOST` | `DEAD`

**Input**: `{ "status": "GHOST" }`  // ACTIVE | GHOST | DEAD | ALL

---

### `get_ghost_approval_queue`
Returns coins awaiting **manual GHOST approval** with `confidence_score` and `score_breakdown`.  
GHOST = algo identified dead/inactive momentum coin pending human confirmation.

**Input**: none

---

## G. Power Tools

### `query_technical_filters`
Multi-criteria screener across the latest scan. Combine any of:

| Filter | Example |
|--------|---------|
| RSI by timeframe | `{ "rsi": { "timeframe": "h1", "operator": "<", "value": 45 } }` |
| EMA200 price position | `{ "ema200": { "timeframe": "h1", "operator": ">" } }` (price above 1H EMA200) |
| Smart level proximity | `{ "smart_level": { "max_distance_pct": 2, "min_confluence": 2 } }` |
| 26-column macro flags | `{ "macro_columns": { "breakout": 1, "momScore": { "operator": ">", "value": 1 } } }` |
| Volume | `{ "volume": { "operator": ">", "value": 50000000 } }` |
| Change % | `{ "change_pct": { "operator": ">", "value": 3 } }` |

**Example — "RSI < 45 on 1H AND price above 1H EMA200 AND within 2% of a smart level":**
```json
{
  "rsi":         { "timeframe": "h1", "operator": "<", "value": 45 },
  "ema200":      { "timeframe": "h1", "operator": ">" },
  "smart_level": { "max_distance_pct": 2, "min_confluence": 1 }
}
```

---

### `get_database_schema`
Returns schema DDL + human-readable description for every table in `dashboard_v3.db`.  
**Always call this first** before writing a custom SQL query.

---

### `run_readonly_sql_query`
Executes any SQLite `SELECT` or `WITH` CTE against `dashboard_v3.db`.  
Auto-appends `LIMIT 100` if not specified.

**Input**: `{ "query": "SELECT ticker, strength FROM volume_events ORDER BY ts DESC LIMIT 10" }`

---

## MCP Resources

| URI | Description |
|-----|-------------|
| `market://latest-snapshot` | Full raw JSON of the latest Stream A market sweep (all tickers + 26-column data) |
| `market://recent-alerts` | Summary of the last 2h of significant volume alerts and smart level events |
| `market://stream-health` | Liveness of all 4 streams (A/B/C/D) — LIVE / FRESH / STALE / DEAD |
| `market://active-trials` | All currently active validator trials with inline rule evaluations |

---

## Architecture Notes

- **Transport**: Server-Sent Events (SSE) at `/mcp/sse`. Messages via `POST /mcp/message`.
- **Safety**: Read-only DB connection. Cannot interrupt or corrupt backend ingestion.
- **Tailscale**: Accessible remotely at `https://<device>.tailbf6529.ts.net/mcp/sse` via Vite proxy (`/mcp/*` → `localhost:3001`).
- **Port**: `3001` (PM2 process: `mcp-server`).
- **Version endpoint**: `GET /mcp` returns tool count and stream list.
