import React, { useMemo } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { TrendingUp, TrendingDown, Minus, Activity, Wifi } from 'lucide-react';
import GenieSmart from '../services/GenieSmart';
import TimeService from '../services/TimeService';
import styles from './HeaderStatsDeck.module.css';
import { MarketHeartbeatIndicator } from './AnalyticsWidgets/MarketHeartbeatIndicator';
import { SpeedometerGauge } from './SpeedometerGauge';

export function HeaderStatsDeck() {
    // 1. CONSUME GENIE SMART STATE
    const activeScan = useTimeStore(s => s.activeScan);
    const marketMood = useTimeStore(s => s.marketMood);

    if (!activeScan) return <div className={styles.deckLoading}>Initialize...</div>;

    // USE GENIE MOOD (Single Source of Truth)
    const { moodScore, label: moodLabel, stats } = marketMood;

    // Dynamic Color
    let moodColor = 'var(--text-muted)';
    if (moodLabel === 'BULLISH' || moodLabel === 'EUPHORIC') moodColor = 'var(--accent-green)';
    else if (moodLabel === 'BEARISH' || moodLabel === 'PANIC') moodColor = 'var(--accent-red)';
    else if (moodLabel === 'NEUTRAL') moodColor = 'var(--warning)';

    return (
        <div className={styles.deckContainer}>
            {/* 1. MOOD GAUGE */}
                <div className={`${styles.card} ${styles.sectionMood}`}>
                    <SpeedometerGauge score={moodScore} label={moodLabel} />
                </div>

                <div className={styles.divider} />

                {/* 2. BREADTH */}
                <div className={`${styles.card} ${styles.sectionBreadth}`}>
                    <div className={styles.cardLabel}>BREADTH</div>
                    <div className={styles.breadthGrid}>
                        <div className={styles.breadthItem} style={{ color: 'var(--accent-green)' }}>
                            <TrendingUp size={14} /> {stats.bullish}
                        </div>
                        <div className={styles.breadthItem} style={{ color: 'var(--accent-red)' }}>
                            <TrendingDown size={14} /> {stats.bearish}
                        </div>
                    </div>
                </div>

                <div className={styles.divider} />

                {/* 3. MARKET HEARTBEAT */}
                <div className={styles.card} style={{ flex: 1, minWidth: '400px', padding: '0', height: '100%', overflow: 'hidden' }}>
                    <MarketHeartbeatIndicator />
                </div>            <div className={styles.divider} />
            <SystemHealthGrid />
            <div className={styles.divider} />
            <SystemTimeCard />
        </div>
    );
}

function SystemHealthGrid() {
    const streamsHealth = useTimeStore(s => s.streamsHealth);
    const timeline = useTimeStore(s => s.timeline);

    // Status Engine (<30m Green, 30-120m Yellow, >120m Red)
    const getStatusParams = (isoString) => {
        if (!isoString) return { label: '--', color: 'var(--text-muted)', dot: '⚪' };
        
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

    // Stream D: Overall System Liveness (based on the latest timeline entry)
    const latestScan = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    const sD = getStatusParams(latestScan?.timestamp);

    const GridItem = ({ title, status }) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.1)', padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.03)' }}>
            <span style={{ color: 'var(--text-muted)' }}>{title}</span>
            <span style={{ color: status.color, textShadow: `0 0 6px ${status.color}40` }}>{status.dot} {status.label}</span>
        </div>
    );

    return (
        <div className={`${styles.card} ${styles.sectionSystem}`} style={{ minWidth: '240px', paddingRight: '12px', justifyContent: 'center' }}>
            <div style={{ 
                display: 'grid', 
                gridTemplateColumns: '1fr 1fr', 
                gap: '6px 12px', 
                width: '100%', 
                fontSize: '10px', 
                fontFamily: 'JetBrains Mono, monospace', 
                fontWeight: 800,
                letterSpacing: '0.5px'
            }}>
                <GridItem title="A:MACRO" status={sA} />
                <GridItem title="B:SCOUT" status={sB} />
                <GridItem title="C:ALERT" status={sC} />
                <GridItem title="D:SYNC" status={sD} />
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

    // Depth calculation
    const getDepth = () => {
        if (timeline.length < 2) return '--';
        const ms = new Date(timeline[timeline.length - 1].timestamp) - new Date(timeline[0].timestamp);
        const h = ms / 3600000;
        return h > 48 ? `${Math.round(h/24)}d` : `${h.toFixed(1)}h`;
    };

    return (
        <div className={`${styles.card} ${styles.sectionSystem}`}>
            <div className={styles.cardLabel} style={{ justifyContent: 'flex-end', gap: '8px' }}>
                <span style={{ opacity: 0.6 }}>REPLAY ENG</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: "var(--accent-blue)" }}>
                    <Activity size={12} strokeWidth={3} />
                    LIVE
                </span>
            </div>
            <div className={styles.timeDisplay} style={{ alignItems: 'flex-end' }}>
                <div className={styles.timeRow}>
                    <span className={styles.timeLabel}>DEPTH:</span>
                    <span className={styles.timeValueSmall} style={{ color: 'var(--text-muted)' }}>{getDepth()}</span>
                </div>
                <div className={styles.timeRow}>
                    <span className={styles.timeLabel}>REPLAY:</span>
                    <span className={styles.timeValueMain}>{scanTimeStr}</span>
                </div>
            </div>
        </div>
    );
}
