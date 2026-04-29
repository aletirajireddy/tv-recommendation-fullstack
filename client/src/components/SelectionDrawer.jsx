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
                <div className={styles.header}>
                    <div className={styles.titleGroup}>
                        <div className="flex items-center gap-2">
                            <LayoutDashboard size={16} className="text-accent-blue" />
                            <span className={styles.titlePrefix}>Technical Toolbox</span>
                        </div>
                        <h2 className={styles.tickerName}>{ticker}</h2>
                    </div>
                    <button className={styles.closeBtn} onClick={() => setTicker(null)}>
                        <X size={20} />
                    </button>
                </div>

                <div className={styles.content}>
                    {/* Filtered Widgets - These widgets should ideally accept a ticker prop to filter their view */}
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
                </div>
            </div>
        </div>
    );
};
