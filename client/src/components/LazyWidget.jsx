import React, { Suspense, useEffect, useRef, useState } from 'react';

/**
 * LazyWidget — Viewport-threshold preloader with mount stagger.
 *
 * Wraps a React.lazy()-imported component and only mounts it when the
 * placeholder enters the viewport (or comes within `rootMargin`). This:
 *   1. Defers initial bundle parse / network hydration of off-screen widgets
 *   2. Preloads slightly ahead of scroll so users never see a flash of skeleton
 *   3. Keeps a stable layout via a min-height skeleton (zero CLS)
 *
 * rootMargin is intentionally small (100px, not 400px).
 * With 400px, on first paint 4-6 widgets simultaneously enter the "near
 * viewport" zone, triggering parallel chunk downloads, Recharts parse, chart
 * init, and backend fetches all in one frame — freezing the main thread.
 * 100px means only widgets genuinely close to the viewport preload; the rest
 * hydrate naturally as the user scrolls toward them.
 *
 * Mount stagger queue: when multiple LazyWidgets intersect in the same
 * IntersectionObserver tick (e.g. on first paint), their mounts are spread
 * across requestAnimationFrame callbacks (~16ms each) instead of firing in
 * one blocking burst. Visually identical — the difference is the chunk-parse
 * cost is amortised across frames rather than one giant spike.
 */

// Module-scope mount queue — one mount per animation frame when multiple
// widgets intersect simultaneously (e.g. initial page load).
let _mountQueue = [];
let _rafPending = false;

const _drain = () => {
    _rafPending = false;
    if (_mountQueue.length === 0) return;
    const cb = _mountQueue.shift();
    try { cb(); } catch (_) { /* host component handles render errors */ }
    if (_mountQueue.length > 0) {
        _rafPending = true;
        if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(_drain);
        else setTimeout(_drain, 16);
    }
};

const _enqueue = (cb) => {
    _mountQueue.push(cb);
    if (_rafPending) return;
    _rafPending = true;
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(_drain);
    else setTimeout(_drain, 16);
};

export function LazyWidget({
    children,
    minHeight = 320,
    rootMargin = '100px 0px',
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
                    _enqueue(() => { if (!cancelled) setShouldRender(true); });
                }
            },
            { rootMargin, threshold }
        );
        io.observe(node);

        return () => { cancelled = true; io.disconnect(); };
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

// Inject shimmer keyframes once (idempotent)
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
