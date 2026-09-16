// ==UserScript==
// @name         Institutional Conviction Engine - Bidirectional v20.17 (Fixed Repeat-Graduation Loop)
// @namespace    http://tampermonkey.net/
// @version      20.31
// @description  v20.31: watchlist sync fallback — confirmed live that a coin can get stuck failing to land on the real watchlist for 15h+ (BCH/ETHFI: 297 consecutive misses, 75 forced UPDATE_WATCHLIST retries via the normal clipboard-paste path, never landing) while every other historical case resolved within 1-2 cycles. The backend tracks this in watchlist_sync_audit and, past a configurable escalation count, sends serverInfo.watchlist_sync_fallback_workflow_id — a heavier Automa recovery workflow (opens a fresh tab, redoes copy+paste from scratch) instead of repeating the same failing action forever. Dispatched via the same automa:execute-workflow CustomEvent, own 5min local cooldown, workflow ID never hardcoded (backend owns it, same pattern as activate_tab_workflow_id). v20.30: backend-driven tab activation — the backend now watches how stale Stream B's actual telemetry write has gone (market_context_logs) and, past a threshold (6min, meaning sendTelemetry() has clearly been skipping itself via isTabHidden() for a while), includes activate_tab_workflow_id in its response with Automa's "Stream B make tab active" workflow ID (3lt4ZkHylt3L0uQlo05iH). processSyncPayload() dispatches whatever ID it's given via the same automa:execute-workflow CustomEvent used by Strict Screened Coin, on a local 3min cooldown to avoid re-firing every cycle. The workflow ID itself is never hardcoded in this script — the backend owns it, same pattern as strict_screened_coin's toggle. Works even while the tab is backgrounded because monitor()'s GATE_8/GATE_20 pushToBackend() calls don't check isTabHidden() (only sendTelemetry() does), so the backend can still reach this stream and tell it to wake itself up. v20.29: fixed a real race in Strict Screened Coin — checkStrictScreenedCoin() (called from sendTelemetry()) used to query the filter-pill DOM itself, BEFORE sendTelemetry() had called ensureWatchlistPanelOpen() to switch to the right panel, so it could misread a genuinely-applied filter as "missing" purely because the wrong panel was showing at that instant. Confirmed live 2026-09-02: Stream B went completely silent ~7-9min after a fresh v20.28 reload — exactly matching 3 false-positive retries at the 3min cooldown before STRICT_SCREEN_GAVE_UP permanently stopped both Automa triggering and telemetry sends. Now monitor() (which always has the panel confirmed open before it checks) is the single source of truth — it caches its DOM reading (lastKnownScreenerFilterActive) and checkStrictScreenedCoin() consumes that instead of re-querying blind. Self-healing: once the cached reading correctly reads true, the retry counter resets automatically on the next check, no manual reset needed even if a prior GAVE_UP already happened. v20.28: monitor() (the coin-intake loop, runs on its own SCAN_MS interval independent of sendTelemetry()) now also refuses to start a new pipeline/qualification clock for any coin scraped while Strict Screened Coin's filter pill isn't confirmed active — previously only sendTelemetry() was gated, so monitor() kept BIRTHing every row of the raw unfiltered screener (confirmed live 2026-09-03: 55+ symbols including cross-exchange UNIUSDT duplicates and non-target rows like SOXLUSDT/USELESSUSDT all started 8/20min qualification clocks simultaneously), later hammering the backend with a burst of GATE_8/GATE_20 pushes once the filter issue had already self-corrected. Existing already-tracked coins still advance normally so nothing is wrongly ghosted mid-correction; the screener snapshot cache used for telemetry/volume-ranking is also skipped while unconfirmed, so it never captures the wrong universe. v20.27: screener snap capture (lastScreenerSnap) now correctly parses TradingView's K/M/B magnitude suffixes (e.g. "570.07M" on a Vol in USD 24h column) into real numbers — previously fell through to raw text, unusable for ranking. Column detection was already header-name-based (data-field attribute), not hardcoded position, so a newly added column like Vol in USD 24h is captured automatically with zero code change beyond this parsing fix. v20.26: an automatic UPDATE_WATCHLIST/RESET_WATCHLIST cooldown-bypass is now only honored while Stream A is actively ingesting data (backend-reported stream_a_fresh, ~15min threshold) — confirmed live (2026-09-02) that a forced Automa push kept firing for master_targets containing old non-crypto garbage regardless of whether Stream A's tab was even running. FRESH_SESSION (manual, dashboard-triggered) is unaffected — never gated by Stream A's state. Normal cooldown-respecting updates are completely untouched either way. v20.25: Strict Screened Coin's workflow ID and all its tunables (max retries, cooldown, settle window) moved into the main CONFIG object at the top of the script — one place to edit instead of buried consts. Confirmed working via manual console test (2026-09-01). v20.24: Strict Screened Coin no longer reloads the page — dispatches Automa's documented CustomEvent ('automa:execute-workflow', workflow id GNRPpM5H6q7VmXjxjlOQC) to trigger a re-select workflow instead, per https://www.goautoma.com/extension/docs/blocks/trigger.html. Same bounded-retry/cooldown scaffolding, just swaps the recovery action. v20.23: Strict Screened Coin now waits 45s after page load before its first check (was: evaluated immediately, which could misread a not-yet-rendered/not-yet-Automa-reselected page as a real failure and burn a retry on nothing). v20.22: Strict Screened Coin now defaults ON (was off) and cooldown between reload attempts is 3min (was 5min) — before each telemetry capture, verifies the watchlist's "screened" filter pill is actually applied in the DOM; if missing, reloads the same tab in place (max 3 attempts, 3min gap between each) instead of silently sending an unfiltered/wrong universe of symbols. v20.20: fireAutoma() now re-asserts the correct ticker-list clipboard value every 2s for 90s after firing (was: written once, then hoped nothing touched it) — closes the actual race that let Automa's own workflow-editor JSON (copied while editing a block) win the clipboard and get pasted into "Add symbol" as junk rows. Stops early the moment verification confirms success. v20.19: updateArea2Watchlist() now rejects non-ticker garbage (JSON/long strings) before adding it to area2WatchlistSet — confirmed live (2026-09-01) that a clipboard collision got pasted into "Add symbol" and landed as literal junk rows on the real watchlist; without this guard, the script would then try to manage that JSON blob as if it were a ticker (diff/removal logic, telemetry payload). v20.18: refresh-click now logs which path found the button (confirmed #js-screener-container vs fallback) every cycle, so the console shows proof it's using the manually-verified selector, not silently falling back. v20.17: updateArea2Watchlist() no longer wipes area2WatchlistSet/watchlistBaseSet on a transient empty read (container present but 0 rows, e.g. mid-render right after a panel-tab switch) — confirmed via DB audit that this was letting coins already on the real watchlist look "missing" for up to a full TELEMETRY cycle, causing them to be wrongly re-adopted into the GATE_8/20 pipeline and re-graduate as STABLE every ~40min with no real screener change, driving needless master_targets diffs / Automa re-syncs. Now only clears+rebuilds on a genuinely non-empty read; an empty read keeps the last-known-good set. v20.16: refresh-button lookup now searches #js-screener-container first (confirmed via user DOM inspection as the button's actual parent), instead of relying on the watchlist-panel/document fallback to find it every time. v20.15: Telemetry cadence matched to Stream D (5min -> 2min). Refresh-click now uses the confirmed selector [data-qa-id="screener-refresh-button"] (was a best-effort guess in v20.14), waits the full 35s settle + re-checks visibility before capturing. Compact title heartbeat now shows coin count, +added/-removed vs the last cycle, and countdown — tuned for the tab strip's tiny width. v20.14: Confirmed live (2026-08-21) that sendTelemetry() kept punching identical price/change_pct for 25-30+ min while backgrounded — same silent-stale-data pattern as Stream D. Added: skip-when-hidden guard on sendTelemetry(), a visibilitychange catch-up call, a best-effort click of TradingView's own refresh control before reading the watchlist (their UI can independently pause its update loop while hidden), and a document.title heartbeat clock so a stuck tab is visible from the taskbar without opening the dashboard. v20.13: FRESH_SESSION removals now bypass VETO_PRUNE — previously any coin still visible on the live screener at reset time was protected from removal by the same veto that guards normal operation, so a hard reset could never actually reach the majors+whitelist baseline; it just stalled at "whatever the screener currently shows". A reset now forces removal regardless, and a legitimately-active coin simply re-earns its spot through a fresh 8/20min cycle. v20.12: clipboard re-assert (added in v20.11) is now scoped to RETRY attempts only (automaAttempt > 0) — refreshing on every 10s poll during the routine, usually-successful FIRST attempt meant hijacking the user's system clipboard constantly, interfering with their own parallel copy/paste work. Now it only kicks in once Automa has already failed once and we're actively retrying — a rare, already-degraded case where the protection is worth the tradeoff. v20.10: FRESH_SESSION signal — manual dashboard-triggered reset to majors + whitelist. v20.9: master_targets diff checks the live screener before honoring any removal. v20.8: closes the previous Automa tab before opening a new one; hard minimum interval between any two fires. v20.7: post-Automa verification, WIPE/PARTIAL_ADD detection + retry. v20.6: REFRESH_WATCHLIST signal. v20.5: screener snap cached by monitor(), absolute-index column mapping. v20.4: full-format diff, cross-exchange guard, always-fresh telemetry.
// @author       Gemini_Thought_Partner
// @match        *://*.tradingview.com/cex-screener/RDpx2vs9/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    // Self-reported version, sent with every TELEMETRY payload — lets the
    // backend tell us if the browser is actually running what we think it's
    // running. Bump this any time @version above changes.
    const SCRIPT_VERSION = '20.31';

    const CONFIG = {
        SCAN_MS: 60000,
        GATE_8: 8,
        GATE_20: 20,
        GHOST_GRACE_MINUTES: 15,
        GRADUATION_LOCK_MINUTES: 30,
        AUTOMA_COOLDOWN_MINUTES: 15,
        // ── v20.7: Automa verification ──────────────────────────────────────
        // Automa's watchlist update is DESTRUCTIVE and NON-ATOMIC: it clears the
        // TradingView watchlist, then types the new comma-separated list. When the
        // second half fails (observed: the Enter keystroke doesn't land) the
        // watchlist is left EMPTY and the engine goes blind. Historical evidence:
        // 24/24 zero-count runs began from a populated watchlist, including one
        // 33 -> 0 -> 15 partial add and a 179-minute blackout.
        // We cannot make Automa atomic, so instead we CHECK ITS WORK and retry.
        // Timing note: Automa does NOT start until the opened tab has fully loaded,
        // then works like a human — locating each DOM node, pausing, clicking. A
        // clear + re-add of a large list therefore takes far longer than a single
        // fixed delay can predict. So we do not check once; we POLL, starting only
        // after the tab has had time to load and Automa to boot, and we keep waiting
        // while it is plainly mid-run (the watchlist is EMPTY between the clear and
        // the add — checking during that gap would false-alarm a wipe).
        AUTOMA_VERIFY_START_MS: 45000,   // don't even look before this (page load + Automa boot)
        AUTOMA_VERIFY_POLL_MS: 10000,    // re-check cadence once we start looking
        AUTOMA_VERIFY_MAX_MS: 240000,    // ceiling; +1s per coin is added on top
        AUTOMA_MAX_RETRIES: 3,           // give up after this many, let backend take over
        AUTOMA_PARTIAL_RATIO: 0.7,       // <70% of expected coins = partial-add failure
        // v20.8: hard floor between ANY two fireAutoma() calls, regardless of
        // trigger source. isForcedUpdate correctly bypasses the 15-min Automa
        // cooldown so a real fix reaches TV fast — but it was bypassing it with
        // NO floor at all. Observed: a busy ticker's normal pipeline activity
        // (qualified-pick every 10-30s) combined with a stuck wipe (action_required
        // staying UPDATE_WATCHLIST) fired Automa every 10-28 seconds for minutes —
        // never letting one run finish before the next interrupted it. That is very
        // likely the actual cause of repeating "element-not-found": Automa was
        // always mid-load in a brand-new tab when the next fire hit it.
        AUTOMA_MIN_REFIRE_MS: 60000,
        // Guard against the v20.6 REFRESH_WATCHLIST feedback loop: that handler
        // calls sendTelemetry(), whose response can request another refresh —
        // unbounded recursion (observed: 74 empty snapshots in 13 minutes).
        REFRESH_MIN_INTERVAL_MS: 60000,
        // ── Strict Screened Coin (v20.21+) ───────────────────────────────────
        // Automa workflow that re-selects/reapplies the screened watchlist
        // filter, triggered via its documented CustomEvent API — no page
        // reload. Manually confirmed working (2026-09-01, browser console
        // test). To point this at a different workflow, edit
        // STRICT_SCREEN_AUTOMA_WORKFLOW_ID below — find the ID in Automa's
        // dashboard (workflow settings / URL). See:
        // https://www.goautoma.com/extension/docs/blocks/trigger.html
        STRICT_SCREEN_AUTOMA_WORKFLOW_ID: 'GNRPpM5H6q7VmXjxjlOQC',
        STRICT_SCREEN_MAX_RETRIES: 3,          // give up after this many consecutive failures
        STRICT_SCREEN_COOLDOWN_MS: 3 * 60 * 1000,   // after triggering the workflow, give it time to actually reapply the filter before trying again
        STRICT_SCREEN_INITIAL_SETTLE_MS: 45000,     // don't evaluate the check until this long after page load
        // v20.30: backend-driven tab-activation. The backend decides (based on
        // how stale Stream B's telemetry has gone) whether THIS tab needs to be
        // brought to front, and tells us via serverInfo.activate_tab_workflow_id
        // on any response — it owns the workflow ID (3lt4ZkHylt3L0uQlo05iH,
        // Automa's "stream B make tab active" workflow), the script just
        // dispatches whatever ID it's given. Cooldown here is purely local
        // spam-prevention — the backend's own staleness threshold is the real
        // gate on how often it will ever send this in the first place.
        TAB_ACTIVATE_COOLDOWN_MS: 3 * 60 * 1000,
        // v20.31: watchlist sync fallback cooldown — local spam-prevention
        // only, same reasoning as TAB_ACTIVATE_COOLDOWN_MS above. The
        // backend's own escalation-threshold + cooldown (watchdog settings)
        // is the real gate on how often it sends this.
        WATCHLIST_SYNC_FALLBACK_COOLDOWN_MS: 5 * 60 * 1000,
        BACKEND_URL: "http://localhost:3000/qualified-pick",
        FIELDS: {
            SYMBOL: "TickerUniversal",
            RATING: "TechnicalRating|TimeResolution1D",
            PRICE: "Price"
        }
    };

    const TELEMETRY = {
        POLL_MS: 300000, // 5min — reverted from 2min to keep refresh-clicking gentler on TradingView's UI
        URL: "http://localhost:3000/api/market-context",
        // Confirmed selector (2026-08-22) for TradingView's own manual refresh
        // control — same one used by the Stream D script. Forces TradingView
        // to pull fresh data itself before we read the DOM.
        REFRESH_BUTTON_SELECTOR: '[data-qa-id="screener-refresh-button"]',
        REFRESH_SETTLE_MS: 35000,
    };

    const activeMasterSet = new Set();
    const serverTargetSet = new Set();
    const pipelineRegistry = new Map();
    const graduatedSet = new Map();
    let area2WatchlistSet = new Set();  // full format: EXCHANGE:TICKER.P
    let watchlistBaseSet  = new Set();  // base only: TICKER.P — for cross-exchange duplicate guard
    let watchlistSnapshot = [];
    // Screener snap cached by monitor() while the screener panel is visible.
    // sendTelemetry() opens the watchlist panel (switching away from the screener tab),
    // which removes screener rows from the DOM before it can read them. Using this
    // cache ensures the last-known screener state is always included in telemetry.
    let lastScreenerSnap  = [];
    let colMap = {};

    // ── v20.7 Automa verification state ─────────────────────────────────────
    let automaVerifyTimer   = null;  // pending verification poll
    let automaRetryTimer    = null;  // pending re-push after a failed verification
    let automaAttempt       = 0;     // consecutive failed pushes for the current target set
    let automaExpectedList  = [];    // what we last asked Automa to install
    let lastRefreshAt       = 0;     // REFRESH_WATCHLIST recursion guard
    // v20.8: handle of the tab opened by the LAST fireAutoma() call. GM_openInTab
    // never closed prior tabs — every retry (script-side backoff AND backend-driven
    // UPDATE_WATCHLIST arriving mid-retry) opened ANOTHER tab, none of which were
    // ever cleaned up. Observed: 6+ tabs accumulated during one unresolved wipe.
    // Worse than clutter — GM_setClipboard is a single shared resource, so two
    // overlapping Automa runs can race and paste the wrong/partial list into each
    // other's run, which can itself be the reason a wipe never resolves.
    let automaTabHandle     = null;
    // v20.20: repeating re-assert guard — see fireAutoma() for why this exists.
    let automaClipboardGuardTimer = null;

    // ── v20.21: Strict Screened Coin ─────────────────────────────────────────
    // Backend-controlled (dashboard toggle, off by default). When on, verifies
    // the watchlist's "screened" filter pill is actually applied in the DOM
    // before trusting a telemetry cycle — without it, the watchlist may be
    // showing TradingView's full unfiltered universe instead of your curated
    // screened set (confirmed live 2026-09-01: QuickList showed 47 symbols
    // including non-crypto assets like TSLAUSDT/SILVERUS when the screener's
    // filter chips weren't engaged, vs. 3 symbols with them applied).
    let strictScreenedCoinEnabled = true; // matches the backend's default (system_settings 'strict_screened_coin'); overwritten by every server response regardless
    const STRICT_SCREEN_SELECTOR = 'div[class*="watchlistWrapper"] button[data-qa-id="ui-lib-pill-active-area-button"]+button[class*="hasClickListener"]';
    const strictScreenPageLoadedAt = Date.now();
    // v20.29: last DOM reading of the filter pill, written ONLY by monitor()
    // (see below) — the one place that has already called
    // ensureWatchlistPanelOpen() and therefore has a guaranteed-correct panel
    // state before querying STRICT_SCREEN_SELECTOR. checkStrictScreenedCoin()
    // (called from sendTelemetry(), on an independent interval) used to query
    // the same selector itself BEFORE sendTelemetry() had opened the watchlist
    // panel — a real race that could read "missing" while the correct panel
    // simply wasn't showing yet, burning all 3 retries on false positives and
    // permanently giving up (confirmed live 2026-09-02: Stream B went silent
    // ~7-9min after a fresh reload, matching exactly 3 retries at the 3min
    // cooldown). Fail-open (true) until monitor() has run at least once.
    let lastKnownScreenerFilterActive = true;

    /**
     * v20.28: pure/read-only status check — no side effects, no logging, no
     * Automa dispatch. Used by monitor() (which runs on its own SCAN_MS
     * interval, independent of sendTelemetry()'s cadence) to decide whether
     * this cycle's screener rows represent the real curated set or TradingView's
     * unfiltered universe. Kept separate from checkStrictScreenedCoin() so
     * monitor()'s much more frequent polling doesn't spam retry counters or
     * fire Automa multiple times per escalation window — that side-effecting
     * logic stays solely on sendTelemetry()'s cadence, below.
     */
    function isScreenerFilterConfirmedActive() {
        if (!strictScreenedCoinEnabled) return true;
        const sinceLoad = Date.now() - strictScreenPageLoadedAt;
        if (sinceLoad < CONFIG.STRICT_SCREEN_INITIAL_SETTLE_MS) return true; // fail open during settle window
        // v20.29: only monitor() calls this, and only after ensureWatchlistPanelOpen()
        // has already run this cycle — so this is the one reliable DOM read.
        // Cache it for checkStrictScreenedCoin() (sendTelemetry's cadence) to
        // consume instead of re-querying blind.
        const filterActive = !!document.querySelector(STRICT_SCREEN_SELECTOR);
        lastKnownScreenerFilterActive = filterActive;
        return filterActive;
    }

    /**
     * Returns true if it's safe to proceed with this telemetry cycle. If the
     * feature is off, or the filter pill is present, returns true immediately.
     * If the pill is missing, triggers the Automa re-select workflow (bounded
     * retries, with a cooldown so we don't fire it in a tight loop) or — once
     * retries are exhausted — just warns and blocks the send.
     */
    function checkStrictScreenedCoin() {
        if (!strictScreenedCoinEnabled) return true;

        const sinceLoad = Date.now() - strictScreenPageLoadedAt;
        if (sinceLoad < CONFIG.STRICT_SCREEN_INITIAL_SETTLE_MS) {
            auditLog("STRICT_SCREEN_SETTLING", null,
                `Page loaded ${Math.round(sinceLoad / 1000)}s ago — waiting for ${CONFIG.STRICT_SCREEN_INITIAL_SETTLE_MS / 1000}s settle window before checking the filter.`,
                "BUFFER");
            return true; // don't gate telemetry on an unsettled page — just skip the check this cycle
        }

        // v20.29: read monitor()'s cached DOM reading instead of querying here —
        // sendTelemetry() can run this check before it has switched panels
        // itself (ensureWatchlistPanelOpen() happens further down in
        // sendTelemetry()), which used to misread a real filter as "missing"
        // just because the wrong panel was showing at that instant. monitor()
        // always queries with the panel confirmed open, so its reading is the
        // one to trust.
        const filterActive = lastKnownScreenerFilterActive;
        if (filterActive) {
            if (GM_getValue('strictScreen_retryCount', 0) !== 0) {
                GM_setValue('strictScreen_retryCount', 0);
                auditLog("STRICT_SCREEN_RECOVERED", null, "Screened-coin filter pill is back — retry counter reset.", "QUALIFIED");
            }
            return true;
        }

        const count = GM_getValue('strictScreen_retryCount', 0);
        const lastTriggerAt = GM_getValue('strictScreen_lastTriggerAt', 0);

        auditLog("STRICT_SCREEN_MISSING", null,
            `Screened-coin filter pill not found in watchlist DOM — telemetry would be unscreened. Retry ${count}/${CONFIG.STRICT_SCREEN_MAX_RETRIES}.`,
            "ORPHAN");

        if (count >= CONFIG.STRICT_SCREEN_MAX_RETRIES) {
            auditLog("STRICT_SCREEN_GAVE_UP", null,
                `Filter still missing after ${CONFIG.STRICT_SCREEN_MAX_RETRIES} Automa workflow triggers — giving up to avoid a trigger loop. Check the screener manually.`,
                "ORPHAN");
            return false;
        }

        if (Date.now() - lastTriggerAt < CONFIG.STRICT_SCREEN_COOLDOWN_MS) {
            // Already triggered recently — give the workflow time to land before trying again.
            return false;
        }

        GM_setValue('strictScreen_retryCount', count + 1);
        GM_setValue('strictScreen_lastTriggerAt', Date.now());
        auditLog("STRICT_SCREEN_AUTOMA_TRIGGER", null,
            `Dispatching Automa re-select workflow (attempt ${count + 1}/${CONFIG.STRICT_SCREEN_MAX_RETRIES}) — no page reload.`,
            "SYSTEM");
        window.dispatchEvent(new CustomEvent('automa:execute-workflow', {
            detail: { id: CONFIG.STRICT_SCREEN_AUTOMA_WORKFLOW_ID }
        }));
        return false;
    }

    // =========================================================================
    // 🗂️ PRECISION AUDIT LOGGER
    // =========================================================================
    const LOG_STYLES = {
        PIPELINE: "color: #ff9800; font-weight: bold;",
        QUALIFIED: "background: #27ae60; color: white; padding: 2px 5px; font-weight: bold;",
        SYNC: "background: #673ab7; color: white; padding: 2px 5px; font-weight: bold; border-left: 4px solid #fff;",
        PRUNE: "color: #f44336; font-weight: bold;",
        BUFFER: "color: #00bcd4; font-weight: bold; font-style: italic;",
        ORPHAN: "background: #ff5722; color: white; padding: 2px 5px; font-weight: bold; border-radius: 3px;",
        SYSTEM: "color: #9e9e9e;"
    };

    function auditLog(category, ticker, message, styleKey) {
        const now = new Date();
        const ts = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const tickerStr = ticker ? `[${ticker}]` : '[SYSTEM]';
        console.log(`%c[${ts}] ${tickerStr} ${category}: ${message}`, LOG_STYLES[styleKey] || LOG_STYLES.SYSTEM);
    }

    // =========================================================================

    function mapHeaders() {
        // Iterate ALL th elements so `i` is the true absolute column index,
        // matching the td index in each row. Using `th[data-field]` only would
        // give a filtered index that breaks if any header column lacks data-field.
        document.querySelectorAll('thead th').forEach((th, i) => {
            const field = th.getAttribute('data-field');
            if (!field) return;
            for (let k in CONFIG.FIELDS) if (field === CONFIG.FIELDS[k]) colMap[k] = i;
        });
    }

    function saveState() {
        if (typeof GM_setValue === "undefined") return;
        const registryData = Array.from(pipelineRegistry.entries()).map(([k, v]) => [k, { ...v }]);
        const state = {
            registry: registryData,
            graduates: Array.from(graduatedSet.entries()),
            activeSet: Array.from(activeMasterSet),
            lastAutomaTriggerMs: window.lastAutomaTriggerMs || 0
        };
        GM_setValue("tv_scout_engine_state", JSON.stringify(state));
    }

    function loadState() {
        try {
            if (typeof GM_getValue === "undefined") return;
            const saved = GM_getValue("tv_scout_engine_state");
            if (!saved) return;
            const state = JSON.parse(saved);
            const now = Date.now();
            const MAX_STALE_MS = 15 * 60 * 1000;

            if (state.lastAutomaTriggerMs) window.lastAutomaTriggerMs = state.lastAutomaTriggerMs;

            if (state.graduates) {
                state.graduates.forEach(([key, data]) => {
                    const gradObj = typeof data === 'number' ? { ts: data, verified: true, ticker: key.split(':')[1] || 'UNKNOWN', exchange: '' } : data;
                    if (now - gradObj.ts < (CONFIG.GRADUATION_LOCK_MINUTES * 60 * 1000)) {
                        graduatedSet.set(key, gradObj);
                    }
                });
            }

            if (state.registry) {
                state.registry.forEach(([key, node]) => {
                    const isRecent = (now - node.bornAt < MAX_STALE_MS);
                    if (isRecent) {
                        pipelineRegistry.set(key, node);
                        if (state.activeSet && state.activeSet.includes(key)) activeMasterSet.add(key);
                    }
                });
            }
            auditLog("STATE_HYDRATED", null, `Loaded ${activeMasterSet.size} Active, ${graduatedSet.size} Locked`, "SYSTEM");
        } catch (e) {
            console.warn("[SYSTEM] Failed to load state:", e);
        }
    }

    function getMarketSnapshot() {
        return Array.from(document.querySelectorAll('tbody tr[data-rowkey]')).map(row => row.getAttribute('data-rowkey'));
    }

    function pushToBackend(payload) {
        payload.market_snapshot = getMarketSnapshot();
        payload.total_market_count = payload.market_snapshot.length;

        GM_xmlhttpRequest({
            method: "POST",
            url: CONFIG.BACKEND_URL,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(payload),
            onload: function (response) {
                if (response.status === 200) {
                    processSyncPayload(JSON.parse(response.responseText), payload.ticker);
                }
            }
        });
    }

    // =========================================================================
    // 🚑 v20.7 — AUTOMA PUSH + VERIFICATION
    // =========================================================================
    // Single entry point for triggering Automa. Every push now schedules a
    // verification pass so a silent failure can never go unnoticed again.

    function fireAutoma(targets, note) {
        if (!Array.isArray(targets) || targets.length === 0) {
            auditLog("AUTOMA_SKIPPED", null, "Refusing to push an EMPTY target list (would wipe the watchlist).", "PRUNE");
            return;
        }
        // v20.8: hard floor — refuse to fire again before the last run has had a
        // real chance to complete, no matter which caller is asking. isForcedUpdate
        // bypasses the NORMAL 15-min cooldown by design, but that must never mean
        // "no floor at all" — a storm of independent triggers (e.g. a busy ticker's
        // pipeline events arriving every few seconds while action_required stays
        // hot) was re-launching Automa every 10-28s, so it never finished a single
        // run before being interrupted by the next.
        const sinceLastFireMs = window.lastAutomaTriggerMs ? Date.now() - window.lastAutomaTriggerMs : Infinity;
        if (sinceLastFireMs < CONFIG.AUTOMA_MIN_REFIRE_MS) {
            auditLog(
                "AUTOMA_THROTTLED",
                null,
                `Suppressed re-fire — last Automa launch was ${(sinceLastFireMs / 1000).toFixed(0)}s ago, ` +
                `floor is ${CONFIG.AUTOMA_MIN_REFIRE_MS / 1000}s. Letting the in-flight run breathe.`,
                "BUFFER"
            );
            return;
        }
        // Cancel any queued retry. The backend can issue an UPDATE_WATCHLIST while
        // a script-side retry is still counting down; without this, two Automa tabs
        // fire moments apart and their clear/add sequences interleave — which can
        // produce exactly the wipe we're trying to prevent.
        if (automaRetryTimer)  { clearTimeout(automaRetryTimer);  automaRetryTimer  = null; }
        if (automaVerifyTimer) { clearTimeout(automaVerifyTimer); automaVerifyTimer = null; }
        if (automaClipboardGuardTimer) { clearInterval(automaClipboardGuardTimer); automaClipboardGuardTimer = null; }

        // v20.8: close the PREVIOUS Automa tab (if it's still open) before opening
        // a new one. Cancelling the JS timers above stops US from re-checking a
        // stale run, but it never closed the actual browser tab — Automa could
        // still be mid-run in it, racing the new tab we're about to open on the
        // same shared clipboard.
        if (automaTabHandle && !automaTabHandle.closed) {
            try { automaTabHandle.close(); auditLog("AUTOMA_TAB_CLOSED", null, "Closed previous Automa tab before firing a new one.", "SYSTEM"); }
            catch (e) { /* tab may already be gone — non-fatal */ }
        }

        const clipboardText = targets.join(',');
        GM_setClipboard(clipboardText);
        auditLog("AUTOMA_TRIGGERED", null, `Copied ${targets.length} coins. Firing new tab.${note || ''}`, "SYNC");
        automaTabHandle = GM_openInTab("https://www.tradingview.com/cex-screener/lEINSjG1/", { active: false, insert: true, setParent: true });

        window.lastAutomaTriggerMs = Date.now();
        automaExpectedList = targets.slice();
        saveState();

        // v20.20: confirmed live (2026-09-01) — GM_setClipboard writes the REAL
        // system clipboard, a single shared resource. Automa doesn't paste the
        // instant we open its tab; it has to load the page and boot first, and
        // that gap (observed: tens of seconds) is a window where ANYTHING else
        // touching the clipboard silently wins — including the user copying a
        // block while editing the Automa flow itself, which is exactly what put
        // Automa's own workflow-editor JSON on the clipboard and got it pasted
        // into "Add symbol" as junk watchlist rows. A single write-and-hope can't
        // defend against that. Instead, keep re-asserting the correct value every
        // 2s for the duration Automa needs it — if something else grabs the
        // clipboard mid-window, this restores the right value within ~2s instead
        // of leaving it corrupted for the whole run. Capped at 90s (comfortably
        // past AUTOMA_VERIFY_START_MS's 45s typical boot time) so it doesn't
        // fight the user's own copy/paste indefinitely.
        const guardDeadline = Date.now() + 90000;
        automaClipboardGuardTimer = setInterval(() => {
            if (Date.now() > guardDeadline) {
                clearInterval(automaClipboardGuardTimer);
                automaClipboardGuardTimer = null;
                return;
            }
            GM_setClipboard(clipboardText);
        }, 2000);

        scheduleAutomaVerify();
    }

    // TradingView may render a watchlist row with or without the exchange prefix
    // ("BINANCE:BTCUSDT.P" vs "BTCUSDT.P"), and master_targets is always fully
    // qualified. Comparing raw strings would report every coin as missing, so all
    // comparisons run on the BASE symbol. Counting rows instead would be worse
    // still — 30 rows of the WRONG coins would pass a count check.
    function _baseSymbol(full) {
        if (!full) return '';
        const s = String(full).trim();
        return (s.includes(':') ? s.split(':')[1] : s).toUpperCase();
    }

    /** Compare the live watchlist against what we asked Automa to install. */
    function _automaMatchState() {
        updateArea2Watchlist();
        const expectedBases = new Set(automaExpectedList.map(_baseSymbol).filter(Boolean));
        // watchlistBaseSet is populated by updateArea2Watchlist() and is already
        // exchange-stripped; fall back to deriving it if it's somehow empty.
        const actualBases = watchlistBaseSet.size
            ? new Set(Array.from(watchlistBaseSet).map(b => String(b).toUpperCase()))
            : new Set(Array.from(area2WatchlistSet).map(_baseSymbol));

        const missing = Array.from(expectedBases).filter(b => !actualBases.has(b));
        const matched = expectedBases.size - missing.length;
        return {
            expected: expectedBases.size,
            present:  actualBases.size,
            matched,
            missing,
            ratio: expectedBases.size ? matched / expectedBases.size : 1,
        };
    }

    function scheduleAutomaVerify() {
        if (automaVerifyTimer) clearTimeout(automaVerifyTimer);
        // Extra headroom per coin — Automa clicks through the list at human pace.
        const budgetMs = CONFIG.AUTOMA_VERIFY_MAX_MS + automaExpectedList.length * 1000;
        const deadline = Date.now() + budgetMs;
        auditLog(
            "AUTOMA_VERIFY",
            null,
            `Verification starts in ${CONFIG.AUTOMA_VERIFY_START_MS / 1000}s, then every ` +
            `${CONFIG.AUTOMA_VERIFY_POLL_MS / 1000}s (budget ${(budgetMs / 1000).toFixed(0)}s for ` +
            `${automaExpectedList.length} coins).`,
            "BUFFER"
        );
        automaVerifyTimer = setTimeout(() => pollAutomaResult(deadline), CONFIG.AUTOMA_VERIFY_START_MS);
    }

    /**
     * Poll rather than single-shot check. Automa is mid-run for an unpredictable
     * span and the watchlist is legitimately EMPTY between its clear and its add,
     * so we keep waiting until the list looks right or the budget is exhausted.
     */
    async function pollAutomaResult(deadline) {
        automaVerifyTimer = null;
        if (automaExpectedList.length === 0) return;

        // v20.11 (revised): GM_setClipboard writes the REAL system clipboard,
        // not an isolated one — anything else copying text in the gap between
        // our copy and Automa's actual paste can silently clobber it. BUT the
        // fresh/first attempt is the common, usually-successful case, and
        // refreshing on every 10s poll during it means hijacking the user's
        // clipboard constantly even when nothing is wrong — real interference
        // with their own copy/paste work running in parallel. So this ONLY
        // re-asserts once we're already in a RETRY (automaAttempt > 0) — a
        // rare, already-degraded situation where the extra protection is
        // worth it, not the routine case.
        if (automaAttempt > 0) {
            GM_setClipboard(automaExpectedList.join(','));
        }

        await ensureWatchlistPanelOpen();
        const st = _automaMatchState();

        // ── SUCCESS — stop early, no need to burn the whole budget ───────────
        if (st.ratio >= CONFIG.AUTOMA_PARTIAL_RATIO) {
            if (automaAttempt > 0) {
                auditLog("AUTOMA_RECOVERED", null, `Watchlist restored: ${st.matched}/${st.expected} coins after ${automaAttempt} retry(s).`, "QUALIFIED");
            } else {
                auditLog("AUTOMA_VERIFIED", null, `Watchlist OK: ${st.matched}/${st.expected} coins present.`, "SYSTEM");
            }
            automaAttempt = 0;
            // Confirmed success — stop the clipboard re-assert guard immediately,
            // no need to keep hijacking the user's clipboard for the rest of its window.
            if (automaClipboardGuardTimer) { clearInterval(automaClipboardGuardTimer); automaClipboardGuardTimer = null; }
            return;
        }

        // ── STILL WORKING — keep waiting while budget remains ────────────────
        if (Date.now() < deadline) {
            const leftS = ((deadline - Date.now()) / 1000).toFixed(0);
            auditLog(
                "AUTOMA_WAITING",
                null,
                `${st.matched}/${st.expected} present` +
                (st.present === 0 ? ' (watchlist empty — Automa likely between clear and add)' : '') +
                `. Re-checking in ${CONFIG.AUTOMA_VERIFY_POLL_MS / 1000}s, ${leftS}s budget left.`,
                "BUFFER"
            );
            automaVerifyTimer = setTimeout(() => pollAutomaResult(deadline), CONFIG.AUTOMA_VERIFY_POLL_MS);
            return;
        }

        // ── FAILURE — budget exhausted ───────────────────────────────────────
        const mode = st.present === 0 ? "WIPE" : "PARTIAL_ADD";
        automaAttempt++;
        auditLog(
            `AUTOMA_${mode}`,
            null,
            `Expected ${st.expected} coins, matched ${st.matched} (watchlist holds ${st.present}). ` +
            `Missing: [${st.missing.slice(0, 10).join(', ')}${st.missing.length > 10 ? '…' : ''}]. ` +
            `Attempt ${automaAttempt}/${CONFIG.AUTOMA_MAX_RETRIES}.`,
            "ORPHAN"
        );

        if (automaAttempt < CONFIG.AUTOMA_MAX_RETRIES) {
            const backoff = CONFIG.AUTOMA_VERIFY_POLL_MS * automaAttempt;
            auditLog("AUTOMA_RETRY", null, `Re-pushing ${automaExpectedList.length} coins in ${backoff / 1000}s.`, "BUFFER");
            const attemptNo = automaAttempt;
            automaRetryTimer = setTimeout(() => {
                automaRetryTimer = null;
                // fireAutoma() resets the counter for backend-driven pushes, so
                // restore it here — this is a continuation of the same failure run.
                const carried = attemptNo;
                fireAutoma(automaExpectedList, ` [RETRY ${attemptNo}]`);
                automaAttempt = carried;
            }, backoff);
        } else {
            // Out of retries. Tell the backend the truth NOW rather than waiting
            // for the next 5-min poll — its wipe-guard takes over from here.
            auditLog("AUTOMA_GAVE_UP", null, `Automa failed ${automaAttempt}x. Reporting watchlist state to backend for recovery.`, "ORPHAN");
            automaAttempt = 0;
            sendTelemetry();
        }
    }

    function processSyncPayload(serverInfo, triggerTicker = "HEARTBEAT") {
        auditLog("BACKEND_SYNC", null, `Trigger: ${triggerTicker} | AI Suggestion: ${serverInfo.ai_suggestion || 'None'}`, "SYNC");

        // ── New backend signals (server >= 2026-05-26) ──────────────────────────
        // force_prune: tickers the backend KNOWS are exchange duplicates (e.g.
        //   BYBIT:XRPUSDT.P when BINANCE:XRPUSDT.P is preferred). These MUST be
        //   removed regardless of whether they are still visible on the live
        //   screener — VETO_PRUNE does not apply here.
        // action_required: "UPDATE_WATCHLIST" | "RESET_WATCHLIST" | null.
        //   When set, the Automa cooldown is bypassed so the watchlist gets
        //   corrected immediately (no 15-min wait for dupes to clear).
        const forcePrune     = Array.isArray(serverInfo.force_prune) ? serverInfo.force_prune : [];
        const actionRequired = serverInfo.action_required || null;
        // v20.26: an automatic UPDATE_WATCHLIST/RESET_WATCHLIST cooldown-bypass
        // is only honored while Stream A is actively ingesting data. Confirmed
        // live (2026-09-02): master_targets can carry old garbage (non-crypto
        // symbols graduated via a past Stream A data-quality bug) that gets
        // force-pushed to Automa on repeat, regardless of whether Stream A is
        // even running right now. The content of what Stream A found isn't the
        // gate — its recent ingestion activity is: an actively-firing Stream A
        // with an empty or unusual result is still legitimate signal and should
        // force through exactly as today; a silent/stale Stream A means nothing
        // new motivates urgency, so the bypass is withheld and this falls back
        // to the normal cooldown-respecting update path instead. FRESH_SESSION
        // is a deliberate manual dashboard action — never gated by this, since
        // you're not waiting on Stream A when you click it.
        const autoForcedAction = actionRequired === 'UPDATE_WATCHLIST' || actionRequired === 'RESET_WATCHLIST';
        const streamAFresh = serverInfo.stream_a_fresh !== false; // undefined (older backend) treated as fresh — fail open, never fail toward MORE aggressive
        if (autoForcedAction && !streamAFresh) {
            auditLog("STREAM_A_STALE_SUPPRESS", null,
                `${actionRequired} received but Stream A hasn't ingested data recently — not bypassing cooldown. Falling back to normal update cadence.`,
                "BUFFER");
        }
        const isForcedUpdate = (autoForcedAction && streamAFresh) || actionRequired === 'FRESH_SESSION';
        // Strict Screened Coin flag — dashboard-controlled, read fresh from every
        // response so a toggle takes effect on the very next cycle, no script edit.
        if (typeof serverInfo.strict_screened_coin === 'boolean') {
            strictScreenedCoinEnabled = serverInfo.strict_screened_coin;
        }

        // v20.30: backend-driven tab activation. The backend watches how stale
        // this stream's telemetry has gone (a gap here means sendTelemetry()
        // has been skipping itself via isTabHidden() — monitor()'s GATE_8/20
        // pushes don't check visibility, so this response can still reach us
        // even while the tab is backgrounded) and, when it decides this window
        // needs to come to front, sends the Automa workflow ID to fire — never
        // hardcoded here, the backend owns which workflow that is. Local
        // cooldown just prevents re-firing every single cycle while the
        // backend keeps sending the same signal.
        if (serverInfo.activate_tab_workflow_id) {
            const lastTabActivateAt = GM_getValue('tabActivate_lastTriggerAt', 0);
            if (Date.now() - lastTabActivateAt >= CONFIG.TAB_ACTIVATE_COOLDOWN_MS) {
                GM_setValue('tabActivate_lastTriggerAt', Date.now());
                auditLog("TAB_ACTIVATE_TRIGGER", null,
                    `Backend flagged this stream as stale/hidden — dispatching Automa workflow ${serverInfo.activate_tab_workflow_id} to bring the tab to front.`,
                    "SYSTEM");
                window.dispatchEvent(new CustomEvent('automa:execute-workflow', {
                    detail: { id: serverInfo.activate_tab_workflow_id }
                }));
            }
        }

        // v20.31: watchlist sync fallback. Confirmed live that a coin can get
        // stuck failing to land on the real watchlist for 15h+ (297 consecutive
        // misses, 75 forced UPDATE_WATCHLIST retries via the normal path) —
        // the same clipboard-paste approach just isn't working for it anymore.
        // The backend tracks this (watchlist_sync_audit) and, past a
        // configurable escalation count, sends a heavier recovery workflow
        // (opens a fresh tab, redoes the copy+paste from scratch) instead of
        // us silently repeating the same failing action forever. Own cooldown,
        // separate from tab-activate's — unrelated recovery actions, shouldn't
        // share a spam-prevention timer.
        if (serverInfo.watchlist_sync_fallback_workflow_id) {
            const lastFallbackAt = GM_getValue('watchlistSyncFallback_lastTriggerAt', 0);
            if (Date.now() - lastFallbackAt >= CONFIG.WATCHLIST_SYNC_FALLBACK_COOLDOWN_MS) {
                GM_setValue('watchlistSyncFallback_lastTriggerAt', Date.now());
                auditLog("WATCHLIST_SYNC_FALLBACK_TRIGGER", null,
                    `Backend reports the normal watchlist sync retry has stopped working for a stuck ticker — dispatching Automa fallback workflow ${serverInfo.watchlist_sync_fallback_workflow_id} (fresh tab, redo copy+paste).`,
                    "ORPHAN");
                window.dispatchEvent(new CustomEvent('automa:execute-workflow', {
                    detail: { id: serverInfo.watchlist_sync_fallback_workflow_id }
                }));
            }
        }

        // ── v20.10 FRESH_SESSION ─────────────────────────────────────────────────
        // Manual "burn it down and start over" reset, triggered from the dashboard.
        // Wipe every piece of local pipeline memory — nothing carries forward, no
        // half-finished 8/20min timers, no locked graduates, no cached target set.
        // Falls through to the master_targets diff below, which will now compute
        // a big "removals" list (everything currently on the watchlist that isn't
        // in the new minimal majors+whitelist baseline) and fire Automa to match.
        if (actionRequired === 'FRESH_SESSION') {
            const clearedCounts = {
                active: activeMasterSet.size, pipeline: pipelineRegistry.size,
                graduated: graduatedSet.size, serverTargets: serverTargetSet.size,
            };
            activeMasterSet.clear();
            pipelineRegistry.clear();
            graduatedSet.clear();
            serverTargetSet.clear();
            automaAttempt = 0;
            auditLog(
                "FRESH_SESSION", null,
                `Backend ordered a clean slate. Cleared local state (active:${clearedCounts.active} ` +
                `pipeline:${clearedCounts.pipeline} graduated:${clearedCounts.graduated} ` +
                `targets:${clearedCounts.serverTargets}). Watchlist will reset to majors + whitelist.`,
                "PRUNE"
            );
            saveState();
            // Fall through — the master_targets diff below now fires Automa
            // against the fresh (empty) local state and the minimal target list.
        }

        // ── 0. REFRESH_WATCHLIST ─────────────────────────────────────────────────
        // Backend detected ≥2 consecutive zero-count snapshots in 5m, meaning the
        // watchlist panel wasn't readable when sendTelemetry() ran. Re-open the
        // panel immediately and fire a fresh telemetry snapshot — don't wait for
        // the next 5-min POLL_MS cycle.
        if (actionRequired === 'REFRESH_WATCHLIST') {
            // v20.7 recursion guard. This handler calls sendTelemetry(), and the
            // response to THAT can request another refresh — an unbounded loop
            // (observed: 74 empty snapshots in 13 minutes). Rate-limit it.
            const nowMs = Date.now();
            if (nowMs - lastRefreshAt < CONFIG.REFRESH_MIN_INTERVAL_MS) {
                const waitS = ((CONFIG.REFRESH_MIN_INTERVAL_MS - (nowMs - lastRefreshAt)) / 1000).toFixed(0);
                auditLog("WATCHLIST_REFRESH", null, `Suppressed — refreshed ${((nowMs - lastRefreshAt) / 1000).toFixed(0)}s ago. Next allowed in ${waitS}s.`, "BUFFER");
            } else {
                lastRefreshAt = nowMs;
                auditLog("WATCHLIST_REFRESH", null, "Backend: zero watchlist extended. Forcing immediate re-read + re-send.", "SYNC");
                ensureWatchlistPanelOpen().then(() => {
                    updateArea2Watchlist();
                    sendTelemetry();
                });
            }
            // Fall through — still process prune/target lists from this response
        }

        // ── 1. Force-prune exchange duplicates (bypasses VETO_PRUNE) ────────────
        if (forcePrune.length > 0) {
            forcePrune.forEach(tickerKey => {
                if (activeMasterSet.has(tickerKey)) {
                    activeMasterSet.delete(tickerKey);
                    pipelineRegistry.delete(tickerKey);
                    auditLog("FORCE_PRUNED", tickerKey, "Removed exchange duplicate (backend dedup).", "PRUNE");
                }
                if (serverTargetSet.has(tickerKey)) serverTargetSet.delete(tickerKey);
                // Also clear from graduatedSet so the orphan-detection loop
                // doesn't try to re-send a STABLE pick for an already-pruned dupe.
                if (graduatedSet.has(tickerKey)) {
                    graduatedSet.delete(tickerKey);
                    auditLog("FORCE_PRUNED", tickerKey, "Cleared graduation lock for exchange duplicate.", "PRUNE");
                }
            });
        }

        // Computed once, reused by both the prune_list block below AND the
        // master_targets diff — the browser's live, right-now view of the raw
        // screener DOM. Both removal paths must agree on the same snapshot.
        const liveScreenerKeys = new Set(getMarketSnapshot());
        const forceSet         = new Set(forcePrune);

        // ── 2. Normal prune list (VETO still applies — coin must be off-screener) ──
        // NOTE: this block only affects PRE-graduation pipeline bookkeeping
        // (activeMasterSet/pipelineRegistry). It does NOT protect a coin that
        // has already graduated and is sitting in the real TV watchlist — that
        // removal happens via the master_targets diff below, which is where
        // v20.9 adds the equivalent live-screener check.
        if (serverInfo.prune_list && Array.isArray(serverInfo.prune_list)) {
            serverInfo.prune_list.forEach(tickerKey => {
                if (forceSet.has(tickerKey)) return;   // already handled above
                if (activeMasterSet.has(tickerKey)) {
                    if (liveScreenerKeys.has(tickerKey)) {
                        auditLog("VETO_PRUNE", tickerKey, "Ignored backend prune. Coin is still actively visible on screener.", "SYSTEM");
                    } else {
                        activeMasterSet.delete(tickerKey);
                        pipelineRegistry.delete(tickerKey);
                        auditLog("PRUNED", tickerKey, "Removed from tracking (Backend order).", "PRUNE");
                    }
                }
                if (serverTargetSet.has(tickerKey)) serverTargetSet.delete(tickerKey);
            });
        }

        if (serverInfo.master_targets && Array.isArray(serverInfo.master_targets)) {
            serverInfo.master_targets.forEach(key => serverTargetSet.add(key));

            // =========================================================================
            // ✅ FULL-FORMAT DIFF — detects exchange swaps (Bug-1 fix)
            // =========================================================================
            // Previous version stripped exchange prefixes before comparing, so
            // BINANCE:XRPUSDT.P (target) vs BYBIT:XRPUSDT.P (watchlist) both became
            // XRPUSDT.P → diff = 0 → Automa never fired → exchange duplicate stayed
            // in the TV watchlist forever even after force_prune cleared internal sets.
            //
            // Full-format comparison: BINANCE:XRPUSDT.P ≠ BYBIT:XRPUSDT.P → diff = 2
            // → Automa fires with the correct BINANCE: version in clipboard.
            const currentSetCheck = new Set(area2WatchlistSet);  // full EXCHANGE:TICKER.P
            const rawTargetSet    = new Set(serverInfo.master_targets);
            const rawRemovals     = Array.from(area2WatchlistSet).filter(x => !rawTargetSet.has(x));

            // v20.9: live-screener veto for THIS removal path. The prune_list
            // block above only protects pre-graduation pipeline bookkeeping — it
            // does nothing for a coin that's already graduated and sitting in the
            // real watchlist, which is removed via this diff instead. Before a
            // removal here is honored, check whether the browser can still
            // genuinely see the coin on the raw screener right now; if so, keep
            // it in what we actually push to Automa instead of silently dropping
            // a coin the backend's (necessarily slightly stale) data got wrong.
            // v20.13: during FRESH_SESSION, the backend decides whether the
            // reset should bypass VETO_PRUNE ('bypass', the default — force
            // removal down to majors+whitelist regardless of live screener
            // visibility, so the watchlist doesn't stall at "whatever the
            // screener currently shows") or still respect it ('smart' — keep
            // protecting a coin that's genuinely still on-screener, same as
            // normal operation). Controlled server-side via POST
            // /api/ghosts/watchdog-settings { freshSessionVetoMode }, carried
            // down per-response as serverInfo.veto_mode — no script edit
            // needed to flip this going forward.
            const freshSessionBypassVeto = actionRequired === 'FRESH_SESSION' && serverInfo.veto_mode !== 'smart';
            const vetoedRemovals = freshSessionBypassVeto
                ? []
                : rawRemovals.filter(x => liveScreenerKeys.has(x));
            if (freshSessionBypassVeto && rawRemovals.length > 0) {
                auditLog("FRESH_SESSION", null, `Veto bypassed for reset (mode: ${serverInfo.veto_mode || 'bypass'}) — forcing removal of ${rawRemovals.length} coin(s) still on-screener.`, "PRUNE");
            }
            vetoedRemovals.forEach(x => auditLog(
                "VETO_PRUNE", x,
                "Ignored backend removal. Coin is still actively visible on screener.", "SYSTEM"
            ));
            const effectiveTargets = vetoedRemovals.length > 0
                ? Array.from(new Set([...serverInfo.master_targets, ...vetoedRemovals]))
                : serverInfo.master_targets;

            const targetSetCheck = new Set(effectiveTargets);
            const additions = effectiveTargets.filter(x => !currentSetCheck.has(x));
            const removals  = Array.from(area2WatchlistSet).filter(x => !targetSetCheck.has(x));
            const diffCount = additions.length + removals.length;

            if (diffCount > 0) {
                auditLog("DIFF_DETECTED", null, `+ Adding: [${additions.join(', ')}] | - Removing: [${removals.join(', ')}]`, "BUFFER");

                const now = Date.now();
                const COOLDOWN_MS = CONFIG.AUTOMA_COOLDOWN_MINUTES * 60 * 1000;
                const cooldownExpired = !window.lastAutomaTriggerMs || (now - window.lastAutomaTriggerMs > COOLDOWN_MS);

                // ── Bypass cooldown when backend says UPDATE/RESET is required ──
                // Without this, exchange-dupe cleanup waits up to 15 min before
                // applying — which is exactly the lockin the user has been seeing.
                if (cooldownExpired || isForcedUpdate) {
                    // v20.7: routed through fireAutoma() so every push is verified
                    // ~25s later and auto-retried if Automa wiped or half-filled it.
                    const bypassNote = (!cooldownExpired && isForcedUpdate) ? ` [COOLDOWN BYPASSED — ${actionRequired}]` : '';
                    automaAttempt = 0;   // fresh target set — reset the retry counter
                    fireAutoma(effectiveTargets, bypassNote);
                } else {
                    const elapsed = now - window.lastAutomaTriggerMs;
                    const minLeft = ((COOLDOWN_MS - elapsed) / 60000).toFixed(1);
                    auditLog("COOLDOWN_BUFFER", null, `Changes pending but locked. Waiting ${minLeft}m before triggering Automa.`, "BUFFER");
                }
            } else {
                auditLog("SYNC_CLEAN", null, "Watchlist perfectly matches Backend. No clipboard copy needed.", "SYSTEM");
            }
        }
    }

    async function ensureWatchlistPanelOpen() {
        const panelBtn = document.querySelector('button[data-name="base"]');
        if (!panelBtn) return false;
        if (panelBtn.getAttribute('aria-pressed') !== 'true') {
            panelBtn.click();
            await new Promise(r => setTimeout(r, 1500));
        }
        return !!document.querySelector('div[data-name="symbol-list-wrap"]');
    }

    function updateArea2Watchlist() {
        // =========================================================================
        // ✅ STRICT DOM SCOPING (Prevents reading the Screener accidentally)
        // =========================================================================
        const watchlistContainer = document.querySelector('div[data-name="symbol-list-wrap"]');

        if (!watchlistContainer) {
            console.warn("[System] Watchlist container not found, skipping UI parse (keeping last-known-good set).");
            return;
        }

        const rows = watchlistContainer.querySelectorAll('div[data-symbol-full]');

        // Bug fix (2026-08-22): confirmed via DB audit — the SAME 6 tickers were
        // re-graduating as STABLE every ~40min even though they never left the
        // real watchlist. Root cause: this function used to clear() the sets
        // unconditionally, then repopulate from whatever it found. Right after
        // ensureWatchlistPanelOpen() switches tabs, TradingView can take longer
        // than the 1500ms wait to actually render the rows — so this ran with
        // the container present but ZERO rows in it yet, wiping a good set down
        // to empty. Every coin on the real watchlist then looked "missing" to
        // the GATE_8/20 pipeline (line ~890's suppression check) for up to a
        // full 5-min TELEMETRY cycle, got re-adopted, and 20-30min later fired
        // a duplicate "STABLE" graduation — which is what was driving repeat
        // master_targets diffs / Automa re-syncs with no real screener change.
        // Fix: only clear+rebuild on a genuinely non-empty read; a transient
        // empty read now keeps the last-known-good set instead of wiping it.
        if (rows.length === 0) {
            console.warn("[System] Watchlist container present but empty (mid-render after tab switch?) — keeping last-known-good set.");
            return;
        }

        area2WatchlistSet.clear();
        watchlistBaseSet.clear();   // Bug-2 fix: reset cross-exchange base set too
        watchlistSnapshot = [];

        // Only query the rows INSIDE the specific Watchlist container
        rows.forEach(row => {
            const full = row.getAttribute('data-symbol-full');
            const short = row.getAttribute('data-symbol-short');

            // Sanity guard (2026-09-01): confirmed live — a clipboard collision
            // between our GM_setClipboard(ticker list) and something else copying
            // text (observed: Automa's own workflow-editor JSON, copied while
            // editing a block) let garbage get pasted into "Add symbol" and land
            // as literal junk rows on the real watchlist. Without this check, this
            // function would happily add that JSON blob to area2WatchlistSet and
            // the diff logic would then try to "remove" it — feeding garbage into
            // DIFF_DETECTED, the telemetry payload, and potentially back into a
            // future Automa fire. A real ticker is always short and punctuation-free
            // (e.g. "BINANCE:BTCUSDT.P") — anything wildly longer or containing
            // JSON-ish characters is not a symbol and must never enter these sets.
            if (full && (full.length > 40 || /[{}"\\[\]]/.test(full))) {
                console.warn(`[System] ⚠️ Skipping non-ticker garbage in watchlist row: "${full.slice(0, 60)}..."`);
                return;
            }

            if (full) {
                area2WatchlistSet.add(full);
                // Strip exchange prefix so BYBIT:XRPUSDT.P and BINANCE:XRPUSDT.P
                // both register base = 'XRPUSDT.P' — prevents the script from scouting
                // the same coin under a different exchange as a new BIRTH.
                const base = full.includes(':') ? full.split(':')[1] : full;
                watchlistBaseSet.add(base);

                let price = "", change_pct = "", vol_raw = "";
                const spans = Array.from(row.children).filter(el => el.tagName === 'SPAN');

                if (spans.length >= 4) {
                    price = spans[0].innerText.replace(/\s|\n/g, '').replace(/−/g, '-');
                    change_pct = spans[2].innerText.replace(/\s|\n/g, '').replace(/−/g, '-');
                    const volSpan = spans[3].querySelector('[data-value]');
                    if (volSpan) vol_raw = volSpan.getAttribute('data-value');
                }

                watchlistSnapshot.push({ full, short, price, change_pct, vol_raw });
            }
        });
    }

    // ── Backgrounded-tab guard ───────────────────────────────────────────────
    // Confirmed live (2026-08-21): every ticker's price/change_pct in this
    // exact snapshot held byte-identical for 25-30+ minutes while the timestamp
    // kept advancing — a hidden/occluded tab silently punching stale DOM reads
    // as if they were fresh. Skip the send entirely while hidden rather than
    // write market_context_logs rows that look live but aren't.
    function isTabHidden() {
        return typeof document.hidden === 'boolean' ? document.hidden : false;
    }

    // Click TradingView's own refresh control before reading the watchlist,
    // forcing a fresh pull from their feed rather than trusting whatever's
    // already rendered — TradingView's own UI can independently pause its
    // update loop while hidden/idle, which no Chrome flag controls.
    function tryClickRefresh(container) {
        // Confirmed (2026-08-22, user DOM inspection + manual console click-test):
        // document.getElementById('js-screener-container').querySelector(
        //   '[data-qa-id="screener-refresh-button"]')  is the button's real,
        // verified-working path — search there first so the primary lookup
        // actually succeeds instead of silently falling through.
        const screenerContainer = document.getElementById('js-screener-container');
        const scope = container || document;
        let btn = null, via = null;
        if (screenerContainer && (btn = screenerContainer.querySelector(TELEMETRY.REFRESH_BUTTON_SELECTOR))) {
            via = '#js-screener-container (confirmed)';
        } else if ((btn = scope.querySelector(TELEMETRY.REFRESH_BUTTON_SELECTOR))) {
            via = 'watchlist-panel scope (fallback)';
        } else if ((btn = document.querySelector(TELEMETRY.REFRESH_BUTTON_SELECTOR))) {
            via = 'document-wide (fallback)';
        }
        if (btn) {
            btn.click();
            auditLog("REFRESH_CLICK", null, `Clicked refresh button via ${via}. Waiting ${TELEMETRY.REFRESH_SETTLE_MS/1000}s to settle.`, "SYSTEM");
            return true;
        }
        auditLog("REFRESH_CLICK", null, `Refresh button not found (selector: "${TELEMETRY.REFRESH_BUTTON_SELECTOR}") — reading table as-is.`, "SYSTEM");
        return false;
    }

    // ── Tab-title heartbeat — compact, tab-strip space is tiny ──────────────
    // Format: "👁26c +2-1 45s"  =  26 coins tracked, +2/-1 vs last telemetry
    // cycle, next update in 45s. If the countdown stops moving, the tab is
    // stuck regardless of what any Chrome flag or dashboard says.
    const titleState = { coinCount: 0, added: 0, removed: 0, nextEventAt: Date.now() + 30000, label: 'init' };
    function renderTitle() {
        const secsLeft = Math.max(0, Math.round((titleState.nextEventAt - Date.now()) / 1000));
        const delta = (titleState.added || titleState.removed) ? ` +${titleState.added}-${titleState.removed}` : '';
        document.title = `👁${titleState.coinCount}c${delta} ${titleState.label} ${secsLeft}s`;
    }
    setInterval(renderTitle, 1000);
    let prevWatchlistBaseSet = new Set();

    async function sendTelemetry() {
        if (isTabHidden()) {
            auditLog("TELEMETRY_SKIPPED", null, "Tab is backgrounded — skipping to avoid punching stale prices. Will catch up when visible again.", "BUFFER");
            titleState.label = 'hidden';
            titleState.nextEventAt = Date.now() + TELEMETRY.POLL_MS;
            return;
        }
        if (!checkStrictScreenedCoin()) {
            titleState.label = 'unscreened';
            titleState.nextEventAt = Date.now() + TELEMETRY.POLL_MS;
            return;
        }
        auditLog("TELEMETRY", null, "Capturing Market Context Snapshot...", "SYSTEM");

        // Bug-6 fix: use screener snap cached by monitor() instead of re-reading here.
        // ensureWatchlistPanelOpen() switches the left panel to the watchlist tab, which
        // removes screener rows from the DOM — any querySelector('tbody tr[data-rowkey]')
        // call AFTER that returns 0 rows, producing screener_total_count: 0 every cycle.
        // monitor() runs while the screener tab is active and populates lastScreenerSnap.
        const screenerSnap = lastScreenerSnap.slice(); // snapshot copy, safe to send

        // Bug-3 fix: always ensure the watchlist panel is open BEFORE reading it.
        await ensureWatchlistPanelOpen();
        const watchlistPanel = document.querySelector('div[data-name="symbol-list-wrap"]');

        if (!watchlistPanel) {
            auditLog("TELEMETRY_ERROR", null, "Skipping: Watchlist container not found.", "PRUNE");
            return;
        }

        // Force TradingView to pull fresh data itself before we read the DOM —
        // its own update loop can independently pause while hidden/idle, which
        // no Chrome flag controls.
        if (tryClickRefresh(watchlistPanel)) {
            titleState.label = 'refreshing';
            titleState.nextEventAt = Date.now() + TELEMETRY.REFRESH_SETTLE_MS;
            await new Promise(r => setTimeout(r, TELEMETRY.REFRESH_SETTLE_MS));
            if (isTabHidden()) {
                auditLog("TELEMETRY_SKIPPED", null, "Tab went hidden during the refresh wait — aborting this cycle.", "BUFFER");
                titleState.label = 'hidden';
                titleState.nextEventAt = Date.now() + TELEMETRY.POLL_MS;
                return;
            }
        }

        // Always refresh watchlist state immediately before building the payload.
        updateArea2Watchlist();

        // Compact added/removed vs the last telemetry cycle — shown in the
        // title heartbeat since tab-strip space is tiny.
        const addedSet   = new Set([...watchlistBaseSet].filter(t => !prevWatchlistBaseSet.has(t)));
        const removedSet = new Set([...prevWatchlistBaseSet].filter(t => !watchlistBaseSet.has(t)));
        titleState.coinCount = watchlistSnapshot.length;
        titleState.added = addedSet.size;
        titleState.removed = removedSet.size;
        titleState.label = 'next';
        titleState.nextEventAt = Date.now() + TELEMETRY.POLL_MS;
        prevWatchlistBaseSet = new Set(watchlistBaseSet);
        if (addedSet.size || removedSet.size) {
            auditLog("WATCHLIST_DELTA", null, `+[${[...addedSet].join(',')}] -[${[...removedSet].join(',')}]`, "SYNC");
        }

        const payload = {
            screener_total_count: screenerSnap.length,
            screener_visible_snapshot: screenerSnap,
            watchlist_count: watchlistSnapshot.length,
            watchlist_active_snapshot: watchlistSnapshot,
            script_version: SCRIPT_VERSION
        };

        GM_xmlhttpRequest({
            method: "POST",
            url: TELEMETRY.URL,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(payload),
            onload: function (response) {
                if (response.status === 200) {
                    const serverInfo = JSON.parse(response.responseText);
                    auditLog("TELEMETRY_SUCCESS", null, "Snapshot Synced to Backend.", "SYNC");
                    // Bug-5 fix: always call processSyncPayload — not just when master_targets
                    // is present. force_prune and action_required must be handled even if the
                    // engine returns no master_targets (e.g. early-boot or overload path).
                    processSyncPayload(serverInfo, "HEARTBEAT");
                } else {
                    auditLog("TELEMETRY_ERROR", null, `HTTP ${response.status}: ${response.responseText}`, "PRUNE");
                }
            },
            onerror: function () {
                auditLog("TELEMETRY_FAILED", null, "Network request failed entirely.", "PRUNE");
            }
        });
    }

    async function monitor() {
        await ensureWatchlistPanelOpen();
        mapHeaders();
        updateArea2Watchlist();

        // v20.28: confirmed once per monitor() cycle, reused below to gate both
        // the screener snapshot cache and new-coin intake. See
        // isScreenerFilterConfirmedActive() for why this doesn't also drive the
        // Automa retry/escalation — that stays on sendTelemetry()'s cadence only.
        const screenerConfirmed = isScreenerFilterConfirmedActive();
        if (!screenerConfirmed && (Date.now() - (window._lastUnscreenedMonitorLogMs || 0)) > 30000) {
            auditLog("MONITOR_SKIPPED_UNSCREENED", null,
                "Screener filter pill not confirmed active — skipping new-coin intake this cycle (existing tracked coins still advance normally). Waiting on Automa correction.",
                "BUFFER");
            window._lastUnscreenedMonitorLogMs = Date.now();
        }

        // =========================================================================
        // 🔍 DYNAMIC ORPHAN COIN DETECTION
        // =========================================================================
        const now = Date.now();

        graduatedSet.forEach((gradData, rowKey) => {
            if (!gradData.verified) {
                if (area2WatchlistSet.has(rowKey)) {
                    gradData.verified = true;
                    auditLog("VERIFIED", gradData.ticker, "Coin successfully appeared in UI Watchlist.", "QUALIFIED");
                } else {
                    let isOrphan = false;
                    let culprit = "UNKNOWN";

                    // DYNAMIC CHECK 1: The Fast Fail.
                    if (window.lastAutomaTriggerMs && window.lastAutomaTriggerMs >= gradData.ts) {
                        const timeSinceAutomaFired = now - window.lastAutomaTriggerMs;
                        if (timeSinceAutomaFired > 3 * 60 * 1000) {
                            isOrphan = true;
                            culprit = serverTargetSet.has(rowKey) ? "AUTOMA_SYNC_FAILED" : "BACKEND_REJECTED";
                        }
                    }
                    // DYNAMIC CHECK 2: The Cooldown Buffer Fallback.
                    else {
                        const timeSinceGraduation = now - gradData.ts;
                        if (timeSinceGraduation > (CONFIG.AUTOMA_COOLDOWN_MINUTES + 3) * 60 * 1000) {
                            isOrphan = true;
                            culprit = "BACKEND_REJECTED (Timeout Exceeded)";
                        }
                    }

                    if (isOrphan) {
                        auditLog("ORPHANED_STABLE", gradData.ticker, `Missed Watchlist! Culprit: ${culprit}`, "ORPHAN");

                        pushToBackend({
                            ticker: gradData.ticker,
                            exchange: gradData.exchange,
                            type: "ORPHANED_STABLE",
                            reason: culprit,
                            move: 0, direction: "UNKNOWN", price: 0
                        });

                        graduatedSet.delete(rowKey);
                        auditLog("LOCK_LIFTED", gradData.ticker, "Lock removed early to allow re-evaluation.", "SYSTEM");
                    }
                }
            }
        });
        // =========================================================================

        const rows = document.querySelectorAll('tbody tr[data-rowkey]');
        const seenInThisScan = new Set();

        // ── Screener snap cache (Bug-6 fix) ──────────────────────────────────────
        // monitor() runs while the screener panel is active. sendTelemetry() switches
        // to the watchlist tab before reading, which removes screener rows from the DOM
        // and produces screener_total_count: 0. Cache here so telemetry always has it.
        // v20.28: also gated on screenerConfirmed — a snapshot taken from the
        // unfiltered universe would otherwise get sent to the backend as
        // screener_visible_snapshot and corrupt the volume-based watchlist-cap
        // ranking with rows that were never really candidates.
        if (rows.length > 0 && screenerConfirmed) {
            const snapHeaders = [];
            document.querySelectorAll('thead th[data-field]').forEach(th => {
                const f = th.getAttribute('data-field');
                if (f) snapHeaders.push(f);
            });
            lastScreenerSnap = [];
            rows.forEach(snapRow => {
                const snapFull = snapRow.getAttribute('data-rowkey');
                if (!snapFull) return;
                const snapParts = snapFull.split(':');
                const snapCells = snapRow.querySelectorAll('td');
                const snapData  = { full: snapFull, short: snapParts.length > 1 ? snapParts[1] : snapFull };
                snapCells.forEach((cell, idx) => {
                    if (idx < snapHeaders.length) {
                        const fieldName = snapHeaders[idx];
                        const rawText   = cell.innerText || '';
                        const numCand   = rawText.replace(/[\n\r,\s]/g, '').replace(/−/g, '-').replace(/USDT$/i, '');
                        // v20.27: handle TradingView's K/M/B magnitude suffixes (e.g. "570.07M"
                        // on a Vol in USD 24h-style column) — previously only bare numbers
                        // parsed; a suffixed value fell through to being stored as raw text,
                        // unusable for any numeric ranking/comparison downstream.
                        const magMatch = numCand.match(/^(-?[\d.]+)([KMB])$/i);
                        let parsedVal;
                        if (magMatch) {
                            const mult = { K: 1e3, M: 1e6, B: 1e9 }[magMatch[2].toUpperCase()];
                            parsedVal = parseFloat(magMatch[1]) * mult;
                        } else if (numCand !== '' && /^-?[\d.]+$/.test(numCand)) {
                            parsedVal = parseFloat(numCand);
                        }
                        snapData[fieldName] = (parsedVal !== undefined && isFinite(parsedVal))
                            ? parsedVal
                            : rawText.replace(/−/g, '-').trim();
                    }
                });
                lastScreenerSnap.push(snapData);
            });
        }
        // ─────────────────────────────────────────────────────────────────────────

        rows.forEach(row => {
            const rowKey = row.getAttribute('data-rowkey');
            const [exchange, ticker] = rowKey.split(':');
            const cells = row.querySelectorAll('td');
            if (!cells[colMap.SYMBOL]) return;
            seenInThisScan.add(rowKey);

            const gradData = graduatedSet.get(rowKey);
            if (gradData) {
                if (Date.now() - gradData.ts > (CONFIG.GRADUATION_LOCK_MINUTES * 60 * 1000)) {
                    graduatedSet.delete(rowKey);
                    auditLog("LOCK_EXPIRED", ticker, `Graduation lock lifted after ${CONFIG.GRADUATION_LOCK_MINUTES}m. Eligible for re-entry.`, "SYSTEM");
                } else {
                    return;
                }
            }

            // Bug-2 fix: guard against cross-exchange duplicates.
            // If BYBIT:XRPUSDT.P is in the watchlist and BINANCE:XRPUSDT.P appears on
            // the screener, area2WatchlistSet.has(rowKey) would miss it. watchlistBaseSet
            // covers the base ticker regardless of which exchange prefix is stored.
            const rowBase = rowKey.includes(':') ? rowKey.split(':')[1] : rowKey;
            if (area2WatchlistSet.has(rowKey) || watchlistBaseSet.has(rowBase)) {
                if (activeMasterSet.has(rowKey) || pipelineRegistry.has(rowKey)) {
                    activeMasterSet.delete(rowKey);
                    pipelineRegistry.delete(rowKey);
                    auditLog("SUPPRESSED", ticker, "Coin already in watchlist (possibly under different exchange). Halting.", "SYSTEM");
                }
                return;
            }

            if (serverTargetSet.has(rowKey) && !activeMasterSet.has(rowKey)) {
                activeMasterSet.add(rowKey);
                const currentPrice = parseFloat(cells[colMap.PRICE]?.innerText.replace(/,/g, '')) || 0;
                pipelineRegistry.set(rowKey, { bornAt: Date.now(), bornPrice: currentPrice, ticker, q8: false });
                auditLog("ADOPTED", ticker, "Resuming watch (Backend ordered).", "PIPELINE");
            }

            if (activeMasterSet.has(rowKey)) {
                const node = pipelineRegistry.get(rowKey);
                const currentPrice = parseFloat(cells[colMap.PRICE]?.innerText.replace(/,/g, '')) || 0;
                const lifetime = Math.floor((Date.now() - node.bornAt) / 60000);
                const totalMove = ((currentPrice - node.bornPrice) / node.bornPrice) * 100;
                const direction = (cells[colMap.RATING]?.innerText || "").includes("Buy") ? "LONG" : "SHORT";

                if (lifetime >= CONFIG.GATE_8 && !node.q8) {
                    node.q8 = true;
                    pushToBackend({ ticker, exchange, type: "VELOCITY", move: totalMove, direction, price: currentPrice });
                    auditLog("GATE_8_VELOCITY", ticker, `Passed 8m. Move: ${totalMove.toFixed(3)}%`, "QUALIFIED");
                }

                if (lifetime >= CONFIG.GATE_20) {
                    pushToBackend({ ticker, exchange, type: "STABLE", move: totalMove, direction, price: currentPrice });
                    auditLog("GATE_20_STABLE", ticker, `Passed 20m. Cycle complete. Locking for ${CONFIG.GRADUATION_LOCK_MINUTES}m.`, "QUALIFIED");

                    activeMasterSet.delete(rowKey);
                    pipelineRegistry.delete(rowKey);

                    graduatedSet.set(rowKey, { ts: Date.now(), verified: false, ticker: ticker, exchange: exchange });
                    serverTargetSet.delete(rowKey);
                }
                return;
            }

            // v20.28: don't start a new pipeline for a coin scraped while the
            // screened filter isn't confirmed active — this is the exact incident
            // from 2026-09-03 where 55+ unfiltered symbols (UNIUSDT duplicates
            // across exchanges, SOXLUSDT/USELESSUSDT and other non-target rows)
            // all got BIRTH'd simultaneously because the raw custom-screener view
            // was mistaken for the real candidate set, later hammering the backend
            // with a burst of GATE_8/GATE_20 qualifications at once. rowKey is
            // still added to seenInThisScan above, so any coin that legitimately
            // started its pipeline earlier (while confirmed) isn't wrongly ghosted
            // just because this cycle happens to be unscreened. Automa's
            // correction workflow (fired on sendTelemetry()'s cadence via
            // checkStrictScreenedCoin()) gets a chance to fix the filter before
            // intake resumes on a later cycle.
            if (!screenerConfirmed) {
                return;
            }

            activeMasterSet.add(rowKey);
            const price = parseFloat(cells[colMap.PRICE]?.innerText.replace(/,/g, '')) || 0;
            pipelineRegistry.set(rowKey, { bornAt: Date.now(), bornPrice: price, ticker, q8: false });
            auditLog("BIRTH", ticker, `Spotted on screener. Starting cycle.`, "PIPELINE");
        });

        pipelineRegistry.forEach((node, key) => {
            if (!seenInThisScan.has(key)) {
                if (!node.pausedAt) {
                    node.pausedAt = now;
                    auditLog("GHOSTING", node.ticker, "Dropped off screener. Pausing timer.", "SYSTEM");
                } else if ((now - node.pausedAt) > (CONFIG.GHOST_GRACE_MINUTES * 60 * 1000)) {
                    activeMasterSet.delete(key);
                    pipelineRegistry.delete(key);
                    auditLog("DELETED", node.ticker, `Exceeded ${CONFIG.GHOST_GRACE_MINUTES}m grace period.`, "PRUNE");
                }
            } else {
                if (node.pausedAt) {
                    const timeAway = now - node.pausedAt;
                    node.bornAt += timeAway;
                    node.pausedAt = null;
                    auditLog("RESURRECTED", node.ticker, "Reappeared on screener. Timers adjusted.", "PIPELINE");
                }
            }
        });
        saveState();
    }

    setTimeout(() => {
        auditLog("INIT", null, "Scanner Engine Started", "SYNC");
        loadState();
        monitor();
    }, 2000);

    setInterval(monitor, CONFIG.SCAN_MS);

    setTimeout(() => {
        sendTelemetry();
        setInterval(sendTelemetry, TELEMETRY.POLL_MS);
    }, 30000);

    // Catch-up the instant the tab regains focus — don't wait for the next
    // (possibly throttle-delayed) TELEMETRY.POLL_MS tick to notice fresh data
    // is available.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            auditLog("VISIBILITY", null, "Tab regained focus — running catch-up telemetry.", "SYSTEM");
            sendTelemetry();
        }
    });

})();