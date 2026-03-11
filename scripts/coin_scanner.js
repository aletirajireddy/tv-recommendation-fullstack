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
                    console.log(`[DATA-RECEIVED] Master: ${serverInfo.master_targets?.length || 0} | Prune: ${serverInfo.prune_list?.length || 0}`);

                    // 1. LOGGING
                    console.log(`%c[SERVER ${status} @ ${ts}] %c${payload.ticker}: ${serverInfo.ai_suggestion || 'Processed'}`,
                        STYLES.SERVER, "color: #b39ddb; font-style: italic;");                    
                        
                    // 2. PRUNE LIST (Feedback Loop)
                    if (serverInfo.prune_list && Array.isArray(serverInfo.prune_list)) {
                        let prunedCount = 0;

                        serverInfo.prune_list.forEach(tickerKey => {
                            if (activeMasterSet.has(tickerKey)) {
                                activeMasterSet.delete(tickerKey);
                                pipelineRegistry.delete(tickerKey);
                                prunedCount++;
                            }
                            // Also remove from target set preventing re-adoption
                            if (serverTargetSet.has(tickerKey)) {
                                serverTargetSet.delete(tickerKey);
                            }
                        });
                        if (prunedCount > 0) console.log(`%c ✂️ Pruned ${prunedCount} Zombies`, "color: #90a4ae;");
                    }

                    // 3. MASTER WATCHLIST (Sync)
                    if (serverInfo.master_targets && Array.isArray(serverInfo.master_targets)) {
                        // Update Global Target Set (Duplicates handled by Set)
                        serverInfo.master_targets.forEach(key => serverTargetSet.add(key));
                        console.log(`%c[MASTER] Target Set:`, "color: #ff9800;", Array.from(serverTargetSet));

                        // 4. MIX & MATCH CLIPBOARD
                        // Merge active_list and new_graduates per implementation plan
                        let clipboardArr = [];
                        if (Array.isArray(serverInfo.active_list)) clipboardArr.push(...serverInfo.active_list);
                        if (Array.isArray(serverInfo.new_graduates)) clipboardArr.push(...serverInfo.new_graduates);
                        clipboardArr = [...new Set(clipboardArr)]; // Deduplicate

                        const clipboardString = clipboardArr.join(',');
                        if (clipboardString) {
                            try {
                                GM_setClipboard(clipboardString);
                                console.log(`%c 📋 Copied Master List! %c 👉 `,
                                    "color: #4caf50; font-weight: bold;",
                                    "background: #ff9800; color: #fff; font-weight: bold; padding: 4px 8px; border-radius: 4px; font-size: 14px;"
                                );

                                // Automa Workaround: Open a dummy URL that Automa's "When visiting a website" trigger can detect
                                // Throttled to 15 minutes to prevent tab spam during fast scans
                                const now = Date.now();
                                if (now - window.lastAutomaTriggerMs > 15 * 60 * 1000 || !window.lastAutomaTriggerMs) {
                                    GM_openInTab("https://www.tradingview.com/cex-screener/lEINSjG1/", { active: false, insert: true, setParent: true });
                                    window.lastAutomaTriggerMs = now;
                                    console.log(`%c 🤖 Fired Automa Trigger (Next allowed in 5m)`, "color: #9c27b0; font-style: italic;");
                                } else {
                                    const minLeft = (15 - ((now - window.lastAutomaTriggerMs) / 60000)).toFixed(1);
                                    console.log(`%c 🤖 Skipped Automa Trigger (Cooldown: ${minLeft}m left)`, "color: #9c27b0; font-style: italic;");
                                }
                            } catch (err) {
                                console.error("Clipboard copy failed:", err);
                            }
                        }
                    }

                } catch (e) {
                    console.warn("[BACKEND] Error parsing response:", e);
                }
            }
        });
    }

    function ensureWatchlistPanelOpen() {
        // Find the specific toggle button on the right sidebar (data-name='base')
        const panelBtn = document.querySelector('button[data-name="base"]');
        if (!panelBtn) return;

        const isPressed = panelBtn.getAttribute('aria-pressed') === 'true';
        if (!isPressed) {
            console.log('[Panel] 📂 Opening Base Right Panel...');
            panelBtn.click();
        }
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

    function sendTelemetry() {
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
                    console.log(`%c[TELEMETRY] 📡 Sent Context: ${payload.screener_total_count} Screener | ${payload.watchlist_count} Watchlist`, "color: #03a9f4; font-style: italic;");
                }
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
    }

    // Main Pick/Ghost Scanner
    setInterval(monitor, CONFIG.SCAN_MS);
    
    // Telemetry Poller (Wait 10s for initial load, then every 5 min)
    setTimeout(() => {
        sendTelemetry(); // Initial send
        setInterval(sendTelemetry, TELEMETRY.POLL_MS);
    }, 10000);
})();