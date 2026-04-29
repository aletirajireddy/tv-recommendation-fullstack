import React, { Suspense, useEffect, useRef, useState } from 'react';

/**
 * LazyWidget — Proactive viewport-threshold preloader
 *
 * Wraps a React.lazy()-imported component and only mounts it when the
 * placeholder enters the viewport (or comes within `rootMargin`). This:
 *   1. Defers initial bundle parse / network hydration of off-screen widgets
 *   2. Preloads slightly ahead of scroll so users never see a "flash of skeleton"
 *   3. Keeps a stable layout via a min-height skeleton (zero CLS)
 *
 * Usage:
 *   const Foo = React.lazy(() => import('./Foo'));
 *   <LazyWidget minHeight={400}><Foo /></LazyWidget>
 *
 * Architecture notes:
 * - Uses IntersectionObserver with a generous rootMargin so the chunk fetch
 *   begins ~one viewport before the widget actually renders.
 * - On first intersection we set mounted=true and disconnect the observer
 *   (one-shot — we never want to unmount and re-fetch).
 * - SSR / no-IO-support fallback: render immediately.
 */
export function LazyWidget({
    children,
    minHeight = 320,
    rootMargin = '400px 0px',  // preload one viewport ahead
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

        const io = new IntersectionObserver(
            (entries) => {
                if (entries.some(e => e.isIntersecting)) {
                    setShouldRender(true);
                    io.disconnect();
                }
            },
            { rootMargin, threshold }
        );
        io.observe(node);

        return () => io.disconnect();
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
