import React from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import styles from './AlertsAnalyzer.module.css';
import { Activity, TrendingUp, TrendingDown, Target, Zap } from 'lucide-react';
import { format } from 'date-fns';



export function AlertsAnalyzer() {
    const { analyticsData, lookbackHours, setLookbackHours } = useTimeStore();

    // Local state for slider to prevent API spam while dragging
    const [localHours, setLocalHours] = React.useState(lookbackHours);

    // Sync local state if store changes externally
    React.useEffect(() => {
        setLocalHours(lookbackHours);
    }, [lookbackHours]);

    if (!analyticsData || !analyticsData.volume_intent) return <div className={styles.loading}>Initializing Insight Engine...</div>;

    const { volume_intent, predictions, insights, market_structure } = analyticsData;
    const totalVolume = volume_intent.bullish + volume_intent.bearish;
    const bullPct = totalVolume > 0 ? (volume_intent.bullish / totalVolume) * 100 : 50;

    // Range Logic: 5m start, 15m steps
    const currentMinutes = Math.round(localHours * 60);
    const sliderVal = Math.max(0, Math.floor((currentMinutes - 5) / 15));

    const handleRangeChange = (e) => {
        const val = parseInt(e.target.value);
        const minutes = 5 + (val * 15);
        setLocalHours(minutes / 60);
    };

    const handleRangeCommit = () => {
        setLookbackHours(localHours);
    };

    const timeDisplay = currentMinutes < 60
        ? `${currentMinutes}m`
        : `${(currentMinutes / 60).toFixed(1)}h`;

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.titleGroup}>
                    <Activity size={18} />
                    <h3>ALERT BATCH ANALYSIS ({analyticsData.total_alerts} events)</h3>
                </div>

                <div className={styles.rangeControl}>
                    {/* Slider Moved to Floating Controller */}
                    <span className={styles.rangeLabel}>LOOKBACK: <strong>{timeDisplay}</strong></span>
                </div>
            </div>

            {/* NEW: MARKET STRUCTURE BAR - MOVED TO PARENT */}

            <div className={styles.grid}>
                {/* COL 1: VOLUME INTENT */}
                <div className={styles.card}>
                    <h4>VOLUME INTENT DISTRIBUTION</h4>
                    <div className={styles.barContainer}>
                        <div className={styles.barLabel}>
                            <span className={styles.bullText}>Bullish ({volume_intent.bullish})</span>
                            <span className={styles.bearText}>Bearish ({volume_intent.bearish})</span>
                        </div>
                        <div className={styles.progressBar}>
                            <div className={styles.bullBar} style={{ width: `${bullPct}%` }}></div>
                            <div className={styles.bearBar} style={{ width: `${100 - bullPct}%` }}></div>
                        </div>
                    </div>
                </div>

                {/* COL 2: STRUCTURAL PRIORITY (REPURPOSED) */}
                <div className={styles.card}>
                    <h4>STRUCTURAL PRIORITY FOCUS</h4>
                    <div className={styles.predictionList}>
                        {(!market_structure || (market_structure.mega_spot.length === 0 && market_structure.testing_support.length === 0)) && predictions.length === 0 && (
                            <div className={styles.empty}>No Critical Structures Detected</div>
                        )}

                        {/* 1. MEGA SPOTS (Highest Priority) */}
                        {(Array.isArray(market_structure?.mega_spot) ? market_structure.mega_spot : []).map((coin, i) => (
                            <div key={`mega-${i}`} className={styles.predictionCard} style={{ borderLeft: '3px solid #ab47bc' }}>
                                <div className={styles.predHeader}>
                                    <span className={styles.coin}>{coin}</span>
                                    <span className={styles.badge} style={{ color: '#ab47bc', background: 'rgba(171, 71, 188, 0.1)' }}>
                                        MEGA SPOT
                                    </span>
                                </div>
                                <div className={styles.reason}>
                                    <Target size={14} />
                                    Institutional Confluence Zone (5xx)
                                </div>
                            </div>
                        ))}

                        {/* 2. FRICTION / TESTING (Medium Priority) */}
                        {(Array.isArray(market_structure?.testing_support) ? market_structure.testing_support : []).map((coin, i) => (
                            <div key={`test-${i}`} className={styles.predictionCard} style={{ borderLeft: '3px solid #ffa726' }}>
                                <div className={styles.predHeader}>
                                    <span className={styles.coin}>{coin}</span>
                                    <span className={styles.badge} style={{ color: '#ffa726', background: 'rgba(255, 167, 38, 0.1)' }}>
                                        TESTING 200 EMA
                                    </span>
                                </div>
                                <div className={styles.reason}>
                                    <Activity size={14} />
                                    Price interaction with key level (4xx)
                                </div>
                            </div>
                        ))}

                        {/* 3. FALLBACK: Neural Algo Predictions */}
                        {predictions.map((p, i) => (
                            <div key={i} className={styles.predictionCard}>
                                <div className={styles.predHeader}>
                                    <span className={styles.coin}>{p.coin}</span>
                                    <span className={`${styles.badge} ${p.type === 'HIGH_SCOPE' ? styles.scope : styles.neural}`}>
                                        {p.type.replace('_', ' ')}
                                    </span>
                                    <span className={styles.confidence}>{p.confidence} Conf.</span>
                                </div>
                                <div className={styles.reason}>
                                    {p.type === 'HIGH_SCOPE' ? <Target size={14} /> : <Zap size={14} />}
                                    {p.reason}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* COL 3: SMART INSIGHTS */}
                <div className={styles.card}>
                    <h4>INSTITUTIONAL BURSTS</h4>
                    <ul className={styles.insightList}>
                        {insights.length === 0 && <li className={styles.empty}>No recent bursts.</li>}
                        {insights.map((text, i) => (
                            <li key={i} className={styles.insightItem}>
                                <TrendingUp size={14} className={styles.icon} />
                                {text}
                            </li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>
    );
}
