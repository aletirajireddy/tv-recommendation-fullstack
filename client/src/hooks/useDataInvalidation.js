import { useEffect, useRef } from 'react';

/**
 * Module-level stagger queue.
 * Off-screen widgets that become visible all at once are spread 150ms apart
 * so the backend never gets a simultaneous flood.
 */
let _queue = [];
let _timer = null;

function _flush() {
    if (_queue.length === 0) { _timer = null; return; }
    const fn = _queue.shift();
    try { fn(); } catch { /* noop */ }
    _timer = setTimeout(_flush, 150);
}

function _enqueue(fn) {
    _queue.push(fn);
    if (!_timer) _timer = setTimeout(_flush, 50);
}

/**
 * useDataInvalidation — viewport-priority silent reload hook.
 *
 * Watches `invalidateOn` (a monotonic timestamp from useTimeStore.lastDataPush).
 * When the signal bumps:
 *   - widget root is visible in the viewport → calls `reloadFn` immediately
 *   - widget root is off-screen              → marks as stale; deferred reload
 *                                              fires via stagger queue when the
 *                                              element next enters the viewport
 *
 * Usage:
 *   const containerRef = useRef(null);
 *   const { reloadSilent } = usePolledFetch(...);
 *   useDataInvalidation(containerRef, reloadSilent, lastDataPush);
 *   return <div ref={containerRef} ...>...</div>;
 *
 * @param {React.RefObject<Element>} containerRef  - root element ref
 * @param {function}                 reloadFn      - silent reload callback
 * @param {number|null}              invalidateOn  - monotonic timestamp signal
 */
export function useDataInvalidation(containerRef, reloadFn, invalidateOn) {
    const pendingRef = useRef(false);   // stale while off-screen
    const visibleRef = useRef(false);   // current viewport intersection state
    const reloadRef  = useRef(reloadFn);
    reloadRef.current = reloadFn;       // always up-to-date without re-running effects

    // ── Track viewport intersection ─────────────────────────────────────────
    useEffect(() => {
        const el = containerRef?.current;

        // Fallback for SSR or missing IntersectionObserver
        if (!el || typeof IntersectionObserver === 'undefined') {
            visibleRef.current = true;
            return;
        }

        const obs = new IntersectionObserver(([entry]) => {
            visibleRef.current = entry.isIntersecting;

            // Drain pending stale state the moment the element enters the viewport
            if (entry.isIntersecting && pendingRef.current) {
                pendingRef.current = false;
                _enqueue(() => reloadRef.current());
            }
        }, {
            rootMargin: '0px',
            threshold: 0.05, // 5 % of the element must be visible
        });

        obs.observe(el);
        return () => obs.disconnect();
    // containerRef.current is stable by convention; lint suppressed intentionally
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── React to invalidation signal ────────────────────────────────────────
    useEffect(() => {
        if (!invalidateOn) return; // 0 / null → ignore initial mount value

        if (visibleRef.current) {
            // Visible: refresh immediately (no spinner, keeps stale data shown)
            reloadRef.current();
        } else {
            // Off-screen: mark as stale — will reload when it scrolls into view
            pendingRef.current = true;
        }
    // invalidateOn intentionally the only dep
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [invalidateOn]);
}

export default useDataInvalidation;
