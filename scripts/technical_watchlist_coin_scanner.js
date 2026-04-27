// ==UserScript==
// @name         Stream D Technical Watchlist Scanner
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Dynamically reads all columns from the Watchlist screener and punches data to backend Stream D
// @author       Antigravity
// @match        *://*.tradingview.com/cex-screener/EsMeqhbP/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        SCAN_INTERVAL_MS: 120000, // 2 minutes
        BACKEND_URL: "http://localhost:3000/api/stream-d/technicals"
    };

    /**
     * Converts a string like "Change % 24h" to camelCase "changePct24h"
     * and "RSI (14) 15m" to "rsi14_15m"
     */
    function normalizeHeaderKey(text) {
        if (!text) {
            return "unknown";
        }
        return text
            .toLowerCase()
            .replace(/%/g, 'Pct')
            .replace(/\(([^)]+)\)/g, '$1') // remove parens but keep contents (e.g., "(14)" -> "14")
            .replace(/[^a-z0-9]/gi, '_')   // replace special chars with underscores
            .replace(/_+/g, '_')           // collapse multiple underscores
            .replace(/^_|_$/g, '')         // trim leading/trailing underscores
            .replace(/_([a-z])/g, (m, c) => c.toUpperCase()); // naive camelCase
    }

    /**
     * Parses numeric strings handling TV specific formats
     */
    function parseTvNumber(text) {
        if (!text || text === '—' || text === '') {
            return null;
        }
        const cleaned = text
            .replace('−', '-')
            .replace(/,/g, '')
            .replace(/[A-Za-z]/g, '') // remove "B", "M", "K" etc. (Note: standard TV doesn't convert B/M to numeric here, but we'll try to just grab the raw number if possible. Actually, let's keep it as a string if it has text so we don't lose the magnitude, or just parsefloat and lose the magnitude? Better to keep the raw string if it has magnitude, but for now we'll just try parseFloat).
            .trim();

        // Handle M/B/K magnitudes
        let multiplier = 1;
        const lastChar = text.trim().slice(-1).toUpperCase();
        if (lastChar === 'B') {
            multiplier = 1000000000;
        } else if (lastChar === 'M') {
            multiplier = 1000000;
        } else if (lastChar === 'K') {
            multiplier = 1000;
        }

        const val = parseFloat(cleaned);
        return isNaN(val) ? text.trim() : val * multiplier;
    }

    function extractTicker(row) {
        const link = row.querySelector('a[class*="tickerName"]');
        if (link) {
            return link.innerText.trim();
        }

        const rowKey = row.getAttribute('data-rowkey');
        if (rowKey) {
            const parts = rowKey.split(':');
            return parts.length > 1 ? parts[1].replace('.P', '').trim() : rowKey;
        }
        return 'UNKNOWN';
    }

    function scanAndPunchData() {
        console.log(`[Stream D] 🕵️‍♂️ Starting scan at ${new Date().toLocaleTimeString()}...`);

        const headerCells = document.querySelectorAll('thead th[data-field]');
        if (headerCells.length === 0) {
            console.warn("[Stream D] ❌ No headers found (data-field missing).");
            return;
        }

        // Dynamically map column index to a stable key
        const columnMap = {};
        headerCells.forEach((th, index) => {
            const field = th.getAttribute('data-field');
            if (field) {
                // We use the data-field as the base for the key, it's more stable
                const key = normalizeHeaderKey(field);
                
                // Also capture the human name for logging/debugging
                const textDiv = th.querySelector('[class*="upperLine"]');
                const humanName = textDiv ? textDiv.innerText.trim() : th.innerText.trim();
                
                columnMap[index] = { key, field, humanName };
            }
        });

        const rawRows = document.querySelectorAll('tbody tr[data-rowkey]');
        if (rawRows.length === 0) {
            console.warn("[Stream D] ⚠️ No data rows found (data-rowkey missing).");
            return;
        }

        const payloadResults = [];

        rawRows.forEach(row => {
            const cells = row.querySelectorAll('td');
            const rowKey = row.getAttribute('data-rowkey') || '';
            const ticker = extractTicker(row);

            if (!ticker || ticker === 'UNKNOWN') {
                return;
            }

            const coinData = {
                ticker: ticker,
                exchange_symbol: rowKey,
                datakey: rowKey,
                close: null 
            };

            cells.forEach((cell, idx) => {
                const mapInfo = columnMap[idx];
                if (mapInfo) {
                    const text = cell.innerText.trim();
                    const value = parseTvNumber(text);
                    
                    coinData[mapInfo.key] = value;

                    // Standardize the price column if found
                    if (mapInfo.field.toLowerCase() === 'price' || mapInfo.humanName.toLowerCase() === 'price') {
                        coinData.close = value;
                    }
                }
            });

            payloadResults.push({
                ticker: ticker,
                data: coinData
            });
        });

        const payload = {
            id: `stream_d_${Date.now()}`,
            timestamp: new Date().toISOString(),
            trigger: 'watchlist_technical_scan',
            results: payloadResults
        };

        console.log(`[Stream D] 📦 Payload generated with ${payloadResults.length} coins. Sending to backend...`);

        GM_xmlhttpRequest({
            method: "POST",
            url: CONFIG.BACKEND_URL,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(payload),
            onload: function (response) {
                if (response.status === 200) {
                    console.log(`[Stream D] ✅ Data successfully punched! Next scan in 2 mins.`);
                } else {
                    console.error(`[Stream D] ❌ Backend rejected payload (Status ${response.status}):`, response.responseText);
                }
            },
            onerror: function (err) {
                console.error(`[Stream D] ❌ Network Error punching data:`, err);
            }
        });
    }

    // Wait for full page load + additional delay for TradingView SPA stability
    window.addEventListener('load', () => {
        setTimeout(() => {
            console.log(`[Stream D] 🚀 Stream D Data Punching Machine Initialized (Post-Load)!`);
            scanAndPunchData(); // Initial run

            // Cyclic Timer
            setInterval(() => {
                console.log(`[Stream D] ⏱️ Auto-timer triggered (${CONFIG.SCAN_INTERVAL_MS / 1000}s interval)`);
                scanAndPunchData();
            }, CONFIG.SCAN_INTERVAL_MS);

        }, 10000); // 10 second safety buffer
    });
})();
