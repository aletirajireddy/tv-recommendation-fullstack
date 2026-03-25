import React from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import styles from './ConfluenceGrid.module.css';
import { Layers, Activity, Zap, Wind } from 'lucide-react';

export function ConfluenceGrid() {
    const analyticsData = useTimeStore(s => s.analyticsData);

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
                            <th>Time Window</th>
                            <th>Duration</th>
                            <th>Total Alerts</th>
                            <th>Intensity Breakdown</th>
                            <th>Coins</th>
                            <th>Density</th>
                            <th>Bias</th>
                            <th>Mom%</th>
                            <th>Ticker Timeline</th>
                        </tr>
                    </thead>
                    <tbody>
                        {[...analyticsData.time_spread]
                            .sort((a, b) => new Date(b.time) - new Date(a.time))
                            .map((row, i) => {
                                const startDate = new Date(row.start_time);
                                const endDate = new Date(row.time);
                                
                                const isToday = startDate.toDateString() === new Date().toDateString();
                                const isYesterday = !isToday && startDate.getTime() > (Date.now() - 48 * 60 * 60 * 1000);
                                
                                const dateStr = isToday ? 'Today' : (isYesterday ? 'Yesterday' : startDate.toLocaleDateString([], { month: 'short', day: 'numeric' }));
                                const startStr = startDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                                const endStr = endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                                
                                const timeWindow = startStr === endStr ? `${dateStr} ${startStr}` : `${dateStr} ${startStr} - ${endStr}`;
                                return (
                                <tr key={i} className={row.count > 5 ? styles.highlightRow : ''}>
                                    <td className={styles.timeCell}>{timeWindow}</td>
                                    <td><span className={styles.durationBadge}>{row.duration}m</span></td>
                                    <td className={styles.metricCell}>{row.count}</td>
                                    <td className={styles.intensityCell}>
                                        {row.inst_count > 0 && <span className={styles.instBadge}>🏦 {row.inst_count} Inst</span>}
                                        {row.tech_count > 0 && <span className={styles.techBadge}>📐 {row.tech_count} Tech</span>}
                                    </td>
                                    <td className={styles.metricCell}>{row.unique_coins}</td>
                                    <td>{row.density}<span className={styles.unit}>/min</span></td>
                                    <td className={row.bias.includes('BULL') ? styles.bull : styles.bear}>
                                        {row.bias}
                                    </td>
                                    <td className={parseFloat(row.mom_pct) > 0 ? styles.bull : styles.bear}>{row.mom_pct}%</td>
                                    <td className={styles.timelineCell} title={row.full_timeline || row.timeline}>{row.timeline}</td>
                                </tr>
                            )})}
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
