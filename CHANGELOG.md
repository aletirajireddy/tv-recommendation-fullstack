# Changelog

All notable changes to the TV Dashboard are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [3.2.0] — 2026-04-30 `feature/perf-arch-hardening`

### Added
- **Telegram Alert Overhaul (3 phases)** — full rewrite of `server/services/telegram.js`
  - 4 critical alert gaps plugged: institutional bar moves, scout graduations, ghost queue additions, Stream D RelVol spikes
  - Severity tiers: `CRITICAL` (always delivered) / `HIGH` (quiet-hours suppressed, digest-queued) / `INFO` (quiet-hours suppressed)
  - Quiet hours gate: 00:00–06:00 UTC non-CRITICAL alerts deferred
  - Per-ticker 4h global cooldown guards all alert types against repetitive noise
  - Morning digest: HIGH alerts held overnight flushed as a single message at 06:00 UTC
  - Hourly heartbeat: every 60 min reports mood, active trial count, alert density, top coins
  - Retry queue: failed Telegram API sends buffered (max 5), retried on next successful delivery
  - Stream-source tags in every message footer: `[A·MACRO]` `[B·SCOUT]` `[C·ALERT]` `[D·REALTIME]` `[SYSTEM]`
  - Reason codes: `#INST_MOVE` `#GRADUATION` `#GHOST_PENDING` `#RVOL_SPIKE` `#EYE_CATCHER` `#HEARTBEAT`
  - Fixed `knownTickers` Set→Map dedup bug in `syncStrategies()`: coins that briefly left a strategy no longer re-trigger as "new" on re-entry
  - Per-ticker 4h verdict cooldown in `telegramValidator.attach()` (CONFIRMED always bypasses)

- **MCP Server v2 — 22 tools across all 4 streams** (`mcp-server/`)
  - 5 new tools: `get_market_regime`, `get_stream_d_matrix`, `get_volume_events`, `get_smart_level_reactions`, `get_stream_health`
  - 4 enhanced tools: `analyze_target` (+Stream D EMA cascade, +active trial, +12h volume events), `get_market_sentiment` (+10-snapshot trend), `get_validated_setups` (+inline rule_snapshot), `get_database_schema` (+human-readable table descriptions)
  - `normaliseStreamD()` shared helper for consistent EMA cascade parsing
  - 2 new MCP resources: `market://stream-health`, `market://active-trials`
  - All tool descriptions rewritten for AI consumption clarity
  - Version bumped to 2.0.0

### Changed
- **VolumeEventService** `STREAM_D_REARM_MS`: 10 min → 30 min (reduces Telegram noise on Stream D)
- **VolumeEventService** `STREAM_D_RVOL_THRESHOLD`: now 1.8× (was 2.0×) — more sensitive leading-edge detection
- **VolumeEventService** `onStreamD()`: now calls `TelegramService.onRelVolSpike()` when relVol ≥ 1.8×
- **GlobalHeader** stream health poll: 10s → 30s (saves ~12 HTTP calls/min over Tailscale)
- **TimeService** `timeAgo()`: "Just now" → "now" (saves header width on mobile)

### Fixed
- `SpeedometerGauge`: invalid SVG attribute `textTransform="uppercase"` moved to `style={{...}}`

---

## [3.1.0] — 2026-04-29 `feature/perf-arch-hardening`

### Added
- **Push-First Widget Architecture** — socket push is now the primary data trigger; 5-min polling is safety-net only
  - `useDataInvalidation` hook: module-level stagger queue (150ms gaps), IntersectionObserver viewport detection
  - Visible widgets refresh immediately on push; off-screen widgets queue and refresh on viewport entry
  - `lastDataPush` monotonic signal in `useTimeStore` bumped on every socket event
  - `usePolledFetch` extended with `invalidateOn` and `initialData` options
  - `SocketService.off()` fixed: now accepts callback reference to avoid removing all handlers
  - `stream-d-update` socket event: server now emits dedicated event alongside `scan-update`
  - `ghost-update` socket event: approve/prune actions broadcast to all connected clients instantly

- **Viewport-Priority Widget Updates**
  - Off-screen widgets defer refresh to a stagger queue (150ms between each) preventing backend flood
  - On scroll-into-view, pending widget reloads are dequeued sequentially
  - Applies to: `CoinAgeWidget`, `ParticipationPulseWidget`, `GhostCoinWidget`, `FusionDashboard`, and all widgets using `usePolledFetch`

### Changed
- All widgets converted from `setInterval` polling to `useDataInvalidation` + `usePolledFetch(invalidateOn)`
- `FusionDashboard`: removed redundant 30s `setInterval`; restored 5-min safety-net poll
- `GhostCoinWidget`: `setInterval` 5s → 30s + `useDataInvalidation`
- Polling reduction: ~23 API calls/min at idle → ~0 calls/min at idle; ~8–10 per 2-min push cycle

### Fixed
- **CoinAgeWidget crash**: `Cannot read properties of null (reading 'length')` on first render
  - Root cause: `usePolledFetch` initialised `data` as `null`; JS destructuring `= []` only applies for `undefined` not `null`
  - Fix: added `initialData` parameter to `usePolledFetch`; `CoinAgeWidget` passes `initialData: []`
- `ParticipationPulseWidget`: was only fetching on mount; now reacts to socket push

---

## [3.0.0] — 2026-04-23 to 2026-04-27

### Added
- **Mobile Header Redesign**: 54px fixed height at ≤768px; heartbeat chart `flex: 1 1 auto`; gauge compressed to 56px; stream health shows 4 CSS dots (A/B/C/D) instead of text grid; breadth + time card hidden on mobile
- **CSS StatusDot**: pure CSS `border-radius:50%` span replaces emoji status indicators — eliminates font-fallback lookup and layout reflow
- **3rd Umpire Validator**: full trial state machine (`WATCHING → EARLY_FAVORABLE → CONFIRMED | FAILED`), EMA cascade rule checklist, pattern statistics win-rate engine, ghost scoring engine
- **Master Coin Store V4**: event-sourced ledger blending all 4 streams per coin; `stream_d_state` JSON column for EMA cascade matrix
- **Volume Event Service**: discrete event model replacing sticky `volSpike` flag
  - `STREAM_A_EDGE`: rising-edge detector (once per 15-min sticky window)
  - `STREAM_C_ALERT`: authoritative spike moment from TradingView webhook
  - `STREAM_D_RVOL`: relative-volume crossing (≥ threshold)
- **Ghost Scoring Engine**: per-ticker trial history + pattern statistics fallback + regime multiplier
- **Analytics Widget Layer**: 6 widgets — EMACascadeMonitor, LevelReactionWidget, ParticipationPulseWidget, DistanceTrackerWidget, CalendarWidget, GhostCoinWidget
- **MCP Server v1**: 17 tools via SSE transport at port 3001
- **Fallback Rehydrator**: Gmail API daemon reads TV alerts from inbox, deduplicates against DB, fills historical gaps

### Changed
- Database: `dashboard_v3.db` — WAL mode, composite indexes, prepared-statement hoisting
- Telegram: basic alerts wired to `syncStrategies` (Stream A) and `telegramValidator` (Stream C verdicts)

---

## Version History Summary

| Version | Date | Branch | Highlights |
|---------|------|--------|-----------|
| 3.2.0 | Apr 30, 2026 | `feature/perf-arch-hardening` | Telegram overhaul, MCP v2 |
| 3.1.0 | Apr 29, 2026 | `feature/perf-arch-hardening` | Push-first architecture, viewport-priority |
| 3.0.0 | Apr 23–27, 2026 | various | Full V4 Master Store, 3rd Umpire, Analytics layer |
| 2.x | 2026 Q1 | — | Stream A/B/C foundation, basic dashboard |
| 1.x | 2025 | — | Initial TradingView scraping prototype |
