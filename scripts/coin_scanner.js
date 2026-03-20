// ==UserScript==
// @name         Institutional Conviction Engine - Bidirectional v16.0
// @namespace    http://tampermonkey.net/
// @version      16.0
// @description  Cyclic monitor with full market snapshot and bidirectional backend feedback.
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
        BACKEND_URL: "http://localhost:3000/qualified-pick",
        FIELDS: {
            SYMBOL: "TickerUniversal",
            RATING: "TechnicalRating|TimeResolution1D",
            PRICE: "Price"
        }
    };

    const TELEMETRY = {
        POLL_MS: 300000, // 5 Minutes
        URL: "http://localhost:3000/api/market-context"
    };

    const activeMasterSet = new Set();
    const serverTargetSet = new Set(); // Coins the server wants us to watch
    const pipelineRegistry = new Map();
    const graduatedSet = new Map(); // tickerKey -> timestamp (60m lock)
    let area2WatchlistSet = new Set(); // Freshly parsed every cycle
    const debugServerHistory = []; // User requested log of server responses
    let colMap = {};

    const STYLES = {
        BORN: "color: #ff9800; font-weight: bold;",
        PICK: "background: #27ae60; color: white; padding: 2px 5px; font-weight: bold;",
        CLEAN: "color: #607d8b; font-style: italic;",
        SERVER: "background: #673ab7; color: white; padding: 2px 5px; font-weight: bold; border-left: 4px solid #fff;"
    };

    function mapHeaders() {
        document.querySelectorAll('thead th[data-field]').forEach((th, i) => {
            const field = th.dataset.field;
            for (let k in CONFIG.FIELDS) if (field === CONFIG.FIELDS[k]) colMap[k] = i;
        });
    }

    function saveState() {
        if (typeof GM_setValue === "undefined") return;
        const state = {
            registry: Array.from(pipelineRegistry.entries()),
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

            // 0. Hydrate Automa Cooldown
            if (state.lastAutomaTriggerMs) {
                window.lastAutomaTriggerMs = state.lastAutomaTriggerMs;
            }

            // 1. Hydrate Graduates (Cooldowns)
            if (state.graduates) {
                state.graduates.forEach(([key, ts]) => {
                    if (now - ts < 60 * 60 * 1000) graduatedSet.set(key, ts);
                });
            }

            // 2. Hydrate Registry & Active Set (with Staleness Check)
            if (state.registry) {
                state.registry.forEach(([key, node]) => {
                    const isRecent = (now - node.bornAt < MAX_STALE_MS);
                    if (isRecent) {
                        pipelineRegistry.set(key, node);
                        if (state.activeSet && state.activeSet.includes(key)) {
                            activeMasterSet.add(key);
                        }
                    }
                });
            }
            console.log(`%c[SYSTEM] 🧩 Hydrated State: ${activeMasterSet.size} Active, ${graduatedSet.size} Cooldowns`, "color: #9c27b0; font-weight: bold;");
        } catch (e) {
            console.warn("[SYSTEM] Failed to load state:", e);
        }
    }

    function getMarketSnapshot() {
        const snapshot = [];
        document.querySelectorAll('tbody tr[data-rowkey]').forEach(row => {
            const key = row.getAttribute('data-rowkey');
            if (key) snapshot.push(key);
        });
        return snapshot;
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
                try {
                    const status = response.status;
                    const ts = new Date().toLocaleTimeString();

                    if (status !== 200) {
                        console.warn(`[BACKEND] ⚠️ Error ${status}:`, response.responseText);
                        return;
                    }

                    const serverInfo = JSON.parse(response.responseText);
                    processSyncPayload(serverInfo, payload.ticker);

                } catch (e) {
                    console.warn("[BACKEND] Error parsing response:", e);
                }
            }
        });
    }

    function processSyncPayload(serverInfo, triggerTicker = "HEARTBEAT") {
        const ts = new Date().toLocaleTimeString();
        console.log(`[SYNC-RECEIVED] Master: ${serverInfo.master_targets?.length || 0} | Prune: ${serverInfo.prune_list?.length || 0}`);

        // 1. LOGGING
        console.log(`%c[SYNC @ ${ts}] %c${triggerTicker}: ${serverInfo.ai_suggestion || 'Stateful Sync'}`,
            STYLES.SERVER, "color: #b39ddb; font-style: italic;");

        // 2. PRUNE LIST (Feedback Loop) - [LOGIC ON HOLD PER USER REQUEST]
        /*
        if (serverInfo.prune_list && Array.isArray(serverInfo.prune_list)) {
            let prunedCount = 0;
            serverInfo.prune_list.forEach(tickerKey => {
                if (activeMasterSet.has(tickerKey)) {
                    activeMasterSet.delete(tickerKey);
                    pipelineRegistry.delete(tickerKey);
                    prunedCount++;
                }
                if (serverTargetSet.has(tickerKey)) serverTargetSet.delete(tickerKey);
            });
            if (prunedCount > 0) console.log(`%c ✂️ Pruned ${prunedCount} Zombies`, "color: #90a4ae;");
        }
        */

        // 3. MASTER WATCHLIST (Sync)
        if (serverInfo.master_targets && Array.isArray(serverInfo.master_targets)) {
            serverInfo.master_targets.forEach(key => serverTargetSet.add(key));

            // 4. INTELLIGENT CLIPBOARD (Threshold & Diff)
            const targetList = [...new Set([
                ...(Array.isArray(serverInfo.active_list) ? serverInfo.active_list : []),
                ...(Array.isArray(serverInfo.new_graduates) ? serverInfo.new_graduates : [])
            ])];

            const currentList = Array.from(area2WatchlistSet);
            const additions = targetList.filter(x => !area2WatchlistSet.has(x));
            const removals = currentList.filter(x => !new Set(targetList).has(x));
            const diffCount = additions.length + removals.length;

            console.log(`[CLIPBOARD-INTEL] Target: ${targetList.length} | Current: ${currentList.length} | Diff: ${diffCount}`);
            if (additions.length > 0) console.log(`%c +  Adding: ${additions.join(', ')}`, "color: #4caf50;");
            if (removals.length > 0) console.log(`%c - Removing: ${removals.join(', ')}`, "color: #f44336;");

            if (diffCount >= 2 || (triggerTicker !== "HEARTBEAT" && diffCount > 0)) {
                const clipboardString = targetList.join(',');
                if (clipboardString) {
                    try {
                        GM_setClipboard(clipboardString);
                        console.log(`%c 📋 Intelligent Sync: Copied ${targetList.length} coins! (Threshold Met: ${diffCount} changes)`,
                            "color: #4caf50; font-weight: bold;");

                        const now = Date.now();
                        const COOLDOWN_MS = 30 * 60 * 1000; // Updated to 30 minutes
                        if (!window.lastAutomaTriggerMs || (now - window.lastAutomaTriggerMs > COOLDOWN_MS)) {
                            GM_openInTab("https://www.tradingview.com/cex-screener/lEINSjG1/", { active: false, insert: true, setParent: true });
                            window.lastAutomaTriggerMs = now;
                            saveState();
                            console.log(`%c 🤖 Fired Automa Trigger (Next allowed in 30m)`, "color: #9c27b0; font-style: italic;");
                        } else {
                            const elapsed = now - window.lastAutomaTriggerMs;
                            const minLeft = ((COOLDOWN_MS - elapsed) / 60000).toFixed(1);
                            console.log(`%c 🤖 Skipped Automa Trigger (Cooldown: ${minLeft}m left)`, "color: #9c27b0; font-style: italic;");
                        }
                    } catch (err) {
                        console.error("Clipboard copy failed:", err);
                    }
                }
            } else {
                console.log(`%c 💤 Clipboard update skipped (Only ${diffCount} changes, threshold is 2)`, "color: #9e9e9e;");
            }
        }
    }

    async function ensureWatchlistPanelOpen() {
        // Find the specific toggle button on the right sidebar (data-name='base')
        const panelBtn = document.querySelector('button[data-name="base"]');
        if (!panelBtn) return false;

        const isPressed = panelBtn.getAttribute('aria-pressed') === 'true';
        if (!isPressed) {
            console.log('[Panel] 📂 Opening Base Right Panel...');
            panelBtn.click();
            // Wait for DOM to render after click
            await new Promise(r => setTimeout(r, 1500));
        }

        // Verify if the watchlist container is now visible
        const watchlistWrap = document.querySelector('div[data-name="symbol-list-wrap"]');
        if (!watchlistWrap) {
            console.warn('[Panel] ⚠️ Watchlist container not found after opening attempt.');
            return false;
        }
        return true;
    }

    let watchlistSnapshot = [];

    function updateArea2Watchlist() {
        area2WatchlistSet.clear();
        watchlistSnapshot = [];

        document.querySelectorAll('div[data-symbol-full]').forEach(row => {
            const full = row.getAttribute('data-symbol-full');
            const short = row.getAttribute('data-symbol-short');

            if (full) {
                area2WatchlistSet.add(full);

                let price = "", change_pct = "", vol_raw = "";
                // Grab the direct span children (Price, Change, Change %, Volume)
                const spans = Array.from(row.children).filter(el => el.tagName === 'SPAN');

                if (spans.length >= 4) {
                    // Clean text spacing and em-dash vs minus characters
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
        console.log("%c[TELEMETRY] 📡 Capturing Market Context Snap...", "color: #03a9f4; font-weight: bold;");

        const screenerTable = document.querySelector('tbody');
        let watchlistPanel = document.querySelector('div[data-name="symbol-list-wrap"]');

        // Resilience: If watchlist is missing, try to open it!
        if (!watchlistPanel) {
            console.log("[TELEMETRY] 🛡️ Watchlist panel missing. Attempting force-open...");
            const success = await ensureWatchlistPanelOpen();
            if (success) {
                watchlistPanel = document.querySelector('div[data-name="symbol-list-wrap"]');
                updateArea2Watchlist(); // Refresh snapshot if panel was just opened
            }
        }

        if (!screenerTable || !watchlistPanel) {
            console.warn("[TELEMETRY] ⚠️ Skipping: Required UI containers (Screener or Watchlist) not found yet.");
            return;
        }

        if (Object.keys(colMap).length === 0) mapHeaders();
        const telemetryHeaders = [];
        // Dynamically grab all column headers from the table top
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
                const rowData = {
                    full,
                    short: parts.length > 1 ? parts[1] : full
                };

                cells.forEach((cell, idx) => {
                    if (idx < telemetryHeaders.length) {
                        const fieldName = telemetryHeaders[idx];
                        const text = cell.innerText.trim();
                        // Clean commonly noisy characters for numeric evaluation
                        const cleanText = text.replace(/\s|\n|USDT/g, '').replace(/−/g, '-');

                        // Robust numeric extraction
                        if (/^-?[\d.]+$/.test(cleanText) && cleanText !== "") {
                            rowData[fieldName] = parseFloat(cleanText);
                        } else {
                            rowData[fieldName] = text; // Keeps 'Buy', 'Sell', symbols etc intact
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
                    const ts = new Date().toLocaleTimeString();
                    const serverInfo = JSON.parse(response.responseText);
                    console.log(`%c[TELEMETRY] ✅ Snapshot Synced @ ${ts}`, "color: #4caf50; font-style: italic;");
                    
                    // Handle Background Sync (Resilience)
                    if (serverInfo.master_targets) {
                        processSyncPayload(serverInfo, "HEARTBEAT");
                    }
                } else {
                    console.error(`[TELEMETRY] ❌ Error ${response.status}:`, response.responseText);
                }
            },
            onerror: function (err) {
                console.error("[TELEMETRY] ❌ Request Failed:", err);
            }
        });
    }

    function monitor() {
        ensureWatchlistPanelOpen();
        mapHeaders();
        updateArea2Watchlist(); // Sync with UI Watchlist

        const rows = document.querySelectorAll('tbody tr[data-rowkey]');
        const seenInThisScan = new Set();
        let adoptedCount = 0;

        rows.forEach(row => {
            const rowKey = row.getAttribute('data-rowkey');
            const [exchange, ticker] = rowKey.split(':');
            const cells = row.querySelectorAll('td');
            if (!cells[colMap.SYMBOL]) return;
            seenInThisScan.add(rowKey);

            // Phase 2: Cooldowns (Graduated Set)
            const gradTime = graduatedSet.get(rowKey);
            if (gradTime) {
                if (Date.now() - gradTime > 60 * 60 * 1000) {
                    graduatedSet.delete(rowKey); // Lock expired
                } else {
                    return; // Ignore, coin recently graduated
                }
            }

            // Phase 2: Re-emergence Bypass (Use Case 4)
            // If the coin is ALREADY explicitly in the active watchlist (Area 2 DOM), bypass scout tracking!
            if (area2WatchlistSet.has(rowKey)) {
                return;
            }

            // ADOPTION LOGIC: If Server wants it, and we aren't tracking it, ADOPT IT.
            // (Takes precedence over normal birth)
            if (serverTargetSet.has(rowKey) && !activeMasterSet.has(rowKey)) {
                activeMasterSet.add(rowKey);
                const currentPrice = parseFloat(cells[colMap.PRICE]?.innerText.replace(/,/g, '')) || 0;
                // We restart its lifecycle from now (or could infer age, but fresh is safer)
                pipelineRegistry.set(rowKey, { bornAt: Date.now(), bornPrice: currentPrice, ticker, q8: false });
                console.log(`%c[SYNC] Resuming watch for ${ticker}`, "color: #2196f3; font-weight: bold;");
                adoptedCount++;
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
                    console.log(`%c[QUALIFIED VELOCITY] ${ticker} | Move: ${totalMove.toFixed(3)}%`, STYLES.PICK);
                }

                if (lifetime >= CONFIG.GATE_20) {
                    pushToBackend({ ticker, exchange, type: "STABLE", move: totalMove, direction, price: currentPrice });
                    console.log(`%c[QUALIFIED STABLE] ${ticker} | Cycle Complete`, STYLES.PICK);
                    activeMasterSet.delete(rowKey);
                    pipelineRegistry.delete(rowKey);

                    // Phase 2: Graduation Lock (60 minutes)
                    graduatedSet.set(rowKey, Date.now());

                    // Remove from server target so we don't re-adopt immediately
                    serverTargetSet.delete(rowKey);
                }
                return;
            }

            // If not in activeMasterSet and not adopted from serverTargetSet, it's a new "birth"
            activeMasterSet.add(rowKey);
            pipelineRegistry.set(rowKey, { bornAt: Date.now(), bornPrice: parseFloat(cells[colMap.PRICE]?.innerText.replace(/,/g, '')) || 0, ticker, q8: false });
            console.log(`%c[WATCH] Starting cycle for ${ticker}`, STYLES.BORN);
        });

        // Cleanup: Phase 2 - Ghost Grace Period (5 Min)
        const now = Date.now();
        pipelineRegistry.forEach((node, key) => {
            if (!seenInThisScan.has(key)) {
                if (!node.pausedAt) {
                    node.pausedAt = now; // Mark missing
                } else if (now - node.pausedAt > 5 * 60 * 1000) { // 5 minutes grace
                    activeMasterSet.delete(key);
                    pipelineRegistry.delete(key);
                }
            } else {
                if (node.pausedAt) {
                    node.pausedAt = null; // Resurrected!
                }
            }
        });
        saveState(); // Persist to GM storage
    }

    // Initial Run
    setTimeout(() => {
        console.log("%c[SYSTEM] 🔥 Initializing Scanner Engine...", "color: #e91e63; font-weight: bold;");
        loadState(); // Hydrate before monitor
        monitor(); // Run immediately
    }, 2000);

    // Main Pick/Ghost Scanner
    setInterval(monitor, CONFIG.SCAN_MS);

    // Telemetry Poller (Wait 30s for full page load, then every 5 min)
    setTimeout(() => {
        sendTelemetry(); // Initial send
        setInterval(sendTelemetry, TELEMETRY.POLL_MS);
    }, 30000);
})();