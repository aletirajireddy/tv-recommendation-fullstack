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
        let totalScore = 0;
        let validCount = 0;

        tickers.forEach(t => {
            // Unpack Data (Handle V3 Flat or Nested)
            const d = t.data || t;

            // Direction Logic
            if (d.direction === 'BULL') bullish++;
            else if (d.direction === 'BEAR') bearish++;
            else neutral++;

            // Global Mood Score Calculation
            // We weigh 'momScore' and 'netTrend' heavily
            const score = d.score || 0; // Use the pre-calc score from Pine if available
            if (score !== 0) {
                totalScore += score;
                validCount++;
            }
        });

        const avgScore = validCount > 0 ? Math.round(totalScore / validCount) : 0;

        // Derive Label
        let label = 'NEUTRAL';
        if (avgScore > 20) label = 'BULLISH';
        if (avgScore > 50) label = 'EUPHORIC';
        if (avgScore < -20) label = 'BEARISH';
        if (avgScore < -50) label = 'PANIC';

        return {
            moodScore: avgScore,
            label,
            stats: { bullish, bearish, total: tickers.length }
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
