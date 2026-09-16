// ==UserScript==
// @name         Ultra Scalper v16.0 - Connected Core (Master)
// @namespace    http://tampermonkey.net/
// @version      16.8
// @description  v16.8: user feedback (2026-09-16) — the setup-check's timing was too aggressive
//               for a real page reload. Bumped STREAM_A_SETUP_INITIAL_SETTLE_MS 45s -> 90s (a
//               heavier Pine screener genuinely needs more than 45s to finish populating real
//               columns after a fresh load, same DOM-timing evidence that already justified the
//               3min->5min cooldown bump in v16.6 — the settle window just never got the same
//               treatment). Replaced the flat 5min retry cooldown with a progressive backoff
//               (5min, 7min, 10min via STREAM_A_SETUP_COOLDOWN_STEPS_MS) so a screener still
//               broken on a later retry gets more breathing room instead of another dispatch
//               stacked close behind the last one. Widened the monitor's own poll interval
//               15s -> 20s (cosmetic — this only controls how often the cheap DOM check
//               re-reads, not dispatch rate, which was already gated by the settle window and
//               cooldown). v16.7: streamAInitialSetupWorkflowId (Ghost Coin widget settings panel) was
//               settable via the watchdog-settings API but had nowhere to go — the script
//               only ever dispatched its own hardcoded CONFIG.STREAM_A_SETUP_AUTOMA_WORKFLOW_ID,
//               so editing the field in the UI silently did nothing (confirmed: DB value read
//               back out by GET /api/ghosts/watchdog-settings for display, never consumed by
//               any /scan-report response). Backend now includes stream_a_setup_workflow_id in
//               every /scan-report response (same pattern as activate_tab_workflow_id); the
//               script picks it up into dynamicStreamASetupWorkflowId and checkStreamAFilterSetup()
//               dispatches that instead of the hardcoded constant once it's arrived at least
//               once. The hardcoded value remains the fallback for a fresh page load before the
//               first response lands. v16.6: confirmed live via real DOM inspection that v16.5's pills-only check missed a genuinely broken screener state — 10 filter pills were present (would've passed), but the table itself had only 1 real data column and every row's indicator cell was empty with a Pine Script "array.get() Index out of bounds" error. checkStreamAFilterSetup() now checks three things together: pills container > 4 children, thead th[data-field] count > 5, tbody tr[data-rowkey] count >= 2. Retry cooldown bumped 3min -> 5min (the table can take a while to populate after the pills render). After 3 retries still fail, reloads the page instead of giving up silently, capped at 3 reloads total to avoid a reload loop if the page is broken for a reason neither Automa nor a reload can fix. v16.5: the initial-setup filter check's settle window now starts from a real page-load signal (document.readyState === 'complete', or a window 'load' listener if not there yet) instead of script-injection time — Tampermonkey has no @run-at directive here (defaults to document-idle), which can fire before TradingView's SPA content has actually rendered, risking judging (and firing Automa against) a genuinely not-yet-loaded page. checkStreamAFilterSetup() fails open (never judges, never triggers) until the real load event has fired, THEN waits the existing 45s settle window on top of that before evaluating. v16.4: fixed a real deadlock in v16.3's filter-setup check — it only ran from inside processData(), but processData() is never called until startAutoScan()'s button-discovery loop finds the scan button, and confirmed live that loop can get stuck retrying forever ("Scan button not found, retrying...") when the screener isn't properly set up. That's exactly the situation the filter check exists to fix, so gating it behind the very thing it was supposed to unblock meant the Automa setup workflow never got a chance to fire. Now a standalone startStreamASetupMonitor() runs checkStreamAFilterSetup() on its own 15s timer, independent of the scan button or any other state, started before the button-dependent functions in the init sequence. v16.3: two additions, mirroring Stream B (coin_scanner.js). (1) Initial-setup filter check — before trusting a scan cycle, verifies the screener's filter pills container (dynamic selector: [class*=screenerContainer] div [class*=pillsWrapper-] div[class*=pillsContainerWrapper-] div[class*=pillsContainer-]) has more than 4 direct children (confirmed via DOM inspection: only 2 children when broken); if not, dispatches Automa workflow 3lcKzNfE_GyXzpUMKxwVi (bounded retries, 3min cooldown, 45s settle window after page load — same scaffolding as Strict Screened Coin) and skips processData() for that cycle instead of sending unfiltered data. Gated once in processData() itself so every trigger source (manual, auto, alert-triggered) is covered. (2) Backend-driven tab activation — the backend now watches scans table staleness and, past a threshold, includes activate_tab_workflow_id in the /scan-report response; the script dispatches whatever ID it's given via the same automa:execute-workflow CustomEvent, on a local 3min cooldown. The workflow ID is never hardcoded here for this part — the backend owns it. v16.2: parseTableData() now rejects non-ticker garbage (JSON/long strings) before adding a row to coins[] — confirmed live (2026-09-01) that fragments of Automa's own workflow-editor JSON got scraped as literal "tickers" (18 junk rows in one scan), sent to the backend, and showed up as permanently "frozen" in the Data Feed Health widget. Same class of fix already applied to Stream B (coin_scanner.js v20.19). v16.1: hidden-tab guard on auto-scan (skip click+process while backgrounded, catch up instantly on refocus) + diagnostic warning when a previously-captured ticker vanishes from a scan's rows (dropped off pine-screener table). v16.0: Auto-triggers AI analysis with smart change detection + Alert integration + Fixed event toggles
// @author       Your Name
// @match        *://*.tradingview.com/pine-screener/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        unsafeWindow
// @connect      localhost
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    console.log('🚀 ULTRA SCALPER v16.0 (MASTER) INITIALIZED - Connected Core');

    /*
    ═══════════════════════════════════════════════════════════════
    TRIGGER BEHAVIOR MATRIX (OPTION B: BALANCED)
    ═══════════════════════════════════════════════════════════════

    | Trigger Type              | Data Changed? | Action                                    |
    |---------------------------|---------------|-------------------------------------------|
    | Auto-scan                 | ✅ Yes        | ✅ Send after 2nd scan                    |
    | Auto-scan                 | ❌ No         | ⏭️ Skip (save API cost)                   |
    | Manual (Alt+U)            | ✅ Yes        | ⏭️ Process only, don't send               |
    | Manual (Alt+U)            | ❌ No         | ⏭️ Skip processing                        |
    | Manual Trigger (Shift+Z)  | ✅ Yes        | ✅ Send immediately                       |
    | Manual Trigger (Shift+Z)  | ❌ No         | ⚠️ Send with 'dataUnchanged: true' flag  |
    | Alert-triggered           | ✅ Yes        | ✅ Send immediately with pulse data       |
    | Alert-triggered           | ❌ No         | ⏭️ Skip + hold alerts for next scan       |

    ═══════════════════════════════════════════════════════════════
    */

    // ═══════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════
    const CONFIG = {
        INTERVAL_MINUTES: 3,
        UI_DELAY_SECONDS: 5,
        TRIGGER_KEY: 'u',

        SHOW_UNFILTERED_DETAILS: true,
        SHOW_MISSED_IN_CONSOLE: true,
        SHOW_INSIGHTS_UNFILTERED: true,
        UNFILTERED_MAX_DISPLAY: 20,

        UNFILTERED_MIN_SCORE: 30,
        UNFILTERED_EXCLUDE_FREEZE: true,

        AUTO_TRIGGER_AFTER_SCANS: 2,
        AUTO_TRIGGER_ENDPOINT: 'http://localhost:3000/scan-report',

        // 2026-09-10: Stream A "initial setup" filter check — mirrors Stream
        // B's Strict Screened Coin (coin_scanner.js). Verifies the screener's
        // filter pills are actually applied before trusting a scan cycle; if
        // the pills container has too few children (confirmed via DOM
        // inspection: 2 children when broken, needs >4 when properly
        // filtered), dispatches this Automa workflow to fix it (bounded
        // retries, cooldown, settle window after page load — same
        // scaffolding as Stream B's).
        //
        // 2026-09-16: this is now the FALLBACK default only. It was
        // previously treated as a fixed value never picked dynamically — but
        // the Ghost Coin widget's settings panel lets you edit
        // streamAInitialSetupWorkflowId, and that edit had nowhere to go
        // (dead setting, confirmed: saved to system_settings, never read back
        // out anywhere). The backend now includes the live value as
        // `stream_a_setup_workflow_id` in every /scan-report response (same
        // pattern as activate_tab_workflow_id below) — see
        // dynamicStreamASetupWorkflowId, which checkStreamAFilterSetup()
        // prefers over this constant once the backend has responded at least
        // once. This constant only matters before the first successful
        // response of a fresh page load, or if the backend ever omits the field.
        STREAM_A_SETUP_AUTOMA_WORKFLOW_ID: '3lcKzNfE_GyXzpUMKxwVi',
        STREAM_A_SETUP_MAX_RETRIES: 3,
        // 2026-09-10: bumped 3min -> 5min. Confirmed live via real DOM
        // inspection that the pills-only check missed a genuinely broken
        // state (10 filter pills present, but the table itself only had 1
        // real data column and every row showed a Pine Script indicator
        // error) — the table can take a while to actually populate after the
        // pills render, so a tighter cooldown risked misjudging "still
        // loading" as "still broken" and burning retries too fast.
        //
        // 2026-09-16: this is now the BASE cooldown for a progressive backoff
        // (see STREAM_A_SETUP_COOLDOWN_STEPS_MS below) rather than one flat
        // value for every retry — same reasoning taken further: a screener
        // that's still broken on retry 2 or 3 is less likely to resolve on
        // its own in the next few minutes than a freshly-reloaded one was, so
        // spacing dispatches out further on later retries avoids stacking
        // redundant Automa actions on top of one that may still be in flight.
        STREAM_A_SETUP_COOLDOWN_MS: 5 * 60 * 1000,
        // Per-retry cooldown before the next dispatch: 5min, 7min, 10min.
        // Indexed by current retry count (0-based) — falls back to the last
        // entry (or the flat STREAM_A_SETUP_COOLDOWN_MS) if retries somehow
        // exceed the list length.
        STREAM_A_SETUP_COOLDOWN_STEPS_MS: [5 * 60 * 1000, 7 * 60 * 1000, 10 * 60 * 1000],
        // 2026-09-16: bumped 45s -> 90s. User feedback + the same DOM
        // evidence behind the cooldown bump above: 45s wasn't reliably
        // enough time for TradingView's Pine screener to finish populating
        // real columns after a full page reload (heavier Pine scripts can
        // take noticeably longer), so the very first judgment after a reload
        // risked firing an unnecessary Automa "fix" dispatch against a page
        // that was still genuinely loading, not actually broken.
        STREAM_A_SETUP_INITIAL_SETTLE_MS: 90000,
        STREAM_A_FILTER_MIN_PILLS: 4,    // pills container must have MORE than this many direct children
        STREAM_A_MIN_TABLE_COLUMNS: 5,   // thead th[data-field] count must be MORE than this
        STREAM_A_MIN_TABLE_ROWS: 2,      // tbody tr[data-rowkey] count must be AT LEAST this many
        // 2026-09-10: after MAX_RETRIES Automa triggers all fail to fix it,
        // reload the page instead of just giving up silently — capped so a
        // persistently broken page (TradingView itself down, Automa broken)
        // can't reload forever.
        STREAM_A_SETUP_MAX_RELOADS: 3,

        // Backend-driven tab activation — same pattern as Stream B v20.30.
        // The backend decides (scans table staleness) whether this tab needs
        // to come to front and hands down whichever workflow ID it wants
        // dispatched via activate_tab_workflow_id in the /scan-report
        // response. Never hardcoded here — see processSyncPayload-equivalent
        // handling in the response onload below.
        TAB_ACTIVATE_COOLDOWN_MS: 3 * 60 * 1000,
    };

    const INTERVAL_MS = CONFIG.INTERVAL_MINUTES * 60 * 1000;
    const UI_DELAY_MS = CONFIG.UI_DELAY_SECONDS * 1000;

    // Self-reported version, sent with every payload — lets the backend tell
    // us if the browser is actually running what we think it's running,
    // instead of relying on "I pasted it" going unconfirmed. Bump this any
    // time @version above changes.
    const SCRIPT_VERSION = '16.8';

    // ── Backgrounded-tab guard ───────────────────────────────────────────────
    // Same class of bug fixed in Stream B/D: Chrome throttles setInterval in
    // hidden tabs, and TradingView's own screener can stop updating while
    // backgrounded, so a click-and-read cycle can silently process/send
    // stale DOM data stamped with a fresh timestamp. Skip the cycle while
    // hidden, and catch up immediately on refocus instead of waiting for the
    // next (possibly throttle-delayed) interval tick.
    function isTabHidden() {
        return typeof document.hidden === 'boolean' ? document.hidden : false;
    }

    // ── 2026-09-10: Stream A initial-setup filter check ──────────────────────
    // Selector is written to match by partial class-name fragments
    // (`[class*=...]`) instead of TradingView's full hashed class names, so it
    // keeps working across their CSS rebuilds — same approach as Stream B's
    // STRICT_SCREEN_SELECTOR.
    const STREAM_A_FILTER_SELECTOR = '[class*=screenerContainer] div [class*=pillsWrapper-] div[class*=pillsContainerWrapper-] div[class*=pillsContainer-]';

    // 2026-09-10: settle window now starts from a REAL page-load signal, not
    // script-injection time. Tampermonkey has no @run-at here (defaults to
    // document-idle), which can fire well before TradingView's SPA content
    // has actually rendered — starting the settle clock at script-parse time
    // risked judging (and firing Automa against) a genuinely not-yet-rendered
    // page. null means "not loaded yet" — checkStreamAFilterSetup() fails
    // open (never judges, never triggers) until this is set.
    let streamAPageLoadedAt = null;

    // 2026-09-16: live-updated from stream_a_setup_workflow_id on every
    // /scan-report response — see the response handler further down. null
    // until the first successful response arrives, at which point
    // checkStreamAFilterSetup() prefers this over CONFIG.STREAM_A_SETUP_AUTOMA_WORKFLOW_ID.
    // Lets the Ghost Coin widget's settings-panel field actually take effect,
    // same as tabActivateWorkflowIdA/B/D and watchlistSyncFallbackWorkflowId.
    let dynamicStreamASetupWorkflowId = null;
    function _markStreamAPageLoaded() {
        if (streamAPageLoadedAt === null) {
            streamAPageLoadedAt = Date.now();
            console.log('[Stream-A-Setup] 📄 Page load event fired — settle window starts now.');
        }
    }
    if (document.readyState === 'complete') {
        _markStreamAPageLoaded();
    } else {
        window.addEventListener('load', _markStreamAPageLoaded, { once: true });
    }

    /**
     * v16.6: combined health check — confirmed live via real DOM inspection
     * that the pills-count check alone missed a genuinely broken state: 10
     * filter pills were present (pills check would've said "fine"), but the
     * table itself only had 1 real data column (thead th[data-field]) and
     * every row's indicator cell was empty with a Pine Script error tooltip
     * ("array.get() Index out of bounds"). All three must hold for the
     * screener to count as properly initialized:
     *   1. filter pills container > STREAM_A_FILTER_MIN_PILLS children
     *   2. thead th[data-field] count > STREAM_A_MIN_TABLE_COLUMNS
     *   3. tbody tr[data-rowkey] count >= STREAM_A_MIN_TABLE_ROWS
     * On failure: bounded retries at a 5min cooldown (bumped from 3min —
     * the table can take a while to actually populate after the pills
     * render, so a tight cooldown risked misjudging "still loading" as
     * "broken"). Once retries are exhausted, reload the page instead of
     * giving up silently — capped at STREAM_A_SETUP_MAX_RELOADS so a
     * persistently broken page can't reload forever.
     */
    function checkStreamAFilterSetup() {
        if (streamAPageLoadedAt === null) {
            return true; // page hasn't fired its load event yet — nothing to judge
        }
        const sinceLoad = Date.now() - streamAPageLoadedAt;
        if (sinceLoad < CONFIG.STREAM_A_SETUP_INITIAL_SETTLE_MS) {
            return true; // loaded, but still settling — don't judge a not-yet-rendered screener as broken
        }

        const pillsContainer = document.querySelector(STREAM_A_FILTER_SELECTOR);
        const pillsCount = pillsContainer ? pillsContainer.children.length : 0;
        const pillsOk = pillsCount > CONFIG.STREAM_A_FILTER_MIN_PILLS;

        const columnCount = document.querySelectorAll('thead th[data-field]').length;
        const columnsOk = columnCount > CONFIG.STREAM_A_MIN_TABLE_COLUMNS;

        const rowCount = document.querySelectorAll('tbody tr[data-rowkey]').length;
        const rowsOk = rowCount >= CONFIG.STREAM_A_MIN_TABLE_ROWS;

        const setupOk = pillsOk && columnsOk && rowsOk;

        if (setupOk) {
            if (GM_getValue('streamASetup_retryCount', 0) !== 0) {
                GM_setValue('streamASetup_retryCount', 0);
                console.log(`[Stream-A-Setup] ✅ Setup confirmed (pills:${pillsCount} columns:${columnCount} rows:${rowCount}) — retry counter reset.`);
            }
            return true;
        }

        const count = GM_getValue('streamASetup_retryCount', 0);
        const lastTriggerAt = GM_getValue('streamASetup_lastTriggerAt', 0);
        console.warn(`[Stream-A-Setup] ⚠️ Setup incomplete — pills:${pillsCount}(need>${CONFIG.STREAM_A_FILTER_MIN_PILLS}) columns:${columnCount}(need>${CONFIG.STREAM_A_MIN_TABLE_COLUMNS}) rows:${rowCount}(need>=${CONFIG.STREAM_A_MIN_TABLE_ROWS}). Retry ${count}/${CONFIG.STREAM_A_SETUP_MAX_RETRIES}.`);

        if (count >= CONFIG.STREAM_A_SETUP_MAX_RETRIES) {
            const reloadCount = GM_getValue('streamASetup_reloadCount', 0);
            if (reloadCount >= CONFIG.STREAM_A_SETUP_MAX_RELOADS) {
                console.error(`[Stream-A-Setup] ❌ Still broken after ${CONFIG.STREAM_A_SETUP_MAX_RETRIES} retries AND ${reloadCount} reloads — giving up entirely to avoid a reload loop. Check the screener manually.`);
                return false;
            }
            GM_setValue('streamASetup_reloadCount', reloadCount + 1);
            GM_setValue('streamASetup_retryCount', 0); // fresh retry budget after the reload
            console.error(`[Stream-A-Setup] 🔄 Still broken after ${CONFIG.STREAM_A_SETUP_MAX_RETRIES} Automa retries — reloading the page (reload ${reloadCount + 1}/${CONFIG.STREAM_A_SETUP_MAX_RELOADS}).`);
            location.reload();
            return false;
        }

        // Progressive backoff: cooldown grows with each successive retry
        // (5min, 7min, 10min) instead of a flat 5min for every attempt —
        // gives a still-broken screener more breathing room on later
        // retries rather than stacking Automa dispatches close together.
        const cooldownMs = CONFIG.STREAM_A_SETUP_COOLDOWN_STEPS_MS[count] ?? CONFIG.STREAM_A_SETUP_COOLDOWN_MS;
        if (Date.now() - lastTriggerAt < cooldownMs) {
            return false; // already triggered recently — give the workflow time to land
        }

        GM_setValue('streamASetup_retryCount', count + 1);
        GM_setValue('streamASetup_lastTriggerAt', Date.now());
        const workflowId = dynamicStreamASetupWorkflowId || CONFIG.STREAM_A_SETUP_AUTOMA_WORKFLOW_ID;
        console.log(`[Stream-A-Setup] 🔧 Dispatching Automa setup workflow ${workflowId}${dynamicStreamASetupWorkflowId ? ' (live from backend)' : ' (hardcoded fallback — no backend response received yet)'} (attempt ${count + 1}/${CONFIG.STREAM_A_SETUP_MAX_RETRIES}).`);
        window.dispatchEvent(new CustomEvent('automa:execute-workflow', {
            detail: { id: workflowId }
        }));
        return false;
    }

    // ═══════════════════════════════════════════════════════════════
    // STATE
    // ═══════════════════════════════════════════════════════════════
    const STATE = {
        lastProcessedData: null,
        lastScanTime: null,
        history: [],
        recommendations: { buy: [], sell: [], retrace: [] },
        unfiltered: { buy: [], sell: [], retrace: [] },
        missed: { buy: [], sell: [], retrace: [] },
        scanIntervalId: null,
        currentFilters: null,
        currentScanName: 'default',
        isPaused: false,
        isScanning: false,
        scanStartTime: 0, // WATCHDOG: Track when scan started
        lastScanHash: null,
        processDebounceTimer: null,

        autoScanCount: 0,
        lastAutoTriggerHash: null,
        lastScanType: null,

        lastSentHash: null,
        lastSentTime: null,

        // State Machine: Alert Batching
        alertBatchPending: false,
        alertBatchTimestamp: null,
        cyclesSinceAlertDetected: 0,
        alertScanPending: false, // Prevents auto-scans from stealing buffer during stabilization
        alertLockTime: 0, // Track when the lock was acquired
    };

    const DEFAULT_FILTERS = {
        minResistDist: 2.0,
        minSupportDist: null,
        minScore: 30,
        excludeFreeze: true,
        excludeCompressed: true,
    };

    STATE.currentFilters = { ...DEFAULT_FILTERS };

    const POSITION_CODE_SCORES = {
        530: 35, 502: 35, 430: 32, 403: 32, 521: 30, 500: 28, 104: 28,
        340: 28, 231: 25, 221: 20, 212: 15, 222: 10, 421: 18, 412: 18,
    };

    const COLORS = {
        bull: { base: '#00c853', bright: '#00ff41' },
        bear: { base: '#ff5252', bright: '#ff1744' },
        purple: '#ba68c8',
        purpleDark: '#9c27b0',
    };

    // ═══════════════════════════════════════════════════════════════
    // OFFLINE STORE & PAYLOAD MANAGER
    // ═══════════════════════════════════════════════════════════════
    const OfflineStore = {
        QUEUE_KEY: 'scan_payload_queue',
        MAX_RETENTION_MS: 72 * 60 * 60 * 1000,

        getQueue: function () {
            try {
                const json = GM_getValue(this.QUEUE_KEY, '[]');
                return JSON.parse(json);
            } catch (e) {
                console.error('Error reading offline queue:', e);
                return [];
            }
        },

        saveQueue: function (queue) {
            try {
                GM_setValue(this.QUEUE_KEY, JSON.stringify(queue));
            } catch (e) {
                console.error('Error saving offline queue:', e);
            }
        },

        add: function (payload) {
            const queue = this.getQueue();
            const item = {
                id: payload.id || Date.now(),
                timestamp: Date.now(),
                payload: payload,
                type: payload.trigger || 'unknown'
            };
            queue.push(item);
            this.saveQueue(queue);
            console.log(`[OfflineStore] Saved item ${item.id} (${item.type}). Queue size: ${queue.length}`);
        },

        prune: function () {
            const queue = this.getQueue();
            const now = Date.now();
            const valid = queue.filter(item => (now - item.timestamp) < this.MAX_RETENTION_MS);
            if (valid.length !== queue.length) {
                console.log(`[OfflineStore] Pruned ${queue.length - valid.length} old items`);
                this.saveQueue(valid);
            }
        }
    };

    function sendPayload(payload, changeDetection = {}) {
        OfflineStore.prune();

        // TRANSACTIONAL COUNT: Capture how many alerts we are taking
        // This effectively "locks" this specific batch for removal upon success
        const alertsToSendCount = payload.institutional_pulse && payload.institutional_pulse.alerts ? payload.institutional_pulse.alerts.length : 0;

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`📦 SENDING PAYLOAD: ${payload.trigger}`);
        console.log(`📦 FULL PAYLOAD DEBUG:`, payload);
        console.log(`${'═'.repeat(60)}`);
        console.log(`   Endpoint: ${CONFIG.AUTO_TRIGGER_ENDPOINT}`);
        console.log(`   Alerts: ${alertsToSendCount}`);
        console.log(`   Data Changed: ${changeDetection.hasChanged}`);
        console.log(`${'═'.repeat(60)}\n`);

        GM_xmlhttpRequest({
            method: 'POST',
            url: CONFIG.AUTO_TRIGGER_ENDPOINT,
            data: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' },
            onload: (response) => {
                if (response.status === 200) {
                    console.log(`✅ Payload sent successfully: ${payload.id}`);

                    if (response.responseText) {
                        try {
                            const resJson = JSON.parse(response.responseText);
                            console.log('📥 Response:', resJson);

                            // SMART SYNC: Update latest confirmed alert timestamp
                            if (resJson.last_alert_ts) {
                                const ts = new Date(resJson.last_alert_ts).getTime();
                                if (ts > (unsafeWindow.latestConfirmedAlertTs || 0)) {
                                    unsafeWindow.latestConfirmedAlertTs = ts;
                                    const localTime = new Date(ts).toLocaleTimeString('en-IN', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
                                    console.log(`[Sync] 🔄 Updated Confirm Head: ${localTime}`);
                                }
                            }

                            // 2026-09-16: pick up the live Stream A setup-fix workflow ID.
                            // Previously the Ghost Coin widget's settings-panel field for
                            // this had nowhere to go — the script only ever used its own
                            // hardcoded constant, so editing the preset in the UI silently
                            // did nothing. checkStreamAFilterSetup() now dispatches this
                            // value once it arrives (falls back to the hardcoded default
                            // until the first successful response of a fresh page load).
                            if (resJson.stream_a_setup_workflow_id && resJson.stream_a_setup_workflow_id !== dynamicStreamASetupWorkflowId) {
                                console.log(`[Stream-A-Setup] 📡 Backend workflow ID updated: ${dynamicStreamASetupWorkflowId || '(none yet, using hardcoded default)'} → ${resJson.stream_a_setup_workflow_id}`);
                                dynamicStreamASetupWorkflowId = resJson.stream_a_setup_workflow_id;
                            }

                            // 2026-09-10: backend-driven tab activation — same pattern as
                            // Stream B v20.30. The backend decides (scans table staleness)
                            // whether this tab needs to come to front and hands down
                            // whichever workflow ID it wants dispatched. Never hardcoded
                            // here — the backend owns which ID that is.
                            if (resJson.activate_tab_workflow_id) {
                                const lastTabActivateAt = GM_getValue('tabActivate_lastTriggerAt', 0);
                                if (Date.now() - lastTabActivateAt >= CONFIG.TAB_ACTIVATE_COOLDOWN_MS) {
                                    GM_setValue('tabActivate_lastTriggerAt', Date.now());
                                    console.log(`[Tab-Activate] 🔔 Backend flagged this stream as stale/hidden — dispatching Automa workflow ${resJson.activate_tab_workflow_id} to bring the tab to front.`);
                                    window.dispatchEvent(new CustomEvent('automa:execute-workflow', {
                                        detail: { id: resJson.activate_tab_workflow_id }
                                    }));
                                }
                            }
                        } catch (e) {
                            console.warn('[Sync] ⚠️ JSON Parse Error on response', e);
                        }
                    }

                    // TRANSACTIONAL FLUSH: Only remove exactly what we sent
                    // This creates a "Sliding Window" that preserves any NEW alerts that arrived during network latency
                    if (alertsToSendCount > 0 && unsafeWindow.pendingAlertBatch) {
                        console.log(`[Cleanup] 🧹 Flushing ${alertsToSendCount} confirmed alerts (Splice)`);
                        unsafeWindow.pendingAlertBatch.splice(0, alertsToSendCount);
                        console.log(`[Cleanup] 📦 Buffer remaining: ${unsafeWindow.pendingAlertBatch.length}`);
                    }

                    STATE.lastSentTime = Date.now();
                    flushNextOfflineItem();
                } else {
                    console.warn(`❌ Backend error ${response.status}. Saving to offline store.`);
                    OfflineStore.add(payload);
                }
            },
            onerror: (err) => {
                console.error('❌ Network error. Saving to offline store:', err);
                OfflineStore.add(payload);
            },
            ontimeout: () => {
                console.error('⏱️ Timeout. Saving to offline store.');
                OfflineStore.add(payload);
            },
            timeout: 10000
        });
    }

    function flushNextOfflineItem() {
        const queue = OfflineStore.getQueue();
        if (queue.length === 0) return;

        const item = queue[0];
        console.log(`[Sync] Flushing offline item ${item.id}...`);

        GM_xmlhttpRequest({
            method: 'POST',
            url: CONFIG.AUTO_TRIGGER_ENDPOINT,
            data: JSON.stringify(item.payload),
            headers: { 'Content-Type': 'application/json' },
            onload: (response) => {
                // [UPDATED] Transactional Removal: ONLY Valid HTTP 200 or 409 (Conflict/Duplicate)
                if (response.status === 200 || response.status === 409) {
                    if (response.status === 409) {
                        console.warn(`[Sync] ⚠️ Item ${item.id} already exists (Duplicate). Removing from queue.`);
                    } else {
                        console.log(`[Sync] ✅ Successfully flushed item ${item.id}`);
                        // Update Sync Head (Last Alert TS)
                        try {
                            const resJson = JSON.parse(response.responseText);
                            if (resJson.last_alert_ts) {
                                const ts = new Date(resJson.last_alert_ts).getTime();
                                if (ts > (unsafeWindow.latestConfirmedAlertTs || 0)) {
                                    unsafeWindow.latestConfirmedAlertTs = ts;
                                    console.log(`[Sync] 🔄 Updated Confirm Head: ${resJson.last_alert_ts}`);
                                }
                            }
                        } catch (e) {
                            console.warn("[Sync] JSON Parse Error on offline flush sync:", e);
                        }
                    }

                    // [CRITICAL] Remove the head ONLY after success
                    const updatedQueue = OfflineStore.getQueue(); // Reload to be safe
                    if (updatedQueue.length > 0 && updatedQueue[0].id === item.id) {
                        updatedQueue.shift(); // Remove head
                        OfflineStore.saveQueue(updatedQueue);
                    }

                    // Recursively process next item
                    setTimeout(() => flushNextOfflineItem(), 1000); // Small delay to breathe
                } else {
                    console.warn(`[Sync] ❌ Failed to flush ${item.id} (Status ${response.status}). Retrying later.`);
                }
            },
            onerror: (err) => {
                console.error(`[Sync] ❌ Network error flashing ${item.id}`);
            },
            timeout: 10000
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════
    function cleanTicker(ticker) {
        if (!ticker) { return ''; }
        return ticker
            .replace(/\.P$/i, '')
            .replace(/USDT$/i, '')
            .replace(/BUSD$/i, '')
            .replace(/USD$/i, '');
    }

    function parseTvNumber(text) {
        if (!text || text === '—' || text === '') { return null; }
        text = String(text)
            .replace('−', '-')
            .replace('%', '')
            .replace(/,/g, '')
            .trim();
        const val = parseFloat(text);
        return isNaN(val) ? null : val;
    }

    function formatTimestamp(date = new Date()) {
        return date.toLocaleTimeString('en-IN', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true,
        });
    }

    function generateDataHash(coins) {
        if (!coins || coins.length === 0) { return 'empty'; }
        // Compute hash of ALL coins to ensure any change is detected
        const str = coins
            .map((c) => `${c.ticker}:${c.netTrend}:${c.resistDist}`)
            .join('|');
        return str;
    }

    // ═══════════════════════════════════════════════════════════════
    // CHANGE DETECTION
    // ═══════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════
    // CHANGE DETECTION
    // ═══════════════════════════════════════════════════════════════
    function detectDataChange(scanType) {
        const currentHash = generateDataHash(STATE.lastProcessedData || []);
        const hasPendingAlerts = unsafeWindow.pendingAlertBatch && unsafeWindow.pendingAlertBatch.length > 0;

        const result = {
            currentHash: currentHash,
            lastSentHash: STATE.lastSentHash,
            hasChanged: currentHash !== STATE.lastSentHash,
            hasPendingAlerts: hasPendingAlerts,
            timeSinceLastSend: STATE.lastSentTime ? Date.now() - STATE.lastSentTime : Infinity,
            shouldSend: false,
            reason: ''
        };

        if (hasPendingAlerts) {
            result.shouldSend = true;
            result.reason = `Pending alerts detected (${unsafeWindow.pendingAlertBatch.length}) - forcing flush`;
            return result;
        }

        switch (scanType) {
            case 'auto':
                // Force send every 2nd scan (heartbeat) even if data hasn't changed
                if ((STATE.autoScanCount % CONFIG.AUTO_TRIGGER_AFTER_SCANS) === 0) {
                    result.shouldSend = true;
                    result.reason = result.hasChanged ? 'Auto-scan: Data changed' : 'Auto-scan: Heartbeat (every 2nd scan)';
                } else {
                    result.shouldSend = result.hasChanged;
                    result.reason = result.hasChanged ? 'Data changed' : 'Data unchanged - skipping';
                }
                break;

            case 'manual':
                result.shouldSend = false;
                result.reason = 'Manual scan - process only, no auto-send';
                break;

            case 'manual-trigger':
                result.shouldSend = true;
                result.reason = result.hasChanged
                    ? 'Manual trigger with data change'
                    : 'Manual trigger - forcing send despite no change';
                break;

            case 'alert-triggered':
                if (!result.hasChanged) {
                    // Force send even if data unchanged, to capture the alert event itself
                    result.shouldSend = true;
                    result.reason = 'Alert fired - forcing send even if market data is static';
                } else {
                    result.shouldSend = true;
                    result.reason = 'Alert-triggered with confirmed market data change';
                }
                break;

            default:
                result.shouldSend = result.hasChanged;
                result.reason = 'Default: send if changed';
        }

        return result;
    }



    // ═══════════════════════════════════════════════════════════════
    // FIND SCAN BUTTON
    // ═══════════════════════════════════════════════════════════════
    function findScanButton() {
        let btn = document.querySelector('[data-name="pine-screener-scan-btn"]');
        if (btn) { return btn; }


        const buttons = document.querySelectorAll('button');
        for (let button of buttons) {
            if (button.innerText && button.innerText.toLowerCase().includes('scan')) {
                return button;
            }
        }
        return null;
    }

    // ═══════════════════════════════════════════════════════════════
    // COLUMN DETECTION
    // ═══════════════════════════════════════════════════════════════
    function detectTableAndColumns() {
        const tables = document.querySelectorAll('table');
        for (let table of tables) {
            const headers = table.querySelectorAll('thead tr th');
            if (headers.length === 0) continue;


            const columnMap = {};

            headers.forEach((th, index) => {
                const textDiv = th.querySelector('[class*="upperLine"]');
                // Fallback: Use direct TH text if upperLine not found
                const text = textDiv ? textDiv.innerText.trim().toLowerCase() : th.innerText.trim().toLowerCase();
                const combined = `${text} ${(th.getAttribute('title') || '').toLowerCase()}`;

                if (combined.includes('symbol') || combined.includes('ticker') || combined.includes('coin') || combined.includes('pair') || combined.includes('name') || combined.includes('asset')) {
                    columnMap.TICKER = index;
                } else if ((combined.includes('close') || combined.includes('price') || combined.includes('last')) && !combined.includes('dist')) {
                    columnMap.CLOSE = index;
                } else if (combined.includes('vol spike')) {
                    columnMap.VOL_SPIKE = index;
                } else if (combined.includes('moment') || combined.includes('mom score')) {
                    columnMap.MOM_SCORE = index;
                } else if (combined.includes('roc')) {
                    columnMap.ROC = index;
                } else if (combined.includes('ema trend')) {
                    columnMap.EMA_TREND = index;
                } else if (combined.includes('ema pos')) { // New: Position Code
                    columnMap.POSITION_CODE = index;
                }

                // EMA Distances
                else if (combined.includes('1h ema50 dist')) {
                    columnMap.EMA50_DIST = index;
                } else if (combined.includes('1h ema200 dist')) {
                    columnMap.EMA200_DIST = index;
                }

                // Support/Resist (Logic & Standard)
                else if (combined.includes('logic support dist')) {
                    columnMap.LOGIC_SUPPORT_DIST = index;
                } else if (combined.includes('logic resist dist')) {
                    columnMap.LOGIC_RESIST_DIST = index;
                } else if (combined.includes('support dist')) {
                    columnMap.SUPPORT_DIST = index;
                } else if (combined.includes('support stars')) {
                    columnMap.SUPPORT_STARS = index;
                } else if (combined.includes('resist dist')) {
                    columnMap.RESIST_DIST = index;
                } else if (combined.includes('resist stars')) {
                    columnMap.RESIST_STARS = index;
                }

                // Daily Context
                else if (combined.includes('daily range')) {
                    columnMap.DAILY_RANGE = index;
                } else if (combined.includes('daily trend')) {
                    columnMap.DAILY_TREND = index;
                }

                // Signals
                else if (combined.includes('freeze')) {
                    columnMap.FREEZE = index;
                } else if (combined.includes('breakout')) {
                    columnMap.BREAKOUT = index;
                } else if (combined.includes('net trend')) {
                    columnMap.NET_TREND = index;
                } else if (combined.includes('retrace')) {
                    columnMap.RETRACE_OPP = index;
                }

                // Cluster Analysis
                else if (combined.includes('scope count')) {
                    columnMap.SCOPE_COUNT = index;
                } else if (combined.includes('scope highest')) {
                    columnMap.CLUSTER_SCOPE_HIGHEST = index;
                } else if (combined.includes('compress count')) {
                    columnMap.CLUSTER_COMPRESS_COUNT = index;
                } else if (combined.includes('compress highest')) {
                    columnMap.CLUSTER_COMPRESS_HIGHEST = index;
                }

                // Flags & Mega Spot
                else if (combined.includes('all ema flags')) {
                    columnMap.EMA_FLAGS = index;
                } else if (combined.includes('htf 200 flags')) {
                    columnMap.HTF_FLAGS = index;
                } else if (combined.includes('mega spot')) {
                    columnMap.MEGA_SPOT_DIST = index;
                } else if (combined.includes('ema position') || combined.includes('position code')) {
                    columnMap.POSITION_CODE = index;
                }
            });



            if (columnMap.TICKER !== undefined && columnMap.CLOSE !== undefined) {
                console.log('[Parse] ✅ Found valid table. Column Mapping:');
                const debugMap = Object.keys(columnMap).map(key => ({
                    Key: key,
                    Index: columnMap[key],
                    HeaderText: headers[columnMap[key]]?.innerText.replace(/\n/g, ' ').trim() || '???'
                }));
                console.table(debugMap);
                return { map: columnMap, table: table };
            }
        }
        console.warn('[Parse] ❌ No valid table found (searched for Symbol + Close headers)');
        return null;
    }

    function extractTicker(row) {
        const link = row.querySelector('a[class*="tickerName"]');
        if (link) { return link.innerText.trim(); }


        const rowKey = row.getAttribute('data-rowkey');
        if (rowKey) {
            const parts = rowKey.split(':');
            if (parts.length > 1) return parts[1].replace('.P', '').trim();
        }
        return 'UNKNOWN';
    }

    // ═══════════════════════════════════════════════════════════════
    // PARSE TABLE
    // ═══════════════════════════════════════════════════════════════
    function parseTableData() {
        const result = detectTableAndColumns();
        if (!result) {
            console.warn('[Parse] Table/Column detection failed');
            return [];
        }
        const { map: columnMap, table } = result;

        const rawRows = table.querySelectorAll('tbody tr');
        const rows = Array.from(rawRows).filter(r => r.querySelectorAll('td').length > 0);

        console.log(`[Parse] Found ${rows.length} valid rows via Content Discovery.`);
        if (rows.length === 0) {
            console.warn('[Parse] No data rows found with selectors: listRow[data-rowkey] OR tr[data-rowkey]');
            // Dump table HTML structure to help debug if user sees console
            const tbody = document.querySelector('tbody');
            if (tbody) console.log('[Parse] First row HTML:', tbody.firstElementChild ? tbody.firstElementChild.outerHTML : 'Empty TBODY');
            return [];
        }

        const coins = [];

        rows.forEach((row) => {
            const cells = row.querySelectorAll('td'); // Just get all cells, ignore class names
            const rowKey = row.getAttribute('data-rowkey') || ''; // Capture BINANCE:ADAUSDT.P

            const coin = {
                row: row,
                ticker: extractTicker(row),
                exchange_symbol: rowKey, // Existing
                datakey: rowKey, // NEW: Explicit request for "datakey"
                close: parseTvNumber(cells[columnMap.CLOSE]?.innerText),

                // Indicators
                roc: parseTvNumber(cells[columnMap.ROC]?.innerText), // New
                volSpike: parseTvNumber(cells[columnMap.VOL_SPIKE]?.innerText),
                momScore: parseTvNumber(cells[columnMap.MOM_SCORE]?.innerText),

                // EMA
                ema50Dist: parseTvNumber(cells[columnMap.EMA50_DIST]?.innerText),
                ema200Dist: parseTvNumber(cells[columnMap.EMA200_DIST]?.innerText),

                // Support/Resist
                supportDist: parseTvNumber(cells[columnMap.SUPPORT_DIST]?.innerText),
                supportStars: parseTvNumber(cells[columnMap.SUPPORT_STARS]?.innerText),
                resistDist: parseTvNumber(cells[columnMap.RESIST_DIST]?.innerText),
                resistStars: parseTvNumber(cells[columnMap.RESIST_STARS]?.innerText),
                logicSupportDist: parseTvNumber(cells[columnMap.LOGIC_SUPPORT_DIST]?.innerText),
                logicResistDist: parseTvNumber(cells[columnMap.LOGIC_RESIST_DIST]?.innerText),

                // Daily
                dailyRange: parseTvNumber(cells[columnMap.DAILY_RANGE]?.innerText),
                dailyTrend: parseTvNumber(cells[columnMap.DAILY_TREND]?.innerText),

                // Signals
                freeze: parseTvNumber(cells[columnMap.FREEZE]?.innerText),
                breakout: parseTvNumber(cells[columnMap.BREAKOUT]?.innerText),
                netTrend: parseTvNumber(cells[columnMap.NET_TREND]?.innerText),
                retraceOpportunity: parseTvNumber(cells[columnMap.RETRACE_OPP]?.innerText),

                // Cluster
                scopeCount: parseTvNumber(cells[columnMap.SCOPE_COUNT]?.innerText),
                clusterScopeHighest: parseTvNumber(cells[columnMap.CLUSTER_SCOPE_HIGHEST]?.innerText),
                compressCount: parseTvNumber(cells[columnMap.CLUSTER_COMPRESS_COUNT]?.innerText),
                compressHighest: parseTvNumber(cells[columnMap.CLUSTER_COMPRESS_HIGHEST]?.innerText),

                // Flags & Mega
                emaFlags: parseTvNumber(cells[columnMap.EMA_FLAGS]?.innerText),
                htfFlags: parseTvNumber(cells[columnMap.HTF_FLAGS]?.innerText),
                megaSpotDist: parseTvNumber(cells[columnMap.MEGA_SPOT_DIST]?.innerText),
                positionCode: parseTvNumber(cells[columnMap.POSITION_CODE]?.innerText),
            };

            // Sanity guard (2026-09-01): confirmed live — 18 garbage "ticker" rows
            // (fragments of Automa's own workflow-editor JSON — "AUTOMA-BLOCKS",
            // {"NODES", "BLOCKDELAY", {"WIDTH", 1000}, {"SOURCE"...) got scraped
            // into real scan_results and sent to the backend, then showed up as
            // permanently "frozen tickers" in the Data Feed Health widget. Same
            // root cause as the Stream B watchlist corruption (a clipboard/paste
            // collision put JSON where a symbol should be) — this just never had
            // a matching guard on the Stream A side. A real ticker is always short
            // and punctuation-free; reject anything else before it ever enters coins[].
            const isJunkTicker = !coin.ticker || coin.ticker === 'UNKNOWN'
                || coin.ticker.length > 20 || /[{}"\\[\]]/.test(coin.ticker);
            if (isJunkTicker) {
                if (coin.ticker && coin.ticker !== 'UNKNOWN') {
                    console.warn(`[Parse] ⚠️ Skipping non-ticker garbage row: "${String(coin.ticker).slice(0, 60)}"`);
                }
                return;
            }
            coins.push(coin);
        });

        return coins;
    }

    // ═══════════════════════════════════════════════════════════════
    // MARKET SENTIMENT
    // ═══════════════════════════════════════════════════════════════
    function analyzeMarketSentiment(allCoins) {
        const sentiment = {
            totalCoins: allCoins.length,
            bullish: 0,
            bearish: 0,
            neutral: 0,
            moodScore: 0,
            moodEmoji: '😐',
            mood: 'RANGING',
            insights: [],
            // Detailed Ticker Splits (Section 4 Requirement)
            tickers: {
                bullish: [],
                bearish: [],
                neutral: []
            }
        };

        allCoins.forEach((coin) => {
            const clean = cleanTicker(coin.ticker);
            // Lightweight Object for Replay (Enriched)
            const miniCoin = {
                t: clean,
                s: coin.score || 0,
                nt: coin.netTrend || 0,
                c: coin.close || 0,
                v: coin.volSpike || 0,
                m: coin.momScore || 0,
                l: coin.label || ''
            };

            if ((coin.netTrend || 0) > 40) {
                sentiment.bullish++;
                sentiment.tickers.bullish.push(miniCoin);
            }
            else if ((coin.netTrend || 0) < -40) {
                sentiment.bearish++;
                sentiment.tickers.bearish.push(miniCoin);
            }
            else {
                sentiment.neutral++;
                sentiment.tickers.neutral.push(miniCoin);
            }
        });

        const bullWeight = sentiment.bullish * 2;
        const bearWeight = sentiment.bearish * 2;
        const validCoins = allCoins.length > 0 ? allCoins.length : 1; // Prevent div by zero
        sentiment.moodScore = Math.round(
            ((bullWeight - bearWeight) / validCoins) * 50
        );
        sentiment.moodScore = Math.max(-100, Math.min(100, sentiment.moodScore));

        if (sentiment.moodScore >= 60) {
            sentiment.mood = 'STRONGLY BULLISH';
            sentiment.moodEmoji = '🚀';
        } else if (sentiment.moodScore >= 30) {
            sentiment.mood = 'BULLISH';
            sentiment.moodEmoji = '📈';
        } else if (sentiment.moodScore <= -60) {
            sentiment.mood = 'STRONGLY BEARISH';
            sentiment.moodEmoji = '📉';
        } else if (sentiment.moodScore <= -30) {
            sentiment.mood = 'BEARISH';
            sentiment.moodEmoji = '⚠️';
        }

        return sentiment;
    }

    // ═══════════════════════════════════════════════════════════════
    // RECOMMENDATION SCORING
    // ═══════════════════════════════════════════════════════════════
    function calculateRecommendation(coin) {
        let score = 0;
        const insights = [];

        // Base Score from Position Code
        score += POSITION_CODE_SCORES[coin.positionCode] || 0;

        // Mega Zone
        if (coin.megaSpotDist !== null && Math.abs(coin.megaSpotDist) <= 0.5) {
            score += 20;
            insights.push('🎯 Mega zone');
        }

        // Trend Alignment (ENHANCED)
        const isBullishTrend = (coin.netTrend || 0) >= 60;
        const isDailyBull = (coin.dailyTrend || 0) === 1;

        if ((coin.resistDist || 0) >= 2.0 && isBullishTrend) {
            score += 20;
            insights.push('💪 Strong trend');

            // Boost if Daily Trend aligns
            if (isDailyBull) {
                score += 5;
                insights.push('☀️ Daily align');
            }
        }

        // Confluence
        if ((coin.supportStars || coin.resistStars || 0) >= 4) {
            score += 12;
            insights.push('⭐ High confluence');
        }

        // Momentum & Volume
        if ((coin.momScore || 0) >= 2) {
            score += coin.momScore === 3 ? 7 : 5;
        }
        if (coin.volSpike === 1) {
            score += 3;
            insights.push('📊 Volume');
        }

        // Breakout Signal (NEW)
        if (coin.breakout === 1) {
            score += 10;
            insights.push('🚀 Breakout');
        }

        // Warning Signs
        if ((coin.dailyRange || 0) > 80) insights.push('⚠️ Late entry');
        if ((coin.compressCount || 0) >= 3) {
            insights.push(`⚡ Compressed(${coin.compressCount})`);
        }
        if (coin.freeze === 1) insights.push('❄️ Frozen');

        let direction = 'NEUTRAL';
        if ((coin.resistDist || 0) >= 2.0) direction = 'BULL';
        else if ((coin.supportDist || 0) <= -2.0) direction = 'BEAR';

        const opacity =
            score < 30
                ? 0
                : Math.round((((score - 30) / 70) * 0.65 + 0.15) * 100) / 100;
        const color =
            score >= 90
                ? COLORS.bull.bright
                : direction === 'BULL'
                    ? COLORS.bull.base
                    : COLORS.bear.base;

        let label = '💤 WEAK';
        if (score >= 90) label = '🚀 MEGA';
        else if (score >= 75) label = '💪 STRONG';
        else if (score >= 60) label = '✅ GOOD';
        else if (score >= 45) label = '👀 WATCH';

        return { score, direction, opacity, color, insights, label };
    }

    // ═══════════════════════════════════════════════════════════════
    // FILTERS
    // ═══════════════════════════════════════════════════════════════
    function applyUnfilteredFilter(coin) {
        if (coin.score < CONFIG.UNFILTERED_MIN_SCORE) { return false; }
        if (CONFIG.UNFILTERED_EXCLUDE_FREEZE && (coin.freeze || 0) === 1) {
            return false;
        }
        return true;
    }

    function applyFilters(coin, filters) {
        if (filters.minScore && coin.score < filters.minScore) { return false; }
        if (filters.minResistDist && (coin.resistDist || 0) < filters.minResistDist) {
            return false;
        }
        if (filters.minSupportDist && (coin.supportDist || 0) > filters.minSupportDist) {
            return false;
        }
        if (filters.minNetTrend && (coin.netTrend || 0) < filters.minNetTrend) {
            return false;
        }
        if (filters.maxNetTrend && (coin.netTrend || 0) > filters.maxNetTrend) {
            return false;
        }
        if (filters.minMomScore && (coin.momScore || 0) < filters.minMomScore) {
            return false;
        }

        if (filters.minStars) {
            const stars = Math.max(coin.resistStars || 0, coin.supportStars || 0);
            if (stars < filters.minStars) { return false; }
        }

        if (filters.positionCodes && filters.positionCodes.length > 0) {
            if (!filters.positionCodes.includes(coin.positionCode)) { return false; }
        }

        if (filters.maxMegaSpotDist !== undefined && coin.megaSpotDist !== null) {
            if (Math.abs(coin.megaSpotDist) > filters.maxMegaSpotDist) { return false; }
        }

        if (filters.excludeFreeze && (coin.freeze || 0) === 1) { return false; }
        if (filters.excludeCompressed && (coin.compressCount || 0) >= 4) {
            return false;
        }

        return true;
    }

    function getFilterFailureReason(coin, filters) {
        const reasons = [];

        if (filters.minScore && coin.score < filters.minScore) {
            reasons.push(`Score ${coin.score} < ${filters.minScore}`);
        }
        if (
            filters.minResistDist &&
            (coin.resistDist || 0) < filters.minResistDist
        ) {
            reasons.push(
                `ResistDist ${(coin.resistDist || 0).toFixed(2)}% < ${filters.minResistDist
                }%`
            );
        }
        if (
            filters.minSupportDist &&
            (coin.supportDist || 0) > filters.minSupportDist
        ) {
            reasons.push(
                `SupportDist ${(coin.supportDist || 0).toFixed(2)}% > ${filters.minSupportDist
                }%`
            );
        }
        if (filters.minNetTrend && (coin.netTrend || 0) < filters.minNetTrend) {
            reasons.push(
                `NetTrend ${(coin.netTrend || 0).toFixed(1)} < ${filters.minNetTrend}`
            );
        }
        if (filters.minMomScore && (coin.momScore || 0) < filters.minMomScore) {
            reasons.push(`MomScore ${coin.momScore || 0} < ${filters.minMomScore}`);
        }
        if (filters.minStars) {
            const stars = Math.max(coin.resistStars || 0, coin.supportStars || 0);
            if (stars < filters.minStars) {
                reasons.push(`Stars ${stars} < ${filters.minStars}`);
            }
        }
        if (filters.excludeCompressed && (coin.compressCount || 0) >= 4) {
            reasons.push(`Over-compressed (${coin.compressCount})`);
        }

        return reasons.join(', ') || 'Unknown';
    }

    function serializeTickerForHistory(coin, missedReason = null) {
        const data = {
            ticker: coin.ticker,
            cleanTicker: cleanTicker(coin.ticker),
            datakey: coin.datakey || coin.exchange_symbol, // [NEW] Essential for payload
            exchange_symbol: coin.exchange_symbol, // [NEW]
            score: coin.score,
            label: coin.label,
            direction: coin.direction,
            insights: coin.insights || [],

            close: coin.close,
            dailyRange: coin.dailyRange,
            dailyTrend: coin.dailyTrend,

            netTrend: coin.netTrend,
            momScore: coin.momScore,
            volSpike: coin.volSpike,
            breakout: coin.breakout,

            resistDist: coin.resistDist,
            resistStars: coin.resistStars,
            logicResistDist: coin.logicResistDist,

            supportDist: coin.supportDist,
            supportStars: coin.supportStars,
            logicSupportDist: coin.logicSupportDist,

            ema50Dist: coin.ema50Dist,
            ema200Dist: coin.ema200Dist,

            positionCode: coin.positionCode,
            megaSpotDist: coin.megaSpotDist,
            retraceOpportunity: coin.retraceOpportunity,

            scopeCount: coin.scopeCount,
            clusterScopeHighest: coin.clusterScopeHighest,
            compressCount: coin.compressCount,
            compressHighest: coin.compressHighest,

            freeze: coin.freeze,
            emaFlags: coin.emaFlags,
            htfFlags: coin.htfFlags,
        };

        if (missedReason) {
            data.missedReason = missedReason;
        }

        return data;
    }

    // ═══════════════════════════════════════════════════════════════
    // VISUAL HIGHLIGHTING
    // ═══════════════════════════════════════════════════════════════
    function resetAllBackgrounds() {
        const rows = document.querySelectorAll('tr[class*="listRow"]');
        rows.forEach((row) => {
            row.style.backgroundColor = '';
            row.style.border = '';
            row.style.boxShadow = '';
            row.style.borderLeft = '';
            const badge = row.querySelector('[data-retrace-badge]');
            if (badge) badge.remove();
        });
    }

    function applyVisualHighlighting(coin) {
        const row = coin.row;
        if (!row) { return; }


        if ((coin.retraceOpportunity || 0) >= 1) {
            const opacity =
                coin.retraceOpportunity >= 3
                    ? 0.45
                    : coin.retraceOpportunity >= 2
                        ? 0.3
                        : 0.2;
            row.style.backgroundColor = `rgba(186, 104, 200, ${opacity})`;
            row.style.borderLeft = `4px solid ${COLORS.purple}`;
            return;
        }



        if (coin.opacity === 0) { return; }


        const r = parseInt(coin.color.slice(1, 3), 16);
        const g = parseInt(coin.color.slice(3, 5), 16);
        const b = parseInt(coin.color.slice(5, 7), 16);
        row.style.backgroundColor = `rgba(${r}, ${g}, ${b}, ${coin.opacity})`;

        if (coin.score >= 90) {
            row.style.border = `3px solid ${coin.color}`;
            row.style.boxShadow = `0 0 12px ${coin.color}`;
        } else if (coin.score >= 75) {
            row.style.border = `2px solid ${coin.color}`;
        } else if (coin.score >= 45) {
            row.style.borderLeft = `4px solid ${coin.color}`;
        }
    }

    function updateDocumentTitle(buys, sells, retraces, sentiment) {
        const parts = [];
        parts.push(
            `${sentiment.moodEmoji}${sentiment.moodScore > 0 ? '+' : ''}${sentiment.moodScore
            }`
        );
        parts.push(`(${buys.length}|${sells.length}|${retraces.length})`);

        if (buys.length > 0) {
            const top = buys
                .slice(0, 2)
                .map((c) => `${cleanTicker(c.ticker)}:${c.score}`)
                .join(' ');
            parts.push(top);
        }

        document.title = parts.join(' | ');
    }

    function printCoinDetails(coin, index, type = 'buy') {
        const cleanName = cleanTicker(coin.ticker);

        if (type === 'retrace') {
            const scopeInfo = coin.clusterScopeHighest
                ? `Scope:${coin.clusterScopeHighest.toFixed(1)}%`
                : '';
            const volInfo = coin.volSpike === 1 ? '🔥' : '';
            console.log(
                `#${index + 1} ${cleanName} ${coin.label} ${coin.score} | ${coin.retraceOpportunity
                }×EMAs ${volInfo} | Code:${coin.positionCode} | NT:${coin.netTrend || 0
                } | ${scopeInfo}`
            );
        } else if (type === 'buy') {
            const resistInfo =
                coin.resistDist !== null ? `R:${coin.resistDist.toFixed(1)}%` : 'R:N/A';
            const starsInfo = coin.resistStars ? `(${coin.resistStars}⭐)` : '';
            console.log(
                `#${index + 1} ${cleanName} ${coin.label} ${coin.score} | Code:${coin.positionCode
                } | NT:${coin.netTrend || 0} | ${resistInfo} ${starsInfo}`
            );
        } else if (type === 'sell') {
            const supportInfo =
                coin.supportDist !== null
                    ? `S:${coin.supportDist.toFixed(1)}%`
                    : 'S:N/A';
            const starsInfo = coin.supportStars ? `(${coin.supportStars}⭐)` : '';
            console.log(
                `#${index + 1} ${cleanName} ${coin.label} ${coin.score} | Code:${coin.positionCode
                } | NT:${coin.netTrend || 0} | ${supportInfo} ${starsInfo}`
            );
        }

        if (
            CONFIG.SHOW_INSIGHTS_UNFILTERED &&
            coin.insights &&
            coin.insights.length > 0
        ) {
            console.log(`   ${coin.insights.join(' | ')}`);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // UTILITY FUNCTIONS
    // ═══════════════════════════════════════════════════════════════
    function copyRecommendationsToClipboard() {
        const buys = STATE.recommendations.buy || [];
        const sells = STATE.recommendations.sell || [];
        const retraces = STATE.recommendations.retrace || [];

        if (buys.length === 0 && sells.length === 0 && retraces.length === 0) {
            console.log('[Copy] No recommendations to copy');
            return;
        }

        const symbols = [];

        [...buys, ...retraces, ...sells].forEach(coin => {
            const ticker = coin.ticker.replace(/\.P$/i, '');
            symbols.push(`BINANCE:${ticker}`);
        });

        const text = symbols.join(',');

        navigator.clipboard.writeText(text).then(() => {
            console.log(`[Copy] ✅ Copied ${symbols.length} symbols to clipboard`);
            console.log(`[Copy] ${text}`);
        }).catch(err => {
            console.error('[Copy] Failed:', err);
        });
    }

    function clickAllEventElements() {
        const selector =
            "div[class*='eventWrapper-'] div[class*='mainScrollWrapper-'] div[class*='buttonContent-']";
        const elements = document.querySelectorAll(selector);

        if (elements.length === 0) {
            console.log(
                '%c No elements found to click with that selector.',
                'color: orange'
            );
            return;
        }


        let clickedCount = 0;
        elements.forEach((element, index) => {
            try {
                setTimeout(() => {
                    element.click();
                    clickedCount++;

                    if (clickedCount === elements.length) {
                        console.log(
                            `%c ✅ CLICKED ALL [${clickedCount}] ELEMENTS`,
                            'color: white; background: green; font-weight: bold; padding: 4px;'
                        );
                    }
                }, index * 50);
            } catch (e) {
                console.error(`Error clicking element ${index + 1}:`, e);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // GLOBAL STATE MACHINE VARIABLES (COMMUNICATION WITH ALERT_SCANNER)
    // ═══════════════════════════════════════════════════════════════
    unsafeWindow.institutionalPulse = unsafeWindow.institutionalPulse || [];
    unsafeWindow.pendingAlertBatch = unsafeWindow.pendingAlertBatch || [];
    unsafeWindow.batchedAlerts = unsafeWindow.batchedAlerts || null;
    unsafeWindow.triggerScreenerScan = unsafeWindow.triggerScreenerScan || false;
    unsafeWindow.latestConfirmedAlertTs = unsafeWindow.latestConfirmedAlertTs || 0;

    console.log('[Init] ✅ State machine variables initialized');
    console.log(`[Init] Buffer size: ${unsafeWindow.pendingAlertBatch.length} alerts`);

    // ═══════════════════════════════════════════════════════════════
    // INSTITUTIONAL PULSE INTEGRATION (UPDATED WITH DI/D SUPPORT)
    // ═══════════════════════════════════════════════════════════════
    function gatherInstitutionalPulse() {
        try {
            if (!window.batchedAlerts || !Array.isArray(window.batchedAlerts)) {
                console.warn('[Pulse] ⚠️ No batched alerts available or invalid format');
                return null;
            }

            if (window.batchedAlerts.length === 0) {
                console.warn('[Pulse] ⚠️ Batched alerts array is empty');
                return null;
            }

            console.log(`[Pulse] Processing ${window.batchedAlerts.length} batched alerts`);

            const batchedAlerts = window.batchedAlerts;

            const validAlerts = batchedAlerts.filter(alert => {
                return alert &&
                    alert.asset &&
                    alert.asset.ticker &&
                    alert.signal &&
                    alert.signal.timestamp;
            });

            if (validAlerts.length === 0) {
                console.warn('[Pulse] ⚠️ No valid alerts found (missing required fields)');
                return null;
            }

            if (validAlerts.length < batchedAlerts.length) {
                console.warn(`[Pulse] ⚠️ Filtered out ${batchedAlerts.length - validAlerts.length} invalid alerts`);
            }

            const alertTickers = new Set(
                validAlerts.map(a => {
                    try {
                        return a.asset.ticker.replace('.P', '').replace('USDT', '');
                    } catch (e) {
                        console.error('[Pulse] Error processing ticker:', e);
                        return null;
                    }
                }).filter(t => t !== null)
            );

            const correlation = {
                alertsInScreener: [],
                alertsNotInScreener: [],
                screenerWithoutAlerts: []
            };

            validAlerts.forEach(alert => {
                try {
                    const tickerClean = alert.asset.ticker.replace('.P', '').replace('USDT', '');

                    const inBuys = STATE.recommendations.buy.find(c => cleanTicker(c.ticker) === tickerClean);
                    const inSells = STATE.recommendations.sell.find(c => cleanTicker(c.ticker) === tickerClean);
                    const inRetraces = STATE.recommendations.retrace.find(c => cleanTicker(c.ticker) === tickerClean);

                    const screenerMatch = inBuys || inSells || inRetraces;

                    // Extract directional value (Di or D)
                    const directionalValue = alert.signal.di || alert.signal.d || 0;
                    const alertDirection = directionalValue === 1 ? 'BULL' :
                        directionalValue === -2 ? 'BEAR' :
                            'NEUTRAL';

                    if (screenerMatch) {
                        const alignment = alertDirection === screenerMatch.direction ? 'CONFIRMED' : 'DIVERGENCE';

                        correlation.alertsInScreener.push({
                            ticker: tickerClean,
                            alertTime: alert.signal.timestamp || 'N/A',
                            alertIntent: alert.signal.volume_intent || 'UNKNOWN',
                            alertDi: directionalValue,
                            alertDirection: alertDirection,
                            alertPrice: alert.signal.price || 0,
                            screenerScore: screenerMatch.score,
                            screenerDirection: screenerMatch.direction,
                            alignment: alignment,
                            signal: screenerMatch.score >= 70 && alignment === 'CONFIRMED' ? 'STRONG' : 'MODERATE'
                        });
                    } else {
                        const inUnfiltered = [...STATE.unfiltered.buy, ...STATE.unfiltered.sell, ...STATE.unfiltered.retrace]
                            .find(c => cleanTicker(c.ticker) === tickerClean);

                        correlation.alertsNotInScreener.push({
                            ticker: tickerClean,
                            alertTime: alert.signal.timestamp || 'N/A',
                            alertIntent: alert.signal.volume_intent || 'UNKNOWN',
                            alertDi: directionalValue,
                            alertDirection: alertDirection,
                            alertPrice: alert.signal.price || 0,
                            reason: inUnfiltered ? 'Filtered out' : 'Not in screener results',
                            screenerScore: inUnfiltered ? inUnfiltered.score : null
                        });
                    }
                } catch (e) {
                    console.error('[Pulse] Error processing alert:', e, alert);
                }
            });

            try {
                [...STATE.recommendations.buy, ...STATE.recommendations.sell].forEach(coin => {
                    const tickerClean = cleanTicker(coin.ticker);
                    if (!alertTickers.has(tickerClean)) {
                        correlation.screenerWithoutAlerts.push({
                            ticker: tickerClean,
                            score: coin.score,
                            direction: coin.direction,
                            signal: 'CONSIDER'
                        });
                    }
                });
            } catch (e) {
                console.error('[Pulse] Error processing screener matches:', e);
            }

            const strongSignals = correlation.alertsInScreener
                .filter(a => a.alignment === 'CONFIRMED' && a.signal === 'STRONG')
                .map(a => a.ticker);

            const divergence = correlation.alertsInScreener
                .filter(a => a.alignment === 'DIVERGENCE')
                .map(a => a.ticker);

            const watchList = correlation.screenerWithoutAlerts
                .filter(s => s.score >= 60)
                .slice(0, 5)
                .map(s => s.ticker);

            console.log(`[Pulse] ✅ Correlation: ${correlation.alertsInScreener.length} matched, ${correlation.alertsNotInScreener.length} not in screener`);
            console.log(`[Pulse] ✅ Strong signals: ${strongSignals.join(', ') || 'None'}`);

            return {
                alerts: validAlerts.map(a => {
                    const directionalValue = a.signal.di || a.signal.d || 0;
                    return {
                        ticker: a.asset.ticker,
                        cleanTicker: a.asset.ticker.replace('.P', '').replace('USDT', ''),
                        alertTime: a.signal.timestamp,
                        category: a.signal.category || 'UNKNOWN',
                        volumeIntent: a.signal.volume_intent || 'UNKNOWN',
                        di: directionalValue,
                        direction: directionalValue === 1 ? 'BULL' : directionalValue === -2 ? 'BEAR' : 'NEUTRAL',
                        price: a.signal.price || 0,
                        momentumPct: a.signal.momentum_pct || 0
                    };
                }),
                correlation: correlation,
                consensus: {
                    strongSignals: strongSignals,
                    divergence: divergence,
                    watchList: watchList
                }
            };

        } catch (error) {
            console.error('[Pulse] ❌ Critical error in gatherInstitutionalPulse:', error);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // PATTERN DETECTION
    // ═══════════════════════════════════════════════════════════════
    function detectTrend() {
        if (STATE.history.length < 3) {
            return 'insufficient_data';
        }

        const last3 = STATE.history.slice(-3);
        const moods = last3.map(h => h.marketSentiment.mood);

        if (moods.every(m => m.includes('BULLISH'))) {
            return 'consistent_bullish';
        }
        if (moods.every(m => m.includes('BEARISH'))) {
            return 'consistent_bearish';
        }
        return 'volatile';
    }

    function detectMomentumShift() {
        if (STATE.history.length < 2) {
            return false;
        }

        const prev = STATE.history[STATE.history.length - 2];
        const curr = STATE.history[STATE.history.length - 1];

        const moodChange = Math.abs(curr.marketSentiment.moodScore - prev.marketSentiment.moodScore);
        return moodChange >= 30;
    }

    // ═══════════════════════════════════════════════════════════════
    // PAYLOAD BUILDER (WITH SAFETY CHECKS AND DI/D SUPPORT)
    // ═══════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════
    // PAYLOAD BUILDER (OPTIMIZED V2 - JAN 2026)
    // ═══════════════════════════════════════════════════════════════
    function buildFinalPayload(historyEntry, scanType, dataChangeInfo) {
        try {
            // 1. RECONSTRUCT AI PRIORITY (Lightweight, Readable Keys)
            const aiPriority = {
                scan: {
                    number: historyEntry.scanNumber,
                    type: scanType,
                    market_mood: historyEntry.marketSentiment.mood,
                    mood_score: historyEntry.marketSentiment.moodScore
                },

                topOpportunities: {
                    buys: STATE.recommendations.buy.slice(0, 10).map(c => ({
                        ticker: c.ticker, // Already Clean
                        cleanTicker: cleanTicker(c.ticker),
                        score: c.score,
                        label: c.label,
                        direction: 'BULL',
                        insights: c.insights || []
                    })),
                    sells: STATE.recommendations.sell.slice(0, 10).map(c => ({
                        ticker: c.ticker,
                        cleanTicker: cleanTicker(c.ticker),
                        score: c.score,
                        label: c.label,
                        direction: 'BEAR',
                        insights: c.insights || []
                    })),
                    retraces: STATE.recommendations.retrace.slice(0, 10).map(c => ({
                        ticker: c.ticker,
                        cleanTicker: cleanTicker(c.ticker),
                        score: c.score,
                        label: c.label,
                        direction: 'RETRACE',
                        insights: c.insights || []
                    }))
                },

                highValueMissed: STATE.missed.buy
                    .concat(STATE.missed.sell)
                    .filter(c => c.score >= 60)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 5)
                    .map(c => ({
                        ticker: c.ticker,
                        score: c.score,
                        missedBy: c.missedReason
                    }))
            };

            // 2. INSTITUTIONAL PULSE PASS-THROUGH (Buffer Logic)
            let institutionalPulse = { alerts: [] };
            if (unsafeWindow.pendingAlertBatch && unsafeWindow.pendingAlertBatch.length > 0) {
                console.log(`[Payload] 📥 Found ${unsafeWindow.pendingAlertBatch.length} buffered alerts from alert_scanner.js`);
                institutionalPulse.alerts = [...unsafeWindow.pendingAlertBatch];
                console.log(`[Payload] 📎 Attached ${institutionalPulse.alerts.length} alerts to payload`);
            }

            // 3. MARKET SENTIMENT (Full English Keys)
            const sentiment = historyEntry.marketSentiment;
            const market_sentiment = {
                totalCoins: sentiment.totalCoins,
                bullish: sentiment.bullish,
                bearish: sentiment.bearish,
                neutral: sentiment.neutral,
                moodScore: sentiment.moodScore,
                moodEmoji: sentiment.moodEmoji,
                mood: sentiment.mood,
                insights: [], // Placeholder for global insights if needed
                tickers: {
                    bullish: (sentiment.tickers.bullish || []).map(t => ({
                        ticker: t.t,
                        score: t.s,
                        netTrend: t.nt,
                        close: t.c,
                        volSpike: t.v,
                        momScore: t.m,
                        label: t.l
                    })),
                    bearish: (sentiment.tickers.bearish || []).map(t => ({
                        ticker: t.t,
                        score: t.s,
                        netTrend: t.nt,
                        close: t.c,
                        volSpike: t.v,
                        momScore: t.m,
                        label: t.l
                    }))
                }
            };

            // 4. RESULTS (The Raw Data Source)
            // Flatten all lists into a single deduplicated list
            const uniqueMap = new Map();
            const timestampNow = new Date().toISOString();

            const processItem = (item, matchedStrategy) => {
                if (!uniqueMap.has(item.ticker)) {
                    // Create Base Object
                    uniqueMap.set(item.ticker, {
                        ticker: item.ticker,
                        // status: REMOVED per user request (redundant)
                        datakey: item.datakey || item.exchange_symbol || `BINANCE:${item.ticker}`,
                        strategies: [matchedStrategy],
                        data: {
                            ...item, // Spread all table columns (roc, momScore, etc.)
                            ticker: item.ticker, // Explicitly add ticker again
                            timestamp: timestampNow // [NEW] Explicit Timestamp
                        }
                    });
                } else {
                    // Append strategy
                    const existing = uniqueMap.get(item.ticker);
                    if (!existing.strategies.includes(matchedStrategy)) {
                        existing.strategies.push(matchedStrategy);
                    }
                }
            };

            // Process ALL Sources (Raw Table Data)
            // [UPDATED] Use historyEntry.allTickers (100% of scanned items) if available
            if (historyEntry.allTickers && historyEntry.allTickers.length > 0) {
                historyEntry.allTickers.forEach(i => processItem(i, i.direction || 'SCAN'));
            } else {
                // Fallback for older history entries
                STATE.unfiltered.buy.forEach(i => processItem(i, 'BUY'));
                STATE.unfiltered.sell.forEach(i => processItem(i, 'SELL'));
                STATE.unfiltered.retrace.forEach(i => processItem(i, 'RETRACE'));
            }

            // Redundant check on recommendations just in case (usually subset)
            STATE.recommendations.buy.forEach(i => processItem(i, 'BUY'));
            STATE.recommendations.sell.forEach(i => processItem(i, 'SELL'));
            STATE.recommendations.retrace.forEach(i => processItem(i, 'RETRACE'));


            const payload = {
                id: `scan_${Date.now()}`,
                trigger: scanType, // Consistent with 'manual', 'auto', 'alert-triggered'
                timestamp: historyEntry.timestamp,
                script_version: SCRIPT_VERSION,
                results: Array.from(uniqueMap.values()),
                aiPriority: aiPriority,
                market_sentiment: market_sentiment,
                institutional_pulse: institutionalPulse
            };

            return payload;

        } catch (error) {
            console.error('[Payload] ❌ Critical error building payload:', error);
            return {
                id: `error_${Date.now()}`,
                trigger: scanType,
                script_version: SCRIPT_VERSION,
                error: error.message,
                results: [],
                market_sentiment: {},
                institutional_pulse: { alerts: [] }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // AUTO-TRIGGER LOGIC (SMART 2-CYCLE BATCHING)
    // ═══════════════════════════════════════════════════════════════
    function handleAutoTrigger(historyEntry) {
        STATE.autoScanCount++;
        console.log(`[AutoTrigger] Scan count: ${STATE.autoScanCount}/${CONFIG.AUTO_TRIGGER_AFTER_SCANS}`);

        const hasAlerts = unsafeWindow.pendingAlertBatch &&
            unsafeWindow.pendingAlertBatch.length > 0;

        // ═══════════════════════════════════════════════════════════════
        // SMART 2-CYCLE BATCHING LOGIC
        // ═══════════════════════════════════════════════════════════════

        if (hasAlerts) {
            console.log(`[AutoTrigger] 🚀 Alerts detected (${unsafeWindow.pendingAlertBatch.length}) - Triggering IMMEDIATE 'Semi-Update'`);

            // Send immediately (Cycle 1 or 2 - doesn't matter, we have data)
            const changeDetection = detectDataChange('auto-alert-triggered');
            const payload = buildFinalPayload(historyEntry, 'auto-alert-triggered', changeDetection);

            sendPayload(payload, changeDetection);

            // Reset alert batch state
            STATE.alertBatchPending = false;
            STATE.cyclesSinceAlertDetected = 0;
            STATE.autoScanCount = 0;
            return;
        }

        // NO ALERTS: Standard 2-scan heartbeat logic
        if (STATE.autoScanCount !== CONFIG.AUTO_TRIGGER_AFTER_SCANS) {
            console.log(`[AutoTrigger] ⏳ Heartbeat Cycle: ${STATE.autoScanCount}/${CONFIG.AUTO_TRIGGER_AFTER_SCANS} - Waiting to send...`);
            return;
        }

        // OFFLINE STORE CHECK (Heartbeat should try to flush pending items)
        const offlineQueue = OfflineStore.getQueue();
        if (offlineQueue.length > 0) {
            console.log(`[AutoTrigger] 🏚️ Found ${offlineQueue.length} offline items. Attempting flush...`);
            flushNextOfflineItem();
        }

        STATE.autoScanCount = 0;
        const changeDetection = detectDataChange('auto');

        if (!changeDetection.shouldSend) {
            console.log(`[AutoTrigger] ⏭️ ${changeDetection.reason}`);
            return;
        }

        console.log(`[AutoTrigger] 🤖 Sending market data (no alerts)`);
        const payload = buildFinalPayload(historyEntry, 'auto', changeDetection);
        sendPayload(payload, changeDetection);
    }



    // ═══════════════════════════════════════════════════════════════
    // PROCESS DATA (MAIN PROCESSING FUNCTION)
    // ═══════════════════════════════════════════════════════════════
    function processData(scanType = 'auto') {
        // Single choke point for every trigger source (manual click, auto-scan,
        // alert-triggered) — gate here once instead of in each caller, same
        // reasoning as Stream B routing everything through sendTelemetry().
        if (!checkStreamAFilterSetup()) {
            console.warn(`[Process] ⏸️ Skipping ${scanType} scan — screener filter setup not confirmed. Waiting on Automa correction.`);
            return;
        }

        // ═══════════════════════════════════════════════════════════════
        // WATCHDOG: Force Break Lock if stuck > 30s
        // ═══════════════════════════════════════════════════════════════
        if (STATE.isScanning) {
            const elapsed = Date.now() - (STATE.scanStartTime || 0);
            if (elapsed > 30000) {
                console.warn(`[Watchdog] ⚠️ Scan stuck for ${Math.round(elapsed / 1000)}s - FORCE RELEASING LOCK`);
                STATE.isScanning = false;
            }
        }

        if (STATE.isScanning) {
            console.log('[Process] ⏸️ Already scanning, skipping duplicate');

            if (scanType === 'alert-triggered') {
                console.warn('[Process] ⚠️ Alert Scan collision - Retrying in 2000ms to allow current scan to finish...');
                setTimeout(() => processData('alert-triggered'), 2000);
            }
            return;
        }

        // PRIORITY CHECK: If an alert triggered a scan, wait for it to finish stabilization
        if (scanType === 'auto' && STATE.alertScanPending) {

            // WATCHDOG: Check for STUCK Lock (e.g., if trigger logic crashed or timeout failed)
            const lockDuration = Date.now() - STATE.alertLockTime;
            if (lockDuration > 20000) { // 20 seconds max hold
                console.warn(`[Process] ⚠️ Found STUCK Priority Lock (>20s). Force releasing to resume operations.`);
                STATE.alertScanPending = false;
                // Don't return, proceed with scan
            } else {
                console.log(`[Process] ⏸️ Skipping auto-scan - Waiting for Alert Stabilization (Priority)`);
                return;
            }
        }

        STATE.isScanning = true;
        STATE.scanStartTime = Date.now(); // Watchdog Start
        STATE.scanStartTime = Date.now(); // Watchdog Start
        STATE.lastScanType = scanType;

        try {
            const allCoins = parseTableData();

            if (allCoins.length === 0) {
                // FORCE SCAN if alerts are pending, even if table is empty
                if (scanType === 'alert-triggered' || scanType === 'manual-trigger' || (unsafeWindow.pendingAlertBatch && unsafeWindow.pendingAlertBatch.length > 0)) {
                    console.log(`[Process] ⚠️ Table empty but forcing scan (Pending Alerts: ${unsafeWindow.pendingAlertBatch ? unsafeWindow.pendingAlertBatch.length : 0})`);
                } else {
                    console.warn('[Process] No data available');
                    STATE.isScanning = false;
                    return;
                }
            }

            // DIAGNOSTIC: a ticker that was captured last scan but is missing from
            // this one won't get a fresh row written for it at all — its DB value
            // just sits there with an aging timestamp while every other coin keeps
            // moving. That looks identical to a "frozen coin" from outside, but the
            // cause is the pine-screener table not rendering that row this cycle
            // (sorted/scrolled out), not a send/hash bug. Surface it directly.
            if (STATE.lastProcessedData && STATE.lastProcessedData.length > 0) {
                const prevTickers = new Set(STATE.lastProcessedData.map((c) => c.ticker));
                const currTickers = new Set(allCoins.map((c) => c.ticker));
                const vanished = [...prevTickers].filter((t) => !currTickers.has(t));
                if (vanished.length > 0) {
                    console.warn(`[Process] ⚠️ ${vanished.length} ticker(s) missing from this scan's captured rows (dropped off pine-screener table?): ${vanished.join(', ')}`);
                }
            }

            const currentHash = generateDataHash(allCoins);
            const hasPendingAlerts = unsafeWindow.pendingAlertBatch && unsafeWindow.pendingAlertBatch.length > 0;

            if (currentHash === STATE.lastScanHash && !hasPendingAlerts) {
                console.log('[Process] ⏭️ Data unchanged and no pending alerts, skipping');
                STATE.isScanning = false;
                return;
            }

            STATE.lastScanHash = currentHash;
            STATE.lastProcessedData = allCoins;
            STATE.lastScanTime = new Date();

            if (scanType === 'auto') {
                STATE.autoScanCount++;
                console.log(`[AutoScan] 🔄 Routine Scan | Cycle: ${STATE.autoScanCount}/${CONFIG.AUTO_TRIGGER_AFTER_SCANS}`);
            } else if (scanType === 'manual' || scanType === 'alert-triggered') {
                console.log(`[${scanType}] Resetting auto-scan counter`);
                STATE.autoScanCount = 0;
            }

            const scored = allCoins.map((coin) => ({
                ...coin,
                ...calculateRecommendation(coin),
            }));

            const sentiment = analyzeMarketSentiment(scored);

            const unfiltered = scored.filter((coin) => applyUnfilteredFilter(coin));

            const unfilteredBuys = unfiltered
                .filter((c) => c.direction === 'BULL')
                .sort((a, b) => b.score - a.score || b.netTrend - a.netTrend); // Tie-break: High Score -> High Trend

            const unfilteredSells = unfiltered
                .filter((c) => c.direction === 'BEAR')
                .sort((a, b) => b.score - a.score || a.netTrend - b.netTrend); // Tie-break: High Score -> Low Trend (Strong Bear)

            const unfilteredRetraces = unfiltered
                .filter((c) => (c.retraceOpportunity || 0) >= 1)
                .sort((a, b) => b.score - a.score || b.netTrend - a.netTrend);

            STATE.unfiltered = {
                buy: unfilteredBuys,
                sell: unfilteredSells,
                retrace: unfilteredRetraces,
            };

            const filtered = scored.filter((coin) =>
                applyFilters(coin, STATE.currentFilters)
            );

            const buys = filtered
                .filter((c) => c.direction === 'BULL')
                .sort((a, b) => b.score - a.score || b.netTrend - a.netTrend);
            const sells = filtered
                .filter((c) => c.direction === 'BEAR')
                .sort((a, b) => b.score - a.score || a.netTrend - b.netTrend); // Strongest Bear (Negative Trend)
            const retraces = filtered
                .filter((c) => (c.retraceOpportunity || 0) >= 1)
                .sort((a, b) => b.score - a.score || b.netTrend - a.netTrend);

            STATE.recommendations = {
                buy: buys,
                sell: sells,
                retrace: retraces,
            };

            const filteredTickers = new Set([
                ...buys.map((c) => c.ticker),
                ...sells.map((c) => c.ticker),
                ...retraces.map((c) => c.ticker),
            ]);

            const missedBuys = unfilteredBuys
                .filter((c) => !filteredTickers.has(c.ticker))
                .map((c) => ({
                    ...c,
                    missedReason: getFilterFailureReason(c, STATE.currentFilters),
                }));

            const missedSells = unfilteredSells
                .filter((c) => !filteredTickers.has(c.ticker))
                .map((c) => ({
                    ...c,
                    missedReason: getFilterFailureReason(c, STATE.currentFilters),
                }));

            const missedRetraces = unfilteredRetraces
                .filter((c) => !filteredTickers.has(c.ticker))
                .map((c) => ({
                    ...c,
                    missedReason: getFilterFailureReason(c, STATE.currentFilters),
                }));

            STATE.missed = {
                buy: missedBuys,
                sell: missedSells,
                retrace: missedRetraces,
            };

            const historyEntry = {
                scanNumber: STATE.history.length + 1,
                timestamp: STATE.lastScanTime.toISOString(),
                timeFormatted: formatTimestamp(STATE.lastScanTime),
                scanType: scanType,

                scanName: STATE.currentScanName,
                scanParams: { ...STATE.currentFilters },

                marketSentiment: sentiment,

                allTickers: scored.map(c => serializeTickerForHistory(c)), // [NEW] Complete Raw List

                unfilteredOpportunities: {
                    buys: unfilteredBuys.map((c) => serializeTickerForHistory(c)),
                    sells: unfilteredSells.map((c) => serializeTickerForHistory(c)),
                    retraces: unfilteredRetraces.map((c) => serializeTickerForHistory(c)),
                },

                opportunities: {
                    buys: buys.map((c) => serializeTickerForHistory(c)),
                    sells: sells.map((c) => serializeTickerForHistory(c)),
                    retraces: retraces.map((c) => serializeTickerForHistory(c)),
                },

                missedOpportunities: {
                    buys: missedBuys.map((c) =>
                        serializeTickerForHistory(c, c.missedReason)
                    ),
                    sells: missedSells.map((c) =>
                        serializeTickerForHistory(c, c.missedReason)
                    ),
                    retraces: missedRetraces.map((c) =>
                        serializeTickerForHistory(c, c.missedReason)
                    ),
                },

                counts: {
                    totalCoins: allCoins.length,
                    unfilteredBuys: unfilteredBuys.length,
                    unfilteredSells: unfilteredSells.length,
                    unfilteredRetraces: unfilteredRetraces.length,
                    filteredBuys: buys.length,
                    filteredSells: sells.length,
                    filteredRetraces: retraces.length,
                    missedBuys: missedBuys.length,
                    missedSells: missedSells.length,
                    missedRetraces: missedRetraces.length,
                },
            };

            STATE.history.push(historyEntry);

            resetAllBackgrounds();
            filtered.forEach((coin) => applyVisualHighlighting(coin));

            updateDocumentTitle(buys, sells, retraces, sentiment);

            const timeStr = formatTimestamp(STATE.lastScanTime);
            const scanTypeEmoji = scanType === 'manual' ? '👆' : scanType === 'alert-triggered' ? '🚨' : '🤖';

            console.log(`\n${'═'.repeat(60)}`);
            console.log(
                `🔍 SCAN #${STATE.history.length} ${scanTypeEmoji} ${scanType.toUpperCase()} | ${timeStr} | 🎯 ${STATE.currentScanName}`
            );
            console.log(`${'═'.repeat(60)}`);
            console.log(
                `📊 MARKET SENTIMENT (${allCoins.length} coins): ${sentiment.moodEmoji} ${sentiment.mood} (${sentiment.moodScore})`
            );
            console.log(
                `   Bullish: ${sentiment.bullish} | Bearish: ${sentiment.bearish} | Neutral: ${sentiment.neutral}`
            );
            console.log(`${'═'.repeat(60)}\n`);

            if (CONFIG.SHOW_UNFILTERED_DETAILS) {
                console.log(`${'─'.repeat(60)}`);
                console.log(
                    `📋 UNFILTERED OPPORTUNITIES (score >= ${CONFIG.UNFILTERED_MIN_SCORE
                    }${CONFIG.UNFILTERED_EXCLUDE_FREEZE ? ', not frozen' : ''})`
                );
                console.log(`${'─'.repeat(60)}\n`);

                if (unfilteredRetraces.length > 0) {
                    const displayCount = Math.min(
                        unfilteredRetraces.length,
                        CONFIG.UNFILTERED_MAX_DISPLAY
                    );
                    console.log(
                        `🎯 UNFILTERED RETRACES (${unfilteredRetraces.length})${unfilteredRetraces.length > displayCount
                            ? ` - Showing top ${displayCount}`
                            : ''
                        }:`
                    );
                    unfilteredRetraces.slice(0, displayCount).forEach((c, i) => {
                        printCoinDetails(c, i, 'retrace');
                    });
                    if (unfilteredRetraces.length > displayCount) {
                        console.log(
                            `   ... and ${unfilteredRetraces.length - displayCount} more`
                        );
                    }
                    console.log('');
                }

                if (unfilteredBuys.length > 0) {
                    const displayCount = Math.min(
                        unfilteredBuys.length,
                        CONFIG.UNFILTERED_MAX_DISPLAY
                    );
                    console.log(
                        `🟢 UNFILTERED BUYS (${unfilteredBuys.length})${unfilteredBuys.length > displayCount
                            ? ` - Showing top ${displayCount}`
                            : ''
                        }:`
                    );
                    unfilteredBuys.slice(0, displayCount).forEach((c, i) => {
                        printCoinDetails(c, i, 'buy');
                    });
                    if (unfilteredBuys.length > displayCount) {
                        console.log(
                            `   ... and ${unfilteredBuys.length - displayCount} more`
                        );
                    }
                    console.log('');
                }

                if (unfilteredSells.length > 0) {
                    const displayCount = Math.min(
                        unfilteredSells.length,
                        CONFIG.UNFILTERED_MAX_DISPLAY
                    );
                    console.log(
                        `🔴 UNFILTERED SELLS (${unfilteredSells.length})${unfilteredSells.length > displayCount
                            ? ` - Showing top ${displayCount}`
                            : ''
                        }:`
                    );
                    unfilteredSells.slice(0, displayCount).forEach((c, i) => {
                        printCoinDetails(c, i, 'sell');
                    });
                    if (unfilteredSells.length > displayCount) {
                        console.log(
                            `   ... and ${unfilteredSells.length - displayCount} more`
                        );
                    }
                    console.log('');
                }

                if (
                    unfilteredBuys.length === 0 &&
                    unfilteredSells.length === 0 &&
                    unfilteredRetraces.length === 0
                ) {
                    console.log('⚠️  No coins passed unfiltered criteria\n');
                }
            }

            console.log(`${'─'.repeat(60)}`);
            console.log(`🔍 FILTERED OPPORTUNITIES (passed scan criteria)`);
            console.log(`${'─'.repeat(60)}`);
            console.log(
                `   Buys: ${buys.length} | Sells: ${sells.length} | Retraces: ${retraces.length}\n`
            );

            if (retraces.length > 0) {
                console.log(`🎯 FILTERED RETRACE OPPORTUNITIES (${retraces.length}):`);
                retraces.forEach((c, i) => {
                    printCoinDetails(c, i, 'retrace');
                });
                console.log('');
            }

            if (buys.length > 0) {
                console.log(`🟢 FILTERED BUY OPPORTUNITIES (${buys.length}):`);
                buys.forEach((c, i) => {
                    printCoinDetails(c, i, 'buy');
                });
                console.log('');
            }

            if (sells.length > 0) {
                console.log(`🔴 FILTERED SELL OPPORTUNITIES (${sells.length}):`);
                sells.forEach((c, i) => {
                    printCoinDetails(c, i, 'sell');
                });
                console.log('');
            }

            if (buys.length === 0 && sells.length === 0 && retraces.length === 0) {
                console.log('⚠️  No coins passed filtered criteria\n');
            }

            if (
                CONFIG.SHOW_MISSED_IN_CONSOLE &&
                (missedBuys.length > 0 ||
                    missedSells.length > 0 ||
                    missedRetraces.length > 0)
            ) {
                console.log(`${'─'.repeat(60)}`);
                console.log(`⚠️  MISSED OPPORTUNITIES`);
                console.log(`${'─'.repeat(60)}`);
                console.log(
                    `   Missed Buys: ${missedBuys.length} | Missed Sells: ${missedSells.length} | Missed Retraces: ${missedRetraces.length}\n`
                );

                if (missedRetraces.length > 0) {
                    const displayCount = Math.min(missedRetraces.length, 5);
                    console.log(
                        `💡 MISSED RETRACES (${missedRetraces.length})${missedRetraces.length > displayCount
                            ? ` - Showing top ${displayCount}`
                            : ''
                        }:`
                    );
                    missedRetraces.slice(0, displayCount).forEach((c, i) => {
                        const cleanName = cleanTicker(c.ticker);
                        console.log(
                            `#${i + 1} ${cleanName} ${c.label} ${c.score} | ${c.retraceOpportunity
                            }×EMAs | ❌ ${c.missedReason}`
                        );
                    });
                    if (missedRetraces.length > displayCount) {
                        console.log(
                            `   ... and ${missedRetraces.length - displayCount} more`
                        );
                    }
                    console.log('');
                }

                if (missedBuys.length > 0) {
                    const displayCount = Math.min(missedBuys.length, 5);
                    console.log(
                        `💡 MISSED BUYS (${missedBuys.length})${missedBuys.length > displayCount
                            ? ` - Showing top ${displayCount}`
                            : ''
                        }:`
                    );
                    missedBuys.slice(0, displayCount).forEach((c, i) => {
                        const cleanName = cleanTicker(c.ticker);
                        const resistInfo =
                            c.resistDist !== null ? `R:${c.resistDist.toFixed(1)}%` : 'R:N/A';
                        console.log(
                            `#${i + 1} ${cleanName} ${c.label} ${c.score
                            } | ${resistInfo} | ❌ ${c.missedReason}`
                        );
                    });
                    if (missedBuys.length > displayCount) {
                        console.log(`   ... and ${missedBuys.length - displayCount} more`);
                    }
                    console.log('');
                }

                if (missedSells.length > 0) {
                    const displayCount = Math.min(missedSells.length, 5);
                    console.log(
                        `💡 MISSED SELLS (${missedSells.length})${missedSells.length > displayCount
                            ? ` - Showing top ${displayCount}`
                            : ''
                        }:`
                    );
                    missedSells.slice(0, displayCount).forEach((c, i) => {
                        const cleanName = cleanTicker(c.ticker);
                        const supportInfo =
                            c.supportDist !== null
                                ? `S:${c.supportDist.toFixed(1)}%`
                                : 'S:N/A';
                        console.log(
                            `#${i + 1} ${cleanName} ${c.label} ${c.score
                            } | ${supportInfo} | ❌ ${c.missedReason}`
                        );
                    });
                    if (missedSells.length > displayCount) {
                        console.log(`   ... and ${missedSells.length - displayCount} more`);
                    }
                    console.log('');
                }
            }

            if (scanType === 'auto') {
                handleAutoTrigger(historyEntry);
            } else if (scanType === 'alert-triggered') {
                const changeDetection = detectDataChange('alert-triggered');

                if (!changeDetection.shouldSend) {
                    console.log(`\n${'═'.repeat(60)}`);
                    console.log('🚨 ALERT-TRIGGERED BUT DATA UNCHANGED');
                    console.log(`   Reason: ${changeDetection.reason}`);
                    console.log(`   Action: Holding alerts for next scan`);
                    console.log(`${'═'.repeat(60)}\n`);
                    return;
                }

                const payload = buildFinalPayload(historyEntry, scanType, changeDetection);
                console.log('📦 FULL PAYLOAD DEBUG:', payload);

                console.log(`\n${'═'.repeat(60)}`);
                console.log('🚨 ALERT-TRIGGERED SCAN COMPLETE - SENDING TO BACKEND');
                console.log(`${'═'.repeat(60)}`);
                console.log(`   AI Priority: ${(JSON.stringify(payload.aiPriority) || '').length} bytes`);
                if (payload.institutionalPulse) {
                    console.log(`   Institutional Pulse: ${payload.institutionalPulse.alerts ? payload.institutionalPulse.alerts.length : 0} alerts`);
                    if (payload.institutionalPulse.consensus && payload.institutionalPulse.consensus.strongSignals) {
                        console.log(`   Strong Signals: ${payload.institutionalPulse.consensus.strongSignals.join(', ') || 'None'}`);
                    }
                }
                console.log(`   Total: ${JSON.stringify(payload).length} bytes`);

                sendPayload(payload);

                STATE.lastSentHash = changeDetection.currentHash;
                STATE.lastSentTime = Date.now();
                window.batchedAlerts = null;

            } else {
                // MANUAL or FALLBACK
                // Force send without hash check (User requested it)
                const payload = buildFinalPayload(historyEntry, scanType || 'manual', { hasChanged: true }); // Assume changed for manual

                console.log(`\n${'═'.repeat(60)}`);
                console.log('🎯 MANUAL SCAN COMPLETE - DEBUG LOGGING ENABLED');
                console.log(`📦 FULL PAYLOAD DEBUG:`, payload);
                console.log(`${'═'.repeat(60)}`);

                sendPayload(payload);
                STATE.lastSentTime = Date.now();
                console.log(`${'═'.repeat(60)}\n`);
            }

            console.log(`${'═'.repeat(60)}\n`);

        } catch (error) {
            console.error('[Process] Error:', error);
        } finally {
            STATE.isScanning = false;
            // FAIL-SAFE: Always release priority lock when any scan completes
            // This prevents deadlocks if a manual scan interrupts an alert scan
            if (STATE.alertScanPending) {
                STATE.alertScanPending = false;
                console.log('[Lock] 🔓 Priority Lock Released (Scan Complete)');
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // MANUAL TRIGGER WITH FRESH SCAN
    // ═══════════════════════════════════════════════════════════════
    function manualTriggerWithFreshScan() {
        console.log('\n🎯 MANUAL TRIGGER REQUESTED (Shift+Alt+Z)');
        console.log('   1️⃣ Clicking scan button...');

        const btn = findScanButton();
        if (!btn) {
            console.error('❌ Scan button not found');
            return;
        }

        btn.click();
        console.log('   2️⃣ Waiting for UI to update...');

        setTimeout(() => {
            console.log('   3️⃣ Processing fresh scan data...');

            processData('manual');

            setTimeout(() => {
                console.log('   4️⃣ Forcing immediate send...');

                if (STATE.history.length === 0) {
                    console.error('❌ No scan data available');
                    return;
                }

                const latestScan = STATE.history[STATE.history.length - 1];
                const changeDetection = detectDataChange('manual-trigger');
                const payload = buildFinalPayload(latestScan, 'manual', changeDetection);

                if (!changeDetection.hasChanged) {
                    console.log(`[ManualTrigger] ⚠️ Data unchanged since last send`);
                    console.log(`[ManualTrigger] Sending anyway with 'dataUnchanged: true' flag`);
                }

                console.log(`📤 Sending manual trigger to ${CONFIG.AUTO_TRIGGER_ENDPOINT}...`);

                sendPayload(payload);

                STATE.lastSentHash = changeDetection.currentHash;
                STATE.lastSentTime = Date.now();

            }, 500);

        }, UI_DELAY_MS);
    }

    // ═══════════════════════════════════════════════════════════════
    // ALERT MONITOR
    // ═══════════════════════════════════════════════════════════════
    function startAlertMonitor() {
        setInterval(() => {
            if (unsafeWindow.triggerScreenerScan && unsafeWindow.batchedAlerts) {
                console.log(`\n${'═'.repeat(60)}`);
                console.log(`🚨 ALERT-TRIGGERED SCAN DETECTED`);
                console.log(`   Alerts in batch: ${unsafeWindow.batchedAlerts.length}`);
                unsafeWindow.batchedAlerts.forEach((alert, i) => {
                    console.log(`   ${i + 1}. ${alert.asset.ticker} @ ${alert.signal.timestamp} (${alert.signal.category})`);
                });
                console.log(`   Waiting 10s for market to stabilize...`);
                console.log(`${'═'.repeat(60)}\n`);

                STATE.alertScanPending = true; // Lock auto-scans
                STATE.alertLockTime = Date.now(); // Track time
                console.log('[Lock] 🔒 Priority Lock Acquired (Waiting for Stabilization)');
                unsafeWindow.triggerScreenerScan = false;

                setTimeout(() => {
                    try {
                        const btn = findScanButton();
                        if (!btn) {
                            console.error('❌ Scan button not found - releasing priority lock');
                            STATE.alertScanPending = false; // FAILSAFE: Release lock
                            console.log('[Lock] 🔓 Priority Lock Released (Button Missing)');
                            return;
                        }
                        console.log('[Trigger] 🖱️ Clicking scan button...');
                        btn.click();

                        // Force processing after delay
                        clearTimeout(STATE.processDebounceTimer);
                        STATE.processDebounceTimer = setTimeout(() => {
                            processData('alert-triggered');
                            // STATE.alertScanPending release moved to processData() finally block for safety
                        }, UI_DELAY_MS);
                    } catch (err) {
                        console.error('[Trigger] ❌ Error during alert processing:', err);
                        STATE.alertScanPending = false;
                        console.log('[Lock] 🔓 Priority Lock Released (Error Failsafe)');
                    }

                }, 10000);
            } else if (unsafeWindow.triggerScreenerScan && !unsafeWindow.batchedAlerts) {
                console.warn('[Trigger] ⚠️ Trigger set but NO batchedAlerts found. Resetting trigger to avoid stuck state.');
                unsafeWindow.triggerScreenerScan = false;
            }

        }, 500);
    }

    // ═══════════════════════════════════════════════════════════════
    // BUTTON LISTENER & AUTO-SCAN
    // ═══════════════════════════════════════════════════════════════
    function setupScanButtonListener() {
        const btn = findScanButton();

        if (!btn) {
            console.log('[Button Listener] Scan button not found, retrying...');
            setTimeout(setupScanButtonListener, 2000);
            return;
        }

        console.log('[Button Listener] ✅ Attached to manual scan button');

        btn.addEventListener('click', () => {
            clearTimeout(STATE.processDebounceTimer);

            STATE.processDebounceTimer = setTimeout(() => {
                processData('manual');
            }, UI_DELAY_MS);
        });
    }

    function triggerAutoScan() {
        if (STATE.isPaused) {
            console.log('[Auto-Scan] ⏸️ Paused, skipping');
            return;
        }

        if (isTabHidden()) {
            console.warn('[Auto-Scan] ⏸️ Tab is backgrounded — skipping cycle (would click/read stale DOM). Will catch up on refocus.');
            return;
        }

        const btn = findScanButton();
        if (!btn) {
            console.warn('[Auto-Scan] ⚠️ Button not found');
            return;
        }

        btn.click();

        // WAKE UP ALERT SCANNER (Background Tab Sync)
        unsafeWindow.TRIGGER_SIDEBAR_CHECK = Date.now();
        console.log(`[Auto-Scan] 🔔 Waking Alert Scanner...`);

        clearTimeout(STATE.processDebounceTimer);
        STATE.processDebounceTimer = setTimeout(() => {
            processData('auto');
        }, UI_DELAY_MS);
    }

    // 2026-09-10: standalone filter-setup monitor — deliberately independent
    // of the scan-button discovery loop. checkStreamAFilterSetup() used to
    // only run from inside processData(), but processData() is never called
    // until startAutoScan()'s checkForButton() finds the scan button — and
    // confirmed live, that loop can get stuck retrying forever
    // ("Scan button not found, retrying...") when the screener isn't properly
    // set up. That's exactly the situation this check exists to fix, so
    // gating it behind the very thing it's supposed to unblock was a
    // deadlock. This runs on its own timer regardless of button/scan state,
    // so the Automa setup workflow gets a chance to fire and fix the page
    // even while everything else is stuck waiting.
    function startStreamASetupMonitor() {
        // 2026-09-16: bumped 15s -> 20s. This interval only controls how
        // often the (cheap, read-only) DOM check re-evaluates — it does NOT
        // control dispatch rate, which is separately gated by the 90s
        // initial settle window and the progressive cooldown between actual
        // Automa dispatches (see checkStreamAFilterSetup()). Widened anyway
        // for a bit more breathing room on lower-end machines/heavier pages.
        setInterval(() => {
            checkStreamAFilterSetup();
        }, 20000);
    }

    function startAutoScan() {
        // ROBUST INIT: Wait for button to exist before starting the clock
        const checkForButton = () => {
            const btn = findScanButton();
            if (btn) {
                if (STATE.scanIntervalId) clearInterval(STATE.scanIntervalId);

                console.log(`[Auto-Scan] ▶️ Started (every ${CONFIG.INTERVAL_MINUTES} minutes)`);
                console.log(`[Auto-Trigger] Will activate after every ${CONFIG.AUTO_TRIGGER_AFTER_SCANS} auto-scans`);

                triggerAutoScan();
                STATE.scanIntervalId = setInterval(triggerAutoScan, INTERVAL_MS);
            } else {
                console.log('[Init] ⏳ Waiting for Scan Button to load...');
                setTimeout(checkForButton, 2000);
            }
        };

        checkForButton();
    }

    // ═══════════════════════════════════════════════════════════════
    // VISIBILITY CATCH-UP
    // ═══════════════════════════════════════════════════════════════
    // Don't wait for the next (possibly throttle-delayed) interval tick once
    // the tab regains focus — fire the scan right away so a long background
    // stretch doesn't cost extra minutes of staleness on top of what it
    // already cost while hidden.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && !STATE.isScanning) {
            console.log('[Auto-Scan] 👁️ Tab regained focus — running catch-up scan.');
            triggerAutoScan();
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // KEYBOARD SHORTCUTS
    // ═══════════════════════════════════════════════════════════════
    document.addEventListener('keydown', (e) => {
        if (e.shiftKey && e.altKey && e.code === 'KeyZ') {
            e.preventDefault();
            manualTriggerWithFreshScan();
            return;
        }

        if (e.altKey && !e.shiftKey && e.code === 'KeyU') {
            e.preventDefault();
            try {
                console.log('[Manual] Alt+U pressed - Force Triggering Auto-Scan...');
                triggerAutoScan();
                if (STATE.scanIntervalId) {
                    clearInterval(STATE.scanIntervalId);
                    STATE.scanIntervalId = setInterval(triggerAutoScan, INTERVAL_MS);
                }
            } catch (err) {
                console.error('[Manual] ❌ Alt+U Failed:', err);
            }
            return;
        }

        if (e.altKey && !e.shiftKey && e.code === 'KeyK') {
            e.preventDefault();
            copyRecommendationsToClipboard();
            return;
        }

        if (e.altKey && !e.shiftKey && e.code === 'KeyL') {
            e.preventDefault();
            console.log('[Control] Alt+L pressed - toggling chart events...');
            clickAllEventElements();
            return;
        }

        if (e.altKey && !e.shiftKey && e.code === 'KeyP') {
            e.preventDefault();
            if (STATE.isPaused) {
                STATE.isPaused = false;
                console.log('[Control] ▶️ RESUMED');
            } else {
                STATE.isPaused = true;
                console.log('[Control] ⏸️ PAUSED');
            }
            return;
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════
    window.UltraScalper = {
        version: '16.0',
        state: STATE,
        recommendations: () => STATE.recommendations,
        unfiltered: () => STATE.unfiltered,
        missed: () => STATE.missed,
        history: () => STATE.history,

        manualTrigger: manualTriggerWithFreshScan,
        forceAutoTrigger: () => {
            if (STATE.history.length > 0) {
                handleAutoTrigger(STATE.history[STATE.history.length - 1]);
            }
        },

        pause: () => {
            STATE.isPaused = true;
            console.log('[Control] ⏸️ PAUSED');
        },
        resume: () => {
            STATE.isPaused = false;
            console.log('[Control] ▶️ RESUMED');
        },

        checkDataChange: () => detectDataChange(STATE.lastScanType || 'manual'),
        toggleChartEvents: clickAllEventElements,
    };



    // ═══════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════
    const STARTUP_DELAY_MS = 3 * 60 * 1000; // 3 Minutes

    console.log(`[Init] ⏳ WARM-UP PHASE: Script will start in ${STARTUP_DELAY_MS / 1000} seconds...`);

    setTimeout(() => {
        console.log('[Init] 🟢 CONNECTING SYSTEMS (Warm-up Complete)...');
        startStreamASetupMonitor(); // independent of the scan button — can fire even if the button is never found
        setupScanButtonListener();
        startAutoScan();
        startAlertMonitor();
        // Check for offline items immediately on wakeup
        flushNextOfflineItem();
    }, STARTUP_DELAY_MS);

    console.log('✅ Ultra Scalper v16.0 (Master) Loaded');
    console.log('   Shift+Alt+Z - Manual trigger (Ready after warm-up)');
    console.log('   Alt+U - Manual scan (Ready after warm-up)');

})();
