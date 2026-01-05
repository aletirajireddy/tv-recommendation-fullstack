// ==UserScript==
// @name         Ultra Scalper v14.5 - Complete with Fixed Alt+L & Di/D Support
// @namespace    http://tampermonkey.net/
// @version      14.2
// @description  Auto-triggers AI analysis with smart change detection + Alert integration + Fixed event toggles
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

    console.log('🚀 ULTRA SCALPER v14.1 INITIALIZED');

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
    };

    const INTERVAL_MS = CONFIG.INTERVAL_MINUTES * 60 * 1000;
    const UI_DELAY_MS = CONFIG.UI_DELAY_SECONDS * 1000;

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
        lastScanHash: null,
        processDebounceTimer: null,

        autoScanCount: 0,
        lastAutoTriggerHash: null,
        lastScanType: null,

        lastSentHash: null,
        lastSentTime: null,
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

    function sendPayload(payload) {
        OfflineStore.prune();

        console.log(`[Send] Sending payload ${payload.id} (${payload.trigger})...`);

        GM_xmlhttpRequest({
            method: 'POST',
            url: CONFIG.AUTO_TRIGGER_ENDPOINT,
            data: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' },
            onload: (response) => {
                if (response.status === 200) {
                    console.log(`✅ Data sent successfully: ${payload.id}`);
                    if (response.responseText) {
                        try {
                            console.log('📥 Response:', response.responseText);
                        } catch (e) { }
                    }
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
                if (response.status === 200) {
                    console.log(`✅ Flushed item ${item.id}`);
                    const newQueue = OfflineStore.getQueue().slice(1);
                    OfflineStore.saveQueue(newQueue);
                    setTimeout(flushNextOfflineItem, 1000);
                } else {
                    console.warn(`❌ Flush failed for ${item.id}, keeping in queue.`);
                }
            },
            onerror: () => console.warn(`❌ Flush network error for ${item.id}`),
            timeout: 10000
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // HELPERS
    // ═══════════════════════════════════════════════════════════════
    function cleanTicker(ticker) {
        if (!ticker) return '';
        return ticker
            .replace(/\.P$/i, '')
            .replace(/USDT$/i, '')
            .replace(/BUSD$/i, '')
            .replace(/USD$/i, '');
    }

    function parseTvNumber(text) {
        if (!text || text === '—' || text === '') return null;
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
        if (!coins || coins.length === 0) return 'empty';
        // Compute hash of ALL coins to ensure any change is detected
        const str = coins
            .map((c) => `${c.ticker}:${c.netTrend}:${c.resistDist}`)
            .join('|');
        return str;
    }

    // ═══════════════════════════════════════════════════════════════
    // CHANGE DETECTION
    // ═══════════════════════════════════════════════════════════════
    function detectDataChange(scanType) {
        const currentHash = generateDataHash(STATE.lastProcessedData || []);

        const result = {
            currentHash: currentHash,
            lastSentHash: STATE.lastSentHash,
            hasChanged: currentHash !== STATE.lastSentHash,
            timeSinceLastSend: STATE.lastSentTime ? Date.now() - STATE.lastSentTime : Infinity,
            shouldSend: false,
            reason: ''
        };

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
        if (btn) return btn;

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
    function detectColumns() {
        const headers = document.querySelectorAll('thead tr th');
        if (headers.length === 0) return null;

        const columnMap = {};

        headers.forEach((th, index) => {
            const textDiv = th.querySelector('[class*="upperLine"]');
            const text = textDiv ? textDiv.innerText.trim().toLowerCase() : '';
            const combined = `${text} ${(th.getAttribute('title') || '').toLowerCase()}`;

            if (combined.includes('symbol') || combined.includes('ticker'))
                columnMap.TICKER = index;
            else if (combined.includes('close') && !combined.includes('dist'))
                columnMap.CLOSE = index;
            else if (combined.includes('vol spike')) columnMap.VOL_SPIKE = index;
            else if (combined.includes('mom score')) columnMap.MOM_SCORE = index;

            // EMA Distances
            else if (combined.includes('1h ema50 dist')) columnMap.EMA50_DIST = index;
            else if (combined.includes('1h ema200 dist')) columnMap.EMA200_DIST = index;

            // Support/Resist (Logic & Standard)
            else if (combined.includes('logic support dist')) columnMap.LOGIC_SUPPORT_DIST = index;
            else if (combined.includes('logic resist dist')) columnMap.LOGIC_RESIST_DIST = index;
            else if (combined.includes('support dist')) columnMap.SUPPORT_DIST = index;
            else if (combined.includes('support stars')) columnMap.SUPPORT_STARS = index;
            else if (combined.includes('resist dist')) columnMap.RESIST_DIST = index;
            else if (combined.includes('resist stars')) columnMap.RESIST_STARS = index;

            // Daily Context
            else if (combined.includes('daily range')) columnMap.DAILY_RANGE = index;
            else if (combined.includes('daily trend')) columnMap.DAILY_TREND = index;

            // Signals
            else if (combined.includes('freeze')) columnMap.FREEZE = index;
            else if (combined.includes('breakout')) columnMap.BREAKOUT = index;
            else if (combined.includes('net trend')) columnMap.NET_TREND = index;
            else if (combined.includes('retrace')) columnMap.RETRACE_OPP = index;

            // Cluster Analysis
            else if (combined.includes('scope count')) columnMap.SCOPE_COUNT = index;
            else if (combined.includes('scope highest')) columnMap.CLUSTER_SCOPE_HIGHEST = index;
            else if (combined.includes('compress count')) columnMap.CLUSTER_COMPRESS_COUNT = index;
            else if (combined.includes('compress highest')) columnMap.CLUSTER_COMPRESS_HIGHEST = index;

            // Flags & Mega Spot
            else if (combined.includes('all ema flags')) columnMap.EMA_FLAGS = index;
            else if (combined.includes('htf 200 flags')) columnMap.HTF_FLAGS = index;
            else if (combined.includes('mega spot')) columnMap.MEGA_SPOT_DIST = index;
            else if (combined.includes('ema position') || combined.includes('position code')) columnMap.POSITION_CODE = index;
        });

        return columnMap.TICKER !== undefined && columnMap.CLOSE !== undefined
            ? columnMap
            : null;
    }

    function extractTicker(row) {
        const link = row.querySelector('a[class*="tickerName"]');
        if (link) return link.innerText.trim();

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
        const columnMap = detectColumns();
        if (!columnMap) {
            console.warn('[Parse] Column detection failed');
            return [];
        }

        const rows = document.querySelectorAll(
            'tbody tr[class*="listRow"][data-rowkey]'
        );
        if (rows.length === 0) {
            console.warn('[Parse] No data rows');
            return [];
        }

        const coins = [];

        rows.forEach((row) => {
            const cells = row.querySelectorAll('td[class*="cell-"]');

            const coin = {
                row: row,
                ticker: extractTicker(row),
                close: parseTvNumber(cells[columnMap.CLOSE]?.innerText),

                // Indicators
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

            if (coin.ticker && coin.ticker !== 'UNKNOWN') {
                coins.push(coin);
            }
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
            // Lightweight Object for Replay (Ticker + Score + NetTrend)
            const miniCoin = { t: clean, s: coin.score, nt: coin.netTrend || 0 };

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
        sentiment.moodScore = Math.round(
            ((bullWeight - bearWeight) / allCoins.length) * 50
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
        if ((coin.momScore || 0) >= 2) score += coin.momScore === 3 ? 7 : 5;
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
        if ((coin.compressCount || 0) >= 3)
            insights.push(`⚡ Compressed(${coin.compressCount})`);
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
        if (coin.score < CONFIG.UNFILTERED_MIN_SCORE) return false;
        if (CONFIG.UNFILTERED_EXCLUDE_FREEZE && (coin.freeze || 0) === 1)
            return false;
        return true;
    }

    function applyFilters(coin, filters) {
        if (filters.minScore && coin.score < filters.minScore) return false;
        if (filters.minResistDist && (coin.resistDist || 0) < filters.minResistDist)
            return false;
        if (
            filters.minSupportDist &&
            (coin.supportDist || 0) > filters.minSupportDist
        )
            return false;
        if (filters.minNetTrend && (coin.netTrend || 0) < filters.minNetTrend)
            return false;
        if (filters.maxNetTrend && (coin.netTrend || 0) > filters.maxNetTrend)
            return false;
        if (filters.minMomScore && (coin.momScore || 0) < filters.minMomScore)
            return false;

        if (filters.minStars) {
            const stars = Math.max(coin.resistStars || 0, coin.supportStars || 0);
            if (stars < filters.minStars) return false;
        }

        if (filters.positionCodes && filters.positionCodes.length > 0) {
            if (!filters.positionCodes.includes(coin.positionCode)) return false;
        }

        if (filters.maxMegaSpotDist !== undefined && coin.megaSpotDist !== null) {
            if (Math.abs(coin.megaSpotDist) > filters.maxMegaSpotDist) return false;
        }

        if (filters.excludeFreeze && (coin.freeze || 0) === 1) return false;
        if (filters.excludeCompressed && (coin.compressCount || 0) >= 4)
            return false;

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
            score: coin.score,
            label: coin.label,
            direction: coin.direction,
            insights: coin.insights || [],

            close: coin.close,
            dailyRange: coin.dailyRange,
            dailyTrend: coin.dailyTrend, // NEW

            netTrend: coin.netTrend,
            momScore: coin.momScore,
            volSpike: coin.volSpike,
            breakout: coin.breakout, // NEW

            resistDist: coin.resistDist,
            resistStars: coin.resistStars,
            logicResistDist: coin.logicResistDist, // NEW

            supportDist: coin.supportDist,
            supportStars: coin.supportStars,
            logicSupportDist: coin.logicSupportDist, // NEW

            ema50Dist: coin.ema50Dist, // NEW
            ema200Dist: coin.ema200Dist, // NEW

            positionCode: coin.positionCode,
            megaSpotDist: coin.megaSpotDist,
            retraceOpportunity: coin.retraceOpportunity,

            scopeCount: coin.scopeCount, // NEW
            clusterScopeHighest: coin.clusterScopeHighest,
            compressCount: coin.compressCount,
            compressHighest: coin.compressHighest, // NEW

            freeze: coin.freeze,
            emaFlags: coin.emaFlags, // NEW
            htfFlags: coin.htfFlags, // NEW
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
        if (!row) return;

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

        if (coin.opacity === 0) return;

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
        if (STATE.history.length < 3) return 'insufficient_data';

        const last3 = STATE.history.slice(-3);
        const moods = last3.map(h => h.marketSentiment.mood);

        if (moods.every(m => m.includes('BULLISH'))) return 'consistent_bullish';
        if (moods.every(m => m.includes('BEARISH'))) return 'consistent_bearish';
        return 'volatile';
    }

    function detectMomentumShift() {
        if (STATE.history.length < 2) return false;

        const prev = STATE.history[STATE.history.length - 2];
        const curr = STATE.history[STATE.history.length - 1];

        const moodChange = Math.abs(curr.marketSentiment.moodScore - prev.marketSentiment.moodScore);
        return moodChange >= 30;
    }

    // ═══════════════════════════════════════════════════════════════
    // PAYLOAD BUILDER (WITH SAFETY CHECKS AND DI/D SUPPORT)
    // ═══════════════════════════════════════════════════════════════
    function buildFinalPayload(historyEntry, scanType, dataChangeInfo) {
        try {
            const aiPriority = {
                scan: {
                    number: historyEntry.scanNumber,
                    type: scanType,
                    name: historyEntry.scanName,
                    timestamp: historyEntry.timestamp,
                    market_mood: historyEntry.marketSentiment.mood,
                    mood_score: historyEntry.marketSentiment.moodScore
                },

                topOpportunities: {
                    buys: STATE.recommendations.buy.slice(0, 10).map(c => ({
                        ticker: cleanTicker(c.ticker),
                        score: c.score,
                        label: c.label,
                        price: c.close,
                        signals: {
                            netTrend: c.netTrend,
                            resistDist: c.resistDist,
                            resistStars: c.resistStars,
                            momentum: c.momScore,
                            volSpike: c.volSpike === 1
                        },
                        position: {
                            code: c.positionCode,
                            megaSpotDist: c.megaSpotDist
                        },
                        insights: c.insights,
                        recommendation: c.score >= 75 ? 'Strong entry' : c.score >= 60 ? 'Good entry' : 'Watch'
                    })),
                    sells: STATE.recommendations.sell.slice(0, 10).map(c => ({
                        ticker: cleanTicker(c.ticker),
                        score: c.score,
                        label: c.label,
                        price: c.close,
                        signals: {
                            netTrend: c.netTrend,
                            supportDist: c.supportDist,
                            supportStars: c.supportStars,
                            momentum: c.momScore,
                            volSpike: c.volSpike === 1
                        },
                        position: {
                            code: c.positionCode,
                            megaSpotDist: c.megaSpotDist
                        },
                        insights: c.insights,
                        recommendation: c.score >= 75 ? 'Strong short' : c.score >= 60 ? 'Good short' : 'Watch'
                    })),
                    retraces: STATE.recommendations.retrace.slice(0, 10).map(c => ({
                        ticker: cleanTicker(c.ticker),
                        score: c.score,
                        label: c.label,
                        price: c.close,
                        retraceLevel: c.retraceOpportunity,
                        signals: {
                            netTrend: c.netTrend,
                            momentum: c.momScore,
                            volSpike: c.volSpike === 1
                        },
                        insights: c.insights,
                        recommendation: 'Retrace entry'
                    }))
                },

                distribution: {
                    filtered: {
                        buys: STATE.recommendations.buy.length,
                        sells: STATE.recommendations.sell.length,
                        retraces: STATE.recommendations.retrace.length
                    },
                    unfiltered: {
                        buys: STATE.unfiltered.buy.length,
                        sells: STATE.unfiltered.sell.length,
                        retraces: STATE.unfiltered.retrace.length
                    },
                    quality_ratio: (STATE.recommendations.buy.length + STATE.recommendations.sell.length) /
                        (STATE.unfiltered.buy.length + STATE.unfiltered.sell.length || 1)
                },

                pattern: {
                    last3Scans: STATE.history.slice(-3).map(h => ({
                        scan: h.scanNumber,
                        mood: h.marketSentiment.mood,
                        buys: h.opportunities.buys.length,
                        sells: h.opportunities.sells.length
                    })),
                    trend: detectTrend(),
                    momentum_shift: detectMomentumShift()
                },

                highValueMissed: STATE.missed.buy
                    .concat(STATE.missed.sell)
                    .filter(c => c.score >= 60)
                    .sort((a, b) => b.score - a.score)
                    .slice(0, 5)
                    .map(c => ({
                        ticker: cleanTicker(c.ticker),
                        score: c.score,
                        missedBy: c.missedReason,
                        potential: c.score >= 65 ? 'high' : 'medium'
                    }))
            };

            const backupData = {
                scanInfo: {
                    number: historyEntry.scanNumber,
                    type: scanType,
                    name: historyEntry.scanName,
                    timestamp: historyEntry.timestamp,
                    timeFormatted: historyEntry.timeFormatted
                },
                marketState: historyEntry.marketSentiment,
                filtersApplied: historyEntry.scanParams,
                opportunities: historyEntry.opportunities,
                unfilteredOpportunities: historyEntry.unfilteredOpportunities,
                missedOpportunities: historyEntry.missedOpportunities,
                counts: historyEntry.counts
            };

            // ═══════════════════════════════════════════════════════════════
            // INSTITUTIONAL PULSE PASS-THROUGH
            // ═══════════════════════════════════════════════════════════════
            let institutionalPulse = { alerts: [] };

            // 1. Consume Buffered Alerts (PASS-THROUGH from alert_scanner.js)
            if (unsafeWindow.pendingAlertBatch && unsafeWindow.pendingAlertBatch.length > 0) {
                console.log(`[Payload] 📥 Found ${unsafeWindow.pendingAlertBatch.length} buffered alerts from alert_scanner.js`);

                // Clone the array to avoid reference issues
                institutionalPulse.alerts = [...unsafeWindow.pendingAlertBatch];

                // CRITICAL: Clear the buffer to prevent duplicate sends on next scan
                unsafeWindow.pendingAlertBatch = [];
                console.log('[Payload] 🧹 Cleared pendingAlertBatch buffer');
            }

            // 2. Legacy/Fallback Logic (if still using gatherInstitutionalPulse)
            if (scanType === 'alert-triggered') {
                // We rely primarily on the buffer now, but if gatherInstitutionalPulse logic is still needed for context:
                // const legacyPulse = gatherInstitutionalPulse(); 
                // if (legacyPulse && legacyPulse.alerts) { ... }
            }

            const scanContext = {
                type: scanType,
                triggeredBy: scanType === 'alert-triggered' && institutionalPulse.alerts.length > 0 ? {
                    alertCount: institutionalPulse.alerts.length,
                    firstAlert: institutionalPulse.alerts[0] ? {
                        ticker: institutionalPulse.alerts[0].asset.ticker,
                        time: institutionalPulse.alerts[0].signal.timestamp
                    } : null
                } : null
            };

            const metadata = {
                dataChanged: dataChangeInfo ? dataChangeInfo.hasChanged : true,
                timeSinceLastSend: dataChangeInfo ? Math.round(dataChangeInfo.timeSinceLastSend / 1000) : null,
                changeReason: dataChangeInfo ? dataChangeInfo.reason : 'N/A'
            };

            const payload = {
                id: `scan_${Date.now()}`,
                trigger: scanType,
                timestamp: historyEntry.timestamp,
                // ═══════════════════════════════════════════════════════════════
                // RESULT DEDUPLICATION (OPTIMIZED SECTION 2)
                // ═══════════════════════════════════════════════════════════════
                results: (() => {
                    const uniqueMap = new Map();

                    // Helper to merge data
                    const procesItem = (item, type, status) => {
                        const ticker = item.ticker;
                        if (!uniqueMap.has(ticker)) {
                            // First time seeing this ticker: Initialize with raw data
                            uniqueMap.set(ticker, {
                                ...item,
                                status: status, // Initial status
                                matchedStrategies: [type], // Track which strategies picked it up
                                missedReason: item.missedReason || null, // Initial reason

                                // Context Injection (Vice-Versa Link)
                                marketMood: historyEntry.marketSentiment.mood,
                                marketScore: historyEntry.marketSentiment.moodScore
                            });
                        } else {
                            // Merge with existing
                            const existing = uniqueMap.get(ticker);

                            // 1. Upgrade Status if needed (PASS overrides MISSED)
                            if (status === 'PASS' && existing.status !== 'PASS') {
                                existing.status = 'PASS';
                                existing.label = item.label; // Use the label from the winning strategy
                                existing.direction = item.direction; // Use direction from the winner
                            }

                            // 2. Track Strategy
                            if (!existing.matchedStrategies.includes(type)) {
                                existing.matchedStrategies.push(type);
                            }

                            // 3. Merge Missed Reasons (if both missed, or just to keep history)
                            if (item.missedReason) {
                                if (existing.missedReason) {
                                    if (!existing.missedReason.includes(item.missedReason)) {
                                        existing.missedReason += ` | ${type}: ${item.missedReason}`;
                                    }
                                } else {
                                    existing.missedReason = `${type}: ${item.missedReason}`;
                                }
                            }
                        }
                    };

                    // Process ALL lists
                    historyEntry.opportunities.buys.forEach(i => procesItem(i, 'BUY', 'PASS'));
                    historyEntry.missedOpportunities.buys.forEach(i => procesItem(i, 'BUY', 'MISSED'));

                    historyEntry.opportunities.sells.forEach(i => procesItem(i, 'SELL', 'PASS'));
                    historyEntry.missedOpportunities.sells.forEach(i => procesItem(i, 'SELL', 'MISSED'));

                    historyEntry.opportunities.retraces.forEach(i => procesItem(i, 'RETRACE', 'PASS'));
                    historyEntry.missedOpportunities.retraces.forEach(i => procesItem(i, 'RETRACE', 'MISSED'));

                    return Array.from(uniqueMap.values());
                })(),
                aiPriority: aiPriority,
                backupData: backupData,
                scanContext: scanContext,
                metadata: metadata,
                // Section 1: Institutional Pulse
                institutional_pulse: institutionalPulse,
                // Section 4: Market Sentiment (New Requirement)
                market_sentiment: historyEntry.marketSentiment
            };

            if (institutionalPulse.alerts.length > 0) {
                console.log(`[Payload] ✅ Attached ${institutionalPulse.alerts.length} alerts to payload.institutional_pulse`);
                // For legacy compat if needed
                payload.institutionalPulse = institutionalPulse;
            } else {
                console.log('[Payload] ℹ️ No pending alerts to attach');
            }

            return payload;

        } catch (error) {
            console.error('[Payload] ❌ Critical error building payload:', error);
            return {
                aiPriority: {
                    scan: {
                        number: historyEntry.scanNumber,
                        type: scanType,
                        error: 'Payload build error'
                    }
                },
                backupData: historyEntry,
                scanContext: { type: scanType, error: error.message },
                metadata: { error: true }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // AUTO-TRIGGER LOGIC (WITH CHANGE DETECTION)
    // ═══════════════════════════════════════════════════════════════
    function handleAutoTrigger(historyEntry) {
        if (STATE.autoScanCount !== CONFIG.AUTO_TRIGGER_AFTER_SCANS) {
            console.log(`[AutoTrigger] ⏸️ Waiting for scan ${CONFIG.AUTO_TRIGGER_AFTER_SCANS} (currently at ${STATE.autoScanCount})`);
            return;
        }

        const changeDetection = detectDataChange('auto');

        if (!changeDetection.shouldSend) {
            console.log(`[AutoTrigger] ⏭️ ${changeDetection.reason}`);
            STATE.autoScanCount = 0;
            return;
        }

        console.log(`\n${'═'.repeat(60)}`);
        console.log('🤖 AUTO-TRIGGER ACTIVATED (After 2nd auto-scan with new data)');
        console.log(`${'═'.repeat(60)}`);

        STATE.autoScanCount = 0;

        const payload = buildFinalPayload(historyEntry, 'auto', changeDetection);

        console.log('📦 Sending data to AI endpoint...');
        console.log(`   Endpoint: ${CONFIG.AUTO_TRIGGER_ENDPOINT}`);
        console.log(`   AI Priority: ${JSON.stringify(payload.aiPriority).length} bytes`);
        console.log(`   Backup Data: ${JSON.stringify(payload.backupData).length} bytes`);
        console.log(`   Total: ${JSON.stringify(payload).length} bytes`);

        GM_xmlhttpRequest({
            method: 'POST',
            url: CONFIG.AUTO_TRIGGER_ENDPOINT,
            data: JSON.stringify(payload),
            headers: {
                'Content-Type': 'application/json',
            },
            onload: (response) => {
                console.log(`✅ Auto-trigger sent successfully: ${response.status}`);
                if (response.responseText) {
                    console.log('📥 Response:', response.responseText);
                }

                STATE.lastSentHash = changeDetection.currentHash;
                STATE.lastSentTime = Date.now();
            },
            onerror: (error) => {
                console.error('❌ Auto-trigger failed:', error);
            },
            ontimeout: () => {
                console.error('⏱️ Auto-trigger timeout - endpoint not responding');
            },
            timeout: 10000,
        });

        console.log(`${'═'.repeat(60)}\n`);
    }

    // ═══════════════════════════════════════════════════════════════
    // PROCESS DATA (MAIN PROCESSING FUNCTION)
    // ═══════════════════════════════════════════════════════════════
    function processData(scanType = 'auto') {
        if (STATE.isScanning) {
            console.log('[Process] ⏸️ Already scanning, skipping duplicate');
            return;
        }

        STATE.isScanning = true;
        STATE.lastScanType = scanType;

        try {
            const allCoins = parseTableData();

            if (allCoins.length === 0) {
                console.warn('[Process] No data available');
                STATE.isScanning = false;
                return;
            }

            const currentHash = generateDataHash(allCoins);
            if (currentHash === STATE.lastScanHash) {
                console.log('[Process] ⏭️ Data unchanged, skipping');
                STATE.isScanning = false;
                return;
            }

            STATE.lastScanHash = currentHash;
            STATE.lastProcessedData = allCoins;
            STATE.lastScanTime = new Date();

            if (scanType === 'auto') {
                STATE.autoScanCount++;
                console.log(`[AutoScan] Count: ${STATE.autoScanCount}/${CONFIG.AUTO_TRIGGER_AFTER_SCANS}`);
            } else if (scanType === 'manual' || scanType === 'alert-triggered') {
                console.log(`[${scanType}] Resetting auto-scan counter`);
                STATE.autoScanCount = 0;
            }

            const sentiment = analyzeMarketSentiment(allCoins);

            const scored = allCoins.map((coin) => ({
                ...coin,
                ...calculateRecommendation(coin),
            }));

            const unfiltered = scored.filter((coin) => applyUnfilteredFilter(coin));

            const unfilteredBuys = unfiltered
                .filter((c) => c.direction === 'BULL')
                .sort((a, b) => b.score - a.score);
            const unfilteredSells = unfiltered
                .filter((c) => c.direction === 'BEAR')
                .sort((a, b) => b.score - a.score);
            const unfilteredRetraces = unfiltered
                .filter((c) => (c.retraceOpportunity || 0) >= 1)
                .sort((a, b) => b.score - a.score);

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
                .sort((a, b) => b.score - a.score);
            const sells = filtered
                .filter((c) => c.direction === 'BEAR')
                .sort((a, b) => b.score - a.score);
            const retraces = filtered
                .filter((c) => (c.retraceOpportunity || 0) >= 1)
                .sort((a, b) => b.score - a.score);

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

                console.log(`\n${'═'.repeat(60)}`);
                console.log('🚨 ALERT-TRIGGERED SCAN COMPLETE - SENDING TO BACKEND');
                console.log(`${'═'.repeat(60)}`);
                console.log(`   AI Priority: ${JSON.stringify(payload.aiPriority).length} bytes`);
                console.log(`   Backup Data: ${JSON.stringify(payload.backupData).length} bytes`);
                if (payload.institutionalPulse) {
                    console.log(`   Institutional Pulse: ${payload.institutionalPulse.alerts.length} alerts`);
                    console.log(`   Strong Signals: ${payload.institutionalPulse.consensus.strongSignals.join(', ') || 'None'}`);
                }
                console.log(`   Total: ${JSON.stringify(payload).length} bytes`);

                sendPayload(payload);

                STATE.lastSentHash = changeDetection.currentHash;
                STATE.lastSentTime = Date.now();
                window.batchedAlerts = null;

                console.log(`${'═'.repeat(60)}\n`);
            }

            console.log(`${'═'.repeat(60)}\n`);

        } catch (error) {
            console.error('[Process] Error:', error);
        } finally {
            STATE.isScanning = false;
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

                unsafeWindow.triggerScreenerScan = false;

                setTimeout(() => {
                    const btn = findScanButton();
                    if (!btn) {
                        console.error('❌ Scan button not found');
                        return;
                    }
                    console.log('[Trigger] 🖱️ Clicking scan button...');
                    btn.click();

                    // Force processing after delay
                    clearTimeout(STATE.processDebounceTimer);
                    STATE.processDebounceTimer = setTimeout(() => {
                        processData('alert-triggered');
                    }, UI_DELAY_MS);

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

        const btn = findScanButton();
        if (!btn) {
            console.warn('[Auto-Scan] ⚠️ Button not found');
            return;
        }

        btn.click();

        clearTimeout(STATE.processDebounceTimer);
        STATE.processDebounceTimer = setTimeout(() => {
            processData('auto');
        }, UI_DELAY_MS);
    }

    function startAutoScan() {
        if (STATE.scanIntervalId) {
            clearInterval(STATE.scanIntervalId);
        }

        console.log(
            `[Auto-Scan] ▶️ Started (every ${CONFIG.INTERVAL_MINUTES} minutes)`
        );
        console.log(`[Auto-Trigger] Will activate after every ${CONFIG.AUTO_TRIGGER_AFTER_SCANS} auto-scans`);

        triggerAutoScan();
        STATE.scanIntervalId = setInterval(triggerAutoScan, INTERVAL_MS);
    }

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
            triggerAutoScan();
            if (STATE.scanIntervalId) {
                clearInterval(STATE.scanIntervalId);
                STATE.scanIntervalId = setInterval(triggerAutoScan, INTERVAL_MS);
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
        version: '14.1',
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
    setTimeout(() => {
        setupScanButtonListener();
        startAutoScan();
        startAlertMonitor();
    }, 2000);

    console.log('✅ Ultra Scalper v14.5 ready');
    console.log('🎯 Shortcuts:');
    console.log('   Shift+Alt+Z - Manual trigger with fresh scan & send to AI');
    console.log('   Alt+U - Manual scan & restart timer');
    console.log('   Alt+K - Copy recommendations to clipboard');
    console.log('   Alt+L - Toggle chart event checkboxes (FIXED)');
    console.log('   Alt+P - Pause/Resume auto-scan');
    console.log(`⏰ Auto-scans every ${CONFIG.INTERVAL_MINUTES} min`);
    console.log(`🤖 Auto-trigger after every ${CONFIG.AUTO_TRIGGER_AFTER_SCANS} auto-scans (with change detection)`);
    console.log(`🚨 Alert monitor active (checks every 2s)`);
    console.log('💾 Smart change detection enabled (Option B: Balanced)');
    console.log('🎯 Di/D support: +1 (Bullish) | -2 (Bearish)');

})();
