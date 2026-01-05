import React from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { TrendingUp, TrendingDown, Minus, Activity, Wifi } from 'lucide-react';
import { format } from 'date-fns';
import styles from './HeaderStatsDeck.module.css';

export function HeaderStatsDeck() {
    const { activeScan, setMonitorModalOpen } = useTimeStore();

    if (!activeScan) return <div className={styles.deckLoading}>WAITING FOR DATA...</div>;

    // 1. EXTRACT DATA (Prioritize Server "Truth")
    const results = activeScan.results || [];
    const sentiment = activeScan.market_sentiment || {};
    const hasSentiment = !!activeScan.market_sentiment;

    // Breadth: Use server counts if available, else derive from results
    const bullish = hasSentiment && sentiment.counts ? sentiment.counts.bullish : results.filter(r => r.bias === 'BULLISH').length;
    const bearish = hasSentiment && sentiment.counts ? sentiment.counts.bearish : results.filter(r => r.bias === 'BEARISH').length;
    const neutral = hasSentiment && sentiment.counts ? sentiment.counts.neutral : results.filter(r => r.bias === 'NEUTRAL' || !r.bias).length;

    // Mood Score: Use server score if available
    const moodScore = hasSentiment ? (sentiment.mood_score || 0) : Math.round(((bullish - bearish) / (results.length || 1)) * 100);

    // Mood Label: Use server label or derive
    let moodLabel = hasSentiment ? (sentiment.mood || 'NEUTRAL') : 'NEUTRAL';
    let moodColor = 'var(--text-secondary)';

    // Recalculate Color based on the authoritative score/label
    if (moodLabel === 'BULLISH' || moodScore > 20) { moodColor = 'var(--success)'; }
    else if (moodLabel === 'BEARISH' || moodScore < -20) { moodColor = 'var(--error)'; }
    else if (moodLabel === 'RANGING') { moodColor = 'var(--warning)'; }

    // 3. OPPORTUNITIES / WATCHLIST / MOVERS LOGIC
    // Prioritize showing actionable Opportunities (PASS)
    // Then Watchlist (Missed)
    // Then default to Top Movers if nothing else

    const opportunities = results.filter(r => r.status === 'PASS' || (r.status && r.status.includes('PASS')));
    const missed = results.filter(r => r.status !== 'PASS' && (!r.status || !r.status.includes('PASS')) && r.bias !== 'NEUTRAL');

    // Sort movers by strength for fallback
    const movers = [...results]
        .filter(r => r.bias !== 'NEUTRAL')
        .sort((a, b) => Math.abs(b.strength || 0) - Math.abs(a.strength || 0))
        .slice(0, 3);

    let listLabel = 'TOP MOVERS';
    let listData = [];
    let listType = 'movers'; // for styling

    if (opportunities.length > 0) {
        listLabel = `OPPORTUNITIES (${opportunities.length})`;
        listData = opportunities;
        listType = 'opportunities';
    } else if (missed.length > 0) {
        listLabel = `WATCHLIST (${missed.length})`;
        listData = missed.slice(0, 4); // Limit to 4 for space
        listType = 'watchlist';
    } else {
        listLabel = 'TOP MOVERS';
        listData = movers;
        listType = 'movers';
    }

    return (
        <div className={styles.deckContainer}>

            {/* CLICKABLE ZONE: Mood, Breadth, Opportunities */}
            <div
                className={styles.interactiveZone}
                onClick={() => setMonitorModalOpen(true)}
                title="Click to view Monitor Details"
            >
                {/* SECTION 1: MARKET MOOD */}
                <div className={`${styles.card} ${styles.sectionMood}`}>
                    <div className={styles.cardLabel}>MARKET MOOD</div>
                    <div key={activeScan.id} className={`${styles.moodDisplay} ${styles.animatedValue}`} style={{ color: moodColor }}>
                        <Activity size={16} />
                        <span className={styles.moodValue}>{moodLabel}</span>
                        <span className={styles.moodScore}>{moodScore > 0 ? '+' : ''}{moodScore}</span>
                    </div>
                </div>

                <div className={styles.divider} />

                {/* SECTION 2: BREADTH */}
                <div className={`${styles.card} ${styles.sectionBreadth}`}>
                    <div className={styles.cardLabel}>BREADTH</div>
                    <div key={activeScan.id} className={`${styles.breadthGrid} ${styles.animatedValue}`}>
                        <div className={styles.breadthItem} style={{ color: 'var(--success)' }}>
                            <TrendingUp size={12} /> {bullish}
                        </div>
                        <div className={styles.breadthItem} style={{ color: 'var(--error)' }}>
                            <TrendingDown size={12} /> {bearish}
                        </div>
                        <div className={styles.breadthItem} style={{ color: 'var(--text-tertiary)' }}>
                            <Minus size={12} /> {neutral}
                        </div>
                    </div>
                </div>

                <div className={styles.divider} />

                {/* SECTION 3: DYNAMIC (Flexible) */}
                <div className={`${styles.card} ${styles.sectionMovers}`}>
                    <div className={styles.cardLabel} style={{ color: listType === 'opportunities' ? 'var(--success)' : (listType === 'watchlist' ? 'var(--warning)' : 'var(--text-tertiary)') }}>
                        {listLabel}
                    </div>
                    <div key={activeScan.id} className={`${styles.moversList} ${styles.animatedValue}`}>
                        {listData.length === 0 ? <span className={styles.empty}>--</span> : (
                            listData.map((m, i) => (
                                <span key={i} className={styles.moverItem}>
                                    <span className={m.bias === 'BULLISH' ? styles.bullText : styles.bearText}>
                                        {m.ticker}
                                    </span>
                                </span>
                            ))
                        )}
                    </div>
                </div>
            </div>

            {/* SEPARATOR (Optional, but gap handled by margins) */}
            <div className={styles.divider} />

            {/* SECTION 4: SYSTEM & TIME (Non-Clickable) */}
            <SystemTimeCard />

        </div>
    );
}

// Sub-component for clean organization
function SystemTimeCard() {
    const { timeline, currentIndex, lastSyncTime } = useTimeStore();

    const currentScanMeta = timeline[currentIndex] || {};
    const scanTime = currentScanMeta.timestamp ? new Date(currentScanMeta.timestamp) : new Date();
    const startTime = timeline.length > 0 ? new Date(timeline[0].timestamp) : null;
    const endTime = timeline.length > 0 ? new Date(timeline[timeline.length - 1].timestamp) : null;

    return (
        <div className={`${styles.card} ${styles.sectionSystem}`}>
            <div className={styles.cardLabel} style={{ justifyContent: 'flex-end' }}>
                SYSTEM STATUS
                <span style={{ marginLeft: '8px', display: 'flex', alignItems: 'center', gap: '4px', opacity: 0.7 }}>
                    <Wifi size={10} color={lastSyncTime ? "var(--success)" : "var(--text-tertiary)"} />
                    {lastSyncTime ? format(lastSyncTime, 'h:mm a') : '--'}
                </span>
            </div>
            <div className={styles.timeDisplay} style={{ alignItems: 'flex-end' }}>
                <div className={styles.timeRow}>
                    <span className={styles.timeLabel}>WINDOW:</span>
                    <span className={styles.timeValueSmall}>
                        {startTime ? format(startTime, 'h:mm') : '--'} - {endTime ? format(endTime, 'h:mm a') : '--'}
                    </span>
                </div>
                <div className={styles.timeRow}>
                    <span className={styles.timeLabel}>REPLAY:</span>
                    <span className={styles.timeValueMain}>
                        {format(scanTime, 'h:mm:ss a')}
                    </span>
                </div>
            </div>
        </div>
    );
}
