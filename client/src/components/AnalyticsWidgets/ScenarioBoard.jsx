import React, { useState, useEffect } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { Swords, Zap, Flame } from 'lucide-react';
import styles from './ScenarioBoard.module.css';

const ScenarioBoard = () => {
    // Decoupled from lookbackHours - We want strict "Tactical" logic (Last 1h)
    const activeScan = useTimeStore(s => s.activeScan);
    const marketMood = useTimeStore(s => s.marketMood);
    const useSmartLevelsContext = useTimeStore(s => s.useSmartLevelsContext);
    const [scenarios, setScenarios] = useState({ planA: [], planB: [], marketCheck: null });
    const [loading, setLoading] = useState(true);

    const TACTICAL_WINDOW_HOURS = 1;

    const fetchScenarios = async () => {
        try {
            let refTimeStr = '';
            if (activeScan && activeScan.timestamp) {
                refTimeStr = `&refTime=${encodeURIComponent(activeScan.timestamp)}`;
            }

            const res = await fetch(`/api/analytics/scenarios?hours=${TACTICAL_WINDOW_HOURS}&smartLevels=${useSmartLevelsContext}${refTimeStr}`);
            const data = await res.json();
            if (data && !data.error) {
                setScenarios(data);
            }
        } catch (err) {
            console.error('Failed to fetch scenarios:', err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchScenarios();
        // Re-fetch only when a new scan arrives (fresh data) or toggle changes
    }, [activeScan, useSmartLevelsContext]);

    const [isPulsing, setIsPulsing] = useState(false);
    useEffect(() => {
        if (activeScan) {
            setIsPulsing(false);
            const trigger = setTimeout(() => setIsPulsing(true), 10);
            const timer = setTimeout(() => setIsPulsing(false), 1300);
            return () => { clearTimeout(trigger); clearTimeout(timer); };
        }
    }, [activeScan?.id]);

    const ScenarioColumn = ({ title, type, items, color }) => (
        <div className={styles.column} style={{ borderColor: color + '44' }}>
            <div className={styles.columnHeader} style={{ backgroundColor: color }}>
                <span>{title}</span>
                <span className={styles.candidateCount}>{items.length} Candidates</span>
            </div>

            <div className={styles.columnList}>
                {items.length === 0 ? (
                    <div className={styles.emptyState}>
                        No candidates meet {type} criteria.
                    </div>
                ) : (
                    items.map((item, idx) => (
                        <div key={idx} className={styles.card} style={{ borderLeftColor: color }}>
                            <div className={styles.cardLeft}>
                                <div className={styles.ticker} style={{ color: 'var(--text-main)' }}>{item.ticker}</div>
                                <div className={styles.trigger} style={{ color: 'var(--text-muted)' }}>
                                    {item.trigger}
                                </div>
                            </div>
                            <div className={styles.cardRight}>
                                <div className={styles.price} style={{ color: color }}>${item.price.toFixed(4)}</div>
                                <div className={styles.meta}>
                                    <span>{item.scope}</span>
                                    {item.vol && (
                                        <Zap size={14} color="#ffbd00" title="Volume Spike Ignition" className="inline" />
                                    )}
                                    {item.heat > 0 && (
                                        <Flame size={14} color="#ff5252" title={`${item.heat} Inst. Alerts`} className="inline" />
                                    )}
                                </div>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );

    return (
        <div className={`${styles.container} ${isPulsing ? 'animate-widget-glow' : ''}`}>
            <div className={styles.boardHeader}>
                <div className={styles.headerLeft}>
                    <span className={styles.headerIcon}><Swords size={20} className="text-accent-blue" /></span>
                    <h3 className="widget-title">SCENARIO PLANNING</h3>
                </div>
                {marketMood && (
                    <div className={styles.marketContext} style={{
                        backgroundColor: 'var(--bg-panel)',
                        color: marketMood.label.includes('BULLISH') || marketMood.label.includes('EUPHORIC') ? 'var(--accent-green)' :
                            marketMood.label.includes('BEARISH') || marketMood.label.includes('PANIC') ? 'var(--accent-red)' : 'var(--text-main)',
                        border: '1px solid var(--border)'
                    }}>
                        Current Context: {marketMood.label} ({marketMood.moodScore})
                    </div>
                )}
            </div>

            <div className={styles.boardContent}>
                <ScenarioColumn
                    title="PLAN A: BULLISH BREAKOUT"
                    type="Breakout"
                    items={scenarios.planA}
                    color="var(--accent-green)"
                />

                <div className={styles.divider}></div>

                <ScenarioColumn
                    title="PLAN B: BEARISH BREAKDOWN"
                    type="Breakdown"
                    items={scenarios.planB}
                    color="var(--accent-red)"
                />
            </div>
        </div>
    );
};

export default ScenarioBoard;
