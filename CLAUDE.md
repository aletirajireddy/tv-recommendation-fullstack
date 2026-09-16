# TV Recommendation Dashboard — Architecture & Design Reference

> Living document. Update whenever a design decision changes. Claude Code loads this automatically.
> Last major update: 2026-09-11 (Backend-Driven Tab Activation & Self-Healing Pipeline — unified activation coordinator, wait-and-listen handshake, per-target backoff, all-streams-dark Telegram alert, Watchlist Sync Fallback — see "Backend-Driven Tab Activation & Self-Healing Pipeline")

---

## ⚠️ CRITICAL WORKFLOW RULE — Tampermonkey Scripts

> **THIS RULE IS MANDATORY. READ BEFORE TOUCHING ANY FILE IN `scripts/`.**

### Files under `scripts/` are NOT live until the user manually pastes them into the browser.

Editing `scripts/coin_scanner.js`, `scripts/technical_watchlist_coin_scanner.js`, or any other Tampermonkey script file in this repo **does nothing** to the actual running script in the browser. Tampermonkey extensions store their own copy of the script. The file in `scripts/` is only a source-of-truth reference.

### Mandatory steps after every `scripts/` change

1. Claude makes the code change to `scripts/<file>.js`
2. **Claude MUST explicitly tell the user:** "I've updated `scripts/<filename>.js`. Please copy the full contents into Tampermonkey (browser extension → edit script → paste → Save). Confirm when done."
3. **Claude must NOT proceed as if the fix is live** until the user replies with confirmation.
4. If the user has not confirmed and a follow-up question implies the old script is still running, Claude must re-ask before debugging.

### Why this matters

- Backend restarts → live immediately (`pm2 restart tv-backend`)
- Frontend rebuilds → live after `npm run build` + `pm2 restart tv-client`
- `scripts/` changes → **NEVER live automatically**. Requires the user to open Tampermonkey, find the script, paste the new code, and Save. No automation exists for this.

### Current Tampermonkey scripts

| File | Browser script name | Current version |
|---|---|---|
| `scripts/symbol_market_scanner.js` | Ultra Scalper - Connected Core (Master) — Stream A | **v16.9** (pending Tampermonkey paste — repo file updated, not yet confirmed live in browser via `script_version_reports`) |
| `scripts/coin_scanner.js` | Institutional Conviction Engine - Bidirectional — Stream B | **v20.31** |
| `scripts/technical_watchlist_coin_scanner.js` | Stream D Technical Watchlist Scanner | **v1.6** |
| `scripts/indicators/tamper_streamA.txt` | Stream A macro scanner reference | — |
| `scripts/indicators/tamper_streamB.txt` | Stream B reference | — |
| `scripts/indicators/tamper_streamD.txt` | Stream D reference | — |

### Automa Workflow ID Registry (updated 2026-09-11)

> Automa runs entirely inside Chrome, independent of the Tampermonkey scripts and the
> backend. A workflow ID only actually does something if either (a) a script
> dispatches it via `window.dispatchEvent(new CustomEvent('automa:execute-workflow',
> {detail:{id}}))`, or (b) it has its own native trigger configured directly in
> Automa's UI (e.g. a Cron job). Column 3 says which applies to each row — don't
> assume a listed ID is "live" just because it's in this table. IDs are stored in
> `system_settings` (via the watchdog-settings API, editable from the Ghost Coin
> widget's settings panel) — **never hardcoded in a script**, except the one marked
> "hardcoded" below (Stream B's re-select-filter recovery), which is a deliberate
> fixed action rather than something the backend needs to pick dynamically.

**2026-09-16 fix — Stream A setup workflow ID was a dead setting.** Until
`symbol_market_scanner.js` v16.7, `streamAInitialSetupWorkflowId` was editable from
the Ghost Coin widget's settings panel and persisted to `system_settings`, but
nothing ever read it back out to the browser — `/scan-report`'s response never
included it, so `checkStreamAFilterSetup()` always dispatched its own hardcoded
`CONFIG.STREAM_A_SETUP_AUTOMA_WORKFLOW_ID` regardless of what was configured in the
UI. Diagnosed live 2026-09-16 (user reported the setup workflow "not firing" after
reconfiguring a preset — the preset itself was fine, the ID just never reached the
script). Fixed: `/scan-report` now includes `stream_a_setup_workflow_id` in every
response (same pattern as `activate_tab_workflow_id`), and the script (v16.7+)
dispatches that live value, falling back to the hardcoded default only until the
first successful response of a fresh page load. **Requires the Tampermonkey paste
— not live until the user confirms it.**

**2026-09-16 follow-up — setup-check timing was too aggressive for a real reload.**
User feedback after pasting v16.7: `STREAM_A_SETUP_INITIAL_SETTLE_MS` was still 45s,
too tight for a heavier Pine screener to finish populating real columns after a
fresh page load — risked judging (and dispatching Automa against) a page that was
still genuinely loading, not actually broken. v16.8 bumps it to 90s, replaces the
flat 5min retry cooldown with a progressive backoff (`STREAM_A_SETUP_COOLDOWN_STEPS_MS`
— 5min, 7min, 10min), and widens the monitor's own poll interval 15s → 20s (cosmetic;
that interval only controls how often the cheap DOM check re-reads, never dispatch
rate). Also caught and fixed in the same pass: the `@version` UserScript tag was
bumped to 16.7 but the separate runtime `SCRIPT_VERSION` constant — the one actually
sent to the backend with every payload and tracked in `script_version_reports` — was
still `'16.6'`, so even a correctly-pasted v16.7 would have under-reported its own
version. Both now stay in sync at 16.9.

**2026-09-16 follow-up #2 — the v16.7/v16.8 description itself broke Tampermonkey's editor.**
User sent a screenshot: Tampermonkey's own metadata-block parser (not ESLint — a real
misdiagnosis on my part initially) flagged every wrapped continuation line of the
multi-line `@description` I'd written for v16.7/16.8 with a red error marker. The
UserScript metadata format requires every line between `==UserScript==` and
`==/UserScript==` to be its own single-line `// @directive` — a plain wrapped comment
continuation has no directive and isn't valid there. Fixed in v16.9 by collapsing the
description back to one line, matching the rest of the file's (admittedly ugly but
correct) convention. Also added `scripts/eslint.config.mjs` — a real ESLint config had
never existed for this folder, so the Tampermonkey GM_* APIs and `unsafeWindow` had no
declared globals; any actual linting reported them as `no-undef`. The config is
self-contained (no `@eslint/js`/`globals` package imports — `scripts/` has no
`node_modules` of its own and Node's ESM resolver won't reach into `client/node_modules`
across sibling directories) and uses the `.mjs` extension specifically because the root
`package.json` lacks `"type": "module"` (adding it there would break `server/index.js`
and other root-level CJS scripts). Fixed the small number of genuine `no-unused-vars`
errors it surfaced along the way — see the v16.9 changelog entry in the file itself for
the details of which were removed vs. renamed vs. left in place pending a decision.

| Workflow ID | Purpose | Wired how |
|---|---|---|
| `GNRPpM5H6q7VmXjxjlOQC` | Stream B — re-select the screened-coin filter | **Live, hardcoded.** Dispatched by `coin_scanner.js`'s `checkStrictScreenedCoin()` (`CONFIG.STRICT_SCREEN_AUTOMA_WORKFLOW_ID`) when the filter pill goes missing. |
| `3lcKzNfE_GyXzpUMKxwVi` | Stream A — initial/filter setup | **Live**, `streamAInitialSetupWorkflowId` setting (as of v16.7 — see "2026-09-16 fix" below). Dispatched by `symbol_market_scanner.js`'s `checkStreamAFilterSetup()` when the pills/columns/rows health check fails (see below). |
| `3lt4ZkHylt3L0uQlo05iH` | Stream B — make its tab/window active | **Live**, `tabActivateWorkflowIdB` setting. Dispatched by the backend's activation coordinator (see below) via `coin_scanner.js`'s `activate_tab_workflow_id` handler. **Caution:** live-Automa-log testing on 2026-09-10 twice showed this ID actually activating Stream D's window, not B's — the user has since said it's fixed on the Automa side, but this hasn't been independently re-verified since. If tab-activation misbehaves for B, check this mapping first. |
| `9NoMligzmg3VE9SJMC942` | Stream A — make its tab/window active | **Live**, `tabActivateWorkflowIdA` setting. Same dispatch path, via `symbol_market_scanner.js`'s `activate_tab_workflow_id` handler. |
| `h3ixjpLixrztE_ZzhLWtk` | Stream D — make its tab/window active | **Live**, `tabActivateWorkflowIdD` setting. Same dispatch path, via `technical_watchlist_coin_scanner.js`'s `activate_tab_workflow_id` handler. Confirmed working via live cross-stream testing (fired through both B's and D's own dispatch code). |
| `4mxKJE8VxWpqztNVK5Wn_` | Stream B — watchlist sync fallback (opens a fresh tab, redoes the copy+paste) | **Live**, `watchlistSyncFallbackWorkflowId` setting. Dispatched by `coin_scanner.js`'s `watchlist_sync_fallback_workflow_id` handler when a ticker's normal sync retry has clearly stopped working. **Proven live 2026-09-11** — see "Watchlist Sync Fallback" below. |

### How the force-update mechanism works (whitelist + watchlist sync)

When a coin is whitelisted via the dashboard:
1. Server sets in-memory `_pendingWhitelistSync = true`
2. Next `processSyncPayload` response (from either `/qualified-pick` or `/api/market-context`) includes `action_required: 'UPDATE_WATCHLIST'` + the new coin in `master_targets`
3. Tampermonkey `processSyncPayload()` sees `isForcedUpdate = true` → bypasses the 15-min Automa cooldown → calls `GM_setClipboard(masterTargetsList)` + `GM_openInTab('https://www.tradingview.com/cex-screener/lEINSjG1/')` → Automa reads clipboard → TV watchlist updated
4. Flag is consumed (one-shot) — subsequent responses return `action_required: null`

---

## Backend-Driven Tab Activation & Self-Healing Pipeline (2026-09-10/11)

> Read this before touching any `activate_tab_workflow_id`/`watchlist_sync_fallback_workflow_id`
> logic in `server/index.js`, or any of the three scripts' response-handling code.
> This replaced an earlier, structurally broken design — the "why" matters as much
> as the "what" here, so a future edit doesn't reintroduce the same bug.

### The problem this solves

All three local-tab streams (A/B/D) depend on their TradingView browser tab staying
genuinely visible/foregrounded — Chrome throttles background-tab timers hard enough
that a backgrounded-too-long tab can stop polling almost entirely (confirmed live:
a 12-hour, then a separate 20-hour, total silence on Stream A with the OS never
sleeping — purely a tab-visibility problem). Automa can bring a tab back to the
front on command, but only if *something* tells it to.

### Real Automa mechanics (confirmed live, 2026-09-10/11 — do not assume otherwise)

Each "make tab active" workflow does exactly ONE thing when fired: activate its own
named tab, force-click its Scan button, wait ~2 minutes, click Scan again, wait
~1 minute, then hand off focus to the *next* tab in a fixed rotation
(B → D → A → B → …) baked into that workflow — and stops there. **The tab that
receives the hand-off gets no forced scan and no further auto-advance** — it just
sits foregrounded until its own script's normal cycle (or another dispatch) does
something with it. Tab activation by itself never triggers a workflow; only an
explicit `automa:execute-workflow` dispatch does.

**Design consequence:** because each workflow already activates its *own* named tab
directly (not the tab after it), the correct way to get a specific stale tab
scanned is to dispatch **that tab's own workflow ID directly** — never rely on the
rotation hand-off to do real work, since the hand-off target gets no scan.

### The old design (retired) and why it was broken

Originally, each stream independently asked "am I stale? if so, tell myself to
activate" (`_getTabActivateSignal()` / `_getStreamAActivateSignal()` /
`_getStreamDActivateSignal()`, one per stream, each reading only its own workflow
ID). This was structurally circular: a stream stale enough to need activating is,
by definition, no longer polling — so it can never receive an instruction to
activate itself, because it never asks. Also each of the three response paths
independently computed and could fire its own dispatch, with per-stream cooldowns
only — no shared awareness, no defense against over-firing across all three at once
(which itself creates Automa overhead: repeated tab switches/clicks piling up
before a prior one has even had a chance to land).

### The current design — unified activation coordinator

`_getCoordinatedActivationTarget(askingStream)` in `server/index.js` replaces all
three old functions. Called from every response path that can carry
`activate_tab_workflow_id` (`/scan-report` for A, `/api/market-context` +
`/qualified-pick` for B, `/api/stream-d/technicals` for D), passing which stream is
asking (i.e. which one is currently reachable/polling):

1. **Never targets the asker.** Only the other two streams are candidates — the
   asker is, by definition, already alive.
2. **Priority = most overdue wins**, in absolute age terms (not relative to each
   stream's own threshold), among candidates that exceed their own threshold
   (`tabActivateThresholdMinA/B/D`, default 6min each).
3. **Wait-and-listen handshake** (not fire-and-forget): once a target is dispatched,
   it's recorded as *pending* (`tab_activate_pending_target` /
   `_dispatched_at` in `system_settings`). Every subsequent call first checks
   whether that pending target's own data has genuinely resumed *after* the
   dispatch timestamp:
   - **Resumed** → handshake succeeded, slot freed, that target's fail-count reset.
   - **Not yet, but still within `TAB_ACTIVATE_HANDSHAKE_WINDOW_MIN` (8min — sized
     for the ~5-6min real Automa hop time plus buffer)** → stays quiet, dispatches
     nothing else. This is the "breathing space" — no new activation fires while
     one is still plausibly in flight.
   - **8 minutes pass, still nothing** → counted as a failed handshake for that
     target (`tab_activate_fail_count_<stream>`).
4. **Backoff + rotate on repeated failure.** Two consecutive failed handshakes for
   the same target (`TAB_ACTIVATE_MAX_CONSECUTIVE_FAILS`) → that target's workflow
   is suspected broken on the Automa side, and it's backed off
   (`tab_activate_backoff_until_<stream>`) for `TAB_ACTIVATE_BACKOFF_MIN` (30min),
   during which the coordinator prefers whichever *other* stale stream needs help
   instead — never permanently gives up, just deprioritizes.
5. **One global cooldown** (`TAB_ACTIVATE_COORDINATOR_COOLDOWN_MIN`, 3min) across
   all three callers, on top of the handshake window, as a final floor.

No script changes are needed to swap in new logic here — all three scripts already
just dispatch whatever ID arrives in `activate_tab_workflow_id`, regardless of which
backend function computed it.

### All-streams-dark detection (Telegram)

The coordinator above only ever runs when *some* stream is polling to trigger it —
if A, B, and D are **all** silent past their thresholds at once, nobody can ask, and
the whole mechanism is powerless. This is checked independently, every 15 minutes,
in the same periodic job that already does per-stream feed-health alerting (near
the bottom of `server/index.js`) — `TelegramService.onAllStreamsDark(allDark,
detail)` in `server/services/telegram.js`. CRITICAL tier, 1-hour cooldown, sends a
recovery message once any stream resumes. Usually means Automa itself is
stuck/broken, or the browser/laptop went idle — needs a human, not another retry.

### Watchlist Sync Fallback — proven live 2026-09-11

`reconcileWatchlistSync()`'s existing escalation path (force `UPDATE_WATCHLIST` on
repeated miss) can itself fail silently and repeat forever for a specific ticker —
confirmed live: `BINANCE:BCHUSDT.P` and `BINANCE:ETHFIUSDT.P` sat stuck for **15+
hours**, 297 consecutive misses, 75 forced-retry escalations, never landing on the
real watchlist, while every other historical entry in `watchlist_sync_audit`
resolved within 1-2 cycles. That's a genuinely stuck case, not routine flakiness —
same recovery action (clipboard-paste in place) just wasn't working anymore for it.

`_getWatchlistSyncFallbackSignal()` watches `watchlist_sync_audit` for any ticker
with `consecutive_misses > 0 AND escalations >= watchlistSyncFallbackEscalationThreshold`
(default 5) and, past `watchlistSyncFallbackCooldownMin` (default 15min) since the
last fallback dispatch, sends `watchlist_sync_fallback_workflow_id` in Stream B's
response (both `/api/market-context` and `/qualified-pick`). `coin_scanner.js`
dispatches it via the same `automa:execute-workflow` CustomEvent, on its own 5min
local cooldown (separate from tab-activate's — unrelated recovery actions).

**Result when this actually fired (2026-09-11):** all three stuck tickers
(`BCHUSDT.P`, `ETHFIUSDT.P`, `SAGAUSDT.P`) landed on the real watchlist within one
cycle of the fallback dispatch, confirmed via `[SYNC-VERIFY] ✅ Landed in
watchlist:` in the backend log and `consecutive_misses` dropping to 0 in
`watchlist_sync_audit`. This is the mechanism that was silently blocking watchlist
rotation — **not** a ghost/prune-removal bug (see "Ghost/prune audit findings"
below).

### Ghost/prune audit findings (2026-09-11) — removal isn't broken, addition was

Investigated a report of "the same 26 symbols never rotate, is ghost auto-removal
broken?" Findings:
- `ghost_auto_approve` was correctly ON, `coin_lifecycles.clock_start_at` for the
  current watchlist had genuinely passed the 12h settle window — removal logic
  *was* eligible to run and wasn't being blocked by the settle gate.
- The 26 coins were legitimate, currently-qualifying majors/liquid-alts — nothing
  pointed to prune logic being broken.
- The actual blocker was the sync-fallback scenario above: new candidates
  (BCH/ETHFI/SAGA) kept getting backend-approved but could never *land* on the
  real watchlist, so nothing could ever rotate in regardless of what happened on
  the removal side.
- Separately noted, not yet fixed: `_checkMonitoringGap()` resets **every**
  tracked coin's `clock_start_at` on any gap over `gapToleranceMin` (15min) —
  including coins that are obviously ancient zombie records (7-day-old mangled
  tickers from an earlier contamination bug, `born_at` days old but only ever
  `last_seen_at` once). Given how often qualifying gaps occur in practice, a truly
  ancient bad record may rarely or never accumulate 12 continuous settle hours.
  Cosmetic today (confirmed those specific zombie tickers are NOT in the real live
  watchlist, just stale `coin_lifecycles` bookkeeping) but worth a real fix later:
  a coin already older than some threshold could skip the settle-window reset and
  become immediately re-evaluable after a gap, instead of waiting another full
  12h alongside genuinely young coins.
- Also noted, not yet fixed: some coins currently on the live watchlist show
  `coin_lifecycles.status: 'DEAD'` while still actively present — the `status`
  field isn't being kept in sync with reality. Didn't block anything found so far,
  but worth checking if `status` is ever load-bearing for a future decision.

### Stream A — initial/filter setup check (v16.3 → v16.6)

Mirrors Stream B's Strict Screened Coin, but had to evolve further once tested
against the real DOM:

- **v16.3**: single check — pills container (`[class*=screenerContainer] div
  [class*=pillsWrapper-] div[class*=pillsContainerWrapper-]
  div[class*=pillsContainer-]`) must have > 4 direct children.
- **v16.4 fix (real deadlock found)**: the check only ran from inside
  `processData()`, which is never called until `startAutoScan()`'s button-discovery
  loop finds the scan button — but that loop can get stuck retrying forever
  ("Scan button not found") exactly when the screener isn't properly set up. The
  fix meant to escape that state was gated behind the very state it needed to
  escape. Fixed with a standalone `startStreamASetupMonitor()` on its own 15s
  timer, independent of button/scan state, started *before* the button-dependent
  functions in the init sequence.
- **v16.5**: settle window now starts from a real page-`load` event (or
  `document.readyState === 'complete'`), not script-injection time — Tampermonkey
  has no `@run-at` here (defaults to `document-idle`), which can fire before
  TradingView's SPA content has actually rendered.
- **v16.6 (combined check, per live DOM review)**: pills-only missed a real broken
  state — 10 filter pills were present (would've passed) but the table itself had
  only 1 real data column and every row showed a Pine Script `array.get() Index
  out of bounds` error. Now requires all three: pills > 4 children, `thead
  th[data-field]` count > 5, `tbody tr[data-rowkey]` count ≥ 2. Retry cooldown
  bumped 3min → 5min (table can take a while to populate after pills render).
  After 3 retries still fail, **reloads the page** instead of giving up silently —
  capped at 3 reloads total to avoid a reload loop.

### Watchdog settings API reference (activation/sync-fallback fields)

```
GET/POST /api/ghosts/watchdog-settings
  tabActivateWorkflowIdA/B/D        — Automa workflow ID per stream's tab-activate
  tabActivateThresholdMinA/B/D      — staleness minutes before that stream is a candidate (default 6)
  streamAInitialSetupWorkflowId     — Stream A's filter-setup fix workflow (live as of v16.7 — see the 2026-09-16 fix note above)
  watchlistSyncFallbackWorkflowId   — heavier recovery workflow for a stuck watchlist-sync ticker
  watchlistSyncFallbackEscalationThreshold — escalations before fallback fires (default 5)
  watchlistSyncFallbackCooldownMin  — min gap between fallback dispatches (default 15)
```

All editable from the Ghost Coin widget's settings panel (⚙), auto-save on blur —
no script or backend redeploy needed to change an ID or threshold.

### Verifying real data flow (not just timestamps) — methodology

A stream can look "healthy" by `lastWriteAgeMinutes` alone while actually punching
frozen values with fresh timestamps (the original bug class this whole session
started from). The real check: walk back through a ticker's recent rows and find
how far back the tracked fields have been byte-identical — a fresh timestamp with
an unchanged value for many consecutive rows means the tab is stuck, not healthy.
Confirmed via this method on 2026-09-11 that the vast majority of A/B/D data is
genuinely changing cycle-to-cycle (not just tab-switch cosmetics) — one real
exception found: `1000PEPEUSDT.P` on Stream A stuck at `close: 0` for ~1h, a
Pine Script data-quality issue on that specific symbol, not a systemic freeze.

---

## Stack

| Layer | Tech |
|---|---|
| Frontend | React + Vite, Zustand, Recharts, CSS Modules |
| Backend | Node.js / Express 5, Socket.IO, SQLite (better-sqlite3) |
| Process manager | PM2 — 3 processes: `tv-backend`, `tv-client`, `mcp-server` |
| Build | `vite build` in `client/` → `client/dist/` served by `vite preview` (`tv-client`) |
| Proxy | Tailscale Funnel → `https://desktop-c92c19n.tailbf6529.ts.net` → `127.0.0.1:5173` (tv-client) |

### Two-Process Architecture (CURRENT)

| Process | Port | Responsibility |
|---|---|---|
| `tv-backend` | **3000** | API + Socket.IO only. No static file serving. Tampermonkey POSTs here directly. |
| `tv-client` | **5173** | `vite preview` serving `client/dist`. Proxies all `/api`, `/socket.io`, `/health`, `/scan-report`, `/mcp` to backend. |
| `mcp-server` | **3001** | MCP server. Accessible via proxy at `/mcp`. |

> **⚠️ PORT RESERVATION — DO NOT REASSIGN (2026-09-16)**
> `3000` (backend/webhooks), `5173` (frontend), and `3001` (MCP) are fixed and
> load-bearing — Tampermonkey scripts POST directly to `3000` by hardcoded URL,
> the Vite proxy config points at these exact ports (`client/vite.config.js`),
> and Tailscale Funnel's external routing assumes them (see the request-flow
> diagram above). **Never repurpose an existing port for a new capability,
> including future MCP work** — if something new needs a port, pick an unused
> one and add it to this table; don't reassign `3000`/`5173`/`3001` to
> anything else. The dev-instance ports (`3010`/`5174`/`3011` below) are the
> existing pattern for "I need a parallel instance" — reuse that pattern
> rather than inventing a new scheme.

**MCP tools** (`mcp-server/tools.js` + registrations in `mcp-server/index.js`) let an
agent query the live DB read-only without hand-writing SQL each time — full list and
schemas live in `index.js`, not duplicated here. `get_ghost_approval_queue` and
`get_watchdog_settings` (2026-09-16) were updated/added to match the ghost-window
redesign below — `get_ghost_approval_queue` now returns per-coin `age_min`,
`remaining_min`, and `outcome_at_expiry` instead of a raw table dump, and
`get_watchdog_settings` surfaces settle/ghost/momentum/gap-tolerance hours in one call.

**How requests flow through Tailscale:**
```
https://desktop-c92c19n.tailbf6529.ts.net  →  port 5173 (tv-client / vite preview)
  /                →  serves React SPA (client/dist/index.html)
  /api/*           →  proxied → localhost:3000 (tv-backend)
  /socket.io       →  proxied → localhost:3000 (tv-backend, ws:true)
  /health          →  proxied → localhost:3000 (tv-backend)
  /scan-report     →  proxied → localhost:3000 (tv-backend)
  /mcp             →  proxied → localhost:3001 (mcp-server)
```

**External access (Oracle VM, other machines on Tailscale network):**
- Dashboard: `https://desktop-c92c19n.tailbf6529.ts.net/`
- Webhooks (Stream C): `POST https://desktop-c92c19n.tailbf6529.ts.net/api/webhook/smart-levels` ✅
- All `/api/*` endpoints accessible via Tailscale URL — proxied to backend port 3000, client app unaffected ✅
- MCP: `https://desktop-c92c19n.tailbf6529.ts.net/mcp` ✅

**Local Tampermonkey scripts** POST directly to `http://localhost:3000/api/*` — bypasses the proxy entirely.

### Vite Proxy Config (`client/vite.config.js`)

Both `server` (dev) and `preview` (production) blocks share the same proxy rules:

```js
const API_PORT = process.env.VITE_API_PORT || 3000;
const MCP_PORT = process.env.VITE_MCP_PORT || 3001;

proxyRules = {
  '/api':       { target: `http://localhost:${API_PORT}`, changeOrigin: true },
  '/socket.io': { target: `http://localhost:${API_PORT}`, ws: true, changeOrigin: true },
  '/health':    { target: `http://localhost:${API_PORT}`, changeOrigin: true },
  '/scan-report': { target: `http://localhost:${API_PORT}`, changeOrigin: true },
  '/mcp':       { target: `http://localhost:${MCP_PORT}`, changeOrigin: true, ... }
}
```

`allowedHosts` includes `desktop-c92c19n.tailbf6529.ts.net` and `.ts.net` wildcard — Tailscale access works without extra config.

### Socket.IO Transport — CRITICAL

**Transport order MUST be `['websocket', 'polling']`** (WebSocket first).

```js
// SocketService.js — correct config
this.socket = io('/', {
    transports: ['websocket', 'polling'],  // WS first — never flip this order
    upgrade: true,
    reconnection: true,
    reconnectionAttempts: 15,
    reconnectionDelay: 1500,
    timeout: 20000,
});
```

The vite preview proxy handles WebSocket upgrades for `/socket.io` correctly (`ws: true`). Tailscale Funnel tunnels the WebSocket as persistent TCP — confirmed working end-to-end.

### PM2 Watch — DISABLED (production)

`watch: false` in `ecosystem.config.js`. Watch mode restarts on every file save, causing brief port-unavailable windows. **Never re-enable for production.**

After backend code changes: `pm2 restart tv-backend`  
After frontend changes: `npm run build` in `client/`, then `pm2 restart tv-client`

> **PM2 ID note**: Always verify IDs with `pm2 list` — they shift after deletions/restarts.

### Development Instance (`ecosystem.dev.config.js`)

A parallel dev stack runs alongside production without port conflicts:

| Process | Port | Notes |
|---|---|---|
| `tv-backend-dev` | **3010** | Watch mode enabled on `index.js`, `services`, `utils`, `validator` |
| `tv-client-dev` | **5174** | `VITE_API_PORT=3010`, `VITE_MCP_PORT=3011` |
| `mcp-server-dev` | **3011** | Watch mode enabled |

```powershell
pm2 start ecosystem.dev.config.js   # start dev instance
pm2 stop  ecosystem.dev.config.js   # stop dev instance
pm2 logs  tv-backend-dev            # dev logs
```

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
| `/api/stream-sync` | `window_min`, `tolerance_min` | **Read-only** B→A·D cycle alignment diagnostics (no writes) |
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
| Stream Sync | `section-sync-diag` | `StreamSyncDiagnostics.jsx` | `streamSync_prefs` | `/api/stream-sync` |
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

## Watchdog Confidence Clock (2026-08-18)

> Governs when a coin is old enough to be judged for removal, and how long a
> flagged coin gets before a long-quiet coin is treated as truly dead. This is
> a core pillar of the ghost/prune pipeline — read this before touching
> `generateScannerFeedback()`, the Ghost Coin widget, or `coin_lifecycles`.

### Why this exists

Two incidents drove this design, both worth knowing before changing it:

1. **PUMP was whitelisted 2026-05-28 but never reached TradingView until
   2026-08-17** — a 76-day gap caused by an in-memory sync flag that didn't
   survive backend restarts (see "Watchlist Sync Reconciliation" below).
   Fixing that surfaced a second, related problem while investigating it.
2. **The "Monday-morning cliff"** — after any multi-hour/day system gap (laptop
   closed, browser tab not open), the old grace-period mechanisms (8h graduate
   grace, ~4h low-score lookback pardon) had *already silently expired* by the
   time monitoring resumed. The instant scanning restarted, a month-old coin
   could be pruned on its very first post-restart reading — no worse than a
   coin born five minutes ago, because nothing distinguished "genuinely new"
   from "old coin whose protective memory just got wiped by an outage."

### The core idea — one clock, two checkpoints

Every tracked coin has **one confidence clock**
(`coin_lifecycles.clock_start_at`), which resets to `now()` on exactly three
events:

| Reset trigger | Scope | Where it happens |
|---|---|---|
| Coin's first-ever birth | per-coin | `generateScannerFeedback()`, on INSERT |
| System-wide monitoring gap detected | **all** tracked coins at once | `_checkMonitoringGap()` |
| Ghost-queue revival (real momentum returns) | per-coin | Momentum Rescue branch |

That clock gates two checkpoints, at two different durations:

| Setting | Default | What it gates |
|---|---|---|
| **`watchdog_settle_hours`** | 12h | Below this age, a coin is **never evaluated** for pruning at all — the frozen/score/volume checks are skipped entirely, same treatment as a protected coin, just for a different reason (not enough continuous data yet). |
| **`watchdog_ghost_hours`** | 36h | **Both modes as of 2026-09-16** (previously manual-only — see "Redesign" below). Once a coin fails its settle-mark judgment, this is how long it gets to show momentum before the window closes. |
| **`watchdog_gap_tolerance_min`** | 15min | A scan gap bigger than this counts as "the system was offline" and triggers the system-wide reset above. |

All three are adjustable at runtime — see "Settings API" below. No deploy needed to change them.

### How a coin's life actually plays out

**At the settle mark (12h), first-ever judgment happens.** Both `ghost_auto_approve`
modes now share the same second stage — a `ghost_hours` (default 36h) redemption
window — and only differ in what happens when that window closes:

```
   settle_hours       Fails judgment (Frozen / Sustained Low Score / Ghost
   clears, coin       Volume) → queued in ghost_approval_queue, ghost_hours
   is judged          clock starts NOW (per-coin — this is that specific
   for the first      coin's own queued_at, not a shared global timer).
   time               Visible in the Ghost Coin widget in BOTH modes.
                              │
                              ├─ Momentum returns before ghost_hours
                              │  → immediately revived: pulled from queue,
                              │    confidence clock resets to 0, re-earns
                              │    everything from scratch ("Momentum Rescue").
                              │
                              ├─ A human clicks Approve/Prune Now in the
                              │  widget, any time, either mode
                              │  → pruned immediately. Explicit human
                              │    decision always bypasses the window.
                              │
                              └─ No momentum by the time ghost_hours expires:
                                     │
                    ┌─ Auto-approve ON ────────────────────┐
                    │  Actually REMOVED from the watchlist   │
                    │  now. No memory carried forward — next │
                    │  appearance = brand new, fresh clock.  │
                    └─────────────────────────────────────────┘
                    ┌─ Auto-approve OFF (manual) ───────────┐
                    │  Force-reset instead — NOT removed.    │
                    │  Recycled to a clean slate: pulled from │
                    │  queue, confidence clock restarts,     │
                    │  stays on the watchlist the whole time │
                    │  (manual mode still never auto-removes).│
                    └─────────────────────────────────────────┘
```

**Total time from a coin's own clock start to a possible removal, at the
defaults: 12h (settle) + 36h (ghost) = 48h** — always measured from that
individual coin's own `clock_start_at`/`queued_at`, never a shared calendar
window across coins.

**2026-09-16 redesign — why this changed.** Before this, `ghost_auto_approve`
ON skipped the ghost_hours window entirely and pruned instantly at the 12h
mark, while OFF gave a flagged coin the full 36h to redeem itself before
only ever being *recycled* (never removed). That was a real asymmetry: the
exact same 12h reading could end a coin permanently in auto mode while the
identical coin got 36h more to prove itself in manual mode, for no principled
reason. Diagnosed live 2026-09-16 while investigating "why isn't anything
getting pruned" (the actual cause that day was `_checkMonitoringGap()` firing
a system-wide clock reset from an unrelated Stream A outage — see the
zombie-record note below — but tracing it surfaced this design gap too).
Fixed by giving every flagged coin the same window regardless of mode; only
the terminal outcome (removed vs. recycled) still depends on
`ghost_auto_approve`. Practical effect: the Ghost Coin widget is no longer
silent in auto mode — a coin's 36h countdown is now visible there too, with
a live "auto-clears in Xh Ym" / "resets in Xh Ym" line per row, and the
approve/prune-now button works in both modes (prunes early instead of
waiting out the rest of the window).

### Why BTC/ETH and whitelisted coins are unaffected

`PERMANENT_MAJORS` (BTC/ETH) and `coin_whitelist` entries bypass the entire
prune-evaluation block before the settle-gate is even checked — same as
always. The confidence clock only governs coins that are subject to
evaluation in the first place.

### What this replaced — don't go looking for the old logic

Three previously-overlapping, differently-scoped grace windows were removed
in favour of the single clock above:

| Removed | Was | Superseded by |
|---|---|---|
| 8-Hour Graduate Grace Period | Any coin that graduated (STABLE/ORPHANED_STABLE_RETRY) in the last 8h was fully immune to all prune reasons | settle-gate — graduation no longer grants a separate immunity window; a graduated coin is judged on the same clock as everything else |
| ~4-Hour Low-Score Lookback Pardon | Re-scanned the last 240 `scan_results` blobs looking for any score>30 to excuse a current low reading | settle-gate — nothing is judged before 12h anyway, so there's no more need to look backward for a pardon at judgment time |
| Absolute 12h staleness cutoff on that lookback | "[PHASE 43] Offline Gap Flush" — discarded lookback data older than 12h | `_checkMonitoringGap()` — a proper gap *detector* (compares consecutive scan timestamps), not just an absolute-age cutoff |

**Not touched by this change** (still exist exactly as before):
- `isStable` (100+ scans in trailing 8h) — still gates the Ghost-Volume rule specifically. This is a *system-wide data-density* check (is the cohort average-volume baseline trustworthy), a different concern from any individual coin's confidence clock.
- Top-5 "protected altcoins" (momentary rank-based protection) — **has a known bug**: it doesn't check `freeze` status, so a frozen coin can be shielded from the Frozen-prune rule purely by momentary score rank. Diagnosed 2026-08-17, not yet fixed. Do not confuse this with the confidence-clock settle-gate — different mechanism, different bug, tracked separately.
- The browser-side orphan-recovery split (`AUTOMA_SYNC_FAILED` should restore a coin directly into `graduatedSet` without resetting its pipeline timer; `BACKEND_REJECTED` should still reset). Agreed but **not yet implemented** — requires a Tampermonkey script change, separate from everything in this section.

### Settings API

```
GET  /api/ghosts/watchdog-settings
     → { settleHours, ghostHours, gapToleranceMin }

POST /api/ghosts/watchdog-settings
     body: { settleHours?, ghostHours?, gapToleranceMin? }  (any subset)
     Clamped server-side: settleHours 0–72, ghostHours 1–336, gapToleranceMin 1–120.
```

Exposed in the Ghost Coin widget via a ⚙ button next to the Auto-Prune toggle
— three number inputs, saved on blur. Backed by `system_settings` keys
`watchdog_settle_hours`, `watchdog_ghost_hours`, `watchdog_gap_tolerance_min`.

### Schema

```sql
-- coin_lifecycles gained one column (migration in database.js, safe/idempotent):
clock_start_at TEXT   -- confidence-clock start; defaults to born_at on migration
```

No new tables. `ghost_approval_queue.queued_at` (already existed) is reused
directly for the ghost_hours expiry check — no new column needed there.

### Rollout — this feature is entirely backend

Tracing through the design confirmed the browser needs **no changes** for
this specific feature:
- Auto-approve ON: a pruned coin is simply gone — no cross-cycle memory needed, nothing for the script to track.
- Manual mode: a queued coin **never leaves the watchlist** while awaiting review, and the script already suppresses its own GATE_8/20 timer for any coin currently present in the watchlist. Nothing new for it to know.

So this shipped as a `pm2 restart tv-backend` + a client rebuild for the
widget UI — **no Tampermonkey paste required.** (The separate orphan-recovery
fix noted above does still need one, whenever it's built.)

---

## Momentum Watcher, Fresh Session & Gated Addition (2026-08-19/20)

> Three related changes shipped together because tracing the first ("why does
> the watchlist keep regrowing?") led straight into the other two. Read this
> before touching `generateScannerFeedback()`'s `master_targets` computation,
> the Fresh Session endpoints, or `coin_scanner.js`'s VETO_PRUNE block.

### 1. Momentum Watcher — replaces the blind 2h graduate-retention window

Previously, any coin that graduated (STABLE/ORPHANED_STABLE_RETRY) was force-
included in `master_targets` for a flat, unverified 2h window — no check that
it was actually *doing* anything, just that it had recently graduated.

Now graduation starts a real, resolvable trial per coin
(`coin_lifecycles.momentum_watch_started_at`), governed by
**`watchdog_momentum_hours`** (default 2h, adjustable — see Settings API
below):

- **While the window is open** — the coin is protected (`stillWatchingMomentum`
  in `generateScannerFeedback()`), same as any other protected coin.
- **Real momentum appears** (`score > 30` or `breakout === 1`) — flips
  `momentum_proven = 1` immediately, doesn't wait for the deadline.
- **At the deadline** — resolves once:
  - Proven at any point during the window → `momentum_verified = 1`,
    `momentum_watch_started_at` cleared. **Skips `settle_hours` from here on**
    — a verified coin never has to re-earn the settle window.
  - Never proven → pruned via the normal pipeline, reason `"No Momentum (Xh)"`,
    subject to `ghost_auto_approve` and VETO_PRUNE like any other prune.

Also fixed a real bug found while tracing this: the old query pulled every
distinct `(exchange, ticker)` pair ever logged, so a coin graduated under two
exchanges (observed: SNXX via both OKX and BITGET) fed both into
`master_targets` every cycle — a likely contributor to the earlier Automa
storm. The new query keys off the *latest* logged exchange only.

### 2. Fresh Session — manual, explicit, two-step "burn it down" reset

A dashboard-triggered hard reset for when accumulated history has gone bad
(spammed watchlist, stuck sync targets, etc.). **Never auto-triggered.**

**Two-step confirm in the widget** (arm → 6s window → confirm) posts
`POST /api/watchlist/fresh-session { confirm: true }`, which:
1. Deletes rows from `coin_lifecycles`, `ghost_approval_queue`,
   `area1_scout_logs`, `watchlist_sync_audit`, `watchlist_wipe_events`,
   `market_context_logs` (whitelist and settings are preserved).
2. Inserts a `fresh_session_events` row (`status: PENDING`) recording the
   expected minimal baseline (majors + whitelist).
3. Arms a one-shot flag (`system_settings.fresh_session_pending`) that the
   *next* `generateScannerFeedback()` call consumes — that response carries
   `action_required: "FRESH_SESSION"` and `master_targets` = majors +
   whitelist only, nothing else.

**Round-trip is proven, not assumed.** A POST only proves intent — it doesn't
prove Automa actually cleared the live TV watchlist. So the event stays
`AWAITING_CONFIRMATION` until a *real* subsequent watchlist snapshot
(`market_context_logs`) is compared against the expected baseline
(`_checkFreshSessionConfirmation()`): zero extras → `CONFIRMED`; still extras
after 15 min (`FRESH_SESSION_CONFIRM_TIMEOUT_MIN`) → `TIMED_OUT`. The widget
shows a live "waiting to hear back from the browser (Ns)…" state and a
capped/scrollable, newest-first log of past attempts
(`GET /api/watchlist/fresh-session-status`) — it does not just declare
success on POST.

**Browser side** (v20.10): on receiving `action_required: "FRESH_SESSION"`,
`coin_scanner.js` clears `activeMasterSet`, `pipelineRegistry`,
`graduatedSet`, `serverTargetSet` and resets `automaAttempt` — every coin's
GATE_8/GATE_20 timer restarts from zero, no half-finished cycles carry
forward. Falls through to the normal `master_targets` diff, which computes a
big removals list and fires Automa.

### 3. Gated addition — closed the real root cause of "it keeps regrowing"

Diagnosed live (2026-08-19/20) via a Fresh Session that dropped the watchlist
30→19 and then stalled, and separately via a report of "19 items on the
screener but more than that on the watchlist." Root cause, confirmed with
timestamped DB evidence:

- **Addition was completely unconditional.** `generateScannerFeedback()`'s
  per-coin loop pushed *every* coin the raw Stream A macro scan currently
  matched (`activeList`) straight into `master_targets` — the value Automa
  actually pastes into the TV watchlist — with zero gating from the FE
  8/20min pipeline, settle_hours, or momentum_hours. Those mechanisms only
  ever governed *removal* timing, never addition.
- **Fix:** `master_targets` is now built only from
  `historicalTargetSet` — coins that logged a real `STABLE`/
  `ORPHANED_STABLE_RETRY` graduation to `area1_scout_logs` via
  `/qualified-pick` (i.e., actually survived the FE 8/20min gate) and are
  still within momentum-watch or already verified — plus
  `PERMANENT_MAJORS` and whitelist pins. Raw screener matches (`activeList`)
  are kept only for the informational `active_list` response field (not
  consumed by the browser) and no longer feed `master_targets`.
- Also stopped the top-5-by-raw-score "protected altcoins" mechanism from
  force-adding itself to `master_targets` — it still protects an
  *already-graduated* coin from prune checks (`isProtected`), it just no
  longer jumps the gate for a coin that hasn't graduated yet.

**Why this matters for Fresh Session specifically:** without this fix, the
very next scan cycle after a reset would re-add anything currently matching
the raw screener, defeating the reset within minutes. With it, the watchlist
stays at majors+whitelist until a coin genuinely re-earns graduation.

### 4. Fresh Session veto mode — the other half of "why doesn't it reach baseline"

Even with gated addition fixed, Fresh Session still couldn't reach its
majors+whitelist target: `coin_scanner.js`'s **VETO_PRUNE** check (protects
any coin still visible on the live DOM screener from removal — correct for
*normal* prune cycles) was also blocking the reset's removals, so it stalled
at "whatever the screener currently shows" instead of a true clean slate.

This is now a backend-controlled setting, not a hardcoded script rule —
**`fresh_session_veto_mode`**:

| Value | Behavior |
|---|---|
| `bypass` (default) | Fresh Session force-removes everything down to majors+whitelist regardless of live screener visibility. A legitimately-active coin isn't lost — it re-earns its spot through a fresh 8/20min cycle. |
| `smart` | Fresh Session still wipes all backend history/clocks, but the browser keeps protecting a coin that's genuinely still on-screener — same behavior VETO_PRUNE already applies to normal prune cycles. |

The backend includes `veto_mode` in every response that can carry a
`FRESH_SESSION` action (both `/api/market-context` and `/qualified-pick`
response paths — the browser may receive the order via either endpoint,
whichever the script happens to call next). The script reads
`serverInfo.veto_mode` at removal-diff time instead of hardcoding the
bypass — flipping the setting takes effect on the *next* Fresh Session with
no script edit.

### Settings API

```
GET  /api/ghosts/watchdog-settings
     → { settleHours, ghostHours, gapToleranceMin, momentumHours, freshSessionVetoMode }

POST /api/ghosts/watchdog-settings
     body: { settleHours?, ghostHours?, gapToleranceMin?, momentumHours?, freshSessionVetoMode? }
     Clamped server-side: settleHours 0–72, ghostHours 1–336, gapToleranceMin 1–120,
     momentumHours 0.25–24. freshSessionVetoMode must be 'bypass' | 'smart'.

POST /api/watchlist/fresh-session
     body: { confirm: true }   (400 without it)

GET  /api/watchlist/fresh-session-status?limit=N
     → { events: [{ requestedAt, consumedAt, confirmedAt, status,
                     requestToConsumeSec, consumeToConfirmSec, totalRoundTripSec, ... }] }
```

All exposed in the Ghost Coin / Ghost Management widget: momentum hours
alongside the other watchdog number fields, Fresh Session veto mode as a
dropdown, and the Fresh Session button + scrollable round-trip log.

### Schema

```sql
-- coin_lifecycles gained (database.js, safe/idempotent):
clock_start_at             TEXT
momentum_watch_started_at  TEXT
momentum_proven            INTEGER DEFAULT 0
momentum_verified          INTEGER DEFAULT 0

-- new table:
CREATE TABLE fresh_session_events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    requested_at     TEXT NOT NULL,
    expected_targets TEXT,       -- JSON array, the majors+whitelist baseline
    consumed_at      TEXT,       -- when generateScannerFeedback() delivered FRESH_SESSION
    confirmed_at     TEXT,       -- when a real watchlist snapshot matched the baseline
    status           TEXT,       -- PENDING | AWAITING_CONFIRMATION | CONFIRMED | TIMED_OUT
    last_checked_at  TEXT,
    last_extra_count INTEGER,
    cleared_counts   TEXT        -- JSON, rows deleted per table at wipe time
);
```

### Rollout

Momentum Watcher and gated-addition are backend-only + client rebuild for the
widget (momentum hours field). Fresh Session is backend + client rebuild
(button/log/veto-mode UI), **and it does require a script change**
(`coin_scanner.js` v20.10 for the clear-and-fall-through handler, v20.13 for
veto-mode awareness) — this is the one that needs the Tampermonkey paste +
confirmation step per the workflow rule at the top of this file.

### Known open question — not yet decided

Addition is now gated by *momentum-watch membership*, but a coin still only
enters `historicalTargetSet` once it's logged a STABLE pick — i.e., once it
survives the full FE 8/20min gate. Whether *that* gate itself should also
factor in settle/ghost state (vs. today's "any coin the browser reports as
graduated gets tracked") hasn't come up as a live problem yet — flagged here
in case it does.

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

---

## Widget Performance Anti-Patterns (Learned from Sprint 1 Audit)

These were caught and fixed during widget enhancement work. Apply these rules to every widget.

### 1. React.memo bypass — inline arrow function props

`React.memo` is useless when a parent passes an **inline arrow function** as a prop — a new function reference is created on every render, so memo always sees "changed props" and re-renders.

```js
// ❌ Breaks React.memo — new reference every render
<DistRow onAlert={() => handleAlert(r)} />

// ✅ Stable reference — wrap in useCallback
const handleAlert = useCallback((ticker) => { ... }, []);
<DistRow onAlert={handleAlert} />
```

**Rule:** Any function passed as a prop to a memoised child component MUST be wrapped in `useCallback`.

### 2. Ref mutation inside useMemo — React 18 StrictMode double-invoke

React 18 StrictMode **double-invokes** the useMemo factory in development. Mutating a ref inside useMemo therefore runs twice, corrupting the ref on the second pass.

```js
// ❌ Mutates ref inside useMemo — double-invoked in StrictMode
const rows = useMemo(() => {
    signalAgeRef.current = computeAges(data);   // runs twice!
    return data.map(...);
}, [data]);

// ✅ Guard with a previous-data ref — only mutate when data actually changed
const prevDataRef = useRef(null);
const rows = useMemo(() => {
    if (data !== prevDataRef.current) {
        signalAgeRef.current = computeAges(data);
        prevDataRef.current = data;
    }
    return data.map(...);
}, [data]);
```

### 3. Collapse redundant useMemo + array passes

Multiple chained `useMemo` blocks each scanning the full coin array waste CPU every render cycle.

```js
// ❌ 3 separate useMemos, 8 array passes total
const filtered = useMemo(() => data.filter(...), [data, filter]);
const sorted   = useMemo(() => [...filtered].sort(...), [filtered, sortKey]);
const counts   = useMemo(() => filtered.reduce(...), [filtered]);

// ✅ Single useMemo, 2 passes — filter+count in one pass, sort in second
const { rows, counts } = useMemo(() => {
    let bullN = 0, bearN = 0;
    const all = (data?.coins || []).map(c => {
        if (c.signal === 'SURGING') bullN++;
        // ...
        return { ...c };
    });
    const filtered = all.filter(matchesFilter);
    const sorted   = filtered.sort(compareFn);
    return { rows: sorted, counts: { bull: bullN, bear: bearN } };
}, [data, filter, sortKey, sortDir]);
```

### 4. Sort fallthrough — missing explicit branch for every sort key

When a sort comparison returns `0` (equal), the fallthrough must go to a **stable tiebreaker**, not to a generic `else` that does string comparison. Missing a branch silently falls through to alphabetical sort.

```js
// ❌ cascadeState branch missing — falls through to alphabet sort
if (sortKey === 'dist')    return b.dist - a.dist;
else if (sortKey === 'rvol') return b.rvol - a.rvol;
else return a.ticker.localeCompare(b.ticker);  // ← cascadeState hits this!

// ✅ explicit branch for every sort key + stable tiebreaker
const CASC_ORDER = { bull: 2, neutral: 0, bear: -2 };
if (sortKey === 'dist')         return b.dist - a.dist;
if (sortKey === 'rvol')         return b.rvol - a.rvol;
if (sortKey === 'cascadeState') return (CASC_ORDER[b.cascadeState] ?? 0) - (CASC_ORDER[a.cascadeState] ?? 0);
return a.ticker.localeCompare(b.ticker);  // stable tiebreaker
```

### 5. CSS Module keyframes not accessible from inline styles

`@keyframes` defined inside a `.module.css` file get **scoped/hashed** by the CSS Modules compiler. The hashed name is inaccessible from inline `style={{ animation: 'pulse 2s infinite' }}` strings — the animation silently doesn't play.

```css
/* ❌ In Widget.module.css — hashed to something like 'pulse_abc123' */
@keyframes pulse { ... }

/* ✅ In global src/index.css — preserved as-is */
@keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.45; transform: scale(0.85); }
}
```

**Rule:** Any `@keyframes` referenced from an **inline `style` string** (e.g. on a live dot, badge, or pulsing indicator) MUST be declared in `client/src/index.css`, not in a CSS Module file.

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
pm2 restart tv-backend
```

### Rebuild frontend after client code change

```powershell
# From project root:
cd client; npm run build; cd ..
pm2 restart tv-client    # tv-client (vite preview) serves the new client/dist
```

### Port conflict (EADDRINUSE)

```powershell
# Find and kill the process holding the port, then restart cleanly
$ports = netstat -ano | Select-String "LISTENING" | Where-Object { $_ -match ":5173 |:3000 " }
foreach ($line in $ports) {
    if ($line -match "\s(\d+)$") { Stop-Process -Id ([int]$matches[1]) -Force -ErrorAction SilentlyContinue }
}
pm2 start ecosystem.config.js --only tv-backend
pm2 start ecosystem.config.js --only tv-client
```

> **PM2 orphan warning**: On Windows, rapid `pm2 restart` can leave orphan Node processes holding ports.
> If EADDRINUSE persists after restart, kill all PIDs on ports 3000 and 5173 first (see above), then do a fresh start.
> **Confirmed live 2026-09-16**: a `pm2 restart tv-backend` hit exactly this — the new process couldn't
> bind :3000, pm2 auto-respawned it in a tight loop (25 restarts in seconds), each spawn leaving another
> orphan `node.exe` still holding the port. Fix that worked: `pm2 stop tv-backend` first (halts the
> respawn loop), then find+kill the PID(s) on :3000 (`Get-NetTCPConnection -LocalPort 3000 -State Listen`
> in PowerShell), confirm the port is free, then `pm2 delete tv-backend` + `pm2 start ecosystem.config.js
> --only tv-backend` — a plain `restart` on an already-wedged process just re-triggers the same race.

### Force PM2 to pick up new env vars from ecosystem.config.js

```powershell
# pm2 restart uses cached env — must delete + re-start to reload config
pm2 delete tv-backend
pm2 start ecosystem.config.js --only tv-backend
```

### Start fresh (all processes)

```powershell
pm2 start ecosystem.config.js
pm2 save
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

Branch: `feat/widget-enhancements-v2` (from `feat/smart-alerts-stable`)
