import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, CartesianGrid } from 'recharts';

export function PersistenceChart({ data }) {
    if (!data || data.length === 0) {
        return (
            <div style={{
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-tertiary)',
                opacity: 0.6
            }}>
                <div className="radar-sweep"></div>
                <span style={{ fontSize: '0.8rem', marginTop: '10px' }}>SEARCHING FOR LOCK...</span>
            </div>
        );
    }

    return (
        <div style={{ width: '100%', height: '100%', minHeight: '300px' }}>
            <ResponsiveContainer>
                <BarChart data={data} layout="vertical" margin={{ left: 40, right: 20, top: 10, bottom: 0 }}>
                    <defs>
                        <linearGradient id="gradHigh" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="var(--success)" stopOpacity={0.6} />
                            <stop offset="100%" stopColor="var(--success)" />
                        </linearGradient>
                        <linearGradient id="gradNormal" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="var(--text-secondary)" stopOpacity={0.4} />
                            <stop offset="100%" stopColor="var(--text-secondary)" />
                        </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="var(--border-subtle)" opacity={0.2} />
                    <XAxis type="number" hide />
                    <YAxis
                        dataKey="ticker"
                        type="category"
                        stroke="var(--text-secondary)"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                        width={60}
                        fontWeight={500}
                    />
                    <Tooltip
                        cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                        contentStyle={{
                            backgroundColor: 'var(--bg-card)',
                            borderColor: 'var(--border-subtle)',
                            color: 'var(--text-primary)',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                            borderRadius: '4px'
                        }}
                    />
                    <Bar dataKey="persistence_score" radius={[0, 4, 4, 0]} barSize={20} animationDuration={1000}>
                        {data.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={index < 3 ? 'url(#gradHigh)' : 'url(#gradNormal)'} />
                        ))}
                    </Bar>
                </BarChart>
            </ResponsiveContainer>
        </div>
    );
}
