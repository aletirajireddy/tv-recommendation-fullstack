import React from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend, Label } from 'recharts';

const COLORS = ['#ef4444', '#f59e0b', '#8b5cf6', '#3b82f6', '#10b981'];

export function RejectionPieChart({ data }) {
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
                <div className="pie-spinner"></div>
                <span style={{ fontSize: '0.8rem', marginTop: '10px' }}>NO REJECTION DATA</span>
            </div>
        );
    }

    const total = data.reduce((acc, curr) => acc + curr.value, 0);

    return (
        <div style={{ width: '100%', height: '100%', minHeight: '200px' }}>
            <ResponsiveContainer>
                <PieChart>
                    <Pie
                        data={data}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={80}
                        paddingAngle={5}
                        dataKey="value"
                        animationDuration={1500}
                    >
                        {data.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} stroke="none" />
                        ))}
                        <Label
                            value={total}
                            position="center"
                            fill="var(--text-primary)"
                            style={{ fontSize: '24px', fontWeight: 'bold', fontFamily: 'monospace' }}
                        />
                    </Pie>
                    <Tooltip
                        contentStyle={{
                            backgroundColor: 'var(--bg-card)',
                            borderColor: 'var(--border-subtle)',
                            color: 'var(--text-primary)',
                            borderRadius: '4px'
                        }}
                    />
                    <Legend
                        verticalAlign="bottom"
                        height={36}
                        iconType="circle"
                        formatter={(value) => <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{value}</span>}
                    />
                </PieChart>
            </ResponsiveContainer>
        </div>
    );
}
