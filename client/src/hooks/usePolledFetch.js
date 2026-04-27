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
 *
 * Usage:
 *   const { data, loading, error, reload } = usePolledFetch(
 *     // build url(s) lazily so changing inputs don't recreate the fetcher
 *     () => `/api/foo?ticker=${ticker}&window=${windowMin}`,
 *     { intervalMs: 60000, deps: [ticker, windowMin] }
 *   );
 *
 * Pass a function instead of a fetch result to keep the closure tight.
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

    const reload = useCallback(async () => {
        // Cancel any in-flight request from previous call
        if (abortRef.current) abortRef.current.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;

        setLoading(true);
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
            if (mountedRef.current && !ctrl.signal.aborted) setLoading(false);
        }
    }, []); // stable — uses ref

    // Trigger reload when deps change (initial + on user-driven inputs)
    /* eslint-disable react-hooks/exhaustive-deps */
    useEffect(() => { reload(); }, deps);
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
                reload();
            }, intervalMs);
        };
        const stop = () => {
            if (timer) { clearInterval(timer); timer = null; }
        };

        const onVisibility = () => {
            if (document.hidden) {
                stop();
            } else {
                if (refetchOnVisible) reload();
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
    }, [intervalMs, pauseOnHidden, refetchOnVisible, reload]);

    return { data, loading, error, reload };
}

export default usePolledFetch;
