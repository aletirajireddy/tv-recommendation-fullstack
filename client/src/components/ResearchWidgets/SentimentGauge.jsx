import React from 'react';
import { RadialBarChart, RadialBar, PolarAngleAxis, ResponsiveContainer } from 'recharts';

export function SentimentGauge({ score }) {
    // Normalize -100 to 100 range to 0-100 for the chart
    const normalized = Math.min(100, Math.max(0, (score + 100) / 2));
    const color = score > 0 ? 'var(--success)' : score < 0 ? 'var(--error)' : 'var(--text-tertiary)';

    const data = [{ name: 'Mood', value: normalized, fill: color }];

    return (
        <div style={{
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '8px',
            padding: '1rem',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%'
        }}>
            <h3 style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>MARKET SENTIMENT</h3>
            <div style={{ width: '100%', height: '150px', position: 'relative' }}>
                <ResponsiveContainer>
                    <RadialBarChart
                        cx="50%"
                        cy="50%"
                        innerRadius="80%"
                        outerRadius="100%"
                        barSize={10}
                        data={data}
                        startAngle={180}
                        endAngle={0}
                    >
                        <RadialBar
                            minAngle={15}
                            background={{ fill: 'var(--bg-main)' }}
                            clockWise
                            dataKey="value"
                            cornerRadius={10}
                        />
                    </RadialBarChart>
                </ResponsiveContainer>
                <div style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -20%)',
                    textAlign: 'center'
                }}>
                    <div style={{ fontSize: '2rem', fontWeight: 700, color: color }}>{score}</div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-tertiary)' }}>SCORE</div>
                </div>
            </div>
        </div>
    );
}
