// ==UserScript==
// @name         Stream D Technical Watchlist Scanner
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  v1.6: backend-driven tab activation — same pattern as Stream A (v16.3+) and Stream B (v20.30). No initial-setup filter check for Stream D (not needed here, unlike A/B's screener filter concerns) — just the dynamic dispatch half. The backend watches coin_metric_history staleness and, past a threshold, includes activate_tab_workflow_id in the /api/stream-d/technicals response; the script dispatches whatever ID it's given via the automa:execute-workflow CustomEvent, on a local 3min cooldown. The workflow ID is never hardcoded here — the backend owns it, same as A/B. v1.5: refresh-click now logs which path found the button (confirmed #js-screener-container vs fallback) every cycle, so the console shows proof it's using the manually-verified selector. v1.4: refresh-button lookup now searches #js-screener-container first (confirmed via user DOM inspection as the button's actual parent), instead of a bare document-wide query. v1.3: Compact title heartbeat (was verbose "26 coins · next update in 47s", now "📡26c +2-1 next 47s" — coin count, +added/-removed vs last cycle, countdown, all in minimal tab-strip space). v1.2: force-refresh via confirmed selector before capture; hidden-tab guard.
// @author       Antigravity
// @match        *://*.tradingview.com/cex-screener/EsMeqhbP/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        SCAN_INTERVAL_MS: 120000, // 2 minutes
        BACKEND_URL: "http://localhost:3000/api/stream-d/technicals",
        // Confirmed selector (2026-08-22) for TradingView's own manual refresh
        // control. Clicking it before reading the table forces TradingView to
        // pull fresh data itself — its own update loop can pause independently
        // of anything Chrome does, which no browser flag can override.
        REFRESH_BUTTON_SELECTOR: '[data-qa-id="screener-refresh-button"]',
        // How long to wait after clicking refresh before reading the table —
        // gives TradingView's own fetch+render time to actually land.
        REFRESH_SETTLE_MS: 35000,

        // 2026-09-10: backend-driven tab activation — same pattern as Stream
        // A/B. The backend decides (coin_metric_history staleness) whether
        // this tab needs to come to front and hands down whichever workflow
        // ID it wants dispatched. Never hardcoded here — the backend owns it.
        TAB_ACTIVATE_COOLDOWN_MS: 3 * 60 * 1000,
    };

    // Self-reported version, sent with every payload — lets the backend tell
    // us if the browser is actually running what we think it's running.
    // Bump this any time @version above changes.
    const SCRIPT_VERSION = '1.6';

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
            .replace(/[A-Za-z]/g, '') // remove "B", "M", "K" etc.
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

    // ── Backgrounded-tab guard ───────────────────────────────────────────────
    // Chrome throttles setInterval in hidden tabs, AND TradingView's own live
    // feed/UI can stop updating while backgrounded — so a "stale but on-time"
    // scan reads DOM numbers that froze whenever the tab was last visible,
    // while the server stamps them with the (fresh) receive time. That makes
    // genuinely old data look live. Skip the punch entirely while hidden, and
    // catch up immediately the moment the tab regains focus instead of waiting
    // for the next interval tick.
    function isTabHidden() {
        return typeof document.hidden === 'boolean' ? document.hidden : false;
    }

    // ── Tab-title heartbeat — compact, tab-strip space is tiny ──────────────
    // Format: "📡26c +2-1 next 45s" = 26 coins captured, +2/-1 vs last cycle,
    // next capture in 45s. If the countdown stops moving, the tab itself is
    // stuck (backgrounded/occluded/idle) regardless of any flag.
    const titleState = {
        coinCount: 0,
        added: 0,
        removed: 0,
        nextEventAt: Date.now() + 10000,
        label: 'init',
    };
    let prevTickerSet = new Set();

    function renderTitle() {
        const secsLeft = Math.max(0, Math.round((titleState.nextEventAt - Date.now()) / 1000));
        const delta = (titleState.added || titleState.removed) ? ` +${titleState.added}-${titleState.removed}` : '';
        document.title = `📡${titleState.coinCount}c${delta} ${titleState.label} ${secsLeft}s`;
    }
    setInterval(renderTitle, 1000);

    function captureAndSend() {
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

        // Compact added/removed vs the last capture — shown in the title
        // heartbeat since tab-strip space is tiny.
        const currentTickerSet = new Set(payloadResults.map(r => r.ticker));
        const addedSet   = new Set([...currentTickerSet].filter(t => !prevTickerSet.has(t)));
        const removedSet = new Set([...prevTickerSet].filter(t => !currentTickerSet.has(t)));
        titleState.coinCount = payloadResults.length;
        titleState.added = addedSet.size;
        titleState.removed = removedSet.size;
        prevTickerSet = currentTickerSet;
        if (addedSet.size || removedSet.size) {
            console.log(`[Stream D] Δ +[${[...addedSet].join(',')}] -[${[...removedSet].join(',')}]`);
        }

        const payload = {
            id: `stream_d_${Date.now()}`,
            timestamp: new Date().toISOString(),
            trigger: 'watchlist_technical_scan',
            script_version: SCRIPT_VERSION,
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
                    console.log(`[Stream D] ✅ Data successfully punched! Next scan in ${CONFIG.SCAN_INTERVAL_MS / 1000}s.`);

                    // 2026-09-10: backend-driven tab activation — same pattern
                    // as Stream A/B. Dispatch whatever workflow ID the backend
                    // sends, on a local cooldown to avoid re-firing every cycle.
                    try {
                        const resJson = JSON.parse(response.responseText);
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
                        console.warn('[Tab-Activate] ⚠️ Could not parse response for activate_tab_workflow_id:', e);
                    }
                } else {
                    console.error(`[Stream D] ❌ Backend rejected payload (Status ${response.status}):`, response.responseText);
                }
            },
            onerror: function (err) {
                console.error(`[Stream D] ❌ Network Error punching data:`, err);
            }
        });
    }

    // ── Full cycle: guard → force-refresh → settle → capture ────────────────
    // Clicking TradingView's own refresh control (rather than just reading
    // whatever's already rendered) forces it to re-pull live data even if its
    // own background update loop had paused — the DOM read alone can't fix
    // that, only TradingView's own refresh action can.
    let cycleRunning = false;
    async function runCycle() {
        if (cycleRunning) return; // don't overlap if a previous cycle is still settling
        cycleRunning = true;
        try {
            if (isTabHidden()) {
                console.warn(`[Stream D] ⏸️ Tab is backgrounded — skipping cycle (would punch stale DOM data). Will catch up when tab regains focus.`);
                titleState.label = 'hidden';
                titleState.nextEventAt = Date.now() + CONFIG.SCAN_INTERVAL_MS;
                return;
            }

            // Confirmed (2026-08-22, user DOM inspection + manual console click-test):
            // document.getElementById('js-screener-container').querySelector(
            //   '[data-qa-id="screener-refresh-button"]')  is the button's real,
            // verified-working path — search there first for a reliable first-try match.
            const screenerContainer = document.getElementById('js-screener-container');
            let refreshBtn = null, refreshVia = null;
            if (screenerContainer && (refreshBtn = screenerContainer.querySelector(CONFIG.REFRESH_BUTTON_SELECTOR))) {
                refreshVia = '#js-screener-container (confirmed)';
            } else if ((refreshBtn = document.querySelector(CONFIG.REFRESH_BUTTON_SELECTOR))) {
                refreshVia = 'document-wide (fallback)';
            }
            if (refreshBtn) {
                refreshBtn.click();
                console.log(`[Stream D] 🔄 Clicked refresh button via ${refreshVia} — waiting ${CONFIG.REFRESH_SETTLE_MS / 1000}s for TradingView to repopulate...`);
                titleState.label = 'refresh';
                titleState.nextEventAt = Date.now() + CONFIG.REFRESH_SETTLE_MS;
                await new Promise(r => setTimeout(r, CONFIG.REFRESH_SETTLE_MS));
                // Re-check visibility — a 35s wait is long enough for the tab
                // to have been backgrounded mid-wait.
                if (isTabHidden()) {
                    console.warn(`[Stream D] ⏸️ Tab went hidden during the refresh wait — aborting this cycle's capture.`);
                    titleState.label = 'hidden';
                    titleState.nextEventAt = Date.now() + CONFIG.SCAN_INTERVAL_MS;
                    return;
                }
            } else {
                console.warn(`[Stream D] ⚠️ Refresh button not found (selector: "${CONFIG.REFRESH_BUTTON_SELECTOR}") — reading table as-is.`);
            }

            captureAndSend();
            titleState.label = 'next';
            titleState.nextEventAt = Date.now() + CONFIG.SCAN_INTERVAL_MS;
        } finally {
            cycleRunning = false;
        }
    }

    // Catch-up the instant the tab regains focus — don't wait for the next
    // (possibly throttle-delayed) interval tick to notice fresh data is available.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            console.log(`[Stream D] 👁️ Tab regained focus — running catch-up cycle.`);
            runCycle();
        }
    });

    // Wait for full page load + additional delay for TradingView SPA stability
    window.addEventListener('load', () => {
        setTimeout(() => {
            console.log(`[Stream D] 🚀 Stream D Data Punching Machine Initialized (Post-Load)!`);
            runCycle(); // Initial run

            // Cyclic Timer
            setInterval(() => {
                console.log(`[Stream D] ⏱️ Auto-timer triggered (${CONFIG.SCAN_INTERVAL_MS / 1000}s interval)`);
                runCycle();
            }, CONFIG.SCAN_INTERVAL_MS);

        }, 10000); // 10 second safety buffer
    });
})();
