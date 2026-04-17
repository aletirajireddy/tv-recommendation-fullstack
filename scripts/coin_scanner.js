// ==UserScript==
// @name         Institutional Conviction Engine - Bidirectional v20.2 (Strict Watchlist Diff)
// @namespace    http://tampermonkey.net/
// @version      20.2
// @description  Cyclic monitor with Precision Audit, deferred sync, Dynamic Orphan Detection, and Strict Watchlist Scoping.
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
    let area2WatchlistSet = new Set();
    let watchlistSnapshot = [];
    let colMap = {};

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
        document.querySelectorAll('thead th[data-field]').forEach((th, i) => {
            const field = th.dataset.field;
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

    function processSyncPayload(serverInfo, triggerTicker = "HEARTBEAT") {
        auditLog("BACKEND_SYNC", null, `Trigger: ${triggerTicker} | AI Suggestion: ${serverInfo.ai_suggestion || 'None'}`, "SYNC");

        if (serverInfo.prune_list && Array.isArray(serverInfo.prune_list)) {
            const liveScreenerKeys = new Set(getMarketSnapshot());

            serverInfo.prune_list.forEach(tickerKey => {
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
            // ✅ STRICT DIFF CALCULATION WITH TICKER NORMALIZATION
            // =========================================================================
            // Strip out exchange prefixes (e.g. "BINANCE:") to prevent format-mismatch bugs
            const extractTicker = (fullString) => fullString.includes(':') ? fullString.split(':')[1] : fullString;

            const normalizedTargets = serverInfo.master_targets.map(extractTicker);
            const normalizedCurrent = Array.from(area2WatchlistSet).map(extractTicker);

            const targetSetCheck = new Set(normalizedTargets);
            const currentSetCheck = new Set(normalizedCurrent);

            const additions = normalizedTargets.filter(x => !currentSetCheck.has(x));
            const removals = normalizedCurrent.filter(x => !targetSetCheck.has(x));
            const diffCount = additions.length + removals.length;

            if (diffCount > 0) {
                auditLog("DIFF_DETECTED", null, `+ Adding: [${additions.join(', ')}] | - Removing: [${removals.join(', ')}]`, "BUFFER");

                // We join the ORIGINAL master targets for the clipboard so TradingView gets the exact format it needs
                const clipboardString = [...serverInfo.master_targets].join(',');
                const now = Date.now();
                const COOLDOWN_MS = CONFIG.AUTOMA_COOLDOWN_MINUTES * 60 * 1000;

                if (!window.lastAutomaTriggerMs || (now - window.lastAutomaTriggerMs > COOLDOWN_MS)) {
                    GM_setClipboard(clipboardString);
                    auditLog("AUTOMA_TRIGGERED", null, `Copied ${serverInfo.master_targets.length} coins. Firing new tab. Next available in ${CONFIG.AUTOMA_COOLDOWN_MINUTES}m.`, "SYNC");
                    GM_openInTab("https://www.tradingview.com/cex-screener/lEINSjG1/", { active: false, insert: true, setParent: true });

                    window.lastAutomaTriggerMs = now;
                    saveState();
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

        const screenerTable = document.querySelector('tbody');
        let watchlistPanel = document.querySelector('div[data-name="symbol-list-wrap"]');

        if (!watchlistPanel) {
            auditLog("TELEMETRY", null, "Watchlist panel missing. Attempting force-open...", "SYSTEM");
            const success = await ensureWatchlistPanelOpen();
            if (success) {
                watchlistPanel = document.querySelector('div[data-name="symbol-list-wrap"]');
                updateArea2Watchlist();
            }
        }

        if (!screenerTable || !watchlistPanel) {
            auditLog("TELEMETRY_ERROR", null, "Skipping: Required UI containers not found.", "PRUNE");
            return;
        }

        if (Object.keys(colMap).length === 0) mapHeaders();
        const telemetryHeaders = [];
        document.querySelectorAll('thead th[data-field]').forEach((th) => {
            const field = th.getAttribute('data-field');
            if (field) telemetryHeaders.push(field);
        });

        const screenerSnap = [];
        document.querySelectorAll('tbody tr[data-rowkey]').forEach(row => {
            const full = row.getAttribute('data-rowkey');
            if (full) {
                const parts = full.split(':');
                const cells = row.querySelectorAll('td');
                const rowData = { full, short: parts.length > 1 ? parts[1] : full };

                cells.forEach((cell, idx) => {
                    if (idx < telemetryHeaders.length) {
                        const fieldName = telemetryHeaders[idx];
                        const text = cell.innerText.trim();
                        const cleanText = text.replace(/\s|\n|USDT/g, '').replace(/−/g, '-');

                        if (/^-?[\d.]+$/.test(cleanText) && cleanText !== "") {
                            rowData[fieldName] = parseFloat(cleanText);
                        } else {
                            rowData[fieldName] = text;
                        }
                    }
                });
                screenerSnap.push(rowData);
            }
        });

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
                    if (serverInfo.master_targets) processSyncPayload(serverInfo, "HEARTBEAT");
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

            if (area2WatchlistSet.has(rowKey)) {
                if (activeMasterSet.has(rowKey) || pipelineRegistry.has(rowKey)) {
                    activeMasterSet.delete(rowKey);
                    pipelineRegistry.delete(rowKey);
                    auditLog("SUPPRESSED", ticker, "Halted scouting. Coin already exists in UI Watchlist.", "SYSTEM");
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