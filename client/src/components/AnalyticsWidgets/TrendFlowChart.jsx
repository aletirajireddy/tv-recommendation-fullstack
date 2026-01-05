import React, { useMemo } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { toMoodFlowData } from '../../utils/chartAdapters';
import styles from './TrendFlowChart.module.css';
import { BarChart2, RefreshCw } from 'lucide-react';
import {
    ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';

export function TrendFlowChart() {
    const { analyticsData, refreshAll } = useTimeStore();

    const data = useMemo(() =>
        toMoodFlowData(analyticsData?.time_spread),
        [analyticsData]);

    const handleRefresh = (e) => {
        e.stopPropagation();
        refreshAll();
    };

    if (!data || data.length === 0) return null;

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <BarChart2 size={18} />
                    <h3>MARKET MOOD & MOMENTUM FLOW</h3>
                </div>
                <button
                    onClick={handleRefresh}
                    style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer' }}
                >
                    <RefreshCw size={14} />
                </button>
            </div>

            <div className={styles.chartWrapper} style={{ height: 250 }}>
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                        data={data}
                        margin={{ top: 20, right: 30, left: 0, bottom: 5 }}
                    >
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                        <XAxis
                            dataKey="label"
                            stroke="var(--text-tertiary)"
                            fontSize={10}
                            tickLine={false}
                        />
                        <YAxis
                            yAxisId="left"
                            stroke="var(--text-tertiary)"
                            fontSize={10}
                            tickLine={false}
                            label={{ value: 'Vol', angle: -90, position: 'insideLeft', fill: 'var(--text-secondary)', fontSize: 10 }}
                        />
                        <YAxis
                            yAxisId="right"
                            orientation="right"
                            stroke="var(--accent-primary)"
                            fontSize={10}
                            tickLine={false}
                            domain={[-100, 100]} // Mood Score Range
                            label={{ value: 'Mood Score', angle: 90, position: 'insideRight', fill: 'var(--accent-primary)', fontSize: 10 }}
                        />
                        <Tooltip
                            contentStyle={{ backgroundColor: 'var(--bg-card)', border: '1px solid var(--border-subtle)' }}
                            cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                        />
                        <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />

                        <Bar yAxisId="left" dataKey="bull" name="Bullish Vol" stackId="a" fill="var(--success)" radius={[0, 0, 4, 4]} barSize={20} />
                        <Bar yAxisId="left" dataKey="bear" name="Bearish Vol" stackId="a" fill="var(--error)" radius={[4, 4, 0, 0]} barSize={20} />

                        <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="moodScore"
                            name="Mood Score"
                            stroke="var(--accent-primary)"
                            strokeWidth={2}
                            dot={{ fill: 'var(--accent-primary)', r: 3 }}
                        />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}
