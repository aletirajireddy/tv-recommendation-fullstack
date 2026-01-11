// ==UserScript==
// @name         Institutional Pulse Tracker v2.8 - Production Final
// @namespace    http://tampermonkey.net/
// @version      2.8.0-final
// @description  Process all alerts on load, auto-summary, backend dedup, time-aware analytics
// @author       Your Name
// @match        *://*.tradingview.com/pine-screener/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        unsafeWindow
// @connect      localhost
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    console.log('🎯 INSTITUTIONAL PULSE TRACKER v2.8 PRODUCTION INITIALIZED');

    // ═══════════════════════════════════════════════════════════════
    // CONFIGURATION
    // ═══════════════════════════════════════════════════════════════
    const CONFIG = {
        // BACKEND_ENDPOINT removed - strictly pass-through
        BATCH_WINDOW_MS: 60000,
        ENABLE_BATCHING: true,
        ENABLE_BACKEND_SYNC: true, // Internal logic flag
        DEBUG_MODE: true,
        POLL_INTERVAL_MS: 3000,
        TOAST_WAIT_MS: 7000,
        PANEL_WAIT_MS: 3000,
        PANEL_OPEN_WAIT_MS: 5000,
        SIDEBAR_RETRY_MAX: 3,
        SIDEBAR_RETRY_DELAY_MS: 2000,
        ENABLE_FORCE_TOGGLE: false // Default: Do not force sidebar open/close sequences (Passive Sync)
    };

    // ═══════════════════════════════════════════════════════════════
    // GLOBAL STATE
    // ═══════════════════════════════════════════════════════════════
    unsafeWindow.institutionalPulse = unsafeWindow.institutionalPulse || [];
    unsafeWindow.alertBatchState = {
        pendingAlerts: [],
        batchTimer: null,
        scanScheduled: false
    };
    unsafeWindow.triggerScreenerScan = false;
    unsafeWindow.batchedAlerts = null;
    if (typeof unsafeWindow.institutionalPulse === 'undefined') {
        console.error('[Init] ❌ Failed to initialize unsafeWindow.institutionalPulse');
    } else {
        console.log('[Init] ✅ unsafeWindow.institutionalPulse initialized:', unsafeWindow.institutionalPulse);
    }

    let alertCount = 0;
    let processedAlertIds = new Set();
    let isInitialLoad = true;

    const pulseStats = {
        totalAlerts: 0,
        ultraScalp: 0,
        institutionalLevel: 0,
        batchesCreated: 0,
        scansTriggered: 0,
        toastDetections: 0,
        sidebarReads: 0,
        sidebarRetries: 0,
        timestampExtractions: 0,
        timestampFallbacks: 0,
        dateLabelsFound: 0,
        backendSyncs: 0,
        backendErrors: 0,
        nonTradingSkipped: 0
    };

    // ═══════════════════════════════════════════════════════════════
    // INSIGHTS ENGINE
    // ═══════════════════════════════════════════════════════════════
    const INSIGHTS = {
        stats: {
            volumeIntent: {
                bullish: 0,
                bearish: 0,
                neutral: 0,
                bullishWeight: 0,
                bearishWeight: 0
            },
            categories: {
                ultraScalp: 0,
                institutionalLevel: 0
            },
            tickers: new Map(),
            timeframes: new Map(),
            rsi: {
                oversold: 0,
                overbought: 0,
                neutral: 0,
                cumulative: { m5: [], m30: [], h1: [], h4: [] }
            },
            momentum: [],
            alertTimes: [],
            rawAlerts: []
        }
    };

    // ═══════════════════════════════════════════════════════════════
    // DATE LABEL PARSER
    // ═══════════════════════════════════════════════════════════════
    function parseDateLabel(dateText) {
        try {
            const cleaned = dateText.trim();
            const now = new Date();

            // 1. Explicit Relative Dates
            if (/^today/i.test(cleaned)) {
                return now;
            }
            if (/^yesterday/i.test(cleaned)) {
                const d = new Date();
                d.setDate(d.getDate() - 1);
                return d;
            }

            // 2. Standard Parse with Explicit Current Year Injection
            // TradingView labels are like "January 10". parsing "January 10" yields year 2001 in some contexts.
            // We force append the current year if it looks like a month-day pattern.
            let parseText = cleaned;
            const hasYear = /\d{4}/.test(cleaned);
            if (!hasYear) {
                parseText = `${cleaned} ${now.getFullYear()}`;
            }

            let parsed = new Date(parseText);

            // 3. Fallback Validation
            if (!isNaN(parsed.getTime())) {
                // 4. Smart Year Rollover (Standard)
                // If we are in Jan 2026 and read "Dec 30", the simple append makes it "Dec 30 2026" (Future).
                // It should be "Dec 30 2025".
                // Logic: If parsed date is > 2 days in the future, assume previous year.
                const futureThreshold = new Date(now.getTime() + 48 * 60 * 60 * 1000);
                if (parsed > futureThreshold) {
                    parsed.setFullYear(now.getFullYear() - 1);
                }

                if (CONFIG.DEBUG_MODE) {
                    console.log(`[Date Parser] ✅ Parsed: "${cleaned}" → ${parsed.toDateString()}`);
                }
                return parsed;
            }

            console.warn(`[Date Parser] ⚠️ Failed to parse: "${cleaned}"`);
            return null;

        } catch (error) {
            console.error('[Date Parser] ❌ Error:', error);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // TIMESTAMP EXTRACTION WITH DATE CONTEXT
    // ═══════════════════════════════════════════════════════════════
    function buildTimestamp(hours, minutes, seconds, meridiem, timeframe, extracted, contextDate = null) {
        if (!extracted || hours === null) {
            pulseStats.timestampFallbacks++;
            const now = new Date();

            if (CONFIG.DEBUG_MODE) {
                console.warn('[Timestamp] ⚠️ Using fallback - current time');
            }

            return {
                timestamp: now.toISOString(),
                timeString: now.toLocaleTimeString('en-IN', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: true
                }),
                extracted: false,
                timeframe: null
            };
        }

        let hour24 = hours;
        if (meridiem.toUpperCase() === 'PM' && hour24 !== 12) {
            hour24 += 12;
        } else if (meridiem.toUpperCase() === 'AM' && hour24 === 12) {
            hour24 = 0;
        }

        const baseDate = contextDate || new Date();
        const extractedDate = new Date(
            baseDate.getFullYear(),
            baseDate.getMonth(),
            baseDate.getDate(),
            hour24,
            minutes,
            seconds || 0,
            0
        );

        pulseStats.timestampExtractions++;

        if (CONFIG.DEBUG_MODE) {
            console.log(`[Timestamp] ✅ Extracted: ${extractedDate.toLocaleString('en-IN')} (base: ${baseDate.toDateString()})`);
        }

        return {
            timestamp: extractedDate.toISOString(),
            timeString: extractedDate.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: true
            }),
            extracted: true,
            timeframe: timeframe,
            date: extractedDate.toDateString()
        };
    }

    function extractTimestampFromAlert(message, contextDate = null) {
        try {
            const lines = message.split('\n');

            if (CONFIG.DEBUG_MODE) {
                console.log('[Timestamp Debug] Parsing message with', lines.length, 'lines');
            }

            let timeframe = null;
            let hours = null;
            let minutes = null;
            let seconds = null;
            let meridiem = null;

            const pattern1 = /(\d+[mh])\s*•\s*(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)/i;
            const pattern2 = /(\d+[mh])\s*•\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i;

            for (let line of lines) {
                line = line.trim();

                let match = line.match(pattern1);
                if (match) {
                    [, timeframe, hours, minutes, seconds, meridiem] = match;
                    return buildTimestamp(
                        parseInt(hours),
                        parseInt(minutes),
                        parseInt(seconds),
                        meridiem,
                        timeframe,
                        true,
                        contextDate
                    );
                }

                match = line.match(pattern2);
                if (match) {
                    [, timeframe, hours, minutes, meridiem] = match;
                    return buildTimestamp(
                        parseInt(hours),
                        parseInt(minutes),
                        0,
                        meridiem,
                        timeframe,
                        true,
                        contextDate
                    );
                }
            }

            for (let line of lines) {
                const tfMatch = line.match(/,\s*(\d+[mh])\s*$/i);
                if (tfMatch) {
                    timeframe = tfMatch[1];
                    break;
                }
            }

            for (let line of lines) {
                line = line.trim();

                let timeMatch = line.match(/^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)$/i);
                if (timeMatch) {
                    [, hours, minutes, seconds, meridiem] = timeMatch;
                    break;
                }

                timeMatch = line.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
                if (timeMatch) {
                    [, hours, minutes, meridiem] = timeMatch;
                    seconds = 0;
                    break;
                }
            }

            if (hours !== null && meridiem !== null) {
                return buildTimestamp(
                    parseInt(hours),
                    parseInt(minutes),
                    parseInt(seconds || 0),
                    meridiem,
                    timeframe || 'unknown',
                    true,
                    contextDate
                );
            }

            return buildTimestamp(null, null, null, null, null, false, contextDate);

        } catch (error) {
            console.error('[Timestamp] ❌ Error extracting timestamp:', error);
            return buildTimestamp(null, null, null, null, null, false, contextDate);
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // PARSING - SMART NON-TRADING FILTER
    // ═══════════════════════════════════════════════════════════════

    function detectAlertFormat(text) {
        try {
            const prefix = text.substring(0, 30).trim().toUpperCase();

            // ✅ SKIP NON-TRADING MESSAGES
            const skipPatterns = [
                'EA PAIR', 'IT\'S A WRAP', 'IT S A WRAP',
                'MOVE OPEN', 'THIS UPDATE', 'LEARN THI',
                'BINGE', 'WEN 1.18', 'ONLY TO', 'EU BUY',
                'MAYBE', 'GOOD MORNING', 'GOOD NIGHT',
                'THANK', 'CONGRAT', 'SORRY', 'PLEASE',
                'CHECK THIS', 'REMINDER', 'MEETING'
            ];

            for (let pattern of skipPatterns) {
                if (prefix.includes(pattern)) {
                    if (CONFIG.DEBUG_MODE) {
                        console.log(`[Parse] ⏭️ SKIPPED non-trading: "${text.substring(0, 50)}"`);
                    }
                    pulseStats.nonTradingSkipped++;
                    return 'NON_TRADING';
                }
            }

            // ✅ MUST HAVE TICKER PATTERN
            if (!text.match(/[A-Z]{2,10}USDT\.P/i)) {
                if (CONFIG.DEBUG_MODE) {
                    console.log(`[Parse] ⏭️ SKIPPED no ticker: "${text.substring(0, 50)}"`);
                }
                pulseStats.nonTradingSkipped++;
                return 'NON_TRADING';
            }

            if (prefix.startsWith('SHORT')) {
                return 'ULTRA_SCALP';
            }

            if (prefix.startsWith('TRIGGER')) {
                return 'INSTITUTIONAL_LEVEL';
            }

            return 'UNKNOWN';
        } catch (error) {
            console.error('[Parse] Error in detectAlertFormat:', error);
            return 'UNKNOWN';
        }
    }

    function parseShortFormat(message) {
        try {
            const lines = message.split('\n');

            let startLine = 0;
            if (lines[0] && lines[0].trim().toUpperCase() === 'SHORT') {
                startLine = 1;
            }

            const line0 = lines[startLine] || '';

            const tickerMatch = line0.match(/([A-Z]+USDT\.P)/i);
            if (!tickerMatch) {
                return null;
            }
            const ticker = tickerMatch[1];
            const cleanTicker = ticker.replace('USDT.P', '');

            const diMatch = line0.match(/Di:\s*([-+]?\d+)/i);
            const di = diMatch ? parseInt(diMatch[1]) : null;

            const momentumMatch = line0.match(/%:\s*([-+]?[\d.]+)/i);
            const momentum_pct = momentumMatch ? parseFloat(momentumMatch[1]) : null;

            const priceMatch = line0.match(/P:\s*([\d.]+)/i);
            const price = priceMatch ? parseFloat(priceMatch[1]) : null;

            const line1 = lines[startLine + 1] || '';
            const rsiMatch = line1.match(/R\([^)]+\):\s*([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)/i);
            const rsi = rsiMatch ? {
                m5: parseFloat(rsiMatch[1]),
                m30: parseFloat(rsiMatch[2]),
                h1: parseFloat(rsiMatch[3]),
                h4: parseFloat(rsiMatch[4])
            } : null;

            const line2 = lines[startLine + 2] || '';
            const tfMatch = (line2 + line0).match(/(\d+[mh])\d{2}:\d{2}:\d{2}/i);
            const timeframe = tfMatch ? tfMatch[1] : '5m';

            if (!ticker || di === null) {
                return null;
            }

            return {
                ticker: ticker,
                cleanTicker: cleanTicker,
                category: 'ULTRA_SCALP',
                di: di,
                price: price,
                momentum_pct: momentum_pct,
                rsi: rsi,
                timeframe: timeframe
            };

        } catch (error) {
            console.error('[Parse] Error in parseShortFormat:', error);
            return null;
        }
    }

    function parseTriggerFormat(message) {
        try {
            const lines = message.split('\n');

            let startLine = 0;
            if (lines[0] && lines[0].trim().toUpperCase() === 'TRIGGER') {
                startLine = 1;
            }

            const line0 = lines[startLine] || '';

            const tickerMatch = line0.match(/([A-Z]+USDT\.P)/i);
            if (!tickerMatch) {
                return null;
            }
            const ticker = tickerMatch[1];
            const cleanTicker = ticker.replace('USDT.P', '');

            const dMatch = line0.match(/D:\s*([-+]?\d+)/i);
            const d = dMatch ? parseInt(dMatch[1]) : null;

            const priceMatch = line0.match(/P:\s*([\d.]+)/i);
            const price = priceMatch ? parseFloat(priceMatch[1]) : null;

            const line1 = lines[startLine + 1] || '';
            const tfMatch = line1.match(/,\s*(\d+[mh])\s*$/i);
            const timeframe = tfMatch ? tfMatch[1] : '5m';

            if (!ticker || d === null) {
                return null;
            }

            return {
                ticker: ticker,
                cleanTicker: cleanTicker,
                category: 'INSTITUTIONAL_LEVEL',
                d: d,
                price: price,
                timeframe: timeframe,
                rsi: null,
                momentum_pct: null
            };

        } catch (error) {
            console.error('[Parse] Error in parseTriggerFormat:', error);
            return null;
        }
    }

    function parseAlertMessage(message, contextDate = null) {
        try {
            const format = detectAlertFormat(message);

            if (format === 'NON_TRADING') {
                return null;
            }

            if (format === 'UNKNOWN') {
                return null;
            }

            let parsed = null;

            if (format === 'ULTRA_SCALP') {
                parsed = parseShortFormat(message);
            } else if (format === 'INSTITUTIONAL_LEVEL') {
                parsed = parseTriggerFormat(message);
            }

            if (!parsed || !parsed.ticker || !parsed.category) {
                return null;
            }

            const timestampData = extractTimestampFromAlert(message, contextDate);

            // ═══════════════════════════════════════════════════════════════
            // SMART HEAD CHECK (OPTIMIZATION)
            // ═══════════════════════════════════════════════════════════════
            const alertTs = timestampData.timestamp ? new Date(timestampData.timestamp).getTime() : 0;
            if (unsafeWindow.latestConfirmedAlertTs && alertTs > 0 && alertTs <= unsafeWindow.latestConfirmedAlertTs) {
                if (CONFIG.DEBUG_MODE) {
                    console.log(`[Parse] 🛑 Alert (${timestampData.timeString}) already synced. Skipping.`);
                }
                return null;
            }

            // ═══════════════════════════════════════════════════════════════
            // CONTENT HASHING (FULL LENGTH FIX)
            // ═══════════════════════════════════════════════════════════════
            // User Request: Remove 100 char limit to prevent collision on long alerts
            const contentHash = message.replace(/\s+/g, '') + (timestampData.timestamp || '');
            // Simple hash function for ID
            let hash = 0;
            for (let i = 0; i < contentHash.length; i++) {
                const char = contentHash.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32bit integer
            }
            const deterministicId = `alert_${Math.abs(hash)}`;

            const alert = {
                id: deterministicId, // DETERMINISTIC ID FOR DEDUPLICATION
                timestamp: timestampData.timestamp,
                raw: message,
                asset: {
                    ticker: parsed.ticker,
                    cleanTicker: parsed.cleanTicker,
                    timeframe: timestampData.timeframe || parsed.timeframe || '5m'
                },
                signal: {
                    category: parsed.category,
                    di: parsed.di !== undefined ? parsed.di : undefined,
                    d: parsed.d !== undefined ? parsed.d : undefined,
                    price: parsed.price,
                    momentum_pct: parsed.momentum_pct,
                    timestamp: timestampData.timeString,
                    timestampExtracted: timestampData.extracted,
                    date: timestampData.date
                },
                confluences: {
                    rsi: parsed.rsi
                },
                parsed: true
            };

            return alert;

        } catch (error) {
            console.error('[Parse] Critical error in parseAlertMessage:', error);
            return null;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // INSIGHTS FUNCTIONS
    // ═══════════════════════════════════════════════════════════════
    function updateInsights(alertData) {
        try {
            let directionalValue = 0;

            if (alertData.signal.di !== undefined) {
                directionalValue = alertData.signal.di;
            } else if (alertData.signal.d !== undefined) {
                directionalValue = alertData.signal.d;
            }

            if (directionalValue === 1) {
                INSIGHTS.stats.volumeIntent.bullish++;
                INSIGHTS.stats.volumeIntent.bullishWeight += 1;
            } else if (directionalValue === -2) {
                INSIGHTS.stats.volumeIntent.bearish++;
                INSIGHTS.stats.volumeIntent.bearishWeight += 2;
            } else {
                INSIGHTS.stats.volumeIntent.neutral++;
            }

            const category = alertData.signal.category;
            if (category === 'ULTRA_SCALP') {
                INSIGHTS.stats.categories.ultraScalp++;
            } else if (category === 'INSTITUTIONAL_LEVEL') {
                INSIGHTS.stats.categories.institutionalLevel++;
            }

            const ticker = alertData.asset.cleanTicker;
            if (!INSIGHTS.stats.tickers.has(ticker)) {
                INSIGHTS.stats.tickers.set(ticker, {
                    count: 0,
                    bullishCount: 0,
                    bearishCount: 0,
                    categories: [],
                    alerts: []
                });
            }
            const tickerData = INSIGHTS.stats.tickers.get(ticker);
            tickerData.count++;

            if (directionalValue === 1) tickerData.bullishCount++;
            else if (directionalValue === -2) tickerData.bearishCount++;

            tickerData.categories.push(category);
            tickerData.alerts.push(alertData);

            const tf = alertData.asset.timeframe;
            if (tf) {
                INSIGHTS.stats.timeframes.set(tf, (INSIGHTS.stats.timeframes.get(tf) || 0) + 1);
            }

            if (alertData.confluences.rsi) {
                const rsi = alertData.confluences.rsi;
                INSIGHTS.stats.rsi.cumulative.m5.push(rsi.m5);
                INSIGHTS.stats.rsi.cumulative.m30.push(rsi.m30);
                INSIGHTS.stats.rsi.cumulative.h1.push(rsi.h1);
                INSIGHTS.stats.rsi.cumulative.h4.push(rsi.h4);

                if (rsi.h1 < 30) INSIGHTS.stats.rsi.oversold++;
                else if (rsi.h1 > 70) INSIGHTS.stats.rsi.overbought++;
                else INSIGHTS.stats.rsi.neutral++;
            }

            if (alertData.signal.momentum_pct !== undefined) {
                INSIGHTS.stats.momentum.push({
                    ticker: ticker,
                    value: alertData.signal.momentum_pct,
                    direction: directionalValue === 1 ? 'BULLISH' : directionalValue === -2 ? 'BEARISH' : 'NEUTRAL'
                });
            }

            INSIGHTS.stats.alertTimes.push(new Date(alertData.timestamp));
            INSIGHTS.stats.rawAlerts.push(alertData);

        } catch (error) {
            console.error('[Insights] Error updating:', error);
        }
    }

    function calculateMarketSentiment() {
        const { bullish, bearish, bullishWeight, bearishWeight } = INSIGHTS.stats.volumeIntent;

        if (bullish === 0 && bearish === 0) {
            return {
                sentiment: 'NEUTRAL',
                score: 0,
                emoji: '😐',
                confidence: 'Low',
                ratio: 'N/A'
            };
        }

        const netWeight = bullishWeight - bearishWeight;
        const totalWeight = bullishWeight + bearishWeight;
        const score = totalWeight > 0 ? Math.round((netWeight / totalWeight) * 10) : 0;
        const ratio = bearish > 0 ? (bullish / bearish).toFixed(2) : bullish > 0 ? '∞' : '0';

        let sentiment, emoji, confidence;

        if (score >= 7) {
            sentiment = '🟢 STRONGLY BULLISH';
            emoji = '🚀';
            confidence = 'Very High';
        } else if (score >= 4) {
            sentiment = '🟢 BULLISH';
            emoji = '📈';
            confidence = 'High';
        } else if (score >= 1) {
            sentiment = '🟡 MILDLY BULLISH';
            emoji = '↗️';
            confidence = 'Medium';
        } else if (score <= -7) {
            sentiment = '🔴 STRONGLY BEARISH';
            emoji = '📉';
            confidence = 'Very High';
        } else if (score <= -4) {
            sentiment = '🔴 BEARISH';
            emoji = '⚠️';
            confidence = 'High';
        } else if (score <= -1) {
            sentiment = '🟡 MILDLY BEARISH';
            emoji = '↘️';
            confidence = 'Medium';
        } else {
            sentiment = '⚪ NEUTRAL';
            emoji = '😐';
            confidence = 'Low';
        }

        return { sentiment, score, emoji, confidence, ratio };
    }

    function getTopMovers(limit = 3) {
        const movers = [];

        INSIGHTS.stats.tickers.forEach((data, ticker) => {
            let dominant = 'NEUTRAL';
            if (data.bullishCount > data.bearishCount) {
                dominant = 'BULLISH';
            } else if (data.bearishCount > data.bullishCount) {
                dominant = 'BEARISH';
            } else if (data.bullishCount === data.bearishCount && data.count > 0) {
                dominant = 'MIXED';
            }

            const latestAlert = data.alerts[data.alerts.length - 1];

            movers.push({
                ticker: ticker,
                count: data.count,
                bullish: data.bullishCount,
                bearish: data.bearishCount,
                dominant: dominant,
                rsi1h: latestAlert.confluences.rsi ? latestAlert.confluences.rsi.h1 : null,
                momentum: latestAlert.signal.momentum_pct || null
            });
        });

        movers.sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return (b.bullish - b.bearish) - (a.bullish - a.bearish);
        });

        return movers.slice(0, limit);
    }

    function calculateAverageRSI() {
        const avg = (arr) => arr.length > 0 ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : 'N/A';

        return {
            m5: avg(INSIGHTS.stats.rsi.cumulative.m5),
            m30: avg(INSIGHTS.stats.rsi.cumulative.m30),
            h1: avg(INSIGHTS.stats.rsi.cumulative.h1),
            h4: avg(INSIGHTS.stats.rsi.cumulative.h4)
        };
    }

    function getAlertFrequency() {
        const times = INSIGHTS.stats.alertTimes;

        if (times.length === 0) {
            return {
                alertRate: 'N/A',
                description: 'No alerts',
                level: 'NONE'
            };
        }

        const earliest = Math.min(...times.map(t => t.getTime()));
        const latest = Math.max(...times.map(t => t.getTime()));
        const spanMs = latest - earliest;
        const spanMinutes = spanMs / 60000;
        const spanHours = spanMs / 3600000;

        let rate, rateUnit, description;

        if (spanMinutes < 1) {
            rate = times.length;
            rateUnit = 'instant burst';
            description = `${times.length} alerts in <1min`;
        } else if (spanMinutes < 60) {
            rate = (times.length / spanMinutes).toFixed(1);
            rateUnit = 'alerts/min';
            description = `over ${Math.round(spanMinutes)}min span`;
        } else {
            rate = (times.length / spanHours).toFixed(1);
            rateUnit = 'alerts/hour';
            description = `over ${spanHours.toFixed(1)}h span`;
        }

        let level = 'LOW';
        if (spanMinutes < 5 && times.length >= 10) {
            level = '🔥 VERY HIGH';
        } else if (spanMinutes < 60 && times.length / spanMinutes > 2) {
            level = '🔶 HIGH';
        } else if (times.length / Math.max(spanMinutes, 1) > 0.5) {
            level = '🔶 MEDIUM';
        }

        return {
            alertRate: `${rate} ${rateUnit}`,
            description: description,
            level: level,
            spanMinutes: Math.round(spanMinutes),
            spanHours: spanHours.toFixed(1),
            totalAlerts: times.length
        };
    }

    function getAlertTimeRange() {
        const times = INSIGHTS.stats.alertTimes;

        if (times.length === 0) {
            return {
                earliest: null,
                latest: null,
                spanMinutes: 0,
                spanFormatted: 'N/A'
            };
        }

        const earliest = new Date(Math.min(...times.map(t => t.getTime())));
        const latest = new Date(Math.max(...times.map(t => t.getTime())));
        const spanMs = latest.getTime() - earliest.getTime();
        const spanMinutes = Math.round(spanMs / 60000);

        let spanFormatted = '';
        if (spanMinutes < 1) {
            spanFormatted = '<1m';
        } else if (spanMinutes < 60) {
            spanFormatted = `${spanMinutes}m`;
        } else if (spanMinutes < 1440) {
            const hours = Math.floor(spanMinutes / 60);
            const mins = spanMinutes % 60;
            spanFormatted = mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
        } else {
            const days = Math.floor(spanMinutes / 1440);
            const hours = Math.floor((spanMinutes % 1440) / 60);
            spanFormatted = `${days}d ${hours}h`;
        }

        return {
            earliest: earliest,
            latest: latest,
            spanMinutes: spanMinutes,
            spanFormatted: spanFormatted,
            earliestStr: earliest.toLocaleString('en-IN'),
            latestStr: latest.toLocaleString('en-IN')
        };
    }

    function generateSmartInsights() {
        const insights = [];
        const { bullish, bearish, bullishWeight, bearishWeight } = INSIGHTS.stats.volumeIntent;
        const freq = getAlertFrequency();
        const timeRange = getAlertTimeRange();
        const avgRsi = calculateAverageRSI();

        if (timeRange.spanMinutes > 0 && timeRange.spanMinutes < 5) {
            insights.push(`🔥 Alert burst - ${INSIGHTS.stats.rawAlerts.length} alerts in ${timeRange.spanFormatted} (${freq.alertRate})`);
        }

        INSIGHTS.stats.tickers.forEach((data, ticker) => {
            if (data.count >= 3) {
                if (data.bullishCount === data.count) {
                    insights.push(`💎 ${ticker} showing ${data.count} consecutive BULLISH signals - strong upward pressure`);
                } else if (data.bearishCount === data.count) {
                    insights.push(`⚠️ ${ticker} showing ${data.count} consecutive BEARISH signals - strong downward pressure`);
                } else if (data.bullishCount > 0 && data.bearishCount > 0) {
                    insights.push(`⚡ ${ticker} mixed signals (${data.bullishCount}🟢/${data.bearishCount}🔴) - choppy action, wait for clarity`);
                }
            }
        });

        if (bearishWeight > bullishWeight * 1.5) {
            insights.push(`📉 Bearish signals dominating (weighted ${bearishWeight} vs ${bullishWeight}) - caution on longs`);
        } else if (bullishWeight > bearishWeight * 2) {
            insights.push(`📈 Bullish signals dominating (weighted ${bullishWeight} vs ${bearishWeight}) - favorable for longs`);
        }

        if (avgRsi.h1 !== 'N/A') {
            const h1Val = parseFloat(avgRsi.h1);
            if (h1Val > 68) {
                insights.push(`⚠️ Average RSI(1h) at ${avgRsi.h1} - approaching overbought zone, watch for reversals`);
            } else if (h1Val < 32) {
                insights.push(`✅ Average RSI(1h) at ${avgRsi.h1} - approaching oversold zone, potential bounce setup`);
            }
        }

        const { ultraScalp, institutionalLevel } = INSIGHTS.stats.categories;
        const totalCategorized = (ultraScalp || 0) + (institutionalLevel || 0);

        if (totalCategorized > 0) {
            if ((ultraScalp || 0) / totalCategorized >= 0.7) {
                insights.push(`🎯 ${Math.round((ultraScalp / totalCategorized) * 100)}% ULTRA_SCALP alerts - high frequency scalping opportunities`);
            }
            if ((institutionalLevel || 0) / totalCategorized >= 0.5) {
                insights.push(`🎯 ${Math.round((institutionalLevel / totalCategorized) * 100)}% INSTITUTIONAL_LEVEL alerts - major breakout/breakdown setups forming`);
            }
        }

        return insights.slice(0, 6);
    }

    // ═══════════════════════════════════════════════════════════════
    // IMMEDIATE ANALYTICS
    // ═══════════════════════════════════════════════════════════════
    function printImmediateAnalytics(alertsArray) {
        if (alertsArray.length === 0) return;

        console.log(`\n${'╔' + '═'.repeat(63) + '╗'}`);
        console.log(`║${' '.repeat(10)}📊 IMMEDIATE DETECTION ANALYTICS (${alertsArray.length} alerts)${' '.repeat(10 - alertsArray.length.toString().length)}║`);
        console.log(`${'╚' + '═'.repeat(63) + '╝'}\n`);

        let bullish = 0, bearish = 0, neutral = 0;
        const tickers = new Set();
        const categories = { ULTRA_SCALP: 0, INSTITUTIONAL_LEVEL: 0 };

        alertsArray.forEach(alert => {
            const dir = alert.signal.di || alert.signal.d || 0;
            if (dir === 1) bullish++;
            else if (dir === -2) bearish++;
            else neutral++;

            tickers.add(alert.asset.cleanTicker);
            if (alert.signal.category) {
                categories[alert.signal.category]++;
            }
        });

        console.log(`🎯 QUICK SNAPSHOT:`);
        console.log(`   Tickers: ${Array.from(tickers).join(', ')}`);
        console.log(`   Directional: ${bullish}🟢 Bullish | ${bearish}🔴 Bearish | ${neutral}⚪ Neutral`);

        if (categories.ULTRA_SCALP > 0) console.log(`   ULTRA_SCALP: ${categories.ULTRA_SCALP}`);
        if (categories.INSTITUTIONAL_LEVEL > 0) console.log(`   INSTITUTIONAL_LEVEL: ${categories.INSTITUTIONAL_LEVEL}`);

        console.log(`\n💡 BIAS: ${bullish > bearish ? '🟢 BULLISH MOMENTUM' : bearish > bullish ? '🔴 BEARISH MOMENTUM' : '⚪ NEUTRAL/MIXED'}`);

        const overallSentiment = calculateMarketSentiment();
        console.log(`\n📊 CUMULATIVE MARKET SENTIMENT: ${overallSentiment.sentiment}`);
        console.log(`   Score: ${overallSentiment.score > 0 ? '+' : ''}${overallSentiment.score}/10 | Confidence: ${overallSentiment.confidence}`);

        console.log(`\n${'─'.repeat(63)}\n`);
    }

    function printBatchSummary() {
        const sentiment = calculateMarketSentiment();
        const topMovers = getTopMovers(3);
        const avgRsi = calculateAverageRSI();
        const freq = getAlertFrequency();
        const timeRange = getAlertTimeRange();
        const insights = generateSmartInsights();
        const { bullish, bearish, neutral, bullishWeight, bearishWeight } = INSIGHTS.stats.volumeIntent;
        const totalAlerts = bullish + bearish + neutral;

        console.log(`\n${'╔' + '═'.repeat(70) + '╗'}`);
        console.log(`║${' '.repeat(20)}📦 ALERT BATCH ANALYSIS (${totalAlerts} alerts)${' '.repeat(20 - totalAlerts.toString().length)}║`);
        console.log(`${'╚' + '═'.repeat(70) + '╝'}\n`);

        if (timeRange.earliest) {
            console.log(`⏰ ANALYZED PERIOD:`);
            console.log(`   From: ${timeRange.earliestStr}`);
            console.log(`   To:   ${timeRange.latestStr}`);
            console.log(`   Span: ${timeRange.spanFormatted} (${totalAlerts} alerts)\n`);
        }

        console.log(`📊 MARKET SENTIMENT: ${sentiment.sentiment} (Score: ${sentiment.score > 0 ? '+' : ''}${sentiment.score}/10)`);
        console.log(`   └─ Bullish Signals: ${bullish} (+1) | Bearish Signals: ${bearish} (-2)`);
        console.log(`   └─ Weighted Balance: Bull:${bullishWeight} vs Bear:${bearishWeight} | Ratio: ${sentiment.ratio}`);
        console.log(`   └─ Confidence: ${sentiment.confidence}\n`);

        if (topMovers.length > 0) {
            console.log(`💎 TOP MOVERS:`);
            topMovers.forEach((m, i) => {
                const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉';
                const signals = `[${m.bullish}🟢 / ${m.bearish}🔴]`;
                const rsiStr = m.rsi1h ? `RSI(1h): ${m.rsi1h.toFixed(0)}` : 'RSI: N/A';
                const momStr = m.momentum ? `Mom: ${m.momentum > 0 ? '+' : ''}${m.momentum.toFixed(1)}%` : '';
                console.log(`   ${i + 1}. ${medal} ${m.ticker.padEnd(6)} - ${m.dominant.padEnd(7)} ${signals} | ${rsiStr} | ${momStr}`);
            });
            console.log('');
        }

        console.log(`📊 VOLUME INTENT DISTRIBUTION:`);
        const totalSignals = bullish + bearish;
        if (totalSignals > 0) {
            const bullishPct = Math.round((bullish / totalSignals) * 100);
            const bearishPct = Math.round((bearish / totalSignals) * 100);
            const bullishBar = '█'.repeat(Math.round(bullishPct / 5));
            const bearishBar = '█'.repeat(Math.round(bearishPct / 5));
            console.log(`   Bullish (+1) ${bullishBar.padEnd(20)} ${bullishPct}% (${bullish} alerts)`);
            console.log(`   Bearish (-2) ${bearishBar.padEnd(20)} ${bearishPct}% (${bearish} alerts)`);
        }
        console.log('');

        if (INSIGHTS.stats.timeframes.size > 0) {
            console.log(`⏱️  TIMEFRAME DISTRIBUTION:`);
            const tfOrder = ['5m', '15m', '30m', '1h', '4h'];
            tfOrder.forEach(tf => {
                const count = INSIGHTS.stats.timeframes.get(tf) || 0;
                const pct = totalAlerts > 0 ? Math.round(count / totalAlerts * 100) : 0;
                const bar = '█'.repeat(Math.round(pct / 5));
                console.log(`   ${tf.padEnd(4)} ${bar.padEnd(20)} ${pct}% (${count})`);
            });
            console.log('');
        }

        if (INSIGHTS.stats.rsi.cumulative.h1.length > 0) {
            console.log(`🎯 RSI CONFLUENCE (Average):`);
            console.log(`   5m: ${avgRsi.m5} | 30m: ${avgRsi.m30} | 1h: ${avgRsi.h1} | 4h: ${avgRsi.h4}`);
            if (avgRsi.h1 !== 'N/A') {
                const h1Val = parseFloat(avgRsi.h1);
                const status = h1Val > 68 ? '⚠️ Approaching overbought' :
                    h1Val < 32 ? '⚠️ Approaching oversold' :
                        '✅ Neutral zone';
                console.log(`   Status: ${status}\n`);
            } else {
                console.log('');
            }
        }

        console.log(`🔥 ALERT FREQUENCY:`);
        console.log(`   Rate: ${freq.alertRate} (${freq.description})`);
        console.log(`   Activity Level: ${freq.level}\n`);

        if (insights.length > 0) {
            console.log(`💡 SMART INSIGHTS:`);
            insights.forEach(insight => console.log(`   ${insight}`));
            console.log('');
        }

        console.log(`${'─'.repeat(70)}\n`);
    }

    // ═══════════════════════════════════════════════════════════════
    // MACRO ANALYSIS WITH TIME SPREAD
    // ═══════════════════════════════════════════════════════════════
    function aggregateInto5mWindows() {
        const windows = [];
        const alerts = INSIGHTS.stats.rawAlerts;

        if (alerts.length === 0) return windows;

        const windowMap = new Map();

        alerts.forEach(alert => {
            const alertTime = new Date(alert.timestamp);
            const windowStart = new Date(alertTime);
            windowStart.setSeconds(0, 0);
            windowStart.setMinutes(Math.floor(windowStart.getMinutes() / 5) * 5);

            const key = windowStart.toISOString();

            if (!windowMap.has(key)) {
                windowMap.set(key, {
                    time: windowStart.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }),
                    date: windowStart.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
                    startTimestamp: windowStart.getTime(),
                    alerts: [],
                    tickers: new Set(),
                    tickerTimeline: new Map(),
                    ultraScalpCount: 0,
                    institutionalCount: 0,
                    bullishCount: 0,
                    bearishCount: 0,
                    momentumValues: [],
                    firstAlertTime: null,
                    lastAlertTime: null
                });
            }

            const window = windowMap.get(key);
            window.alerts.push(alert);
            window.tickers.add(alert.asset.cleanTicker);

            if (!window.tickerTimeline.has(alert.asset.cleanTicker)) {
                window.tickerTimeline.set(alert.asset.cleanTicker, alertTime.getTime());
            }

            if (!window.firstAlertTime || alertTime.getTime() < window.firstAlertTime) {
                window.firstAlertTime = alertTime.getTime();
            }
            if (!window.lastAlertTime || alertTime.getTime() > window.lastAlertTime) {
                window.lastAlertTime = alertTime.getTime();
            }

            if (alert.signal.category === 'ULTRA_SCALP') {
                window.ultraScalpCount++;
            } else if (alert.signal.category === 'INSTITUTIONAL_LEVEL') {
                window.institutionalCount++;
            }

            const directionalValue = alert.signal.di || alert.signal.d || 0;
            if (directionalValue === 1) {
                window.bullishCount++;
            } else if (directionalValue === -2) {
                window.bearishCount++;
            }

            if (alert.signal.momentum_pct !== undefined) {
                window.momentumValues.push(alert.signal.momentum_pct);
            }
        });

        windowMap.forEach((window, key) => {
            const coinCount = window.tickers.size;

            const bullishWeight = window.bullishCount;
            const bearishWeight = window.bearishCount * 2;

            let bias = 'NEUTRAL';
            if (bullishWeight > bearishWeight * 1.2) {
                bias = 'BULLISH';
            } else if (bearishWeight > bullishWeight * 1.2) {
                bias = 'BEARISH';
            }

            const avgMomentum = window.momentumValues.length > 0
                ? window.momentumValues.reduce((a, b) => a + b, 0) / window.momentumValues.length
                : 0;

            const timeSpreadSeconds = window.firstAlertTime && window.lastAlertTime
                ? Math.round((window.lastAlertTime - window.firstAlertTime) / 1000)
                : 0;

            const alertDensity = timeSpreadSeconds > 0
                ? ((window.alerts.length / timeSpreadSeconds) * 60).toFixed(1)
                : window.alerts.length > 0 ? 'Instant' : '0';

            let clusterType = 'ISOLATED';
            if (window.alerts.length >= 3) {
                if (timeSpreadSeconds < 10) {
                    clusterType = 'BURST';
                } else if (timeSpreadSeconds < 60) {
                    clusterType = 'WAVE';
                } else {
                    clusterType = 'STEADY';
                }
            }

            let waveType = 'Isolated Flow';
            if (clusterType === 'BURST') {
                waveType = '⚡ Burst Cluster';
            } else if (coinCount >= 5) {
                waveType = '🌊 Broad Flow';
            } else if (window.ultraScalpCount >= 3) {
                waveType = '🎯 Scalp Cluster';
            } else if (window.institutionalCount >= 2) {
                waveType = '🏛️ Institutional Wave';
            }

            const tickersByEntry = Array.from(window.tickerTimeline.entries())
                .sort((a, b) => a[1] - b[1])
                .map(([ticker, timestamp]) => ({
                    ticker,
                    entryTime: new Date(timestamp).toLocaleTimeString('en-IN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false
                    })
                }));

            windows.push({
                time: window.time,
                date: window.date,
                coinCount: coinCount,
                alertCount: window.alerts.length,
                timeSpreadSeconds: timeSpreadSeconds,
                alertDensity: alertDensity,
                clusterType: clusterType,
                bias: bias,
                ultraScalpCount: window.ultraScalpCount,
                institutionalCount: window.institutionalCount,
                avgMomentum: avgMomentum,
                waveType: waveType,
                tickers: Array.from(window.tickers),
                tickerTimeline: tickersByEntry
            });
        });

        return windows;
    }

    function printMacroSummary() {
        const windows = aggregateInto5mWindows();

        if (windows.length === 0) {
            console.log('[Macro] No data available for summary');
            return;
        }

        console.log(`\n${'═'.repeat(160)}`);
        console.log(`🎯 ENHANCED INSTITUTIONAL MACRO SUMMARY (Time Spread Analysis)`);
        console.log(`${'═'.repeat(160)}\n`);

        console.log(
            `${'#'.padEnd(5)}` +
            `${'Date'.padEnd(12)}` +
            `${'5m Window'.padEnd(12)}` +
            `${'Alerts'.padEnd(9)}` +
            `${'Coins'.padEnd(8)}` +
            `${'Spread'.padEnd(10)}` +
            `${'Density'.padEnd(10)}` +
            `${'Cluster'.padEnd(12)}` +
            `${'Bias'.padEnd(12)}` +
            `${'S/I'.padEnd(8)}` +
            `${'Mom%'.padEnd(9)}` +
            `${'Wave Type'.padEnd(20)}` +
            `Ticker Timeline`
        );
        console.log(`${'─'.repeat(160)}`);

        // Fix: Sort windows by time descending (Newest First) to match UI
        windows.sort((a, b) => b.startTimestamp - a.startTimestamp);

        windows.forEach((window, idx) => {
            const index = (idx + 1).toString().padEnd(5);
            const date = window.date.padEnd(12);
            const timeWindow = window.time.padEnd(12);
            const alertCount = window.alertCount.toString().padEnd(9);
            const breadth = window.coinCount.toString().padEnd(8);

            const spreadStr = window.timeSpreadSeconds === 0
                ? 'Instant'
                : window.timeSpreadSeconds < 60
                    ? `${window.timeSpreadSeconds}s`
                    : `${Math.floor(window.timeSpreadSeconds / 60)}m ${window.timeSpreadSeconds % 60}s`;
            const spread = spreadStr.padEnd(10);

            const densityStr = window.alertDensity === 'Instant'
                ? 'Instant'
                : `${window.alertDensity}/min`;
            const density = densityStr.padEnd(10);

            const clusterEmoji = {
                'BURST': '⚡',
                'WAVE': '🌊',
                'STEADY': '📊',
                'ISOLATED': '○'
            };
            const cluster = `${clusterEmoji[window.clusterType] || ''} ${window.clusterType}`.padEnd(12);

            const biasIcon = window.bias === 'BULLISH' ? '🟢' :
                window.bias === 'BEARISH' ? '🔴' : '⚪';
            const bias = `${window.bias} ${biasIcon}`.padEnd(12);

            const scalpInst = `${window.ultraScalpCount}/${window.institutionalCount}`.padEnd(8);
            const avgMom = `${window.avgMomentum > 0 ? '+' : ''}${window.avgMomentum.toFixed(2)}%`.padEnd(9);
            const waveType = window.waveType.padEnd(20);

            const tickerTimeline = window.tickerTimeline
                .slice(0, 3)
                .map(t => `${t.ticker}@${t.entryTime}`)
                .join(', ');

            console.log(`${index}${date}${timeWindow}${alertCount}${breadth}${spread}${density}${cluster}${bias}${scalpInst}${avgMom}${waveType}${tickerTimeline}`);
        });

        console.log(`${'─'.repeat(160)}\n`);

        const totalAlerts = windows.reduce((sum, w) => sum + w.alertCount, 0);
        const burstWindows = windows.filter(w => w.clusterType === 'BURST').length;
        const waveWindows = windows.filter(w => w.clusterType === 'WAVE').length;
        const avgDensity = windows
            .filter(w => w.alertDensity !== 'Instant')
            .map(w => parseFloat(w.alertDensity))
            .filter(d => !isNaN(d));
        const avgDensityValue = avgDensity.length > 0
            ? (avgDensity.reduce((a, b) => a + b, 0) / avgDensity.length).toFixed(1)
            : '0';

        console.log(`📊 SUMMARY:`);
        console.log(`   Total 5m Windows: ${windows.length}`);
        console.log(`   Total Alerts: ${totalAlerts}`);
        console.log(`   Burst Clusters (⚡ <10s): ${burstWindows}`);
        console.log(`   Wave Clusters (🌊 10-60s): ${waveWindows}`);
        console.log(`   Average Alert Density: ${avgDensityValue}/min`);
        console.log(`${'═'.repeat(160)}\n`);
    }

    // ═══════════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════════
    function syncBatchToBackend(batchData, isSyncMode = false) {
        // PASS-THROUGH STRATEGY:
        // Integrated function to buffer alerts AND trigger the scanner.
        // Replaces conflicting definitions.

        const alerts = batchData.alerts || [];
        if (alerts.length === 0) return;

        if (!unsafeWindow.pendingAlertBatch) {
            unsafeWindow.pendingAlertBatch = [];
        }

        console.log(`[Sync] 📦 Buffering ${alerts.length} alerts for pass-through (Total buffered: ${unsafeWindow.pendingAlertBatch.length + alerts.length})`);

        // Append new alerts to the buffer
        unsafeWindow.pendingAlertBatch.push(...alerts);

        // TRIGGER SCREENER SCAN
        if (unsafeWindow.institutionalPulse) {
            unsafeWindow.batchedAlerts = alerts; // Expose current batch explicitly if needed

            if (!isSyncMode) {
                unsafeWindow.triggerScreenerScan = true;
                pulseStats.scansTriggered++;
                console.log(`[Sync] 🚀 TRIGGERED SCREENER SCAN (Flag set: true)`);
            } else {
                console.log(`[Sync] 💤 Passive Mode: Buffered for next auto-scan (No immediate trigger)`);
            }
        }

        // Update stats
        pulseStats.backendSyncs++;
    }

    // ═══════════════════════════════════════════════════════════════
    // SMART SIDEBAR STATE MANAGER
    // ═══════════════════════════════════════════════════════════════
    async function ensureSidebarReady(retryCount = 0) {
        return new Promise(async (resolve, reject) => {
            try {
                console.log(`[Sidebar Check] 🔍 Verifying sidebar state (attempt ${retryCount + 1}/${CONFIG.SIDEBAR_RETRY_MAX})...`);

                const widgetbar = document.querySelector('[data-name="widgetbar-pages-with-tabs"]');
                if (!widgetbar) {
                    console.warn('[Sidebar Check] ⚠️ Widgetbar not found in DOM');

                    if (retryCount < CONFIG.SIDEBAR_RETRY_MAX) {
                        pulseStats.sidebarRetries++;
                        console.log(`[Sidebar Check] ⏳ Retrying in ${CONFIG.SIDEBAR_RETRY_DELAY_MS / 1000}s...`);
                        setTimeout(async () => {
                            const result = await ensureSidebarReady(retryCount + 1);
                            resolve(result);
                        }, CONFIG.SIDEBAR_RETRY_DELAY_MS);
                        return;
                    } else {
                        reject(new Error('Widgetbar not found after max retries'));
                        return;
                    }
                }

                const isExpanded = document.body.classList.contains('is-widgetbar-expanded');
                console.log(`[Sidebar Check] ${isExpanded ? '✅' : '❌'} Widgetbar expanded: ${isExpanded}`);

                const alertsButton = document.querySelector('button[data-name="alerts"]');
                if (!alertsButton) {
                    console.warn('[Sidebar Check] ⚠️ Alerts button not found');

                    if (retryCount < CONFIG.SIDEBAR_RETRY_MAX) {
                        pulseStats.sidebarRetries++;
                        setTimeout(async () => {
                            const result = await ensureSidebarReady(retryCount + 1);
                            resolve(result);
                        }, CONFIG.SIDEBAR_RETRY_DELAY_MS);
                        return;
                    } else {
                        reject(new Error('Alerts button not found'));
                        return;
                    }
                }

                const isPressed = alertsButton.getAttribute('aria-pressed') === 'true';
                console.log(`[Sidebar Check] ${isPressed ? '✅' : '❌'} Alerts button pressed: ${isPressed}`);

                if (!isPressed) {
                    console.log('[Sidebar Check] 📂 Opening alerts panel...');
                    alertsButton.click();

                    await new Promise(resolve => setTimeout(resolve, 1000));

                    const newState = alertsButton.getAttribute('aria-pressed') === 'true';
                    if (!newState) {
                        console.warn('[Sidebar Check] ⚠️ Failed to open alerts panel');

                        if (retryCount < CONFIG.SIDEBAR_RETRY_MAX) {
                            pulseStats.sidebarRetries++;
                            setTimeout(async () => {
                                const result = await ensureSidebarReady(retryCount + 1);
                                resolve(result);
                            }, CONFIG.SIDEBAR_RETRY_DELAY_MS);
                            return;
                        } else {
                            reject(new Error('Could not open alerts panel'));
                            return;
                        }
                    }

                    console.log('[Sidebar Check] ✅ Alerts panel opened');
                }

                const logTab = document.querySelector('#AlertsHeaderTabs button#log');
                if (logTab) {
                    const isLogSelected = logTab.getAttribute('aria-selected') === 'true';
                    console.log(`[Sidebar Check] ${isLogSelected ? '✅' : '❌'} Log tab selected: ${isLogSelected}`);

                    if (!isLogSelected) {
                        console.log('[Sidebar Check] 📑 Selecting Log tab...');
                        logTab.click();
                        await new Promise(resolve => setTimeout(resolve, 500));
                        console.log('[Sidebar Check] ✅ Log tab selected');
                    }
                } else {
                    console.warn('[Sidebar Check] ⚠️ Log tab not found (might be default view)');
                }

                const finalCheck = document.querySelectorAll('div[data-name="alert-log-item"]');
                if (finalCheck.length === 0) {
                    console.warn('[Sidebar Check] ⚠️ No alert items visible yet');

                    if (retryCount < CONFIG.SIDEBAR_RETRY_MAX) {
                        pulseStats.sidebarRetries++;
                        console.log('[Sidebar Check] ⏳ Waiting for alerts to render...');
                        setTimeout(async () => {
                            const result = await ensureSidebarReady(retryCount + 1);
                            resolve(result);
                        }, CONFIG.SIDEBAR_RETRY_DELAY_MS);
                        return;
                    }
                }

                console.log(`[Sidebar Check] ✅ Sidebar ready (${finalCheck.length} alerts visible)`);
                resolve(true);

            } catch (error) {
                console.error('[Sidebar Check] ❌ Error:', error);
                reject(error);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // DATE-AWARE SIDEBAR ALERTS READING - PROCESS ALL ON LOAD
    // ═══════════════════════════════════════════════════════════════
    let sidebarMutationObserver = null;



    async function readSidebarAlerts(delay = 0, isSyncMode = false) {
        setTimeout(async () => {
            pulseStats.sidebarReads++;
            console.log(`\n[Sidebar] 📖 Starting alert read sequence... (SyncMode: ${isSyncMode})`);

            try {
                await ensureSidebarReady();

                console.log('[Sidebar] 🔍 Reading alerts from sidebar panel...');

                // 1. Find the correct container (ScrollContainer)
                // We find the first alert item and get its parent to ensure we are in the right level.
                const firstItem = document.querySelector('div[data-name="alert-log-item"]');
                let logContainer = firstItem ? firstItem.parentElement : null;

                if (!logContainer) {
                    console.log('[Sidebar] ⚠️ No alert items found, checking fallbacks...');
                    logContainer = document.querySelector('div[data-name="alert-log"]');
                }

                if (!logContainer) {
                    console.warn('[Sidebar] ❌ No container found');
                    return;
                }

                console.log(`[Sidebar] ✅ Container found: ${logContainer.className}`);

                // 2. Iterate Direct Children Only (Preserve Order & Context)
                const children = Array.from(logContainer.children);
                console.log(`[Sidebar] 📂 Processing ${children.length} items in stream...`);

                let newAlertsCount = 0;
                let currentDate = new Date(); // Fallback
                const capturedAlertsThisRead = [];

                children.forEach((element) => {
                    try {
                        const classAttr = element.getAttribute('class') || '';
                        const dataName = element.getAttribute('data-name') || '';

                        // A. DATE LABEL CHECK (Class contains 'label-')
                        // User Context: "class='label-*' holds the date group"
                        // We check for 'label-' presence.
                        if (classAttr.includes('label-')) {
                            const dateText = element.innerText || element.textContent || '';
                            const parsedDate = parseDateLabel(dateText);

                            if (parsedDate) {
                                currentDate = parsedDate;
                                pulseStats.dateLabelsFound++;
                                if (CONFIG.DEBUG_MODE) {
                                    console.log(`[Date Context] 📅 Context Set: ${dateText} → ${currentDate.toLocaleDateString()}`);
                                }
                            }
                            return; // Is a label, done.
                        }

                        // B. ALERT ITEM CHECK
                        // User Context: "sibling element with class='alert-log-item' are alert elements"
                        if (dataName === 'alert-log-item') {
                            const alertText = element.innerText;

                            if (!alertText || alertText.trim() === '') {
                                return;
                            }

                            // ═══════════════════════════════════════════════════════════════
                            // CONTENT HASHING (FULL LENGTH FIX)
                            // ═══════════════════════════════════════════════════════════════
                            const contentHash = alertText.replace(/\s+/g, '');

                            if (processedAlertIds.has(contentHash)) {
                                return;
                            }

                            // PASS THE CURRENT CONTEXT DATE
                            const alertData = parseAlertMessage(alertText, currentDate);

                            if (!alertData || !alertData.parsed) {
                                return;
                            }

                            processedAlertIds.add(contentHash);

                            alertCount++;
                            pulseStats.totalAlerts++;
                            newAlertsCount++;

                            if (alertData.signal.category === 'ULTRA_SCALP') {
                                pulseStats.ultraScalp++;
                            } else if (alertData.signal.category === 'INSTITUTIONAL_LEVEL') {
                                pulseStats.institutionalLevel++;
                            }

                            unsafeWindow.institutionalPulse.push(alertData);
                            capturedAlertsThisRead.push(alertData);

                            const dir = alertData.signal.di !== undefined ? alertData.signal.di : alertData.signal.d;
                            const dirStr = dir === 1 ? '+1' : dir === -2 ? '-2' : '0';
                            const rsiStr = alertData.confluences.rsi ? ` RSI:${alertData.confluences.rsi.h1}` : '';
                            const tsExtracted = alertData.signal.timestampExtracted ? '🕐' : '⏰';
                            console.log(`🚨 #${alertCount}: ${alertData.asset.cleanTicker} | ${alertData.signal.category} | ${alertData.signal.timestamp}`);

                            updateInsights(alertData);
                        }

                    } catch (error) {
                        console.error(`[Sidebar] ❌ Error processing item:`, error);
                    }
                });

                if (isInitialLoad) {
                    isInitialLoad = false;
                    console.log(`[Init] ✅ Initial load complete - processed ${newAlertsCount} alerts`);
                }

                console.log(`[Sidebar] ✅ Captured ${newAlertsCount} alerts (${pulseStats.nonTradingSkipped} non-trading skipped)`);

                if (newAlertsCount > 0) {
                    // ✅ SEND TO BACKEND IMMEDIATELY
                    syncBatchToBackend({
                        batch_id: `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        alerts: capturedAlertsThisRead,
                        batch_summary: {
                            total: newAlertsCount,
                            sentiment: calculateMarketSentiment(),
                            topMovers: getTopMovers(5),
                            avgRSI: calculateAverageRSI(),
                            frequency: getAlertFrequency(),
                            timeRange: getAlertTimeRange(),
                            insights: generateSmartInsights()
                        },
                        macro_windows: aggregateInto5mWindows(),
                        timestamp: new Date().toISOString()
                    }, isSyncMode);

                    // ✅ SHOW SUMMARIES IMMEDIATELY
                    console.log(`\n${'═'.repeat(60)}`);
                    console.log(`📊 SHOWING ANALYSIS FOR ${newAlertsCount} ALERTS`);
                    console.log(`${'═'.repeat(60)}\n`);

                    printImmediateAnalytics(capturedAlertsThisRead);

                    setTimeout(() => {
                        printBatchSummary();
                        printMacroSummary();
                    }, 1000);
                }

            } catch (error) {
                console.error('[Sidebar] ❌ Error:', error);
            }

        }, delay);
    }

    function ensureAlertsPanelOpen() {
        const alertsBtn = document.querySelector('button[data-name="alerts"]');

        if (!alertsBtn) {
            console.warn('[Panel] ⚠️ Alerts button not found');
            return false;
        }

        const isPressed = alertsBtn.getAttribute('aria-pressed') === 'true';

        if (isPressed) {
            console.log('[Panel] ✅ Alerts panel already open');
            return true;
        } else {
            console.log('[Panel] 📂 Opening alerts panel...');
            alertsBtn.click();
            return false;
        }
    }

    function setupSidebarMutationObserver() {
        const alertsBtn = document.querySelector('button[data-name="alerts"]');

        if (!alertsBtn) {
            console.log('[Sidebar Observer] ⚠️ Alerts button not found yet');
            return false;
        }

        if (sidebarMutationObserver) {
            console.log('[Sidebar Observer] ⚠️ Already monitoring sidebar button');
            return true;
        }

        sidebarMutationObserver = new MutationObserver(() => {
            const isPressed = alertsBtn.getAttribute('aria-pressed') === 'true';

            if (isPressed) {
                console.log('[Sidebar Observer] 📂 Alerts panel opened manually, waiting 3 seconds...');
                readSidebarAlerts(3000);
            } else {
                console.log('[Sidebar Observer] 📪 Alerts panel closed');
            }
        });

        sidebarMutationObserver.observe(alertsBtn, {
            attributes: true,
            attributeFilter: ['aria-pressed']
        });

        console.log('[Sidebar Observer] ✅ Monitoring alerts button state');
        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    // GLOBAL TRIGGER WATCHER (BACKGROUND TAB SYNC)
    // ═══════════════════════════════════════════════════════════════
    let lastTriggerTime = 0;

    function toggleSidebarSequence() {
        if (!CONFIG.ENABLE_FORCE_TOGGLE) {
            // VERBOSE LOGGING: Provide confidence that the system is alive even in passive mode
            const bufferSize = unsafeWindow.pendingAlertBatch ? unsafeWindow.pendingAlertBatch.length : 0;
            console.log(`[Sync] 🔄 Cycle Check (Passive Mode) | Buffered: ${bufferSize} | Total Processed: ${pulseStats.totalAlerts}`);
            return;
        }

        console.log('[Sync] 🔄 Cycle detected! Running Force-Toggle Sequence...');

        const alertsBtn = document.querySelector('button[data-name="alerts"]');
        if (!alertsBtn) {
            console.warn('[Sync] ⚠️ Alerts button not found, skipping toggle');
            return;
        }

        const isPressed = alertsBtn.getAttribute('aria-pressed') === 'true';

        // Helper: Wait for items to render
        const waitForRender = (attempt = 0) => {
            const items = document.querySelectorAll('div[data-name="alert-log-item"]');
            if (items.length > 0) {
                console.log(`[Sync] ✅ Render detected (${items.length} items) after ${attempt * 500}ms`);
                readSidebarAlerts(0);
            } else if (attempt < 10) { // Max 5 seconds wait
                console.log(`[Sync] ⏳ Waiting for render (attempt ${attempt + 1})...`);
                setTimeout(() => waitForRender(attempt + 1), 500);
            } else {
                console.warn('[Sync] ⚠️ Render timeout - reading what we have');
                readSidebarAlerts(0);
            }
        };

        if (isPressed) {
            // Panel is OPEN. Close it, then Re-open.
            console.log('[Sync] 🔽 Closing panel...');
            alertsBtn.click();

            setTimeout(() => {
                console.log('[Sync] � Re-opening panel to force DOM render...');
                alertsBtn.click();
                setTimeout(() => waitForRender(), 500);
            }, 500);
        } else {
            // Panel is CLOSED. Just Open it.
            console.log('[Sync] 🔼 Opening panel...');
            alertsBtn.click();
            setTimeout(() => waitForRender(), 500);
        }
    }

    function startGlobalTriggerWatcher() {
        console.log('[Sync] 📡 Listening for Master Trigger (unsafeWindow.TRIGGER_SIDEBAR_CHECK)...');

        setInterval(() => {
            if (unsafeWindow.TRIGGER_SIDEBAR_CHECK && unsafeWindow.TRIGGER_SIDEBAR_CHECK > lastTriggerTime) {
                lastTriggerTime = unsafeWindow.TRIGGER_SIDEBAR_CHECK;
                console.log(`[Sync] 🔔 Trigger received at ${new Date(lastTriggerTime).toLocaleTimeString()}`);
                toggleSidebarSequence();
            }
        }, 2000); // Check every 2s (Lightweight)
    }

    // ═══════════════════════════════════════════════════════════════
    // SIMPLIFIED TOAST DETECTION (TRIGGER ONLY)
    // ═══════════════════════════════════════════════════════════════
    let pollingInterval = null;
    let toastCheckCount = 0;
    let isProcessingToast = false;

    function handleToastDetection() {
        if (isProcessingToast) {
            console.log('[Toast] ⏭️ Already processing, skipping...');
            return;
        }

        isProcessingToast = true;
        pulseStats.toastDetections++;

        console.log(`\n[Toast] 🔔 Alert detected! Waiting ${CONFIG.TOAST_WAIT_MS / 1000}s...`);

        setTimeout(() => {
            console.log('[Toast] ⏰ Opening alerts panel and reading...');

            const panelWasOpen = ensureAlertsPanelOpen();
            const waitTime = panelWasOpen ? CONFIG.PANEL_WAIT_MS : CONFIG.PANEL_OPEN_WAIT_MS;

            readSidebarAlerts(waitTime);

            setTimeout(() => {
                isProcessingToast = false;
            }, waitTime + 2000);

        }, CONFIG.TOAST_WAIT_MS);
    }

    function checkToastForNewAlerts() {
        toastCheckCount++;

        const toastGroups = document.querySelectorAll("#overlap-manager-root section [class*='toastGroup']");

        if (toastGroups.length < 2) { // Need at least 2 groups (Group 1 is usually alerts)
            if (toastCheckCount % 20 === 0) {
                console.log(`[Poll] ⏳ [${toastCheckCount * 3}s] Waiting for toast container...`);
            }
            return;
        }

        const targetToast = toastGroups[1];
        if (!targetToast) return;

        // Visual Check
        const style = window.getComputedStyle(targetToast);
        const isVisible = style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            parseFloat(style.opacity) > 0;

        if (!isVisible) return;

        // DIRECT PARSING LOGIC: Look for 'ul > li' items
        const listItems = targetToast.querySelectorAll('ul li');
        if (listItems.length === 0) return;

        let newToastAlertsCount = 0;
        const capturedToastAlerts = [];
        const todayContext = new Date(); // Explicit "Today" per user request

        listItems.forEach(li => {
            try {
                const text = li.innerText || '';
                if (text.length < 10) return;

                // DEDUPLICATION: Shared Hash Check
                const contentHash = text.replace(/\s+/g, '');
                if (processedAlertIds.has(contentHash)) {
                    return; // Already processed by Sidebar or previous Poll
                }

                // Parse with TODAY context
                const alertData = parseAlertMessage(text, todayContext);

                if (alertData && alertData.parsed) {
                    console.log(`[Poll] 🔔 Captured Toast Alert: ${alertData.asset.cleanTicker}`);

                    processedAlertIds.add(contentHash); // Lock it immediately

                    pulseStats.totalAlerts++;
                    pulseStats.toastDetections++;
                    newToastAlertsCount++;

                    unsafeWindow.institutionalPulse.push(alertData);
                    capturedToastAlerts.push(alertData);
                    updateInsights(alertData);
                }
            } catch (err) {
                console.warn('[Poll] ⚠️ Failed to parse toast item (skipping):', err);
            }
        });

        if (newToastAlertsCount > 0) {
            console.log(`[Poll] ✅ Direct-Parsed ${newToastAlertsCount} alerts from Toast! Syncing...`);
            syncBatchToBackend({
                batch_id: `toast_${Date.now()}`,
                alerts: capturedToastAlerts,
                batch_summary: {
                    source: 'TOAST_FALLBACK',
                    count: newToastAlertsCount
                }
            }, false); // Force Trigger (Toasts are usually urgent)
        }
    }

    function startPollingObserver() {
        if (pollingInterval) {
            console.log('[Poll] ⚠️ Polling already active');
            return;
        }

        console.log('[Poll] 🚀 Starting toast detection (3s interval)...');

        checkToastForNewAlerts();
        pollingInterval = setInterval(checkToastForNewAlerts, CONFIG.POLL_INTERVAL_MS);

        console.log('[Poll] ✅ Polling active');
    }

    function stopPollingObserver() {
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
            console.log('[Poll] 🛑 Polling stopped');
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // KEYBOARD SHORTCUTS
    // ═══════════════════════════════════════════════════════════════
    document.addEventListener('keydown', (e) => {
        if (e.altKey && e.code === 'KeyI') {
            e.preventDefault();
            console.log(`\n${'═'.repeat(60)}`);
            console.log('📊 INSTITUTIONAL PULSE STATS v2.4 PRODUCTION');
            console.log(`${'═'.repeat(60)}`);
            console.log(`   Total Alerts: ${pulseStats.totalAlerts}`);
            console.log(`   ULTRA_SCALP: ${pulseStats.ultraScalp}`);
            console.log(`   INSTITUTIONAL_LEVEL: ${pulseStats.institutionalLevel}`);
            console.log(`   Non-Trading Skipped: ${pulseStats.nonTradingSkipped} 🚫`);
            console.log(`   Toast Detections: ${pulseStats.toastDetections}`);
            console.log(`   Sidebar Reads: ${pulseStats.sidebarReads}`);
            console.log(`   Sidebar Retries: ${pulseStats.sidebarRetries}`);
            console.log(`   Date Labels Found: ${pulseStats.dateLabelsFound} 📅`);
            console.log(`   Timestamp Extractions: ${pulseStats.timestampExtractions}`);
            console.log(`   Timestamp Fallbacks: ${pulseStats.timestampFallbacks}`);
            console.log(`   Backend Syncs: ${pulseStats.backendSyncs} ✅`);
            console.log(`   Backend Errors: ${pulseStats.backendErrors}`);
            console.log(`   Stored Alerts: ${unsafeWindow.institutionalPulse.length}`);
            console.log(`   Poll Checks: ${toastCheckCount}`);
            console.log(`   Polling Active: ${pollingInterval !== null}`);
            console.log(`${'═'.repeat(60)}\n`);
        }

        if (e.altKey && e.shiftKey && e.code === 'KeyA') {
            e.preventDefault();
            printBatchSummary();
            printMacroSummary();
        }

        if (e.altKey && e.shiftKey && e.code === 'KeyC') {
            e.preventDefault();
            unsafeWindow.institutionalPulse = [];
            alertCount = 0;
            processedAlertIds.clear();

            INSIGHTS.stats = {
                volumeIntent: { bullish: 0, bearish: 0, neutral: 0, bullishWeight: 0, bearishWeight: 0 },
                categories: { ultraScalp: 0, institutionalLevel: 0 },
                tickers: new Map(),
                timeframes: new Map(),
                rsi: { oversold: 0, overbought: 0, neutral: 0, cumulative: { m5: [], m30: [], h1: [], h4: [] } },
                momentum: [],
                alertTimes: [],
                rawAlerts: []
            };

            console.log('[Control] 🗑️ All alerts and insights cleared');
        }

        if (e.altKey && e.shiftKey && e.code === 'KeyP') {
            e.preventDefault();
            if (pollingInterval) {
                stopPollingObserver();
                console.log('[Control] ⏸️ Polling paused');
            } else {
                startPollingObserver();
                console.log('[Control] ▶️ Polling resumed');
            }
        }

        if (e.altKey && e.shiftKey && e.code === 'KeyR') {
            e.preventDefault();
            console.log('[Control] 📖 Force reading sidebar now...');
            readSidebarAlerts(0);
        }
    });

    // ═══════════════════════════════════════════════════════════════
    // PUBLIC API
    // ═══════════════════════════════════════════════════════════════
    unsafeWindow.InstitutionalPulse = {
        version: '16.0',
        getAlerts: () => unsafeWindow.institutionalPulse,
        getStats: () => pulseStats,
        getInsights: () => INSIGHTS.stats,
        getSentiment: calculateMarketSentiment,
        getTopMovers: getTopMovers,
        getAlertFrequency: getAlertFrequency,
        getAlertTimeRange: getAlertTimeRange,
        showBatchSummary: printBatchSummary,
        showMacroSummary: printMacroSummary,
        showImmediateAnalytics: printImmediateAnalytics,
        clearAlerts: () => {
            unsafeWindow.institutionalPulse = [];
            alertCount = 0;
            processedAlertIds.clear();
        },
        stopPolling: stopPollingObserver,
        startPolling: startPollingObserver,
        forceCheck: checkToastForNewAlerts,
        forceReadSidebar: () => readSidebarAlerts(0),
        getPollingStatus: () => ({
            active: pollingInterval !== null,
            checkCount: toastCheckCount,
            processing: isProcessingToast
        }),
        config: CONFIG
    };

    // ═══════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════
    function initialize() {
        console.log('[Init] 🎬 Initializing Institutional Pulse Tracker v2.4 Production...');

        let retryCount = 0;
        const maxRetries = 10;

        function trySetupSidebar() {
            const sidebarSetup = setupSidebarMutationObserver();
            if (!sidebarSetup && retryCount < maxRetries) {
                retryCount++;
                console.log(`[Init] ⏳ Retry ${retryCount}/${maxRetries} for sidebar button...`);
                setTimeout(trySetupSidebar, 2000);
            } else if (sidebarSetup) {
                console.log('[Init] ✅ Sidebar observer setup complete');
            } else {
                console.warn('[Init] ⚠️ Failed to setup sidebar observer after max retries');
            }
        }

        trySetupSidebar();

        setTimeout(() => {
            startPollingObserver();
            if (typeof startGlobalTriggerWatcher === 'function') startGlobalTriggerWatcher();
        }, 3000);

        setTimeout(() => {
            const alertsBtn = document.querySelector('button[data-name="alerts"]');
            if (alertsBtn && alertsBtn.getAttribute('aria-pressed') === 'true') {
                console.log('[Init] 📖 Panel already open, doing initial read...');
                readSidebarAlerts(2000);
            }
        }, 5000);
    }

    function waitForPageLoad() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                console.log('[Init] ✅ DOM loaded, waiting 3 seconds for dynamic content...');
                setTimeout(initialize, 3000);
            });
        } else {
            console.log('[Init] ✅ DOM already loaded, waiting 3 seconds for dynamic content...');
            setTimeout(initialize, 3000);
        }
    }

    waitForPageLoad();

    console.log('✅ Institutional Pulse Tracker v2.8 PRODUCTION ready');
    console.log('🔄 Detection: Toast Polling + Date-Aware Sidebar');
    console.log('📋 Categories: ULTRA_SCALP (Short) | INSTITUTIONAL_LEVEL (Trigger)');
    console.log('✨ v2.4 Features:');
    console.log('   • Process ALL alerts on load (no 30s filter)');
    console.log('   • Auto-show summary immediately after read');
    console.log('   • Non-trading message filter (EA pair, etc.)');
    console.log('   • Fixed frequency (rate over actual span)');
    console.log('   • Backend deduplication handled server-side');
    console.log('   • Time-aware analytics (trigger timestamps)');
    console.log('🎯 Shortcuts: Alt+I (stats) | Alt+Shift+A (summary) | Alt+Shift+C (clear)');

})();
