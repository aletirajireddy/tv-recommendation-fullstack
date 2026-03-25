import React, { useMemo } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { TrendingUp, TrendingDown, Minus, Activity, Wifi } from 'lucide-react';
import GenieSmart from '../services/GenieSmart';
import TimeService from '../services/TimeService';
import styles from './HeaderStatsDeck.module.css';
import { MarketHeartbeatIndicator } from './AnalyticsWidgets/MarketHeartbeatIndicator';

export function HeaderStatsDeck() {
    // 1. CONSUME GENIE SMART STATE
    const activeScan = useTimeStore(s => s.activeScan);
    const marketMood = useTimeStore(s => s.marketMood);

    if (!activeScan) return <div className={styles.deckLoading}>Initialize...</div>;

    // USE GENIE MOOD (Single Source of Truth)
    const { moodScore, label: moodLabel, stats } = marketMood;

    // Dynamic Color
    let moodColor = 'var(--text-secondary)';
    if (moodLabel === 'BULLISH' || moodLabel === 'EUPHORIC') moodColor = 'var(--success)';
    else if (moodLabel === 'BEARISH' || moodLabel === 'PANIC') moodColor = 'var(--error)';
    else if (moodLabel === 'NEUTRAL') moodColor = 'var(--warning)';

    return (
        <div className={styles.deckContainer}>
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

                {/* 3. MARKET HEARTBEAT */}
                <div className={styles.card} style={{ flex: 1, minWidth: '350px', padding: '0', height: '64px', overflow: 'hidden' }}>
                    <MarketHeartbeatIndicator />
                </div>            <div className={styles.divider} />
            <TriStreamHealthCard />
            <div className={styles.divider} />
            <SystemTimeCard />
        </div>
    );
}

function TriStreamHealthCard() {
    const streamsHealth = useTimeStore(s => s.streamsHealth);

    // Status Engine (<30m Green, 30-120m Yellow, >120m Red)
    const getStatusParams = (isoString) => {
        if (!isoString) return { label: '--', color: 'var(--text-tertiary)', dot: '⚪' };
        
        const mins = (Date.now() - new Date(isoString).getTime()) / 60000;
        let diffStr = TimeService.timeAgo(isoString);
        
        // Strip out "AGO" for space conservation in the tight header block
        diffStr = diffStr.replace(/ AGO/i, '');

        if (mins < 30) return { label: diffStr, color: '#10B981', dot: '🟢' };
        if (mins <= 120) return { label: diffStr, color: '#FACC15', dot: '🟡' }; 
        return { label: diffStr, color: '#EF4444', dot: '🔴' }; 
    };

    const sA = getStatusParams(streamsHealth?.streamA);
    const sB = getStatusParams(streamsHealth?.streamB);
    const sC = getStatusParams(streamsHealth?.streamC);

    return (
        <div className={`${styles.card} ${styles.sectionSystem}`} style={{ minWidth: '200px', paddingRight: '12px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', fontSize: '10px', fontFamily: 'monospace', fontWeight: 700 }}>
                
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '3px' }}>
                    <span style={{ color: 'var(--text-tertiary)' }}>A: MACRO SCAN</span>
                    <span style={{ color: sA.color }}>{sA.dot} {sA.label}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '3px' }}>
                    <span style={{ color: 'var(--text-tertiary)' }}>B: SCOUT VELO</span>
                    <span style={{ color: sB.color }}>{sB.dot} {sB.label}</span>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-tertiary)' }}>C: INST ALERTS</span>
                    <span style={{ color: sC.color }}>{sC.dot} {sC.label}</span>
                </div>

            </div>
        </div>
    );
}

function SystemTimeCard() {
    const timeline = useTimeStore(s => s.timeline);
    const currentIndex = useTimeStore(s => s.currentIndex);
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
