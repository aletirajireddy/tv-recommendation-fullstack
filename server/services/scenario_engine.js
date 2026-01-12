const db = require('better-sqlite3')('dashboard.db');

/**
 * SCENARIO PLANNING ENGINE (Plan A / Plan B)
 * 
 * Analyzes the latest market scan and institutional pulse to generate
 * two distinct strategic focus lists.
 */

const ScenarioEngine = {
    /**
     * Generate the Scenario Plan
     * @param {number} hours - Lookback window in hours (default: 24)
     * @returns {Object} { planA: [], planB: [], sentiment: {} }
     */
    generatePlan: function (hours = 24) {
        try {
            // 1. Get Latest Scan ID
            const latestScan = db.prepare(`
                SELECT id, timestamp, market_mood, market_mood_score 
                FROM scans 
                ORDER BY id DESC LIMIT 1
            `).get();

            if (!latestScan) return { planA: [], planB: [], sentiment: null };

            // 2. Get Scan Results (Candidates)
            // FIXED: Use 'scan_entries' table and parse 'raw_data_json'
            // RELAXED: Include 'MISSED' entries so Scenario Engine can find hidden gems
            const entries = db.prepare(`
                SELECT ticker, raw_data_json, status FROM scan_entries 
                WHERE scan_id = ?
            `).all(latestScan.id);

            const candidates = entries.map(e => {
                const raw = JSON.parse(e.raw_data_json || '{}');
                // Ensure critical fields exist
                return {
                    ticker: e.ticker,
                    price: raw.close || 0,
                    resistDist: raw.resistDist,
                    supportDist: raw.supportDist,
                    momScore: raw.momScore,
                    volSpike: raw.volSpike
                };
            });

            // 3. Get Recent Institutional Pulse (Dynamic Window)
            const cutoff = Date.now() - (hours * 60 * 60 * 1000);
            const pulseEvents = db.prepare(`
                SELECT ticker, type, payload_json, timestamp 
                FROM pulse_events 
                WHERE timestamp > ?
            `).all(cutoff);

            // Map Pulse to Tickers
            const pulseMap = {};
            pulseEvents.forEach(evt => {
                // Parse payload if needed, or rely on 'type' column
                let signalType = evt.type || '';
                if (!signalType) {
                    try {
                        const p = JSON.parse(evt.payload_json || '{}');
                        signalType = p.signal?.category || 'UNKNOWN';
                    } catch (e) { }
                }

                if (!pulseMap[evt.ticker]) pulseMap[evt.ticker] = { buy: 0, sell: 0 };

                // Heuristic for Pulse Direction
                const rawUpper = (JSON.stringify(evt)).toUpperCase();
                if (rawUpper.includes('BUY') || rawUpper.includes('BULL') || rawUpper.includes('LONG')) pulseMap[evt.ticker].buy++;
                if (rawUpper.includes('SELL') || rawUpper.includes('BEAR') || rawUpper.includes('SHORT')) pulseMap[evt.ticker].sell++;
            });

            // 4. Generate Plans
            const planA = []; // Bullish Breakout
            const planB = []; // Bearish Breakdown

            candidates.forEach(coin => {
                // Parse JSON fields
                const resistDist = typeof coin.resistDist === 'string' ? parseFloat(coin.resistDist) : coin.resistDist;
                const supportDist = typeof coin.supportDist === 'string' ? parseFloat(coin.supportDist) : coin.supportDist;
                const momScore = typeof coin.momScore === 'string' ? parseFloat(coin.momScore) : coin.momScore;
                const volSpike = typeof coin.volSpike === 'string' ? parseFloat(coin.volSpike) : coin.volSpike;

                const pulse = pulseMap[coin.ticker] || { buy: 0, sell: 0 };

                // LOGIC UPDATE: Priority for Volume + Momentum "Ignition"
                const hasVol = volSpike !== null && volSpike > 0;
                const hasMom = momScore !== null && Math.abs(momScore) > 0;

                // Heat Score: Base Pulse + Bonus for Vol/Mom combo
                let heatScore = Math.max(pulse.buy, pulse.sell);
                if (hasVol) heatScore += 3; // Massive bonus for Volume Spike
                if (hasMom) heatScore += 1;

                // PLAN A: Bullish Breakout
                // RELAXED: Allow neutral momentum (-5) if near resistance (< 3.0%)
                if (
                    resistDist !== null && resistDist >= 0 && resistDist < 3.0 &&
                    momScore >= -5
                ) {
                    planA.push({
                        ticker: coin.ticker,
                        price: coin.price,
                        trigger: `Break R (+${resistDist.toFixed(1)}%)`,
                        scope: `Mom: ${momScore}`,
                        heat: heatScore,
                        vol: hasVol,
                        type: 'BREAKOUT'
                    });
                }

                // PLAN B: Bearish Breakdown
                // RELAXED: Allow neutral momentum (5) if near support (> -3.0%)
                if (
                    supportDist !== null && supportDist <= 0 && supportDist > -3.0 &&
                    momScore <= 5
                ) {
                    planB.push({
                        ticker: coin.ticker,
                        price: coin.price,
                        trigger: `Lose S (${supportDist.toFixed(1)}%)`,
                        scope: `Mom: ${momScore}`,
                        heat: heatScore,
                        vol: hasVol,
                        type: 'BREAKDOWN'
                    });
                }
            });

            // Sort by Boosted Heat (Inst Activity + Vol Spike) then Momentum
            planA.sort((a, b) => b.heat - a.heat);
            planB.sort((a, b) => b.heat - a.heat);

            return {
                timestamp: latestScan.timestamp,
                marketCheck: {
                    mood: latestScan.market_mood,
                    score: latestScan.market_mood_score
                },
                planA: planA.slice(0, 10), // Top 10
                planB: planB.slice(0, 10)  // Top 10
            };

        } catch (err) {
            console.error('[ScenarioEngine] Error:', err);
            return { error: err.message };
        }
    }
};

module.exports = ScenarioEngine;
