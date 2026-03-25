/**
 * RSIEngine.js
 * Institutional Grade RSI & Speedbreaker Calculation Engine
 * 
 * Provides categorization of coins based on RSI multi-timeframe matrices 
 * and calculates distance (%) to Smart Levels for "Speedbreaker" rendering.
 */

// Categorize RSI into actionable buckets
const categorizeRSI = (rsiMatrix) => {
    if (!rsiMatrix || !rsiMatrix.h1) return 'NEUTRAL';

    const h1 = parseFloat(rsiMatrix.h1);

    if (h1 <= 30) return 'OVERSOLD_30';
    if (h1 >= 70) return 'OVERBOUGHT_70';
    
    // RSI 50 Rejection Logic: If RSI is hovering around the 50 pivot.
    if (h1 >= 48 && h1 <= 52) {
        return 'REJECTION_50';
    }

    return 'NEUTRAL';
};

// Calculate percentage relative distance
const calcDistance = (price, targetPrice) => {
    if (!price || !targetPrice) return null;
    const p = parseFloat(price);
    const t = parseFloat(targetPrice);
    if (p === 0) return 0;
    return ((t - p) / p) * 100; // Positive means target is above (Resistance), Negative means below (Support)
};

// Map smart levels to speedbreaker objects
const generateSpeedbreakers = (price, smartLevels) => {
    const breakers = [];

    if (!smartLevels) return breakers;

    // Helper to safely push a level
    const addLevel = (name, type, levelObj) => {
        if (!levelObj || !levelObj.p) return;
        const dist = calcDistance(price, levelObj.p);
        if (dist !== null) {
            breakers.push({
                name,
                type,           // 'EMA200', 'EMA50', 'FIB', 'MEGA_SPOT', 'LOGIC'
                price: parseFloat(levelObj.p),
                distance_pct: dist,
                stars: levelObj.s || (levelObj.c ? levelObj.c : 0) // stars or mega_count
            });
        }
    };

    // 1. Mega Spots
    addLevel('Mega Spot', 'MEGA_SPOT', smartLevels.mega_spot);

    // 2. 200 EMAs
    if (smartLevels.emas_200) {
        addLevel('EMA200 (5m)', 'EMA200', smartLevels.emas_200.m5);
        addLevel('EMA200 (15m)', 'EMA200', smartLevels.emas_200.m15);
        addLevel('EMA200 (1H)', 'EMA200', smartLevels.emas_200.h1);
        addLevel('EMA200 (4H)', 'EMA200', smartLevels.emas_200.h4);
    }
    
    // 3. 50 EMAs (If exported by Pine Script overlay)
    if (smartLevels.emas_50) {
        addLevel('EMA50 (5m)', 'EMA50', smartLevels.emas_50.m5);
        addLevel('EMA50 (30m)', 'EMA50', smartLevels.emas_50.m30);
        addLevel('EMA50 (1H)', 'EMA50', smartLevels.emas_50.h1);
        addLevel('EMA50 (4H)', 'EMA50', smartLevels.emas_50.h4);
    }

    // 4. Fibs
    if (smartLevels.fibs_618) {
        addLevel('Fib 618 (1H)', 'FIB', smartLevels.fibs_618.h1);
        addLevel('Fib 618 (1D)', 'FIB', smartLevels.fibs_618.d1);
        addLevel('Fib 618 (1W)', 'FIB', smartLevels.fibs_618.w1);
    }

    // 5. Daily/Hourly Logic (Bases/Necks)
    if (smartLevels.daily_logic) {
        addLevel('Daily Base', 'LOGIC', smartLevels.daily_logic.base_supp || smartLevels.daily_logic.base_res);
        addLevel('Daily Neck', 'LOGIC', smartLevels.daily_logic.neck_supp || smartLevels.daily_logic.neck_res);
    }
    if (smartLevels.hourly_logic) {
        addLevel('1H Base', 'LOGIC', smartLevels.hourly_logic.base_supp || smartLevels.hourly_logic.base_res);
        addLevel('1H Neck', 'LOGIC', smartLevels.hourly_logic.neck_supp || smartLevels.hourly_logic.neck_res);
    }

    // Sort by absolute proximity to current price
    breakers.sort((a, b) => Math.abs(a.distance_pct) - Math.abs(b.distance_pct));

    return breakers;
};

// Main processing wrapper
const processRSIData = (streamC_Rows) => {
    const buckets = {
        OVERSOLD_30: [],
        REJECTION_50: [],
        OVERBOUGHT_70: [],
        NEUTRAL: []
    };

    streamC_Rows.forEach(row => {
        try {
            const parsedData = JSON.parse(row.raw_data);
            const rsiMatrix = parsedData.rsi_matrix;            
            const category = categorizeRSI(rsiMatrix);
            
            const processedCoin = {
                ticker: row.ticker,
                price: row.price,
                direction: row.direction,
                roc_pct: row.roc_pct,
                rsi_matrix: rsiMatrix,
                speedbreakers: generateSpeedbreakers(row.price, parsedData.smart_levels),
                alert_time: row.alert_time
            };

            if (buckets[category]) {
                buckets[category].push(processedCoin);
            }
        } catch (e) {
            console.error(`[RSI Engine] Error parsing row for ${row.ticker}:`, e.message);
        }
    });

    return buckets;
};

module.exports = {
    categorizeRSI,
    generateSpeedbreakers,
    processRSIData
};
