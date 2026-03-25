import React, { useMemo, useState } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import {
    ComposedChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Brush, ReferenceArea, ReferenceLine
} from 'recharts';
import { format, startOfDay, addHours } from 'date-fns';

export function MarketSentimentTimeline() {
    const timeline = useTimeStore(s => s.timeline);

    const [brushRange, setBrushRange] = useState(() => {
        try {
            const saved = localStorage.getItem('tv_marketSentimentBrush');
            if (saved) return JSON.parse(saved);
        } catch (e) {}
        return { startIndex: undefined, endIndex: undefined, isLive: true, windowSize: 0 };
    });


    const { chartData, timezones } = useMemo(() => {
        if (!timeline || timeline.length === 0) return { chartData: [], timezones: [] };
        
        const data = timeline.map(t => {
            const mood = t.mood || 0;
            return {
                timestamp_ms: new Date(t.timestamp).getTime(),
                timeLabel: format(new Date(t.timestamp), 'MMM d, HH:mm'),
                bull_flow: mood > 0 ? mood : 0,
                bear_flow: mood < 0 ? mood : 0, // Plot negatively so line descends from 0
                net_flow: mood
            };
        });

        // Generate Timezone Markers
        const firstTime = data[0].timestamp_ms;
        const lastTime = data[data.length - 1].timestamp_ms;
        const markers = [];
        
        let startDay = startOfDay(new Date(firstTime));
        const endDay = startOfDay(new Date(lastTime));

        while (startDay.getTime() <= endDay.getTime()) {
            // UTC Sessions mapped to user's requested markers
            // Example: Asia -> 5:30AM - 2:30pm IST (00:00 - 09:00 UTC)
            // Note: date-fns addHours works in local time. We need to be careful.
            // The safest way is to use UTC calculations for the blocks.
            const baseUTC = Date.UTC(startDay.getFullYear(), startDay.getMonth(), startDay.getDate());
            
            // Asia: 00:00 to 09:00 UTC
            markers.push({ name: 'ASIA', fill: 'rgba(59, 130, 246, 0.12)', start: baseUTC, end: baseUTC + 9 * 3600000 });
            // London: 08:00 to 17:00 UTC
            markers.push({ name: 'LONDON', fill: 'rgba(234, 179, 8, 0.12)', start: baseUTC + 8 * 3600000, end: baseUTC + 17 * 3600000 });
            // NY AM: 13:00 to 18:00 UTC
            markers.push({ name: 'NY AM', fill: 'rgba(16, 185, 129, 0.12)', start: baseUTC + 13 * 3600000, end: baseUTC + 18 * 3600000 });
            // NY PM: 18:00 to 24:00 UTC
            markers.push({ name: 'NY PM', fill: 'rgba(239, 68, 68, 0.12)', start: baseUTC + 18 * 3600000, end: baseUTC + 24 * 3600000 });
            
            startDay = addHours(startDay, 24);
        }

        return { chartData: data, timezones: markers };
    }, [timeline]);

    const handleBrushChange = (newRange) => {
        if (newRange && newRange.startIndex !== undefined) {
            const isAtEnd = newRange.endIndex === chartData.length - 1;
            const size = newRange.endIndex - newRange.startIndex;
            const state = { startIndex: newRange.startIndex, endIndex: newRange.endIndex, isLive: isAtEnd, windowSize: size };
            setBrushRange(state);
            localStorage.setItem('tv_marketSentimentBrush', JSON.stringify(state));
        }
    };

    // Auto-Follow Logic for Streaming Data
    React.useEffect(() => {
        if (chartData.length > 0 && brushRange.isLive) {
            const lastIdx = chartData.length - 1;
            if (brushRange.endIndex !== lastIdx) {
                const newStart = brushRange.startIndex !== undefined 
                    ? Math.max(0, lastIdx - brushRange.windowSize)
                    : undefined;
                
                setBrushRange(prev => ({
                    ...prev,
                    startIndex: newStart,
                    endIndex: lastIdx
                }));
            }
        }
    }, [chartData.length, brushRange.isLive, brushRange.windowSize, brushRange.startIndex, brushRange.endIndex]);

    if (chartData.length === 0) {
        return (
            <div className="flex items-center justify-center p-8 text-gray-500 font-mono text-xs border rounded-lg bg-[var(--bg-card)] border-[var(--border-subtle)]">
                AWAITING MACRO TIMELINE...
            </div>
        );
    }

    const CustomTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            const p = payload[0].payload;
            return (
                <div className="p-3 rounded shadow-lg border bg-[var(--bg-card)] border-[var(--border-subtle)] text-[var(--text-primary)] min-w-[160px]">
                    <div className="font-bold mb-2 text-xs text-[var(--text-secondary)]">{p.timeLabel}</div>
                    <div className="flex justify-between items-center py-1 text-xs font-mono border-b border-gray-700/50 mb-1">
                        <span className="font-bold tracking-wider">NET MOOD</span>
                        <span className={`font-bold ${p.net_flow > 0 ? 'text-[#10B981]' : p.net_flow < 0 ? 'text-[#EF4444]' : 'text-gray-400'}`}>
                            {p.net_flow > 0 ? '+' : ''}{p.net_flow}
                        </span>
                    </div>
                </div>
            );
        }
        return null;
    };

    return (
        <div className="flex flex-col w-full p-4 h-[300px] rounded-lg shadow-sm bg-[var(--bg-card)] border border-[var(--border-subtle)] mb-4">
            <div className="flex items-center justify-between mb-4">
                <div className="flex gap-2 items-center">
                    <span className="text-xl">🌊</span>
                    <h3 className="text-sm font-bold uppercase text-[var(--text-secondary)] tracking-wider">Market Sentiment Analyzer</h3>
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
                        <defs>
                            <linearGradient id="glowBull" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#10B981" stopOpacity={0.6} />
                                <stop offset="95%" stopColor="#10B981" stopOpacity={0.05} />
                            </linearGradient>
                            <linearGradient id="glowBear" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#EF4444" stopOpacity={0.6} />
                                <stop offset="95%" stopColor="#EF4444" stopOpacity={0.05} />
                            </linearGradient>
                        </defs>

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
                        <YAxis 
                            domain={[-100, 100]} 
                            tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} 
                            axisLine={false} 
                            tickLine={false} 
                            width={35} 
                        />
                        <ReferenceLine y={0} stroke="var(--border-subtle)" strokeDasharray="3 3" />

                        <Tooltip content={<CustomTooltip />} />

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

                        <Area 
                            type="monotone" 
                            dataKey="bull_flow" 
                            stroke="#10B981" 
                            strokeWidth={2} 
                            fill="url(#glowBull)" 
                            isAnimationActive={false} 
                        />
                        <Area 
                            type="monotone" 
                            dataKey="bear_flow" 
                            stroke="#EF4444" 
                            strokeWidth={2} 
                            fill="url(#glowBear)" 
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

export default MarketSentimentTimeline;
