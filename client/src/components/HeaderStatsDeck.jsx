import React, { lazy, Suspense, useMemo } from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { TrendingUp, TrendingDown, Minus, Activity, Wifi } from 'lucide-react';
import GenieSmart from '../services/GenieSmart';
import TimeService from '../services/TimeService';
import styles from './HeaderStatsDeck.module.css';
import { SpeedometerGauge } from './SpeedometerGauge';

// Lazy-load so Recharts (~200KB) ships in a separate chunk and does NOT block
// the initial JS parse. The header paints immediately with mood/breadth/health;
// the heartbeat chart hydrates in the background once Recharts arrives.
const MarketHeartbeatIndicator = lazy(() =>
    import('./AnalyticsWidgets/MarketHeartbeatIndicator').then(m => ({ default: m.MarketHeartbeatIndicator }))
);

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

                {/* 3. MARKET HEARTBEAT — Recharts in separate chunk, fallback=null so
                    the header height stays fixed while the chart hydrates. */}
                <div className={`${styles.card} ${styles.sectionHeartbeat}`}>
                    <Suspense fallback={null}>
                        <MarketHeartbeatIndicator />
                    </Suspense>
                </div>
            <div className={styles.divider} />
            <SystemHealthGrid />
            <div className={styles.divider} />
            <SystemTimeCard />
        </div>
    );
}

/** Pure-CSS status dot — no emoji, no layout reflow, no extra paint */
function StatusDot({ color }) {
    return (
        <span style={{
            display: 'inline-block',
            width: 7, height: 7,
            borderRadius: '50%',
            background: color,
            boxShadow: `0 0 5px ${color}99`,
            flexShrink: 0,
        }} />
    );
}

function SystemHealthGrid() {
    const streamsHealth = useTimeStore(s => s.streamsHealth);
    const timeline      = useTimeStore(s => s.timeline);

    // Status params: <30m green · 30-120m yellow · >120m red
    const getStatusParams = (isoString) => {
        if (!isoString) return { label: '--', color: 'var(--text-muted)' };
        const mins = (Date.now() - new Date(isoString).getTime()) / 60000;
        const label = TimeService.timeAgo(isoString);   // "now" | "2m ago" | …
        if (mins < 30)  return { label, color: '#10B981' };
        if (mins <= 120) return { label, color: '#FACC15' };
        return { label, color: '#EF4444' };
    };

    const sA = getStatusParams(streamsHealth?.streamA);
    const sB = getStatusParams(streamsHealth?.streamB);
    const sC = getStatusParams(streamsHealth?.streamC);
    const latestScan = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    const sD = getStatusParams(latestScan?.timestamp);

    const streams = [
        { key: 'A', title: 'A:MACRO', s: sA },
        { key: 'B', title: 'B:SCOUT', s: sB },
        { key: 'C', title: 'C:ALERT', s: sC },
        { key: 'D', title: 'D:SYNC',  s: sD },
    ];

    /* ── Desktop: full 2×2 grid ── */
    const GridItem = ({ title, status }) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(0,0,0,0.1)', padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.03)', gap: 6 }}>
            <span style={{ color: 'var(--text-muted)' }}>{title}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: status.color }}>
                <StatusDot color={status.color} />
                {status.label}
            </span>
        </div>
    );

    return (
        <div className={`${styles.card} ${styles.sectionSystem} ${styles.sectionSystemHealth}`}>
            {/* Desktop grid — hidden on mobile via CSS */}
            <div className={styles.streamGrid}>
                {streams.map(({ key, title, s }) => (
                    <GridItem key={key} title={title} status={s} />
                ))}
            </div>

            {/* Mobile compact dots — shown only on mobile via CSS */}
            <div className={styles.streamDots} title="A·B·C·D stream health">
                {streams.map(({ key, s }) => (
                    <div key={key} className={styles.streamDotItem}>
                        <span className={styles.streamDotLabel}>{key}</span>
                        <StatusDot color={s.color} />
                    </div>
                ))}
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
