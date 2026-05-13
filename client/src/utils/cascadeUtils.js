// Shared EMA cascade logic — used by EMACascadeMonitor, ATRRaceWidget, and any
// future widget that needs cascade classification or settings validation.

export const TF_ORDER = ['h4', 'h1', 'm15', 'm5', 'm1']; // longest → shortest

export const TF_LABELS = {
    h4: '4h', h1: '1h', m15: '15m', m5: '5m', m1: '1m',
};

export const CASCADE_SERIES_DEFAULTS = {
    longSeries:     ['h4', 'h1', 'm15'],
    shortSeries:    ['m5', 'm1'],
    equalThreshold: 0.2,
};

// ─── Core cascade check ────────────────────────────────────────────────────────
// seriesTFs: ordered longest → shortest, e.g. ['h4', 'h1', 'm15']
// emas:      { h4, h1, m15, m5, m1 } — actual EMA200 price values from board API
// Returns 'bull' | 'bear' | 'neutral'
export function checkCascade(emas, seriesTFs, threshold = 0.2) {
    if (!emas || !seriesTFs || seriesTFs.length < 2) return 'neutral';
    let isBull = true, isBear = true;
    let validPairs = 0;
    for (let i = 0; i < seriesTFs.length - 1; i++) {
        const emaLonger  = emas[seriesTFs[i]];
        const emaShorter = emas[seriesTFs[i + 1]];
        // Skip pairs where either TF has no data yet — don't let missing TFs
        // invalidate pairs that DO have data.
        if (!emaLonger || !emaShorter || emaLonger === 0) continue;
        validPairs++;
        const pctDiff = ((emaShorter - emaLonger) / emaLonger) * 100;
        if (pctDiff < -threshold) isBull = false;
        if (pctDiff >  threshold) isBear = false;
    }
    if (validPairs === 0) return 'neutral'; // no usable data at all
    if (isBull && !isBear) return 'bull';
    if (isBear && !isBull) return 'bear';
    return 'neutral';
}

// ─── ATR noise gate for counter-trend ─────────────────────────────────────────
// Returns true when the gap between the first and last EMA in shortSeries
// exceeds the coin's ATR(15m) in price terms — filters out noise moves.
export function passesAtrGate(emas, shortSeries, atrs, price) {
    if (!shortSeries || shortSeries.length === 0) return false;
    const emaFirst  = emas?.[shortSeries[0]];
    const emaLast   = emas?.[shortSeries[shortSeries.length - 1]];
    // If EMA data is missing for the short series, pass the gate — we have a
    // cascade direction signal but can't measure the gap, so don't suppress it.
    if (!emaFirst || !emaLast) return true;
    const atr15Pct = atrs?.m15 || 0;
    // If ATR data is missing, pass the gate — no noise floor to compare against.
    if (!atr15Pct) return true;
    const atrPrice = (price || 1) * (atr15Pct / 100);
    return Math.abs(emaFirst - emaLast) > atrPrice;
}

// ─── Classify a single board coin into one of 5 groups ────────────────────────
// Returns 'longBull' | 'longBear' | 'tempBull' | 'tempBear' | 'neutral'
export function classifyCoin(coin, longSeries, shortSeries, equalThreshold) {
    const { emas, atrs, price } = coin;
    if (!emas) return 'neutral';
    const longResult  = checkCascade(emas, longSeries,  equalThreshold);
    const shortResult = checkCascade(emas, shortSeries, equalThreshold);
    const atrGate     = passesAtrGate(emas, shortSeries, atrs, price);

    if (longResult === 'bull' && shortResult === 'bear' && atrGate) return 'tempBear';
    if (longResult === 'bear' && shortResult === 'bull' && atrGate) return 'tempBull';
    if (longResult === 'bull') return 'longBull';
    if (longResult === 'bear') return 'longBear';
    return 'neutral';
}

// ─── Settings validation ───────────────────────────────────────────────────────
// Returns { errors: string[], warnings: string[], isValid: bool }
export function validateCascadeSettings(longSeries, shortSeries) {
    const errors   = [];
    const warnings = [];

    // Rule 1 — long needs min 2
    if (!longSeries || longSeries.length < 2)
        errors.push('Long series needs at least 2 timeframes to define a cascade.');

    // Rule 2 — short needs min 1
    if (!shortSeries || shortSeries.length < 1)
        errors.push('Select at least 1 timeframe for the counter-trend series.');

    if (errors.length === 0) {
        // Rule 3 — no collision
        const collision = longSeries.filter(tf => shortSeries.includes(tf));
        if (collision.length > 0) {
            const names = collision.map(tf => TF_LABELS[tf]).join(', ');
            errors.push(
                `${names} appear in both series — remove from Long or Short before applying.`
            );
        }

        // Rule 4 — short TFs must be shorter than long's shortest TF
        const longShortestIdx  = Math.max(...longSeries.map(tf => TF_ORDER.indexOf(tf)));
        const shortInvalidTFs  = shortSeries.filter(
            tf => TF_ORDER.indexOf(tf) <= longShortestIdx
        );
        if (shortInvalidTFs.length > 0) {
            const longShortest = TF_LABELS[TF_ORDER[longShortestIdx]];
            const names = shortInvalidTFs.map(tf => TF_LABELS[tf]).join(', ');
            errors.push(
                `${names} must be shorter than the Long series end (${longShortest}). ` +
                `Move them to Long or remove them from Short.`
            );
        }
    }

    // Rule 5 — warn on non-sequential gaps in long series (allow but warn)
    if (longSeries && longSeries.length >= 2) {
        const sorted = [...longSeries].sort(
            (a, b) => TF_ORDER.indexOf(a) - TF_ORDER.indexOf(b)
        );
        for (let i = 0; i < sorted.length - 1; i++) {
            const aIdx = TF_ORDER.indexOf(sorted[i]);
            const bIdx = TF_ORDER.indexOf(sorted[i + 1]);
            if (bIdx - aIdx > 1) {
                const missing = TF_LABELS[TF_ORDER[aIdx + 1]];
                warnings.push(
                    `${TF_LABELS[sorted[i]]} → ${TF_LABELS[sorted[i + 1]]} skips ${missing}. ` +
                    `Cascade signal is stronger with ${missing} included.`
                );
            }
        }
    }

    return { errors, warnings, isValid: errors.length === 0 };
}

// ─── Load / save helpers ───────────────────────────────────────────────────────
const LS_CASCADE_SERIES_KEY = 'emaCascade_series';

export function loadCascadeSeries() {
    try {
        const raw = localStorage.getItem(LS_CASCADE_SERIES_KEY);
        if (!raw) return { ...CASCADE_SERIES_DEFAULTS };
        const saved = JSON.parse(raw);
        // Validate on load — if invalid, return defaults
        const { isValid } = validateCascadeSettings(saved.longSeries, saved.shortSeries);
        if (!isValid) return { ...CASCADE_SERIES_DEFAULTS };
        return {
            longSeries:     saved.longSeries     || CASCADE_SERIES_DEFAULTS.longSeries,
            shortSeries:    saved.shortSeries    || CASCADE_SERIES_DEFAULTS.shortSeries,
            equalThreshold: saved.equalThreshold ?? CASCADE_SERIES_DEFAULTS.equalThreshold,
        };
    } catch {
        return { ...CASCADE_SERIES_DEFAULTS };
    }
}

export function saveCascadeSeries(settings) {
    try {
        localStorage.setItem(LS_CASCADE_SERIES_KEY, JSON.stringify(settings));
    } catch {}
}

export function resetCascadeSeries() {
    try { localStorage.removeItem(LS_CASCADE_SERIES_KEY); } catch {}
    return { ...CASCADE_SERIES_DEFAULTS };
}
