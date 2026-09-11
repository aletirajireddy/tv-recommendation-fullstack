import { useMemo, useCallback } from 'react';
import { useTimeStore } from '../store/useTimeStore';

/**
 * Global "active coin mask" — when enabled, restricts per-coin widgets to
 * only the tickers present in the current/latest Stream A scan
 * (`activeScan.results[].ticker`). Toggled from the eye icon in GlobalHeader.
 *
 * Every candidate widget's own endpoint already returns `ticker` in the same
 * exchange-suffixed form as Stream A (e.g. "BTCUSDT.P"), so a plain
 * Set.has(ticker) works with no per-widget format translation.
 */
export function useActiveCoinMask() {
    const enabled = useTimeStore(s => s.coinMaskEnabled);
    const activeScan = useTimeStore(s => s.activeScan);

    const activeTickers = useMemo(
        () => new Set((activeScan?.results || []).map(r => r.ticker)),
        [activeScan]
    );

    const isActive = useCallback(
        (ticker) => !enabled || activeTickers.has(ticker),
        [enabled, activeTickers]
    );

    return { enabled, activeTickers, isActive };
}

export default useActiveCoinMask;
