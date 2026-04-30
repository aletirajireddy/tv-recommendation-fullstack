# Telegram Alert Architecture

**Version**: 2.0  
**Last Updated**: April 30, 2026  
**Service**: `server/services/telegram.js`  
**Validator hooks**: `server/services/telegramValidator.js`

---

## Overview

The Telegram alert system is the operator's real-time awareness layer. It covers all 4 data streams and is designed around three principles:

1. **No blind spots** — every critical signal pathway has a dedicated alert type
2. **No spam** — layered cooldown and quiet-hours suppression prevents alert fatigue
3. **Self-describing messages** — every alert includes stream source tag and reason code so the operator can act from Telegram alone without opening the dashboard

---

## Alert Types

| Alert Type | Method | Stream | Trigger Condition | Default Tier |
|------------|--------|--------|-------------------|--------------|
| **Eye-Catcher Pulse** | `syncStrategies()` | A·MACRO | New ticker enters a strategy (15-min global cooldown) | HIGH |
| **Institutional Move** | `onInstitutionalBarMove()` | C·ALERT | `bar_move_pct ≥ 1.5%` | HIGH / CRITICAL |
| **Scout Graduation** | `onScoutGraduation()` | B·SCOUT | Coin reaches STABLE status | HIGH |
| **Ghost Queued** | `onGhostQueued()` | SYSTEM | Coin added to ghost_approval_queue | INFO |
| **RelVol Spike** | `onRelVolSpike()` | D·REALTIME | `relVol ≥ 1.8×` (30-min rearm) | HIGH / CRITICAL |
| **Validator Verdict** | `telegramValidator` | C·ALERT | Trial resolves CONFIRMED / FAILED / NEUTRAL_TIMEOUT | CRITICAL / HIGH / INFO |
| **Early Favorable** | `telegramValidator` | C·ALERT | Trial passes 15-min EMA check | HIGH |
| **System Heartbeat** | `onHeartbeat()` | SYSTEM | Every 60 minutes | INFO |
| **Morning Digest** | `sendMorningDigest()` | SYSTEM | First heartbeat after 06:00 UTC | CRITICAL (forced) |
| **System Online** | constructor | SYSTEM | Server boot | INFO |

---

## Severity Tiers

```
CRITICAL  ──►  Always delivered. Bypasses quiet hours. Bypasses rate limits.
HIGH      ──►  Delivered unless quiet hours (00:00–06:00 UTC).
               If suppressed → queued in digestQueue for morning delivery.
INFO      ──►  Delivered unless quiet hours.
               If suppressed → silently dropped (low priority).
```

### Tier Assignment by Alert Type

| Condition | Tier |
|-----------|------|
| `bar_move_pct ≥ 3%` | CRITICAL |
| `bar_move_pct 1.5–3%` | HIGH |
| `relVol ≥ 3.0×` | CRITICAL |
| `relVol 1.8–3.0×` | HIGH |
| Validator `CONFIRMED` | CRITICAL |
| Validator `FAILED` | HIGH |
| Scout graduation (STABLE) | HIGH |
| Validator `EARLY_FAVORABLE` | HIGH |
| Eye-catcher pulse | HIGH |
| Ghost queued | INFO |
| Heartbeat | INFO |

---

## Quiet Hours Gate

```
QUIET_START_UTC = 00:00
QUIET_END_UTC   = 06:00
```

During quiet hours:
- `CRITICAL` alerts are **delivered immediately** (always)
- `HIGH` alerts are **queued** into `digestQueue` (max 30 items) and flushed as a single morning digest message at the first heartbeat after 06:00 UTC
- `INFO` alerts are **silently dropped**

The morning digest is sent as a single numbered list showing the first line of each suppressed HIGH alert.

---

## Cooldown System (Anti-Spam)

### Per-Ticker Global Cooldown
All non-CRITICAL alert types check `_isTickerOnCooldown(ticker)` before firing.

```
PER_TICKER_COOLDOWN_MS = 4 hours
```

The cooldown is shared across all alert types for the same ticker. If BTCUSDT.P fires a scout graduation, it cannot also fire a ghost alert or relVol alert for 4 hours (unless those are CRITICAL tier).

**Implementation**: `tickerLastAlerted: Map<ticker, timestamp>` in `TelegramService`.

### Stream A Global Cooldown
`syncStrategies()` has its own 15-minute global gate (separate from per-ticker):

```
STREAM_A_COOLDOWN_MS = 15 minutes
```

Even if many new tickers appear simultaneously, at most one pulse fires every 15 minutes.

### Stream A Ticker Memory (Bug-Fixed in v2)
Previously `knownTickers` was a `Set` replaced on every scan — coins that briefly left a strategy and re-entered were falsely counted as "new". Now it is a `Map<ticker, lastSeenMs>`:

- Tickers are **merged** (not replaced) on every scan
- A ticker is only "new" if `(now - lastSeenMs) > PER_TICKER_COOLDOWN_MS`
- Entries not seen in 24h are automatically evicted (memory guard)

### Validator Verdict Cooldown
`telegramValidator.attach()` maintains a separate `tickerVerdictCooldown: Map<ticker, timestamp>`:

```
VERDICT_COOLDOWN_MS = 4 hours
```

- `CONFIRMED` always bypasses (high-value signal)
- `FAILED` and `EARLY_FAVORABLE` suppressed if same ticker alerted within 4h
- Prevents same coin generating repeated verdict alerts when bouncing a level multiple times

---

## Retry Queue

Failed `bot.sendMessage()` calls are buffered in `_retryQueue` (max 5 items).  
The queue is drained on the next successful `sendAlert()` call — up to 2 retries per cycle.

If the retry fails again, the item is put back into the queue.  
Queue is in-memory (lost on process restart) — for transient Telegram API outages only.

---

## Message Format Standard

Every message follows this structure:

```
{ICON} *ALERT TYPE* [TIER if notable]
*{TICKER}* · {PRICE} · {DIRECTION}
{PRIMARY METRIC}: {VALUE}
{SECONDARY CONTEXT}
`[{STREAM}] #{REASON_CODE}`
```

### Examples

**Institutional Move (CRITICAL):**
```
🔥 INSTITUTIONAL MOVE [CRITICAL]
*BTCUSDT.P* · $43,250 · 📈 BULL
Bar Move: *+3.2%* · Vol: $1.2B
[C·ALERT] #INST_MOVE
```

**Validator CONFIRMED (CRITICAL):**
```
✅ CONFIRMED — 🟢 BTCUSDT.P LONG
   Level: $43,100 (BOUNCE @ EMA200_1H)
   Move: +1.8% | 23m elapsed

   ✓ 5m EMA200 Hold ($43,080)
   ✓ 15m EMA200 Sustain ($42,900)
   ✓ 1H EMA200 Align ($42,750)
   ✗ Volume Confirmed

🌡 Market mood: +34
📊 Similar setups: 72% win rate (n=18, HIGH confidence)
🎯 Next target: $43,800 (4H EMA200)
🚫 Invalidation: $42,800 (5m EMA200)
```

**RelVol Spike (HIGH):**
```
⚡ REL-VOL SPIKE [HIGH]
*GALAUSDT.P* · $0.00321
Relative Volume: *2.3×* (institutional footprint)
[D·REALTIME] #RVOL_SPIKE
```

**Scout Graduation (HIGH):**
```
🔍 SCOUT GRADUATION
*ENJUSDT.P* · $0.05646
Status: *STABLE* — entering active watchlist · Vol Δ: *+78%*
[B·SCOUT] #GRADUATION
```

**Ghost Queued (INFO):**
```
👻 GHOST QUEUE
*BIOUSDT.P* needs review
Reason: *Ghost Volume*
Approve in dashboard or it stays active.
[SYSTEM] #GHOST_PENDING
```

**Hourly Heartbeat (INFO):**
```
💓 SYSTEM HEARTBEAT — 14:00 UTC
Mood: 🟢 *BULLISH* (+34)
Active Trials: *3*
Alerts last hour: *4*
Top activity: BTCUSDT.P (2×), ETHUSDT.P (1×), SOLUSDT.P (1×)
[SYSTEM] #HEARTBEAT
```

---

## Enable / Disable Controls

### Runtime toggle (persisted to DB)
```js
TelegramService.toggle(true | false)
```
Persisted to `system_settings WHERE key = 'telegram_enabled'`. Survives process restarts.

### Environment override
```env
TELEGRAM_ENABLED=false   # in server/.env — master kill switch
```

### Per-feature config (via trial config_snapshot)
```json
{ "validator.telegram_phase2_enabled": false }     // suppress verdict alerts
{ "validator.telegram_early_check_enabled": false } // suppress early-favorable alerts
```

### Client UI
The dashboard header contains a Telegram toggle that calls `POST /api/settings/telegram`. State reflected in `useTimeStore.telegramEnabled`.

---

## DB Logging

Every `sendAlert()` call writes to `telegram_logs` regardless of whether the message was actually sent to Telegram (controlled by `isEnabled`). This means the operator can audit the full alert history even when notifications are disabled.

```sql
SELECT timestamp, level, message FROM telegram_logs ORDER BY timestamp DESC LIMIT 50;
```

The `level` column maps to alert types: `AI_PULSE`, `INST_MOVE`, `SCOUT`, `GHOST`, `RVOL_SPIKE`, `SUCCESS`, `WARN`, `INFO`, `HEARTBEAT`, `DIGEST`.

---

## Stream Wiring Summary

| Stream | Entry Point | Telegram Hook | Since |
|--------|------------|---------------|-------|
| A·MACRO | `POST /scan-report` → `analyzeProactiveStrategies()` | `syncStrategies()` | v3.0 |
| B·SCOUT | `POST /qualified-pick` (type=STABLE) | `onScoutGraduation()` | **v3.2** |
| C·ALERT (smart levels) | `POST /api/stream-c/webhook` → UmpireEngine | `telegramValidator.attach()` | v3.0 |
| C·ALERT (institutional) | `POST /api/stream-c/webhook` (bar_move_pct path) | `onInstitutionalBarMove()` | **v3.2** |
| D·REALTIME | `VolumeEventService.onStreamD()` → relVol crossing | `onRelVolSpike()` | **v3.2** |
| SYSTEM | Ghost approval queue insert | `onGhostQueued()` | **v3.2** |
| SYSTEM | `setInterval` 60 min | `onHeartbeat()` | **v3.2** |

Rows marked **v3.2** were gaps in previous versions and are newly wired.
