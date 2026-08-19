// ==UserScript==
// @name         Institutional Conviction Engine - Bidirectional v20.13 (Fresh Session Bypasses Veto)
// @namespace    http://tampermonkey.net/
// @version      20.13
// @description  v20.13: FRESH_SESSION removals now bypass VETO_PRUNE — previously any coin still visible on the live screener at reset time was protected from removal by the same veto that guards normal operation, so a hard reset could never actually reach the majors+whitelist baseline; it just stalled at "whatever the screener currently shows". A reset now forces removal regardless, and a legitimately-active coin simply re-earns its spot through a fresh 8/20min cycle. v20.12: clipboard re-assert (added in v20.11) is now scoped to RETRY attempts only (automaAttempt > 0) — refreshing on every 10s poll during the routine, usually-successful FIRST attempt meant hijacking the user's system clipboard constantly, interfering with their own parallel copy/paste work. Now it only kicks in once Automa has already failed once and we're actively retrying — a rare, already-degraded case where the protection is worth the tradeoff. v20.10: FRESH_SESSION signal — manual dashboard-triggered reset to majors + whitelist. v20.9: master_targets diff checks the live screener before honoring any removal. v20.8: closes the previous Automa tab before opening a new one; hard minimum interval between any two fires. v20.7: post-Automa verification, WIPE/PARTIAL_ADD detection + retry. v20.6: REFRESH_WATCHLIST signal. v20.5: screener snap cached by monitor(), absolute-index column mapping. v20.4: full-format diff, cross-exchange guard, always-fresh telemetry.
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
        BACKEND_URL: "http://localhost:3000/qualified-pick",
        FIELDS: {
            SYMBOL: "TickerUniversal",
            RATING: "TechnicalRating|TimeResolution1D",
            PRICE: "Price"
        }
    };

    const TELEMETRY = {
        POLL_MS: 300000,
        URL: "http://localhost:3000/api/market-context"
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

        // v20.8: close the PREVIOUS Automa tab (if it's still open) before opening
        // a new one. Cancelling the JS timers above stops US from re-checking a
        // stale run, but it never closed the actual browser tab — Automa could
        // still be mid-run in it, racing the new tab we're about to open on the
        // same shared clipboard.
        if (automaTabHandle && !automaTabHandle.closed) {
            try { automaTabHandle.close(); auditLog("AUTOMA_TAB_CLOSED", null, "Closed previous Automa tab before firing a new one.", "SYSTEM"); }
            catch (e) { /* tab may already be gone — non-fatal */ }
        }

        GM_setClipboard(targets.join(','));
        auditLog("AUTOMA_TRIGGERED", null, `Copied ${targets.length} coins. Firing new tab.${note || ''}`, "SYNC");
        automaTabHandle = GM_openInTab("https://www.tradingview.com/cex-screener/lEINSjG1/", { active: false, insert: true, setParent: true });

        window.lastAutomaTriggerMs = Date.now();
        automaExpectedList = targets.slice();
        saveState();
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
        const isForcedUpdate = actionRequired === 'UPDATE_WATCHLIST' || actionRequired === 'RESET_WATCHLIST' || actionRequired === 'FRESH_SESSION';

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
        area2WatchlistSet.clear();
        watchlistBaseSet.clear();   // Bug-2 fix: reset cross-exchange base set too
        watchlistSnapshot = [];

        // =========================================================================
        // ✅ STRICT DOM SCOPING (Prevents reading the Screener accidentally)
        // =========================================================================
        const watchlistContainer = document.querySelector('div[data-name="symbol-list-wrap"]');

        if (!watchlistContainer) {
            console.warn("[System] Watchlist container not found, skipping UI parse.");
            return;
        }

        // Only query the rows INSIDE the specific Watchlist container
        watchlistContainer.querySelectorAll('div[data-symbol-full]').forEach(row => {
            const full = row.getAttribute('data-symbol-full');
            const short = row.getAttribute('data-symbol-short');

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

    async function sendTelemetry() {
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

        // Always refresh watchlist state immediately before building the payload.
        updateArea2Watchlist();

        const payload = {
            screener_total_count: screenerSnap.length,
            screener_visible_snapshot: screenerSnap,
            watchlist_count: watchlistSnapshot.length,
            watchlist_active_snapshot: watchlistSnapshot
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
            onerror: function (err) {
                auditLog("TELEMETRY_FAILED", null, "Network request failed entirely.", "PRUNE");
            }
        });
    }

    async function monitor() {
        await ensureWatchlistPanelOpen();
        mapHeaders();
        updateArea2Watchlist();

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
        if (rows.length > 0) {
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
                        snapData[fieldName] = (numCand !== '' && /^-?[\d.]+$/.test(numCand))
                            ? parseFloat(numCand)
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

})();