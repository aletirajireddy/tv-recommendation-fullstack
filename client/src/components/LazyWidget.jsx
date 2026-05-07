import React, { Suspense, useEffect, useRef, useState } from 'react';

/**
 * LazyWidget — Proactive viewport-threshold preloader with mount stagger.
 *
 * Wraps a React.lazy()-imported component and only mounts it when the
 * placeholder enters the viewport (or comes within `rootMargin`). This:
 *   1. Defers initial bundle parse / network hydration of off-screen widgets
 *   2. Preloads slightly ahead of scroll so users never see a "flash of skeleton"
 *   3. Keeps a stable layout via a min-height skeleton (zero CLS)
 *
 * Initial-load freeze fix (May 2026):
 * On first paint, the IntersectionObserver fires for every widget already in
 * the near-viewport zone in the SAME tick — meaning 4–6 widgets would all
 * simultaneously download chunks, parse Recharts (~200KB), initialize chart
 * instances, and fire backend fetches. Result: ~1 min main-thread freeze on
 * page load. Two changes mitigate this with zero data-flow side effects:
 *
 *   1. Smaller default rootMargin (100px vs 400px) — drastically reduces the
 *      number of widgets that enter "near viewport" simultaneously. Off-screen
 *      widgets still load fine when the user scrolls toward them.
 *
 *   2. Module-scope mount queue — when multiple LazyWidgets become visible in
 *      the same IO tick, their mounts are spread across animation frames
 *      (~16ms each) instead of all firing in the same paint. The user-visible
 *      effect is identical (instant mount on intersection); the difference is
 *      that chunk-parse cost is amortised across frames instead of one giant
 *      blocking burst.
 */

// Module-scope mount queue — spreads simultaneous intersections across frames.
// Keeps things simple: a FIFO of pending mount callbacks, drained one per RAF.
let _mountQueue = [];
let _mountRafScheduled = false;
const _drainMountQueue = () => {
    _mountRafScheduled = false;
    if (_mountQueue.length === 0) return;
    const cb = _mountQueue.shift();
    try { cb(); } catch { /* swallow — host component will handle render error */ }
    if (_mountQueue.length > 0) {
        _mountRafScheduled = true;
        // requestAnimationFrame keeps mounts aligned with paint; falls back to
        // setTimeout for non-browser environments (test runners).
        if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(_drainMountQueue);
        else setTimeout(_drainMountQueue, 16);
    }
};
const _enqueueMount = (cb) => {
    _mountQueue.push(cb);
    if (_mountRafScheduled) return;
    _mountRafScheduled = true;
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(_drainMountQueue);
    else setTimeout(_drainMountQueue, 16);
};

export function LazyWidget({
    children,
    minHeight = 320,
    rootMargin = '100px 0px',  // small preload buffer — see freeze-fix notes above
    threshold = 0,
    fallback,
    placeholderClassName,
    placeholderStyle,
}) {
    const ref = useRef(null);
    const [shouldRender, setShouldRender] = useState(
        typeof window === 'undefined' || typeof IntersectionObserver === 'undefined'
    );

    useEffect(() => {
        if (shouldRender) return;
        const node = ref.current;
        if (!node) return;

        let cancelled = false;
        const io = new IntersectionObserver(
            (entries) => {
                if (entries.some(e => e.isIntersecting)) {
                    io.disconnect();
                    // Defer the actual mount through the global queue so that
                    // when 5+ widgets intersect in the same tick (e.g. on first
                    // paint), they don't all parse chunks and init charts in
                    // the same frame.
                    _enqueueMount(() => {
                        if (!cancelled) setShouldRender(true);
                    });
                }
            },
            { rootMargin, threshold }
        );
        io.observe(node);

        return () => {
            cancelled = true;
            io.disconnect();
        };
    }, [shouldRender, rootMargin, threshold]);

    const skeleton = fallback ?? (
        <div
            className={placeholderClassName}
            style={{
                width: '100%',
                minHeight,
                borderRadius: 8,
                background:
                    'linear-gradient(90deg, rgba(255,255,255,0.02) 0%, rgba(255,255,255,0.05) 50%, rgba(255,255,255,0.02) 100%)',
                backgroundSize: '200% 100%',
                animation: 'lazyShimmer 1.6s ease-in-out infinite',
                border: '1px solid rgba(255,255,255,0.04)',
                ...placeholderStyle,
            }}
            aria-busy="true"
            aria-label="Loading widget"
        />
    );

    if (!shouldRender) {
        return (
            <div ref={ref} style={{ width: '100%', minHeight }}>
                {skeleton}
            </div>
        );
    }

    return <Suspense fallback={skeleton}>{children}</Suspense>;
}

// Inject keyframes once (module-level, idempotent)
if (typeof document !== 'undefined' && !document.getElementById('lazy-widget-keyframes')) {
    const style = document.createElement('style');
    style.id = 'lazy-widget-keyframes';
    style.textContent = `@keyframes lazyShimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
    }`;
    document.head.appendChild(style);
}

export default LazyWidget;
