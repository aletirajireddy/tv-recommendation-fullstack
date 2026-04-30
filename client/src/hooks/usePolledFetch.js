import { useEffect, useRef, useState, useCallback } from 'react';

/**
 * usePolledFetch — performance-audit fixes consolidated:
 *   • Ref-pattern fetcher so the polling interval is created ONCE and never
 *     torn down on dependency changes (eliminates "duplicate fetch on every
 *     control click" + "interval recreation churn").
 *   • AbortController per call. Stale in-flight requests from rapid window
 *     changes are cancelled — prevents race-set state from late responses.
 *   • Auto-pause when document.hidden via Page Visibility API. Tabs in the
 *     background stop hammering the backend; resumes with an immediate
 *     refresh on visibility change.
 *   • Silent reload mode: when `silent=true` the loading flag is NOT set to
 *     true — existing stale data stays visible while the background refresh
 *     completes. Used by socket-triggered reloads to prevent spinner flicker.
 *
 * Usage:
 *   const { data, loading, error, reload, reloadSilent } = usePolledFetch(
 *     () => `/api/foo?ticker=${ticker}&window=${windowMin}`,
 *     { intervalMs: 60000, deps: [ticker, windowMin] }
 *   );
 *   // call reloadSilent() from socket handlers — keeps stale data visible
 *
 * @param {() => string | string[] | Promise<any>} fetcher
 *        - if returns string: fetched as JSON
 *        - if returns array: fetched in parallel, results array returned
 *        - if returns a Promise: awaited as-is
 * @param {object} opts
 * @param {number} opts.intervalMs       polling cadence; 0 = no polling
 * @param {Array}  opts.deps             reload-trigger deps (like useEffect)
 * @param {boolean}opts.pauseOnHidden    default true
 * @param {boolean}opts.refetchOnVisible default true
 */
export function usePolledFetch(fetcher, {
    intervalMs = 60_000,
    deps = [],
    pauseOnHidden = true,
    refetchOnVisible = true,
    invalidateOn = null, // external signal: when this value changes, do a silent reload
} = {}) {
    const [data, setData]       = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError]     = useState(null);

    // Ref pattern — fetcher closure can change every render without
    // recreating the polling interval.
    const fetcherRef = useRef(fetcher);
    fetcherRef.current = fetcher;
    const abortRef    = useRef(null);
    const mountedRef  = useRef(true);

    // Core fetch logic — silent=true skips the loading flag so stale data
    // stays visible during a background refresh (e.g. socket-triggered reload).
    const doFetch = useCallback(async (silent = false) => {
        // Cancel any in-flight request from previous call
        if (abortRef.current) abortRef.current.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;

        if (!silent) setLoading(true);
        setError(null);
        try {
            const result = fetcherRef.current(ctrl.signal);
            let payload;
            if (typeof result === 'string') {
                const r = await fetch(result, { signal: ctrl.signal });
                payload = await r.json();
            } else if (Array.isArray(result)) {
                payload = await Promise.all(
                    result.map(u => fetch(u, { signal: ctrl.signal }).then(r => r.json()))
                );
            } else {
                payload = await result;
            }
            if (!mountedRef.current || ctrl.signal.aborted) return;
            if (payload?.error) setError(payload.error);
            else setData(payload);
        } catch (e) {
            if (e.name === 'AbortError') return;          // expected on unmount/dep-change
            if (!mountedRef.current) return;
            setError(e.message || String(e));
        } finally {
            if (!silent && mountedRef.current && !ctrl.signal.aborted) setLoading(false);
        }
    }, []); // stable — uses ref

    /** Force-reload with loading indicator (for user-initiated refreshes) */
    const reload        = useCallback(() => doFetch(false), [doFetch]);
    /** Background reload — keeps stale data visible, no spinner (socket handlers) */
    const reloadSilent  = useCallback(() => doFetch(true),  [doFetch]);

    // Trigger reload when deps change (initial + on user-driven inputs)
    /* eslint-disable react-hooks/exhaustive-deps */
    useEffect(() => { reload(); }, deps);
    /* eslint-enable react-hooks/exhaustive-deps */

    // External invalidation signal — fires a silent reload without a spinner.
    // Callers pass lastDataPush from useTimeStore; widgets that are visible react
    // immediately, background-tab pause is already handled by pauseOnHidden.
    /* eslint-disable react-hooks/exhaustive-deps */
    useEffect(() => {
        if (!invalidateOn) return; // 0 / null → skip
        reloadSilent();
    }, [invalidateOn]);
    /* eslint-enable react-hooks/exhaustive-deps */

    // Polling interval — created once, never torn down on dep changes.
    useEffect(() => {
        mountedRef.current = true;
        if (!intervalMs) return undefined;

        let timer = null;
        const start = () => {
            if (timer) return;
            timer = setInterval(() => {
                if (pauseOnHidden && document.hidden) return;
                reloadSilent(); // background poll — no spinner
            }, intervalMs);
        };
        const stop = () => {
            if (timer) { clearInterval(timer); timer = null; }
        };

        const onVisibility = () => {
            if (document.hidden) {
                stop();
            } else {
                if (refetchOnVisible) reloadSilent(); // tab restored — silent too
                start();
            }
        };

        if (!pauseOnHidden || !document.hidden) start();
        if (pauseOnHidden) document.addEventListener('visibilitychange', onVisibility);

        return () => {
            mountedRef.current = false;
            stop();
            if (pauseOnHidden) document.removeEventListener('visibilitychange', onVisibility);
            if (abortRef.current) abortRef.current.abort();
        };
    }, [intervalMs, pauseOnHidden, refetchOnVisible, reloadSilent]);

    return { data, loading, error, reload, reloadSilent };
}

export default usePolledFetch;
