// ==UserScript==
// @name         Institutional Conviction Engine - Bidirectional v16.0
// @namespace    http://tampermonkey.net/
// @version      16.0
// @description  Cyclic monitor with full market snapshot and bidirectional backend feedback.
// @author       Gemini_Thought_Partner
// @match        *://*.tradingview.com/cex-screener/RDpx2vs9/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        SCAN_MS: 60000,
        GATE_8: 8, GATE_20: 20,
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

                    // 1. LOGGING & HISTORY
                    console.log(`%c[SERVER ${status} @ ${ts}] %c${payload.ticker}: ${serverInfo.ai_suggestion || 'Processed'}`,
                        STYLES.SERVER, "color: #b39ddb; font-style: italic;");

                    // Archive Response
                    debugServerHistory.push({
                        ts: ts,
                        prune: serverInfo.prune_list,
                        master: serverInfo.master_watchlist
                    });
                    console.log("[DEBUG HISTORY]", debugServerHistory);


                    // 2. PRUNE LIST (Feedback Loop)
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
                        console.log(`%c[MASTER] Target Set Size: ${serverTargetSet.size}`, "color: #ff9800;");
                    }

                } catch (e) {
                    console.warn("[BACKEND] Error parsing response:", e);
                }
            }
        });
    }

    function monitor() {
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