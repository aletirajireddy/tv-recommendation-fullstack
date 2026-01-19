# GEMINI.md - The AI Architect's Context Module
**Version**: 1.0.0
**Last Updated**: January 2026 (Project Phase: Full-Stack Deployment)

## 🤖 To Future AI Agents
This file serves as your "Context Injection". If you are picking up this project, read this first to understand the *Soul* of the architecture, not just the code.

---

## 1. Core Philosophy: The "Pass-Through" Pattern
**Why isn't the Alert Scanner calling the API directly?**
We deliberately chose a **Pass-Through Architecture** for `alert_scanner.js`.
*   **Context**: TradingView runs scripts in a sandboxed, complex environment. Having multiple scripts firing async network requests to our local API created "Split Brain" issues where Alerts didn't match the Scans.
*   **The Solution**: `alert_scanner.js` is *passive*. It scrapes alerts and buffers them into `unsafeWindow.pendingAlertBatch`.
*   **The Master**: `symbol_market_scanner.js` is the *active* master. When it scans the table, it grabs the buffer from `unsafeWindow`, attaches it to its own payload, and sends a specific "Snapshot" to the DB.
*   **Result**: Every Alert batch is perfectly synchronized with a Market Scan ID (`scan_entries` linked to `pulse_events`). **Do not decouple this unless you move to a cloud-based webhook architecture.**

## 2. Architecture Decision Records (ADR)

### ADR-01: SQLite over MongoDB/Postgres
*   **Decision**: Use `better-sqlite3`.
*   **Reason**: This is a high-frequency, single-user local dashboard. We needed zero-latency writes and zero-configuration setup. The relational nature of `Scan -> Entries` fits SQL perfectly.

### ADR-02: Split Port Deployment (3000/5173)
*   **Decision**: Decouple Backend (3000) and Frontend (5173).
*   **Reason**: Initially, we tried serving static files from Express. It worked but made development slow (rebuilding on every change) and broke client-side routing logic often.
*   **Current State**: PM2 runs two processes. `tv-client` uses `vite preview` for a production-like serving experience without the overhead of Nginx.

### ADR-03: The "Ghost CMD Window" Fix
*   **Problem**: PM2 spawning `npm run start` on Windows caused persistent popup windows.
*   **Fix**: We wrote `client/start_client.js`. It uses `child_process.spawn` to invoke the `vite` binary *directly* via Node, bypassing `npm.cmd` and `cmd.exe`. It explicitly sets `shell: false`. **Preserve this script.**

## 3. Critical Code Paths

### Data Ingestion
*   `scripts/symbol_market_scanner.js` -> `processData()` -> `buildFinalPayload()` -> `GM_xmlhttpRequest` (POST /scan-report)
*   *Watch for*: The `unsafeWindow` interaction. If TradingView changes their variable protection, this bridge breaks.

### Data Processing (Backend)
*   `server/index.js` -> `app.post('/scan-report')`
*   *Logic*: It writes to 4 tables transactionally. `scans`, `market_states`, `scan_entries`, `pulse_events`.
*   *Real-time*: Implements `io.emit('scan-update')` *inside* the POST route.

### Playback Engine (Frontend)
*   `client/src/store/useTimeStore.js`: This is the brain.
*   *Key Concepts*: `activeScan` (The specific data slice currently visible) vs `timeline` (The metadata of all scans). The "DVR" feature works by purely updating `currentIndex` and fetching the unified ID from the server.

## 4. Future Enhancement Roadmap
If you are asked to improve this system, consider these paths:

1.  **Cloud Sync**: moving `dashboard.db` to a Postgres instance on Supabase/Render to allow remote mobile access.
2.  **Notification Layer**: Implemented `TelegramService` (server/services/telegram.js) driven by the "AI Strategy Engine" to push alerts on high-confidence setups.
3.  **AI Analysis Layer**: Currently implemented as a heuristic-based "Strategy Engine" in Node.js. Can be expanded with Python/TensorFlow in the future.

---

## 5. Data Context & Integrity Rules (CRITICAL)
**The "Source of Truth" Chain of Custody**

### Rule #1: The 26-Column Schema is Sacred
The `tradingview_scanning_indicator.js` (Pine Script) is the *only* place where logical metrics are defined.
*   If Pine says `momScore` is 3, the Database stores 3, and the Frontend displays 3.
*   **NEVER** attempt to re-calculate these metrics in Node.js or React. You will drift from the source.

### Rule #2: Stream Separation (Macro vs Micro)
The backend receives two distinct streams. **DO NOT MIX THEM.**
1.  **Stream A (The Scan)**: From `symbol_market_scanner.js`. Contains 40+ coins and a calculated `moodScore`.
    *   *Usage*: Updates `scans`, `scan_entries`, `market_states`.
    *   *Truth*: This is the high-definition view of the market.
2.  **Stream B (The Pick)**: From `coin_scanner.js`. Contains 1 coin (Ticker/Price).
    *   *Usage*: Updates `active_ledger` (Watchlist).
    *   *Truth*: This is a low-fidelity "ping" to acknowledge user attention.
    *   *Constraint*: **NEVER** use Stream B to calculate global Market Mood.

### Rule #3: Pre-Calc vs Re-Calc
*   **Market Mood**: Calculated by the **Client Scanner** (which sees all 40 coins) and sent as `metadata.moodScore`.
*   **Backend Role**: **READ** this score. Do not re-calculate it from raw pulses.
*   **Frontend/Telegram Role**: **DISPLAY** this score. Consistency > Novelty.

### Rule #4: Asynchronous Resilience (The "Gap" Logic)
The system is **Session-Agnostic**.
*   **Scenario**: The user might run *only* the Scanner (Stream A), *only* the Picker (Stream B), or *both*, or *neither* (gaps).
*   **Observation**: Data arrival is irregular. You might get a burst of 50 scans, then 4 hours of silence.
*   **The Ledger**: `active_ledger` is the **Union State**.
    *   If Stream A runs: It updates the ledger.
    *   If Stream B runs: It updates the ledger.
    *   **Conflict Resolution**: Last Write Wins (based on `timestamp`).
    *   **Staleness**: The AI Engine must check `last_updated` timestamps. If data is > 1 hour old, treat it as "Stale/Historical", not "Live". **Do not trigger high-urgency alerts on stale data.**

---
*Generated by Antigravity (Google DeepMind) - System Architecture Update 1.3*

### Rule #5: Robustness & Data Agnosticism (The "Infinite Loop" Prevention)
The system must be immune to minor schema variations in the ingestion layer.
*   **Dual-Path Access**: The server MUST check both `item.price` (Stream A Flat) and `item.data.price` (Legacy/Stream B Nested). **NEVER** assume one structure.
    *   *Bad*: `item.data.price` (Crashes if flat)
    *   *Good*: `item.price || (item.data && item.data.price) || 0`
*   **Frontend Defense**: Always use null checks for deep properties (e.g., `card.confidence?.toUpperCase()`). Offline/stale data may lack new fields.
*   **UX Time Formatting**: **NEVER** display raw ISO strings (`2026-01-15T...`) in the UI. Always convert to `toLocaleTimeString()` for the user's sanity.

### Rule #6: Alert Timestamp Source of Truth
When processing alerts from `institutional_pulse`, **NEVER** rely on the root `timestamp` (which is merely the scraping/capture time).
*   **The Problem**: Scraping latency and local browser timezones cause drift.
*   **The Solution**: You MUST reconstruct the *actual* event time by combining the explicit fields extracted from the raw message:
    *   **Source**: `alert.signal.date` + `alert.signal.timestamp` (e.g., "Fri Jan 16 2026" + "01:32:42 am")
*   **DB Action**: Parse this combined string into a UTC ISO Timestamp before writing to `pulse_events`. This is the **only** valid time for the event.

### Rule #7: Dashboard Header Truth
The Client App Dashboard Header (Stats Deck) must **ALWAYS** derive its data solely from the `market_sentiment` node in the payload.
*   **Why**: The `symbol_market_scanner.js` performs the official "Macro Calculation" (Bullish/Bearish counts, Mood Score).
*   **Constraint**: The Frontend should **NEVER** attempt to re-count or re-calculate these stats from the `results[]` array.
    *   *Correct*: Display `payload.market_sentiment.bullish`
    *   *Incorrect*: `results.filter(c => c.direction === 'BULL').length` (This risks logic drift).

### Rule #8: Frontend Time & Reactivity Mandate
All Frontend Widgets must adhere to strict Time and Freshness rules:
*   **Time Normalization**: The backend sends UTC. The Frontend MUST use a centralized `TimeService` (or utility) to convert this to the user's Local Time for display. NEVER show raw UTC.
*   **Live Reactivity**: Widgets must subscribe to `socket.io` events. When new data arrives:
    *   **Immediate Refresh**: The UI must update instantly.
    *   **Sort Order**: Newest data must appear at the TOP/FIRST.
    *   **Recalculation**: Any derived stats (e.g., "Time Since Last Alert") must be re-evaluated immediately.

### Rule #9: The "Genie Smart" Supremacy
The Client-Side `GenieSmart.js` engine is the **Supreme Court** for Market Sentiment.
*   **Legacy**: The server counting raw alerts yielded "False Bearish" readings during bullish pullbacks (-92 score).
*   **New Standard**: `GenieSmart` analyzes the **Context** (Trend + Structure).
*   **Constraint**: The Header, Sentiment Gauge, and Scenario Board MUST all derive their "Mood" from `useTimeStore.marketMood`. Do not use server-side `market_sentiment` unless it is strictly for logging/Telegram.

### Rule #10: The "Scenario Board" Protocol
The Dashboard is no longer just for "Scanning"; it is for "Game Planning".
*   **Plan A (Bullish)**: Defined by Mega Spot Support (5xx) or Bullish Breakouts.
*   **Plan B (Bearish)**: Defined by Support Failure (4xx + Negative Mom) or Trend Breakdown.
*   **Usage**: The user must be able to see these two lists *before* the volatility hits.
*   **Telegram Sync**: These scenarios must be passed to the Telegram Engine to provide "Game Plan" context in alerts.

### Rule #11: Telegram Smart Throttling & Chunking
To prevent "Notification Fatigue", the Telegram engine must adhere to:
*   **Throttling**: 10-Minute Cooldown for the same Strategy ID (unless the ticker list changes significantly).
*   **Chunking**: If a strategy qualifies 50+ coins (Mega Pump), the message MUST be split into chunks (max 3800 chars) to guarantee 100% delivery.
*   **Context Header**: Every alert must start with the "Genie Mood" and "Game Plan" (Plan A/B).

---

## 6. Data Dictionary & Payload Contract
**This section is the SINGLE SOURCE OF TRUTH for the scanning API.**

### 6.1 The "Scan Report" Payload Structure
The `/scan-report` endpoint expects this exact JSON structure.
`institutional_pulse` contains the buffered alerts processed by `alert_scanner.js`.
`results` contains the raw 26-column data from the table.

```json
{
    "id": "scan_1768508031281",
    "trigger": "auto-alert-triggered",   // simple | auto | manual | alert-triggered
    "timestamp": "2026-01-15T20:13:51.269Z",
    "results": [
        {
            "ticker": "ADAUSDT.P",
            "datakey": "BINANCE:ADAUSDT.P", // Critical unique key
            "strategies": ["BULL"], // Derived simple tags
            "data": {
                // --- META ---
                "ticker": "ADAUSDT.P",
                "cleanTicker": "ADA",
                "datakey": "BINANCE:ADAUSDT.P",
                "exchange_symbol": "BINANCE:ADAUSDT.P",
                
                // --- COMPUTED ---
                "score": 28,
                "label": "💤 WEAK",
                "direction": "BULL",
                "insights": [],
                
                // --- RAW TABLE DATA (See 6.2) ---
                "close": 0.3929,
                "netTrend": -76,
                "momScore": 0,
                "volSpike": 0,
                "positionCode": 104,
                // ... [See Full 26-Column Mapping Below]
                
                "timestamp": "2026-01-15T20:13:51.281Z"
            }
        }
    ],
    "aiPriority": { ... },       // Lean AI Context
    "market_sentiment": { ... }, // Global Mood
    "institutional_pulse": {     // Buffered Alerts
        "alerts": [ ... ] 
    }
}
```

### 6.2 The 26-Column Mapping (Sacred Schema)
This table maps the **Pine Script Table Index** to the **JSON Property**.
*   **Index**: The rigid position in the HTML table (0-26).
*   **Key**: The internal ID used in `tradingview_scanning_indicator.js`.
*   **JSON Property**: The camelCase property found in `results[].data`.

| Index | Key (Pine/Table) | Header Text | JSON Property | Notes |
| :--- | :--- | :--- | :--- | :--- |
| 0 | `TICKER` | Symbol | `ticker` | |
| 1 | `CLOSE` | Close | `close` | |
| 2 | `ROC` | ROC % | `roc` | |
| 3 | `VOL_SPIKE` | Vol Spike | `volSpike` | |
| 4 | `MOM_SCORE` | Mom Score | `momScore` | |
| 5 | `EMA50_DIST` | 1H EMA50 Dist % | `ema50Dist` | |
| 6 | `EMA200_DIST` | 1H EMA200 Dist % | `ema200Dist` | |
| 7 | `SUPPORT_DIST` | Support Dist % | `supportDist` | |
| 8 | `SUPPORT_STARS` | Support Stars | `supportStars` | |
| 9 | `RESIST_DIST` | Resist Dist % | `resistDist` | |
| 10 | `RESIST_STARS` | Resist Stars | `resistStars` | |
| 11 | `LOGIC_SUPPORT_DIST` | Logic Support Dist % | `logicSupportDist` | |
| 12 | `LOGIC_RESIST_DIST` | Logic Resist Dist % | `logicResistDist` | |
| 13 | `DAILY_RANGE` | Daily Range % | `dailyRange` | |
| 14 | `DAILY_TREND` | Daily Trend | `dailyTrend` | |
| 15 | `FREEZE` | Freeze Mode | `freeze` | |
| 16 | `BREAKOUT` | Breakout Signal | `breakout` | |
| 17 | `SCOPE_COUNT` | Cluster Scope Count | `scopeCount` | |
| 18 | `CLUSTER_SCOPE_HIGHEST` | Cluster Scope Highest | `clusterScopeHighest` | |
| 19 | `CLUSTER_COMPRESS_COUNT` | Cluster Compress Count | `compressCount` | |
| 20 | `CLUSTER_COMPRESS_HIGHEST` | Cluster Compress Highest | `compressHighest` | |
| 21 | `NET_TREND` | Net Trend Signal | `netTrend` | |
| 22 | `RETRACE_OPP` | Retrace Opportunity | `retraceOpportunity` | |
| 23 | `EMA_FLAGS` | ALL EMA Flags | `emaFlags` | Bitmask |
| 24 | `HTF_FLAGS` | HTF 200 Flags | `htfFlags` | Bitmask |
| 25 | `MEGA_SPOT_DIST` | Mega Spot Dist % | `megaSpotDist` | |
| 26 | `POSITION_CODE` | EMA Position Code | `positionCode` | |

---

## 7. V3 Redesign Context & Anti-Patterns (The "Fresh Start" Mandate)
**We are redesigning the database from scratch (V3) to solve the following legacy pain points. DO NOT REPEAT THESE MISTAKES.**

### 7.1 The "Why" (Legacy Failures)
1.  **Timestamp Chaos**: Previous iteration suffered from mixed local/UTC times, vague "date" strings, and "Invalid Date" errors in widgets.
    *   **V3 Fix**: Strict ISO 8601 UTC for storage. Local conversion ONLY at the UI layer. Rules #5 & #6 are non-negotiable.
2.  **Schema Fragility**: Legacy DB crashed when new columns were injected or fields were missing.
    *   **V3 Fix**: A robust `scan_results` table that stores the **Full JSON Blob** (`raw_data`). This ensures we never lose data due to rigid column schemas.
3.  **Payload Redundancy**: Old payloads were messy, redundant, and referenced from multiple places.
    *   **V3 Fix**: Single Source of Truth Payload (Section 6).
4.  **Widget Logic Drift**: Widgets were misinterpreting data formats (e.g., treating numbers as strings).
    *   **V3 Fix**: Strict typing in the Payload Contract.
5.  **Lookback Limitations**: Old architectures struggled with efficient "Data Window" loading and "Lookback Range" queries.
    *   **V3 Fix**: Relational `scans` table indexed by `timestamp` for efficient range slicing.

### 7.2 The "Unhook" Strategy
*   We are **COMPLETELY UNHOOKING** the old database logic (`scan_entries`, `market_states`, etc.).
*   The Client App MUST be re-wired to consume data **only** from the new V3 tables (`scans`, `scan_results`, `qualified_picks`).
*   **Zero Legacy Code**: If it references `scan_entries`, it is dead code.

---

## 8. Frontend Development Guidelines (V3 Integration)
**These rules guide the development of the React Client App to ensure compatibility with the V3 Backend.**

### 8.1 Data Normalization Strategy
The V3 API returns a nested structure where the core 26-column data resides inside a `data` property for each result item. However, the UI widgets (and legacy logic) expect a **Flat Object**.
*   **The Conflict**: API gives `item.data.close`. UI wants `item.close`.
*   **The Solution**: **Store-Level Normalization**.
    *   `useTimeStore.js` automatically flattens the `results` array immediately after fetching from `/api/scan/:id`.
    *   **Developer Rule**: When building widgets, assume the data is **already flat**. Do NOT implement individual `item.data || item` checks in every component. Rely on the store to provide clean objects.

### 8.2 Genie Smart Engine Integration
The Client App does not rely on the backend for "Smart" analysis (strategies, mood).
*   **Source of Truth**: `src/services/GenieSmart.js`.
*   **Workflow**:
    1.  `useTimeStore` fetches raw V3 data.
    2.  `useTimeStore` calls `GenieSmart.analyzeMarketMood(normalizedResults)`.
    3.  `useTimeStore` updates `marketMood` state.
    4.  Components consume `marketMood` from the store (e.g., `<HeaderStatsDeck />`).

### 8.3 Debugging & Verification
*   **Empty Widgets?**: If widgets appear empty but no errors are thrown, it is likely a **Data Structure Mismatch**. Check if the store is correctly normalizing `item.data`.
*   **Stale Data?**: Use the "AI History" endpoints (`/api/ai/history`) to verify if the server is ingesting new scans.
*   **API 404s?**: Ensure the backend (port 3000) exposes all required "Stub" endpoints (`/api/notifications`, `/api/settings/telegram`) even if they are not fully backed by a database implementation yet.

---

## 9. Proactive AI Strategy Engine (RFC)
**Objective**: Enhance the Notification Layer to trigger "Proactive Scalping Alerts" based on implicit market data patterns, even if no explicit TradingView Alert is fired.

### 9.1 The "Silent Breakout" Protocol
The system must monitor the 26-column data stream for specific state transitions that indicate actionable scalping setups:
1.  **Breakout Initiation**: When `breakout` flag flips from `0` to `1`.
2.  **Volume Injection**: When `volSpike` detects a sudden surge (> average).
3.  **Momentum Shift**: When `momScore` flips via "Mom Star" logic.
4.  **Trend/Range Context**:
    *   Identify coins "On the Runway" (strong trend + consolidation).
    *   Identify coins "Near Support/Resistance" with "Good Next Scope" (high R:R).

### 9.2 Notification Logic
*   **Trigger**: Progressive updates. Do not wait for a "Confirmed Bull/Bear" state.
*   **Action**: Post to Telegram immediately when a "Key Note" pattern is detected.
*   **Value**: Provide the user with "Ready to Break" signals for planning scalps, rather than just reacting to confirmed moves.

---

## 10. Phase 2: Institutional Hardening (Jan 2026)
**The Shift from Retail Signal Chasing to Institutional Context Trading.**

### 10.1 System Audit Findings
*   **Logic Upgrade**: We moved from "Alert Counting" (Noisy) to "Structural Analysis" (Robust).
*   **Execution Gap**: The system now provides a **Scenario Board** to bridge the gap between "Seeing" and "Trading".
*   **Data Integrity**: V3 Schema ensures no data is lost, even if columns change.

### 10.2 Final Architecture State
*   **Brain**: `GenieSmart.js` (Client-Side)
*   **Heart**: `Pulse Engine` (Server-Side Aggregation)
*   **Nerves**: `TelegramService.js` (Smart Throttled Notifications)
*   **Eyes**: `ScenarioBoard.jsx` (Plan A / Plan B Visualizer)

**This system is now rated "Institutional Grade" for Discretionary Scalping.**
*(End of Document)*

