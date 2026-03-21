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
    const { activeScan, useSmartLevelsContext } = useTimeStore();

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
            // Safe V3 Object Mapping (Fallback logic)
            const d = item.data || item;
            const code = d.positionCode || 0;
            const score = d.score || item.score || 0;
            
            // Phase 15: Contextual Visualization via Smart Levels
            let smartLevelContext = null;
            if (useSmartLevelsContext && Array.isArray(d.smartLevels)) {
                d.smartLevels.forEach(sl => {
                    if (sl && sl.price) {
                        const distPct = Math.abs((d.close - sl.price) / d.close) * 100;
                        if (distPct < 0.5) {
                            if (sl.type && sl.type.includes('Support')) smartLevelContext = 'SUPPORT';
                            if (sl.type && (sl.type.includes('Resistance') || sl.type.includes('Resist'))) smartLevelContext = 'RESIST';
                        }
                    }
                });
            }

            const mappedItem = {
                ticker: item.ticker,
                cleanTicker: d.cleanTicker || item.ticker,
                score: score,
                smartLevelContext: smartLevelContext
            };

            if (code >= 100 && code < 200) groups.bearish.push(mappedItem);
            else if (code >= 200 && code < 300) groups.choppy.push(mappedItem);
            else if (code >= 300 && code < 400) groups.bullish.push(mappedItem);
            else if (code >= 400 && code < 500) groups.support.push(mappedItem);
            else if (code >= 500) groups.mega.push(mappedItem);
        });

        // Optional: Sort each bucket by highest score first to surface the best setups
        Object.keys(groups).forEach(key => {
            groups[key].sort((a, b) => b.score - a.score);
        });

        return groups;
    }, [activeScan, useSmartLevelsContext]);

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
                items.map((item, i) => {
                    // Check if this specific item is testing a smart level
                    const isSmartSupport = item.smartLevelContext === 'SUPPORT';
                    const isSmartResist = item.smartLevelContext === 'RESIST';
                    const isSmartActive = isSmartSupport || isSmartResist;
                    
                    // Apply a glowing border if resting on a smart level
                    const chipGlow = isSmartSupport ? 'inset 2px 0 8px rgba(59,130,246,0.3)' : (isSmartResist ? 'inset 2px 0 8px rgba(239,68,68,0.3)' : 'none');

                    return (
                        <div key={i} className={styles.chip} style={{ borderLeftColor: color, boxShadow: chipGlow }}>
                            <span className={styles.ticker} title={isSmartSupport ? "Bouncing off Smart Support" : (isSmartResist ? "Rejecting from Smart Resistance" : "")}>
                                {item.cleanTicker}
                                {isSmartSupport && <span style={{marginLeft: '4px', filter: 'drop-shadow(0 0 2px rgba(59,130,246,0.8))'}}>🎯</span>}
                                {isSmartResist && <span style={{marginLeft: '4px', filter: 'drop-shadow(0 0 2px rgba(239,68,68,0.8))'}}>🧱</span>}
                            </span>
                            {(item.score !== undefined) && (
                                <span className={styles.score} style={{ color: item.score >= 50 ? 'var(--success)' : 'var(--error)' }}>
                                    {item.score}
                                </span>
                            )}
                        </div>
                    );
                })
            )}
        </div>
    </div>
);
