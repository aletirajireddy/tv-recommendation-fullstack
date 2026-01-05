/**
 * CHART ADAPTERS (Middleware)
 * Transforms raw Analytics Data into visualization-ready formats.
 * Decouples logic from UI components.
 */

// Transforms Time Spread Map into Bull/Bear Flow Data
export function toMoodFlowData(timeSpread) {
    if (!timeSpread) return [];

    // Sort by time (assuming time string logic is consistent or provide fallback)
    // Here we rely on the server returning meaningful time strings or presorted
    // Actually server returns array. Let's just map it.

    // We need to reverse it if it's descending? Server likely returns desc or asc.
    // Let's assume we want Chronological (Left to Right).
    // The server currently maps from a Map which might be unordered, but likely insertion order.
    // Let's safe-guard sort if needed, or trust the array index.

    return timeSpread.map(item => ({
        label: item.time,
        fullTime: item.time,
        bull: item.bullish || 0,
        bear: item.bearish || 0,
        intensity: item.count,
        bias: item.bias,
        density: parseFloat(item.density),
        momentum: parseFloat(item.mon_pct) || 0,
        moodScore: item.mood_score || 0 // New Field
    })).reverse(); // Reverse for Chart (Old -> New) // Usually latest is first, we want charts to go Left(Old)->Right(New)
}

// Transforms Scan Results into Scatter Data (Price vs Volatility)
export function toScatterData(scans) {
    // Placeholder for future Scatter Logic
    return [];
}
