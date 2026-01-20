import React, { useState, useEffect } from 'react';
import { useTimeStore } from '../../store/useTimeStore';

import styles from './ScenarioBoard.module.css';

const ScenarioBoard = () => {
    // Decoupled from lookbackHours - We want strict "Tactical" logic (Last 1h)
    const { activeScan, marketMood } = useTimeStore();
    const [scenarios, setScenarios] = useState({ planA: [], planB: [], marketCheck: null });
    const [loading, setLoading] = useState(true);

    const TACTICAL_WINDOW_HOURS = 1;

    const fetchScenarios = async () => {
        try {
            const res = await fetch(`http://${window.location.hostname}:3000/api/analytics/scenarios?hours=${TACTICAL_WINDOW_HOURS}`);
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
        // Re-fetch only when a new scan arrives (fresh data)
    }, [activeScan]);

    const ScenarioColumn = ({ title, type, items, color }) => (
        <div className={styles.column} style={{ borderColor: color }}>
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
                                <div className={styles.ticker}>{item.ticker}</div>
                                <div className={styles.trigger}>
                                    {item.trigger}
                                </div>
                            </div>
                            <div className={styles.cardRight}>
                                <div className={styles.price} style={{ color: color }}>${item.price.toFixed(4)}</div>
                                <div className={styles.meta}>
                                    <span>{item.scope}</span>
                                    {item.vol && (
                                        <span title="Volume Spike Ignition" style={{ fontSize: '0.9rem', color: '#ffbd00' }}>⚡</span>
                                    )}
                                    {item.heat > 0 && (
                                        <span title={`${item.heat} Inst. Alerts`} style={{ fontSize: '0.9rem' }}>🔥</span>
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
        <div className={styles.container}>
            <div className={styles.boardHeader}>
                <div className={styles.headerLeft}>
                    <span className={styles.headerIcon}>⚔️</span>
                    <h3 className={styles.title}>SCENARIO PLANNING</h3>
                </div>
                {marketMood && (
                    <div className={styles.marketContext} style={{
                        backgroundColor: marketMood.label.includes('BULLISH') || marketMood.label.includes('EUPHORIC') ? '#d4edda' :
                            marketMood.label.includes('BEARISH') || marketMood.label.includes('PANIC') ? '#f8d7da' : '#e2e3e5',
                        color: marketMood.label.includes('BULLISH') || marketMood.label.includes('EUPHORIC') ? '#155724' :
                            marketMood.label.includes('BEARISH') || marketMood.label.includes('PANIC') ? '#721c24' : '#383d41'
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
                    color="#00c853"
                />

                <div className={styles.divider}></div>

                <ScenarioColumn
                    title="PLAN B: BEARISH BREAKDOWN"
                    type="Breakdown"
                    items={scenarios.planB}
                    color="#ff5252"
                />
            </div>
        </div>
    );
};

export default ScenarioBoard;
