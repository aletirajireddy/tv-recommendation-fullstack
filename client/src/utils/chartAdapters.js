/**
 * CHART ADAPTERS (Middleware)
 * Transforms raw Analytics Data into visualization-ready formats.
 * Decouples logic from UI components.
 */

// Transforms Time Spread Map into Bull/Bear Flow Data
export function toMoodFlowData(timeSpread) {
    if (!timeSpread) return [];

    return timeSpread.map(item => {
        // Format raw UTC timestamp into clean Local HH:mm for the X-Axis
        const dateObj = new Date(item.time);
        const timeLabel = isNaN(dateObj.getTime()) 
            ? item.time // Fallback if invalid
            : dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

        return {
            label: timeLabel,
            fullTime: item.time,
            bull: item.bullish || 0,
            bear: item.bearish || 0,
            intensity: item.count,
            bias: item.bias,
            density: parseFloat(item.density),
            momentum: parseFloat(item.mom_pct) || 0,
            moodScore: item.mood_score || 0
        };
    }).reverse(); // Reverse for Chart (Left -> Right = Old -> New)
}

// Transforms Scan Results into Scatter Data (Price vs Volatility)
export function toScatterData(scans) {
    // Placeholder for future Scatter Logic
    return [];
}
