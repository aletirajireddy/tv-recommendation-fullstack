import React from 'react';
import { useTimeStore } from '../store/useTimeStore';
import styles from './MacroHUD.module.css';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export function MacroHUD() {
    const { activeScan } = useTimeStore();

    if (!activeScan || !activeScan.market_sentiment) {
        return <div className="card" style={{ padding: '1rem', color: 'var(--text-tertiary)' }}>No Market Data</div>;
    }

    const { mood, moodScore, counts, tickers } = activeScan.market_sentiment;
    const moodColor = moodScore > 0 ? 'var(--success)' : moodScore < 0 ? 'var(--error)' : 'var(--text-tertiary)';

    return (
        <aside className={styles.container}>
            {/* 1. MOOD SCORE CARD */}
            <div className="card" style={{ padding: '24px' }}>
                <div className={styles.moodLabel}>MARKET MOOD</div>
                <div className={styles.moodBigValue} style={{ color: moodColor }}>
                    {mood}
                </div>
                <div className={styles.scoreRow}>
                    <span className={styles.scoreValue}>{moodScore}</span>
                    <span className={styles.scoreSub}>/ 100</span>
                </div>
            </div>

            {/* 2. BREADTH STATS */}
            <div className="card" style={{ padding: '16px' }}>
                <div className={styles.sectionTitle}>BREADTH</div>

                {/* Bullish */}
                <div className={styles.statRow}>
                    <div className={styles.statLabel}>
                        <TrendingUp size={16} color="var(--success)" />
                        <span>BULLISH</span>
                    </div>
                    <span className={styles.statNumber}>{counts.bullish}</span>
                </div>

                {/* Bearish */}
                <div className={styles.statRow}>
                    <div className={styles.statLabel}>
                        <TrendingDown size={16} color="var(--error)" />
                        <span>BEARISH</span>
                    </div>
                    <span className={styles.statNumber}>{counts.bearish}</span>
                </div>

                {/* Neutral */}
                <div className={styles.statRow}>
                    <div className={styles.statLabel}>
                        <Minus size={16} color="var(--text-tertiary)" />
                        <span>NEUTRAL</span>
                    </div>
                    <span className={styles.statNumber}>{counts.neutral}</span>
                </div>

                <div className={styles.totalRow}>
                    <span>TOTAL</span>
                    <span>{counts.total}</span>
                </div>
            </div>

            {/* 3. TICKER LISTS (Replay Data) */}
            <div className="card" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div className={styles.sectionTitle} style={{ padding: '16px', borderBottom: '1px solid var(--border-subtle)' }}>
                    MOVERS
                </div>
                <div className={styles.scrollList}>
                    {/* Bullish Movers */}
                    {tickers.bullish && tickers.bullish.length > 0 && (
                        <div className={styles.groupBlock}>
                            <div className={styles.groupHeader} style={{ color: 'var(--success)' }}>BULLISH</div>
                            {tickers.bullish.map(t => (
                                <div key={t.t} className={styles.tickerRow}>
                                    <span className={styles.tickerName}>{t.t}</span>
                                    <span className={styles.tickerMeta}>{t.nt} NT</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Bearish Movers */}
                    {tickers.bearish && tickers.bearish.length > 0 && (
                        <div className={styles.groupBlock}>
                            <div className={styles.groupHeader} style={{ color: 'var(--error)' }}>BEARISH</div>
                            {tickers.bearish.map(t => (
                                <div key={t.t} className={styles.tickerRow}>
                                    <span className={styles.tickerName}>{t.t}</span>
                                    <span className={styles.tickerMeta}>{t.nt} NT</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </aside>
    );
}
