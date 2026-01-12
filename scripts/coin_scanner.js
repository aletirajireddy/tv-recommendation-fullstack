// ==UserScript==
// @name         Institutional Conviction Engine - Bidirectional v8.0
// @namespace    http://tampermonkey.net/
// @version      8.0
// @description  Continuous 8m/20m monitoring with real-time Node backend push.
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
    const pipelineRegistry = new Map();
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
                    const serverInfo = JSON.parse(response.responseText);
                    // LOGGING THE DATA RECEIVED BACK FROM SERVER
                    console.log(`%c[SERVER RESPONSE] %c${payload.ticker}: ${serverInfo.message || 'Processed'}`,
                        STYLES.SERVER, "color: #b39ddb; font-style: italic;");
                    if (serverInfo.ai_suggestion) {
                        console.log(`%c > Suggestion: ${serverInfo.ai_suggestion}`, "color: #ce93d8;");
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

        rows.forEach(row => {
            const rowKey = row.getAttribute('data-rowkey');
            const [exchange, ticker] = rowKey.split(':');
            const cells = row.querySelectorAll('td');
            if (!cells[colMap.SYMBOL]) return;

            seenInThisScan.add(rowKey);

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
                }
                return;
            }

            activeMasterSet.add(rowKey);
            pipelineRegistry.set(rowKey, { bornAt: Date.now(), bornPrice: parseFloat(cells[colMap.PRICE]?.innerText.replace(/,/g, '')) || 0, ticker, q8: false });
            console.log(`%c[WATCH] Starting cycle for ${ticker}`, STYLES.BORN);
        });

        pipelineRegistry.forEach((node, key) => { if (!seenInThisScan.has(key)) { activeMasterSet.delete(key); pipelineRegistry.delete(key); } });
    }

    setInterval(monitor, CONFIG.SCAN_MS);
})();