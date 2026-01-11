import React from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import styles from './ConfluenceGrid.module.css';
import { Layers, Activity, Zap, Wind } from 'lucide-react';

export function ConfluenceGrid() {
    const { analyticsData } = useTimeStore();

    if (!analyticsData || !analyticsData.time_spread) return <div className={styles.loading}>Loading Macro Data...</div>;

    return (
        <div className={styles.gridContainer}>
            <h3 className={styles.title}>ENHANCED INSTITUTIONAL MACRO SUMMARY (Time Spread Analysis)</h3>

            <div
                className={styles.tableWrapper}
            >
                <table className={styles.macroTable}>
                    <thead>
                        <tr>
                            <th>#</th>
                            <th>Date Time</th>
                            <th>Alerts</th>
                            <th>Coins</th>
                            <th>Spread</th>
                            <th>Density</th>
                            <th>Cluster</th>
                            <th>Bias</th>
                            <th>S/I</th>
                            <th>Mom%</th>
                            <th>Wave Type</th>
                            <th>Ticker Timeline</th>
                        </tr>
                    </thead>
                    <tbody>
                        {[...analyticsData.time_spread]
                            .sort((a, b) => new Date(b.full_ts) - new Date(a.full_ts))
                            .map((row, i) => (
                                <tr key={i} className={row.count > 5 ? styles.highlightRow : ''}>
                                    <td className={styles.dim}>{i + 1}</td>
                                    <td className={styles.timeCell}>{row.time}</td>
                                    <td className={styles.metricCell}>{row.count}</td>
                                    <td className={styles.metricCell}>{row.unique_coins}</td>
                                    <td className={styles.dim}>{row.spread}</td>
                                    <td>{row.density}<span className={styles.unit}>/min</span></td>
                                    <td className={styles.clusterCell}>
                                        {getClusterIcon(row.cluster)}
                                        <span>{row.cluster}</span>
                                    </td>
                                    <td className={row.bias === 'BULL' ? styles.bull : styles.bear}>
                                        {row.bias}
                                    </td>
                                    <td className={styles.dim}>{row.si}</td>
                                    <td className={parseFloat(row.mon_pct) > 0 ? styles.bull : styles.bear}>{row.mon_pct}</td>
                                    <td className={styles.waveType}>
                                        {getWaveIcon(row.wave_type)}
                                        {row.wave_type}
                                    </td>
                                    <td className={styles.timelineCell} title={row.timeline}>{row.timeline}</td>
                                </tr>
                            ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function getClusterIcon(type) {
    if (type === 'BURST') return <Zap size={14} color="#facc15" />;
    if (type === 'STEADY') return <Layers size={14} color="#60a5fa" />;
    return <Activity size={14} color="#9ca3af" />;
}

function getWaveIcon(type) {
    if (type === 'Burst Cluster') return <Zap size={12} />;
    if (type === 'Broad Flow') return <Wind size={12} />;
    return <Activity size={12} />;
}
