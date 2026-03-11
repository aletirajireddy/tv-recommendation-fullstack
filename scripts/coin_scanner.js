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
        SCAN_MS: 60000, // Reduced to 30s scans for testing
        GATE_8: 8,      // VELOCITY alert after 1 minute (was 8)
        GATE_20: 20,     // STABLE alert after 2 minutes (was 20)
        BACKEND_URL: "http://localhost:3000/qualified-pick",
        FIELDS: { SYMBOL: "TickerUniversal", RATING: "TechnicalRating|TimeResolution1D", PRICE: "Price" }
    };

    const activeMasterSet = new Set();
    const serverTargetSet = new Set(); // Coins the server wants us to watch
    const pipelineRegistry = new Map();
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
                    console.log(`[DATA-RECEIVED] Master: ${serverInfo.master_watchlist || 'None'} | Prune: ${serverInfo.prune_list || 'None'}`);

                    // 1. LOGGING
                    console.log(`%c[SERVER ${status} @ ${ts}] %c${payload.ticker}: ${serverInfo.ai_suggestion || 'Processed'}`,
                        STYLES.SERVER, "color: #b39ddb; font-style: italic;");                    // 2. PRUNE LIST (Feedback Loop)
                    if (serverInfo.prune_list && typeof serverInfo.prune_list === 'string') {
                        const pruneList = serverInfo.prune_list.split(',').filter(s => s.trim().length > 0);
                        let prunedCount = 0;

                        pruneList.forEach(tickerKey => {
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
                    if (serverInfo.master_watchlist) {
                        const masterList = serverInfo.master_watchlist.split(',').filter(s => s.trim().length > 0);
                        // Update Global Target Set (Duplicates handled by Set)
                        masterList.forEach(key => serverTargetSet.add(key));
                        console.log(`%c[MASTER] Target Set:`, "color: #ff9800;", Array.from(serverTargetSet));

                        // Copy to Clipboard feature for easy pasting
                        const clipboardString = masterList.join(',');
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

    function monitor() {
        ensureWatchlistPanelOpen();
        mapHeaders();
        const rows = document.querySelectorAll('tbody tr[data-rowkey]');
        const seenInThisScan = new Set();
        let adoptedCount = 0;

        rows.forEach(row => {
            const rowKey = row.getAttribute('data-rowkey');
            const [exchange, ticker] = rowKey.split(':');
            const cells = row.querySelectorAll('td');
            if (!cells[colMap.SYMBOL]) return;
            seenInThisScan.add(rowKey);

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

        // Cleanup: If a coin disappears from the UI, we stop tracking it (unless you want blind persistence?)
        // User said: "if the coin not listed in table UI ignore that coin".
        // So we delete it from activeMasterSet.
        pipelineRegistry.forEach((node, key) => {
            if (!seenInThisScan.has(key)) {
                activeMasterSet.delete(key);
                pipelineRegistry.delete(key);
                // We do NOT delete from serverTargetSet, so if it reappears, we re-adopt.
            }
        });
    }

    setInterval(monitor, CONFIG.SCAN_MS);
})();