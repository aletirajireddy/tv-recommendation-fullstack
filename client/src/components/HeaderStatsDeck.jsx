import React, { useMemo } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { TrendingUp, TrendingDown, Minus, Activity, Wifi } from 'lucide-react';
import GenieSmart from '../services/GenieSmart';
import TimeService from '../services/TimeService';
import styles from './HeaderStatsDeck.module.css';

export function HeaderStatsDeck() {
    // 1. CONSUME GENIE SMART STATE
    const { activeScan, setMonitorModalOpen, marketMood } = useTimeStore();

    // Memoize Derived Lists for Performance
    const { opportunities, watchlist, movers } = useMemo(() => {
        if (!activeScan || !activeScan.results) return { opportunities: [], watchlist: [], movers: [] };

        const results = activeScan.results;

        // A. Opportunities (Strategies Detected)
        const opps = [];
        const watches = [];

        results.forEach(r => {
            const strategies = GenieSmart.deriveStrategies(r);
            if (strategies.length > 0) {
                opps.push({ ...r, matchedStrategies: strategies.map(s => s.label || s.name) });
            } else if (r.bias && r.bias !== 'NEUTRAL') {
                // B. Watchlist (Direction but no explicit strategy)
                watches.push(r);
            }
        });

        // C. Top Movers (Abs Strength)
        const topMovers = [...results]
            .sort((a, b) => Math.abs(b.strength || b.netTrend || 0) - Math.abs(a.strength || a.netTrend || 0))
            .slice(0, 3);

        return { opportunities: opps, watchlist: watches, movers: topMovers };

    }, [activeScan]);

    if (!activeScan) return <div className={styles.deckLoading}>Initialize scan...</div>;

    // USE GENIE MOOD (Single Source of Truth)
    const { moodScore, label: moodLabel, stats } = marketMood;

    // Dynamic Color
    let moodColor = 'var(--text-secondary)';
    if (moodLabel === 'BULLISH' || moodLabel === 'EUPHORIC') moodColor = 'var(--success)';
    else if (moodLabel === 'BEARISH' || moodLabel === 'PANIC') moodColor = 'var(--error)';
    else if (moodLabel === 'NEUTRAL') moodColor = 'var(--warning)';

    // Dynamic List Selection
    let listLabel = 'TOP MOVERS';
    let listData = [];
    let listType = 'movers';

    if (opportunities.length > 0) {
        listLabel = `GENIE OPPS (${opportunities.length})`;
        listData = opportunities;
        listType = 'opportunities';
    } else if (watchlist.length > 0) {
        listLabel = `WATCHLIST (${watchlist.length})`;
        listData = watchlist.slice(0, 4);
        listType = 'watchlist';
    } else {
        listLabel = 'TOP MOVERS';
        listData = movers;
        listType = 'movers';
    }

    return (
        <div className={styles.deckContainer}>
            {/* CLICKABLE ZONE */}
            <div className={styles.interactiveZone} onClick={() => setMonitorModalOpen(true)}>

                {/* 1. MOOD */}
                <div className={`${styles.card} ${styles.sectionMood}`}>
                    <div className={styles.cardLabel}>GENIE MOOD</div>
                    <div className={`${styles.moodDisplay} ${styles.animatedValue}`} style={{ color: moodColor }}>
                        <Activity size={18} strokeWidth={2.5} />
                        <span className={styles.moodValue}>{moodLabel}</span>
                        <span className={styles.moodScore}>{moodScore > 0 ? '+' : ''}{moodScore}</span>
                    </div>
                </div>

                <div className={styles.divider} />

                {/* 2. BREADTH */}
                <div className={`${styles.card} ${styles.sectionBreadth}`}>
                    <div className={styles.cardLabel}>BREADTH</div>
                    <div className={styles.breadthGrid}>
                        <div className={styles.breadthItem} style={{ color: 'var(--success)' }}>
                            <TrendingUp size={14} /> {stats.bullish}
                        </div>
                        <div className={styles.breadthItem} style={{ color: 'var(--error)' }}>
                            <TrendingDown size={14} /> {stats.bearish}
                        </div>
                        <div className={styles.breadthItem} style={{ color: 'var(--text-tertiary)' }}>
                            <Minus size={14} /> {stats.neutral}
                        </div>
                    </div>
                </div>

                <div className={styles.divider} />

                {/* 3. DYNAMIC LIST */}
                <div className={`${styles.card} ${styles.sectionMovers}`}>
                    <div className={styles.cardLabel} style={{ color: listType === 'opportunities' ? 'var(--success)' : 'var(--text-secondary)' }}>
                        {listLabel}
                    </div>
                    <div className={styles.moversList}>
                        {listData.map((m, i) => (
                            <div key={i} className={styles.moverItem}>
                                <span style={{ fontWeight: 800, minWidth: '60px' }}>{m.ticker}</span>
                                {listType === 'opportunities' && (
                                    <span className={styles.strategyTag}>{m.matchedStrategies[0]}</span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className={styles.divider} />
            <SystemTimeCard />
        </div>
    );
}

function SystemTimeCard() {
    const { timeline, currentIndex } = useTimeStore();
    const currentScan = timeline[currentIndex];

    // System Status (latest received data) vs View Status (current scan)
    const latestScan = timeline.length > 0 ? timeline[timeline.length - 1] : null;

    // Time Normalization (Rule #8)
    const scanTimeStr = currentScan ? TimeService.formatTime(currentScan.timestamp) : '--:--:--';

    // "Ago" should always reflect SYSTEM LIVENESS (Latest packet), not Replay Position
    const relativeTime = latestScan ? TimeService.timeAgo(latestScan.timestamp) : '';

    // Window calculation
    const startTime = timeline.length > 0 ? TimeService.formatDateTime(timeline[0].timestamp) : '--';
    const latestTimeStr = latestScan ? TimeService.formatTime(latestScan.timestamp) : '--'; // Renamed variable to avoid conflict

    return (
        <div className={`${styles.card} ${styles.sectionSystem}`}>
            <div className={styles.cardLabel} style={{ justifyContent: 'flex-end', gap: '8px' }}>
                <span style={{ opacity: 0.6 }}>SYSTEM STATUS</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: "var(--success)" }}>
                    <Wifi size={12} strokeWidth={3} />
                    {relativeTime}
                </span>
            </div>
            <div className={styles.timeDisplay} style={{ alignItems: 'flex-end' }}>
                <div className={styles.timeRow}>
                    <span className={styles.timeLabel}>WINDOW:</span>
                    <span className={styles.timeValueSmall}>{startTime} - {latestTimeStr}</span>
                </div>
                <div className={styles.timeRow}>
                    <span className={styles.timeLabel}>REPLAY:</span>
                    <span className={styles.timeValueMain}>{scanTimeStr}</span>
                </div>
            </div>
        </div>
    );
}
