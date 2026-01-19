import React, { useMemo } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { ArrowDown, Minus, ArrowUp, Anvil, Zap } from 'lucide-react';
import styles from './MarketStructureWidget.module.css';

/**
 * Market Structure Widget (Consolidated)
 * Visualizes the market structure based on EMA Position Codes from the Active Scan.
 * 
 * Buckets:
 * 1. BEARISH (1xx) - Price < All EMAs
 * 2. CHOPPY (2xx) - Mixed EMA states
 * 3. BULLISH (3xx) - Price > All EMAs
 * 4. SUPPORT (4xx) - Testing EMAs / Key Levels
 * 5. MEGA SPOT (5xx) - Institutional Confluence
 */
export const MarketStructureWidget = () => {
    const { activeScan } = useTimeStore();

    const buckets = useMemo(() => {
        const groups = {
            bearish: [], // 1xx
            choppy: [],  // 2xx
            bullish: [], // 3xx
            support: [], // 4xx
            mega: []     // 5xx
        };

        if (!activeScan || !activeScan.results) return groups;

        activeScan.results.forEach(item => {
            const code = item.positionCode || 0;
            if (code >= 100 && code < 200) groups.bearish.push(item);
            else if (code >= 200 && code < 300) groups.choppy.push(item);
            else if (code >= 300 && code < 400) groups.bullish.push(item); // Corrected: 3xx is Bullish
            else if (code >= 400 && code < 500) groups.support.push(item);
            else if (code >= 500) groups.mega.push(item);
        });

        return groups;
    }, [activeScan]);

    if (!activeScan) return <div className={styles.loading}>Waiting for Scan Data...</div>;

    return (
        <div className={styles.container}>
            {/* Header for Consistence */}
            <div className={styles.headerTitle}>
                <h3>MARKET STRUCTURE DISTRIBUTION</h3>
            </div>

            <div className={styles.grid}>
                {/* BUCKET 1: BEARISH */}
                <Bucket
                    title="BEARISH TREND"
                    count={buckets.bearish.length}
                    items={buckets.bearish}
                    icon={ArrowDown}
                    color="var(--error)"
                    bgColor="rgba(239, 68, 68, 0.1)"
                />

                {/* BUCKET 2: CHOPPY */}
                <Bucket
                    title="CHOPPY / RANGE"
                    count={buckets.choppy.length}
                    items={buckets.choppy}
                    icon={Minus}
                    color="var(--warning)"
                    bgColor="rgba(245, 158, 11, 0.1)"
                />

                {/* BUCKET 3: BULLISH */}
                <Bucket
                    title="BULLISH TREND"
                    count={buckets.bullish.length}
                    items={buckets.bullish}
                    icon={ArrowUp}
                    color="var(--success)"
                    bgColor="rgba(16, 185, 129, 0.1)"
                />

                {/* BUCKET 4: TESTING SUPPORT */}
                <Bucket
                    title="TESTING SUPPORT"
                    count={buckets.support.length}
                    items={buckets.support}
                    icon={Anvil}
                    color="#3b82f6"
                    bgColor="rgba(59, 130, 246, 0.1)"
                    highlight
                />

                {/* BUCKET 5: MEGA SPOT */}
                <Bucket
                    title="MEGA SPOT"
                    count={buckets.mega.length}
                    items={buckets.mega}
                    icon={Zap}
                    color="#8b5cf6"
                    bgColor="rgba(139, 92, 246, 0.1)"
                    highlight
                />
            </div>
        </div>
    );
};

const Bucket = ({ title, count, items, icon: Icon, color, bgColor, highlight }) => (
    <div className={styles.bucket} style={{ borderColor: color, boxShadow: highlight ? `0 0 10px ${bgColor}` : 'none' }}>
        <div className={styles.header} style={{ backgroundColor: bgColor, color: color }}>
            <Icon size={16} strokeWidth={2.5} />
            <span className={styles.title}>{title}</span>
            <span className={styles.count}>{count}</span>
        </div>
        <div className={styles.body}>
            {items.length === 0 ? <span className={styles.empty}>--</span> : (
                items.slice(0, 8).map((item, i) => ( // Limit visual display
                    <div key={i} className={styles.chip} style={{ borderLeftColor: color }}>
                        <span className={styles.ticker}>{item.cleanTicker || item.ticker}</span>
                        {item.score !== 0 && <span className={styles.score} style={{ color: item.score > 0 ? 'var(--success)' : 'var(--error)' }}>{item.score}</span>}
                    </div>
                ))
            )}
            {items.length > 8 && <div className={styles.more}>+{items.length - 8} more</div>}
        </div>
    </div>
);
