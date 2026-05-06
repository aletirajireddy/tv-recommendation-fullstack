import React, { lazy, Suspense } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { X, LayoutDashboard } from 'lucide-react';
import styles from './SelectionDrawer.module.css';

// Lazy: drawer only opens on user action — no need to ship these on first paint.
// Keeping the same chunks the App.jsx LazyWidgets use means the second open is free.
const LevelReactionWidget = lazy(() =>
    import('./AnalyticsWidgets/LevelReactionWidget').then(m => ({ default: m.LevelReactionWidget }))
);
const EMACascadeMonitor = lazy(() =>
    import('./AnalyticsWidgets/EMACascadeMonitor').then(m => ({ default: m.EMACascadeMonitor }))
);
// Re-introduced for single-coin view per user request — was previously commented out.
// Filtered to the selected ticker so the table is short and immediately useful.
const DistanceTracker = lazy(() =>
    import('./AnalyticsWidgets/DistanceTracker').then(m => ({ default: m.default || m.DistanceTracker }))
);

const DrawerFallback = () => (
    <div style={{ padding: 16, color: 'var(--text-muted)', fontSize: 12 }}>Loading…</div>
);

export const SelectionDrawer = () => {
    const ticker = useTimeStore(s => s.selectedTicker);
    const setTicker = useTimeStore(s => s.setSelectedTicker);

    if (!ticker) return null;

    return (
        <div className={styles.drawerOverlay} onClick={() => setTicker(null)}>
            <div className={styles.drawer} onClick={e => e.stopPropagation()}>
                {/* Compact single-line header — saves ~28px vertical space so charts
                    inside the scrollable body get a taller render box and don't clip. */}
                <div className={styles.header}>
                    <div className={styles.titleGroup}>
                        <LayoutDashboard size={14} className="text-accent-blue" />
                        <span className={styles.titlePrefix}>Toolbox</span>
                        <span className={styles.titleSep}>·</span>
                        <h2 className={styles.tickerName}>{ticker}</h2>
                    </div>
                    <button className={styles.closeBtn} onClick={() => setTicker(null)} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className={styles.content}>
                    {/* widgetBox no longer clips children — see CSS — so any chart that
                        renders taller than its initial estimate (Recharts ResponsiveContainer
                        on first paint) can grow without cropping. */}
                    <div className={styles.widgetBox}>
                        <Suspense fallback={<DrawerFallback />}>
                            <LevelReactionWidget filterTicker={ticker} compact />
                        </Suspense>
                    </div>
                    <div className={styles.widgetBox}>
                        <Suspense fallback={<DrawerFallback />}>
                            <EMACascadeMonitor filterTicker={ticker} compact />
                        </Suspense>
                    </div>
                    <div className={styles.widgetBox}>
                        <Suspense fallback={<DrawerFallback />}>
                            <DistanceTracker filterTicker={ticker} compact />
                        </Suspense>
                    </div>
                </div>
            </div>
        </div>
    );
};
