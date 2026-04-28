import React from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { LevelReactionWidget } from './AnalyticsWidgets/LevelReactionWidget';
import { EMACascadeMonitor } from './AnalyticsWidgets/EMACascadeMonitor';
import { DistanceTracker } from './AnalyticsWidgets/DistanceTracker';
import styles from './SelectionDrawer.module.css';

export const SelectionDrawer = () => {
    const ticker = useTimeStore(s => s.selectedTicker);
    const setTicker = useTimeStore(s => s.setSelectedTicker);

    if (!ticker) return null;

    return (
        <div className={styles.drawerOverlay} onClick={() => setTicker(null)}>
            <div className={styles.drawer} onClick={e => e.stopPropagation()}>
                <div className={styles.header}>
                    <div className={styles.titleGroup}>
                        <span className={styles.titlePrefix}>Technical Toolbox</span>
                        <h2 className={styles.tickerName}>{ticker}</h2>
                    </div>
                    <button className={styles.closeBtn} onClick={() => setTicker(null)}>✕</button>
                </div>

                <div className={styles.content}>
                    {/* Filtered Widgets - These widgets should ideally accept a ticker prop to filter their view */}
                    <div className={styles.widgetBox}>
                        <LevelReactionWidget filterTicker={ticker} compact />
                    </div>
                    <div className={styles.widgetBox}>
                        <EMACascadeMonitor filterTicker={ticker} compact />
                    </div>
                    <div className={styles.widgetBox}>
                        <DistanceTracker filterTicker={ticker} compact />
                    </div>
                </div>
            </div>
        </div>
    );
};
