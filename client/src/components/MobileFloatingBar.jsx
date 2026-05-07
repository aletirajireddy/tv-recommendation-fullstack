import React, { useState } from 'react';
import { Wifi, History, Palette, X } from 'lucide-react';
import { useTimeStore } from '../store/useTimeStore';
import TimeService from '../services/TimeService';
import { SmartAlertsBell } from './SmartAlerts/SmartAlertsBell';
import styles from './MobileFloatingBar.module.css';

function StatusDot({ color }) {
    return (
        <span style={{
            display: 'inline-block',
            width: 7, height: 7,
            borderRadius: '50%',
            background: color,
            boxShadow: `0 0 5px ${color}88`,
            flexShrink: 0,
        }} />
    );
}

function useStreams() {
    const streamsHealth = useTimeStore(s => s.streamsHealth);
    const timeline      = useTimeStore(s => s.timeline);

    const getStatus = (iso) => {
        if (!iso) return { label: '--', color: 'var(--text-muted)' };
        const mins = (Date.now() - new Date(iso).getTime()) / 60000;
        const label = TimeService.timeAgo(iso);
        if (mins < 30)  return { label, color: '#10B981' };
        if (mins <= 120) return { label, color: '#FACC15' };
        return { label, color: '#EF4444' };
    };

    const latest = timeline.length > 0 ? timeline[timeline.length - 1] : null;
    return [
        { key: 'A', name: 'MACRO', s: getStatus(streamsHealth?.streamA) },
        { key: 'B', name: 'SCOUT', s: getStatus(streamsHealth?.streamB) },
        { key: 'C', name: 'ALERT', s: getStatus(streamsHealth?.streamC) },
        { key: 'D', name: 'SYNC',  s: getStatus(latest?.timestamp) },
    ];
}

export function MobileFloatingBar({ onOpenThemeBuilder }) {
    const [expanded, setExpanded] = useState(false);
    const timeline     = useTimeStore(s => s.timeline);
    const currentIndex = useTimeStore(s => s.currentIndex);
    const isLive = timeline.length > 0 && currentIndex === timeline.length - 1;
    const streams = useStreams();
    const badCount = streams.filter(st => st.s.color === '#EF4444').length;

    return (
        <div className={styles.wrapper}>
            {/* Expanded panel — slides up above the bubble */}
            {expanded && (
                <div className={styles.panel}>
                    <button className={styles.closeBtn} onClick={() => setExpanded(false)}>
                        <X size={13} />
                    </button>

                    {/* Stream health grid */}
                    <div className={styles.streamsGrid}>
                        {streams.map(({ key, name, s }) => (
                            <div key={key} className={styles.streamRow}>
                                <StatusDot color={s.color} />
                                <span className={styles.streamKey}>{key}</span>
                                <span className={styles.streamName}>{name}</span>
                                <span className={styles.streamAge} style={{ color: s.color }}>{s.label}</span>
                            </div>
                        ))}
                    </div>

                    <div className={styles.divider} />

                    {/* Action row: live badge + bell + palette */}
                    <div className={styles.actionsRow}>
                        <div className={`${styles.liveBadge} ${isLive ? styles.liveBadgeActive : styles.liveBadgeReplay}`}>
                            {isLive
                                ? <><Wifi size={12} /><span>LIVE</span></>
                                : <><History size={12} /><span>REPLAY</span></>
                            }
                        </div>

                        {/* Reuse the self-contained bell — dropdown opens upward via CSS */}
                        <div className={styles.bellWrap}>
                            <SmartAlertsBell />
                        </div>

                        <button
                            className={styles.iconBtn}
                            onClick={() => { onOpenThemeBuilder(); setExpanded(false); }}
                            title="Theme Builder"
                        >
                            <Palette size={16} />
                        </button>
                    </div>
                </div>
            )}

            {/* Floating bubble */}
            <button
                className={`${styles.bubble} ${isLive && !expanded ? styles.bubbleLive : ''} ${badCount > 0 && !expanded ? styles.bubbleAlert : ''}`}
                onClick={() => setExpanded(v => !v)}
                title={expanded ? 'Close' : 'Stream status & tools'}
            >
                {expanded
                    ? <X size={18} />
                    : isLive
                        ? <Wifi size={18} color="#10B981" className={styles.pulseIcon} />
                        : <History size={18} color="var(--accent-orange)" />
                }
                {!expanded && badCount > 0 && <span className={styles.alertDot} />}
            </button>
        </div>
    );
}
