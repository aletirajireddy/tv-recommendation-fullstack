import React from 'react';
import { useTimeStore } from '../store/useTimeStore';
import styles from './MacroHUD.module.css';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';

export function MacroHUD() {
    const activeScan = useTimeStore(s => s.activeScan);
    const marketMood = useTimeStore(s => s.marketMood);

    if (!activeScan) {
        return <div className="card" style={{ padding: '1rem', color: 'var(--text-tertiary)' }}>No Active Scan</div>;
    }

    // Use marketMood (Supreme Court) for stats, fall back to activeScan.market_sentiment
    const stats = marketMood?.stats || activeScan.market_sentiment?.counts || activeScan.market_sentiment || {};
    const moodLabel = marketMood?.label || activeScan.market_sentiment?.mood || 'NEUTRAL';
    const moodScore = marketMood?.moodScore ?? activeScan.market_sentiment?.moodScore ?? 0;
    const tickers = activeScan.market_sentiment?.tickers || { bullish: [], bearish: [] };

    const moodColor = moodScore > 0 ? 'var(--success)' : moodScore < 0 ? 'var(--error)' : 'var(--text-tertiary)';

    return (
        <aside className={styles.container}>
            {/* 1. MOOD SCORE CARD */}
            <div className="card" style={{ padding: '24px' }}>
                <div className={styles.moodLabel}>MARKET MOOD</div>
                <div className={styles.moodBigValue} style={{ color: moodColor }}>
                    {moodLabel}
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
                    <span className={styles.statNumber}>{stats.bullish || 0}</span>
                </div>

                {/* Bearish */}
                <div className={styles.statRow}>
                    <div className={styles.statLabel}>
                        <TrendingDown size={16} color="var(--error)" />
                        <span>BEARISH</span>
                    </div>
                    <span className={styles.statNumber}>{stats.bearish || 0}</span>
                </div>

                {/* Neutral */}
                <div className={styles.statRow}>
                    <div className={styles.statLabel}>
                        <Minus size={16} color="var(--text-tertiary)" />
                        <span>NEUTRAL</span>
                    </div>
                    <span className={styles.statNumber}>{stats.neutral || 0}</span>
                </div>

                <div className={styles.totalRow}>
                    <span>TOTAL</span>
                    <span>{stats.total || 0}</span>
                </div>
            </div>

        </aside>
    );
}
