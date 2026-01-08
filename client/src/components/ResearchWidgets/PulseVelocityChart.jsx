import React from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';

export function PulseVelocityChart({ data }) {
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
                <div className="spinner" style={{ marginBottom: '10px' }}></div>
                <span style={{ fontSize: '0.8rem', letterSpacing: '1px' }}>AWAITING SIGNAL LOCK...</span>
            </div>
        );
    }

    const formattedData = data.map(d => {
        // Assume 'd.time' is UTC "YYYY-MM-DD HH:mm". We append 'Z' to treat it as UTC for safe parsing.
        // If it's already ISO, 'Z' check handles it.
        const isoString = d.time.includes('T') ? d.time : d.time.replace(' ', 'T') + (d.time.includes('Z') ? '' : ':00Z');
        return {
            dateObj: new Date(isoString),
            count: d.count
        };
    });

    return (
        <div style={{ width: '100%', height: '100%', minHeight: '200px' }}>
            <ResponsiveContainer>
                <AreaChart data={formattedData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                        <linearGradient id="colorVelocity" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="var(--accent-primary)" stopOpacity={0.8} />
                            <stop offset="95%" stopColor="var(--accent-primary)" stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} opacity={0.3} />
                    <XAxis
                        dataKey="dateObj"
                        stroke="var(--text-tertiary)"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        minTickGap={30}
                        tickFormatter={(val) => {
                            if (!val) return '';
                            // Format: MM/DD HH:mm
                            const date = new Date(val);
                            const m = date.getMonth() + 1;
                            const d = date.getDate();
                            const h = date.getHours().toString().padStart(2, '0');
                            const min = date.getMinutes().toString().padStart(2, '0');
                            return `${m}/${d} ${h}:${min}`;
                        }}
                    />
                    <YAxis
                        stroke="var(--text-tertiary)"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        domain={[0, 'auto']}
                    />
                    <Tooltip
                        contentStyle={{
                            backgroundColor: 'var(--bg-card)',
                            borderColor: 'var(--border-subtle)',
                            color: 'var(--text-primary)',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                            borderRadius: '4px'
                        }}
                        itemStyle={{ color: 'var(--accent-primary)' }}
                        formatter={(value) => [`${value} alerts/min`, 'Velocity']}
                    />
                    <Area
                        type="monotone"
                        dataKey="count"
                        stroke="var(--accent-primary)"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorVelocity)"
                        animationDuration={1500}
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}
