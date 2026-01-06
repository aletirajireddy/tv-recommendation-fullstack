import React from 'react';
import { useTimeStore } from '../store/useTimeStore';
import { TrendingUp, TrendingDown, Minus, Activity, Wifi } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
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
        listData = missed.slice(0, 4);
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
                        <Activity size={18} strokeWidth={2.5} />
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
                            <TrendingUp size={14} strokeWidth={2.5} /> {bullish}
                        </div>
                        <div className={styles.breadthItem} style={{ color: 'var(--error)' }}>
                            <TrendingDown size={14} strokeWidth={2.5} /> {bearish}
                        </div>
                        <div className={styles.breadthItem} style={{ color: 'var(--text-tertiary)' }}>
                            <Minus size={14} strokeWidth={2.5} /> {neutral}
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
                                <div
                                    key={i}
                                    className={styles.moverItem}
                                    title={`TICKER: ${m.ticker}\nSCORE: ${m.score || 0}\nBIAS: ${m.bias}\nSTRATEGIES: ${m.matchedStrategies?.join(', ') || 'None'}\nREASONS: ${m.missedReason || 'N/A'}\nSTRENGTH: ${m.strength}`}
                                >
                                    <span className={m.bias === 'BULLISH' ? styles.bullText : (m.bias === 'BEARISH' ? styles.bearText : '')} style={{ fontWeight: 800 }}>
                                        {m.ticker}
                                    </span>
                                    {/* Show Strategy or Reason if available */}
                                    {(listType === 'opportunities' && m.matchedStrategies && m.matchedStrategies.length > 0) && (
                                        <span className={styles.strategyTag}>{m.matchedStrategies[0]}</span>
                                    )}
                                    {(listType === 'watchlist' && m.missedReason) && (
                                        <span className={styles.reasonTag}>{m.missedReason.substring(0, 15)}{m.missedReason.length > 15 ? '...' : ''}</span>
                                    )}
                                </div>
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
    const { timeline, currentIndex } = useTimeStore();

    const currentScanMeta = timeline[currentIndex] || {};
    const scanTime = currentScanMeta.timestamp ? new Date(currentScanMeta.timestamp) : new Date();

    // Safely handle potentially missing timestamps
    const startTimeResult = timeline.length > 0 ? new Date(timeline[0].timestamp) : new Date();
    const endTimeResult = timeline.length > 0 ? new Date(timeline[timeline.length - 1].timestamp) : new Date();

    // Calculate time helper - derived from the DATA TIME, not system time
    // If it's a replay, it shows how "old" that specific scan was relative to now (which might be confusing), 
    // OR we compare it to the "Latest" scan to show lag? 
    // User requested: "last update since last dbupdate to current time!" 
    // This implies: How long ago was the *latest* data in the DB captured?

    // Let's use the LAST item in timeline (Live edge) to calculate system freshness
    const latestScanTime = timeline.length > 0 ? new Date(timeline[timeline.length - 1].timestamp) : new Date();
    const updatedAgo = timeline.length > 0 ? formatDistanceToNow(latestScanTime, { addSuffix: true }) : 'Unknown';

    return (
        <div className={`${styles.card} ${styles.sectionSystem}`}>
            <div className={styles.cardLabel} style={{ justifyContent: 'flex-end', gap: '8px' }}>
                <span style={{ opacity: 0.6 }}>SYSTEM STATUS</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '4px', color: "var(--success)" }} title={`Latest Data: ${format(latestScanTime, 'HH:mm:ss')}`}>
                    <Wifi size={12} strokeWidth={3} />
                    {updatedAgo.replace('about ', '')}
                </span>
            </div>

            <div className={styles.timeDisplay} style={{ alignItems: 'flex-end' }}>
                <div className={styles.timeRow}>
                    <span className={styles.timeLabel}>WINDOW:</span>
                    <span className={styles.timeValueSmall}>
                        {format(startTimeResult, 'MMM dd HH:mm')} - {format(endTimeResult, 'HH:mm')}
                    </span>
                </div>
                <div className={styles.timeRow}>
                    <span className={styles.timeLabel}>REPLAY:</span>
                    <span className={styles.timeValueMain}>
                        {format(scanTime, 'MMM dd HH:mm:ss')}
                    </span>
                </div>
            </div>
        </div>
    );
}
