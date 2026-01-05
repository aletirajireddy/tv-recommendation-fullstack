import React from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import styles from './AlphaScatter.module.css';
import { RefreshCw, Target } from 'lucide-react';
import {
    ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';

export function AlphaScatter() {
    const { activeScan, refreshAll, analyticsData } = useTimeStore();

    // Transform Data
    const data = React.useMemo(() => {
        // Priority 1: Time-Windowed Signals (aggregated from backend)
        if (analyticsData && analyticsData.signals && analyticsData.signals.length > 0) {
            return analyticsData.signals.map(s => ({
                ticker: s.ticker,
                x: s.x,
                y: s.y,
                bias: s.bias,
                volSpike: s.volSpike
            }));
        }

        // Priority 2: Snapshot Scan (Legacy/Fallback)
        if (!activeScan || !activeScan.results) return [];
        return activeScan.results
            .filter(r => r.category && r.category !== 'PASSED')
            .map(r => ({
                ticker: r.ticker,
                x: parseFloat(r.netTrend || 0),
                y: parseFloat(r.score || 0),
                bias: r.direction || r.category,
                volSpike: r.volSpike === 1
            }));
    }, [activeScan, analyticsData]);

    const handleRefresh = (e) => {
        e.stopPropagation();
        refreshAll();
    };

    const CustomTooltip = ({ active, payload }) => {
        if (active && payload && payload.length) {
            const d = payload[0].payload;
            return (
                <div className={styles.tooltip}>
                    <h4>{d.ticker}</h4>
                    <p>Trend Strength: {d.x}</p>
                    <p>Quality Score: {d.y}</p>
                    {d.volSpike && <p style={{ color: 'var(--accent-secondary)' }}>⚡ High Volume</p>}
                    <span className={d.bias === 'BULLISH' || d.bias === 'LONG' ? styles.bull : styles.bear}>{d.bias}</span>
                </div>
            );
        }
        return null;
    };

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.title}>
                    <Target size={18} />
                    <h3>ALPHA QUADRANT (Momentum vs Quality)</h3>
                </div>
                <button className={styles.refreshBtn} onClick={handleRefresh} title="Refresh Scan">
                    <RefreshCw size={14} />
                </button>
            </div>

            <div className={styles.chartArea}>
                {!activeScan ? (
                    <div className={styles.emptyState}>
                        <p>Waiting for Scan Data...</p>
                        <button className={styles.loadBtn} onClick={refreshAll}>Load Latest</button>
                    </div>
                ) : data.length === 0 ? (
                    <div className={styles.emptyState}>
                        <p>No Active Signals in Current Scan</p>
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
                            <XAxis
                                type="number"
                                dataKey="x"
                                name="Trend Strength"
                                stroke="var(--text-secondary)"
                                fontSize={10}
                                domain={[-100, 100]}
                                label={{ value: 'Trend Strength', position: 'insideBottom', offset: -5, fill: 'var(--text-tertiary)', fontSize: 10 }}
                            />
                            <YAxis
                                type="number"
                                dataKey="y"
                                name="Activity Score"
                                stroke="var(--text-secondary)"
                                fontSize={10}
                                domain={[0, 100]}
                                label={{ value: 'Activity Score', angle: -90, position: 'insideLeft', fill: 'var(--text-tertiary)', fontSize: 10 }}
                            />
                            <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<CustomTooltip />} />
                            <Scatter name="Coins" data={data} fill="#8884d8">
                                {data.map((entry, index) => (
                                    <Cell key={`cell-${index}`} fill={entry.bias === 'BULLISH' ? 'var(--success)' : 'var(--error)'} />
                                ))}
                            </Scatter>
                        </ScatterChart>
                    </ResponsiveContainer>
                )}
            </div>
        </div>
    );
}
