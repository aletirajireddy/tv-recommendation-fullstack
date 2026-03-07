/**
 * GENIE SMART ENGINE
 * The Core Intelligence Layer for the Frontend
 * 
 * Purpose:
 * Derives "Smart Insights" and "Global Mood" from the raw 26-column V3 data blob.
 * It replaces the legacy backend "Market Sentiment" stats with dynamic client-side logic.
 * 
 * Reference: GEMINI.md Section 6.2 (The Sacred Schema)
 */

const GenieSmart = {

    // ═══════════════════════════════════════════════════════════════
    // CONSTANTS & CONFIG
    // ═══════════════════════════════════════════════════════════════

    POSITION_CODE_SCORES: {
        530: 35, 502: 35, 430: 32, 403: 32, 521: 30,
        500: 28, 104: 28, 340: 28, 231: 25, 221: 20,
        212: 15, 222: 10, 421: 18, 412: 18
    },

    /**
     * 0. Calculate Quality Score (Client-Side Derivative)
     * Replaces the need for the scanner script to send a pre-calculated score.
     * @param {Object} d - The raw coin data object (flattened)
     */
    calculateScore: (d) => {
        let score = 0;
        const insights = [];

        // 1. Base Score from Position Code
        score += GenieSmart.POSITION_CODE_SCORES[d.positionCode] || 0;

        // 2. Mega Zone
        if (d.megaSpotDist !== null && Math.abs(d.megaSpotDist) <= 0.5) {
            score += 20;
            insights.push('🎯 Mega zone');
        }

        // 3. Trend Alignment
        const isBullishTrend = (d.netTrend || 0) >= 60;
        const isDailyBull = (d.dailyTrend || 0) === 1;

        if ((d.resistDist || 0) >= 2.0 && isBullishTrend) {
            score += 20;
            insights.push('💪 Strong trend');
            if (isDailyBull) {
                score += 5;
                insights.push('☀️ Daily align');
            }
        }

        // 4. Confluence
        if ((d.supportStars || d.resistStars || 0) >= 4) {
            score += 12;
            insights.push('⭐ High confluence');
        }

        // 5. Momentum & Volume
        if ((d.momScore || 0) >= 2) {
            score += d.momScore === 3 ? 7 : 5;
        }
        if (d.volSpike === 1) {
            score += 3;
            insights.push('📊 Volume');
        }

        // 6. Breakout Signal (NEW)
        if (d.breakout === 1) {
            score += 10;
            insights.push('🚀 Breakout');
        }

        // 7. Warning Signs (Penalties/Insights)
        if ((d.dailyRange || 0) > 80) insights.push('⚠️ Late entry');
        if ((d.compressCount || 0) >= 3)
            insights.push(`⚡ Compressed(${d.compressCount})`);
        if (d.freeze === 1) insights.push('❄️ Frozen');

        // Derived Logic for Label/Color
        let direction = 'NEUTRAL';
        if ((d.resistDist || 0) >= 2.0) direction = 'BULL';
        else if ((d.supportDist || 0) <= -2.0) direction = 'BEAR';

        // Label Logic
        let label = '💤 WEAK';
        if (score >= 90) label = '🚀 MEGA';
        else if (score >= 75) label = '💪 STRONG';
        else if (score >= 60) label = '✅ GOOD';
        else if (score >= 45) label = '👀 WATCH';

        return { score, label, direction, insights };
    },

    /**
     * 1. Analyze Global Market Mood
     * Aggregates individual coin data to determine the overall vibe.
     * @param {Array} tickers - The 'results' array from the scan blob
     */
    analyzeMarketMood: (tickers = []) => {
        if (!tickers || tickers.length === 0) return { score: 0, label: 'OFFLINE', intent: 'NEUTRAL' };

        let bullish = 0;
        let bearish = 0;
        let neutral = 0;

        // Count Directions based on Position Code
        // 1xx = Bearish, 3xx/5xx = Bullish, 2xx/4xx = Neutral/Choppy
        tickers.forEach(t => {
            const d = t.data || t;
            const code = d.positionCode || 0;

            if (code >= 300) bullish++;          // 300+ (Bullish Trend, Mega Spot)
            else if (code >= 100 && code < 200) bearish++; // 100-199 (Bearish Trend)
            else neutral++;
        });

        const total = tickers.length;

        // 🎯 GENIE MOOD FORMULA (Net Flow %)
        // Range: -100 (All Bear) to +100 (All Bull)
        // 0 = Perfect Balance
        let rawScore = 0;
        if (total > 0) {
            rawScore = ((bullish - bearish) / total) * 100;
        }

        const avgScore = Math.round(rawScore);

        // Derive Label
        let label = 'NEUTRAL';
        if (avgScore >= 20) label = 'BULLISH';
        if (avgScore >= 60) label = 'EUPHORIC';
        if (avgScore <= -20) label = 'BEARISH';
        if (avgScore <= -60) label = 'PANIC';

        return {
            moodScore: avgScore,
            label,
            stats: { bullish, bearish, total }
        };
    },

    /**
     * 2. Interpret EMA Position Code
     * Decodes the 3-digit Position Code (e.g. 104, 305, 500)
     * @param {number} code 
     */
    interpretPosition: (code) => {
        if (!code) return { label: 'UNKNOWN', color: 'gray' };

        // 1xx: Bearish (Below all EMAs)
        if (code >= 100 && code < 200) return { label: 'BEARISH TREND', color: 'red' };

        // 2xx: Choppy (Mixed EMAs)
        if (code >= 200 && code < 300) return { label: 'CHOPPY / RANGE', color: 'yellow' };

        // 3xx: Bullish (Above all EMAs)
        if (code >= 300 && code < 400) return { label: 'BULLISH TREND', color: 'green' };

        // 4xx: Testing Support (Pullback)
        if (code >= 400 && code < 500) return { label: 'TESTING SUPPORT', color: 'blue' };

        // 5xx: Mega Spot (Institutional Zone)
        if (code >= 500) return { label: 'MEGA SPOT', color: 'purple' };

        return { label: 'NORMAL', color: 'gray' };
    },

    /**
     * 3. Derive "Smart Strategies"
     * Identifies high-quality setups based on multiple columns.
     */
    deriveStrategies: (tickerData) => {
        const d = tickerData.data || tickerData;
        const strategies = [];

        // Strategy A: "Sniper entry" (Pullback to Support + Mob Momentum)
        if (d.supportDist < 2 && d.momScore > 50) {
            strategies.push({ name: 'SNIPER_ENTRY', confidence: 'HIGH' });
        }

        // Strategy B: "Breakout" (Vol Spike + Logic Resist Break)
        if (d.volSpike > 20 && d.logicResistDist < 1) {
            strategies.push({ name: 'VOL_BREAKOUT', confidence: 'MEDIUM' });
        }

        // Strategy C: "Oversold Bounce" (Low EMA dist + RSI/Mom low)
        if (d.ema200Dist < -5 && d.momScore < -20) {
            strategies.push({ name: 'OVERSOLD_BOUNCE', confidence: 'MEDIUM' });
        }

        // Strategy D: "Breakout Signal" (Explicit Column 16)
        if (d.breakout) {
            strategies.push({ name: 'BREAKOUT_SIGNAL', confidence: 'HIGH', label: '🚀 BREAKOUT' });
        }

        // Strategy E: "Freeze Mode" (Explicit Column 15 - Low Volatility/Compression)
        if (d.freeze) {
            strategies.push({ name: 'FREEZE_MODE', confidence: 'NEUTRAL', label: '🧊 FREEZE' });
        }

        return strategies;
    }
};

export default GenieSmart;
