import React, { useMemo, useState } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import {
    ComposedChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Brush, ReferenceArea
} from 'recharts';
import { format, startOfDay, addHours } from 'date-fns';

export function AlertFrequencyTimeline() {
    const { analyticsData } = useTimeStore();

    const [brushRange, setBrushRange] = useState(() => {
        try {
            const saved = localStorage.getItem('tv_alertFreqBrush');
            if (saved) return JSON.parse(saved);
        } catch (e) {}
        return null;
    });

    const handleBrushChange = (newRange) => {
        if (newRange && newRange.startIndex !== undefined) {
            setBrushRange({ startIndex: newRange.startIndex, endIndex: newRange.endIndex });
            localStorage.setItem('tv_alertFreqBrush', JSON.stringify({ startIndex: newRange.startIndex, endIndex: newRange.endIndex }));
        }
    };

    const { chartData, timezones } = useMemo(() => {
        if (!analyticsData || !analyticsData.time_spread || analyticsData.time_spread.length === 0) {
            return { chartData: [], timezones: [] };
        }
        
        // time_spread is grouped by clusters with properties: timestamp/start_time/count/bullish/bearish
        // It comes sorted DESC, so let's reverse it for the chart (left to right = oldest to newest)
        const sortedData = [...analyticsData.time_spread].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());

        const data = sortedData.map(t => {
            return {
                timestamp_ms: new Date(t.start_time).getTime(),
                timeLabel: format(new Date(t.start_time), 'MMM d, HH:mm'),
                bull_count: t.bullish || 0,
                bear_count: t.bearish || 0,
                total_density: t.count || 0,
                coins: t.timeline || ''
            };
        });

        // Generate Timezone Markers
        const firstTime = data[0].timestamp_ms;
        const lastTime = data[data.length - 1].timestamp_ms;
        const markers = [];
        
        let startDay = startOfDay(new Date(firstTime));
        const endDay = startOfDay(new Date(lastTime));

        while (startDay.getTime() <= endDay.getTime()) {
            const baseUTC = Date.UTC(startDay.getFullYear(), startDay.getMonth(), startDay.getDate());
            markers.push({ name: 'ASIA', fill: 'rgba(59, 130, 246, 0.12)', start: baseUTC, end: baseUTC + 9 * 3600000 });
            markers.push({ name: 'LONDON', fill: 'rgba(234, 179, 8, 0.12)', start: baseUTC + 8 * 3600000, end: baseUTC + 17 * 3600000 });
            markers.push({ name: 'NY AM', fill: 'rgba(16, 185, 129, 0.12)', start: baseUTC + 13 * 3600000, end: baseUTC + 18 * 3600000 });
            markers.push({ name: 'NY PM', fill: 'rgba(239, 68, 68, 0.12)', start: baseUTC + 18 * 3600000, end: baseUTC + 24 * 3600000 });
            startDay = addHours(startDay, 24);
        }

        return { chartData: data, timezones: markers };
    }, [analyticsData]);

    if (chartData.length === 0) {
        return (
            <div className="flex items-center justify-center p-8 text-gray-500 font-mono text-xs border rounded-lg bg-[var(--bg-card)] border-[var(--border-subtle)]">
                AWAITING ALERT DENSITY DATA...
            </div>
        );
    }

    const CustomTooltip = ({ active, payload }) => {
        if (active && payload && payload.length) {
            const p = payload[0].payload;
            return (
                <div className="p-3 rounded shadow-lg border bg-[var(--bg-card)] border-[var(--border-subtle)] text-[var(--text-primary)] min-w-[200px]">
                    <div className="font-bold mb-2 text-xs text-[var(--text-secondary)]">{p.timeLabel}</div>
                    
                    <div className="flex justify-between items-center py-1 text-xs font-mono">
                        <span className="text-[#10B981] font-bold">Bullish Alerts</span>
                        <span className="font-bold">{p.bull_count}</span>
                    </div>
                    <div className="flex justify-between items-center py-1 text-xs font-mono">
                        <span className="text-[#EF4444] font-bold">Bearish Alerts</span>
                        <span className="font-bold">{p.bear_count}</span>
                    </div>
                    
                    <div className="mt-2 pt-2 border-t border-[var(--border-subtle)]">
                        <span className="text-[10px] text-[var(--text-tertiary)] block mb-1 uppercase tracking-wider">Involved Assets</span>
                        <span className="text-[10px] font-mono text-[var(--text-secondary)] leading-tight">{p.coins}</span>
                    </div>
                </div>
            );
        }
        return null;
    };

    return (
        <div className="flex flex-col w-full p-4 h-[300px] rounded-lg shadow-sm bg-[var(--bg-card)] border border-[var(--border-subtle)]">
            <div className="flex items-center justify-between mb-4">
                <div className="flex gap-2 items-center">
                    <span className="text-xl">📊</span>
                    <h3 className="text-sm font-bold uppercase text-[var(--text-secondary)] tracking-wider">Alert Frequency Analyzer</h3>
                </div>
                <div className="flex items-center gap-4 text-[10px] font-bold uppercase text-[var(--text-tertiary)]">
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-blue-500/20 border border-blue-500/50"></div> ASIA</span>
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-yellow-500/20 border border-yellow-500/50"></div> LONDON</span>
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-emerald-500/20 border border-emerald-500/50"></div> NY AM</span>
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-red-500/20 border border-red-500/50"></div> NY PM</span>
                </div>
            </div>

            <div className="flex-1 w-full min-h-[200px]">
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                        <XAxis 
                            dataKey="timestamp_ms" 
                            type="number" 
                            scale="time" 
                            domain={['dataMin', 'dataMax']} 
                            tickFormatter={(unixTime) => format(new Date(unixTime), 'HH:mm')} 
                            tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }}
                            minTickGap={60}
                            axisLine={false}
                            tickLine={false}
                        />
                        <YAxis hide domain={[0, 'auto']} />

                        <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,46,147,0.1)' }} />

                        {timezones.map((tz, i) => (
                            <ReferenceArea 
                                key={i}
                                x1={tz.start} 
                                x2={tz.end} 
                                fill={tz.fill} 
                                strokeOpacity={0}
                                ifOverflow="hidden"
                            />
                        ))}

                        <Bar 
                            dataKey="bull_count" 
                            stackId="a" 
                            fill="#10B981" 
                            barSize={8}
                            radius={[0, 0, 4, 4]} 
                            isAnimationActive={false}
                        />
                        <Bar 
                            dataKey="bear_count" 
                            stackId="a" 
                            fill="#EF4444" 
                            barSize={8}
                            radius={[4, 4, 0, 0]} 
                            isAnimationActive={false}
                        />
                        
                        <Brush 
                            dataKey="timestamp_ms" 
                            height={25} 
                            stroke="var(--text-tertiary)" 
                            fill="var(--bg-app)"
                            tickFormatter={(unixTime) => format(new Date(unixTime), 'HH:mm')}
                            onChange={handleBrushChange}
                            {...(brushRange ? { startIndex: brushRange.startIndex, endIndex: brushRange.endIndex } : {})}
                        />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}

export default AlertFrequencyTimeline;
