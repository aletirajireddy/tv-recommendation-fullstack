import React, { useMemo } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import {
    ComposedChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Brush, ReferenceArea, ReferenceLine
} from 'recharts';
import { format, startOfDay, addHours } from 'date-fns';
import { useChartBrush } from '../../hooks/useChartBrush';

export function MarketSentimentTimeline() {
    const fullTimeline = useTimeStore(s => s.timeline);
    const currentIndex = useTimeStore(s => s.currentIndex);
    const lookbackHours = useTimeStore(s => s.lookbackHours);

    const { chartData, timezones } = useMemo(() => {
        if (!fullTimeline || fullTimeline.length === 0) return { chartData: [], timezones: [] };
        
        // Time Isolation Protocol
        // Limit backward history to the Lookback Lens
        const refTimeMs = new Date(fullTimeline[currentIndex].timestamp).getTime();
        const cutoffMs = refTimeMs - (lookbackHours * 60 * 60 * 1000);
        const timeline = fullTimeline.slice(0, currentIndex + 1).filter(t => new Date(t.timestamp).getTime() >= cutoffMs);
        
        const data = timeline.map(t => {
            const mood = t.mood || 0;
            return {
                timestamp_ms: new Date(t.timestamp).getTime(),
                timeLabel: format(new Date(t.timestamp), 'MMM d, HH:mm'),
                bull_flow: mood > 0 ? mood : 0,
                bear_flow: mood < 0 ? mood : 0,
                net_flow:  mood
            };
        });

        // Generate Timezone Markers
        const firstTime = data[0].timestamp_ms;
        const lastTime  = data[data.length - 1].timestamp_ms;
        const markers   = [];
        
        let startDay = startOfDay(new Date(firstTime));
        const endDay = startOfDay(new Date(lastTime));

        while (startDay.getTime() <= endDay.getTime()) {
            const baseUTC = Date.UTC(startDay.getFullYear(), startDay.getMonth(), startDay.getDate());
            markers.push({ name: 'ASIA',   fill: 'rgba(59, 130, 246, 0.12)',  start: baseUTC,                      end: baseUTC +  9 * 3600000 });
            markers.push({ name: 'LONDON', fill: 'rgba(234, 179, 8, 0.12)',   start: baseUTC +  8 * 3600000,       end: baseUTC + 17 * 3600000 });
            markers.push({ name: 'NY AM',  fill: 'rgba(16, 185, 129, 0.12)',  start: baseUTC + 13 * 3600000,       end: baseUTC + 18 * 3600000 });
            markers.push({ name: 'NY PM',  fill: 'rgba(239, 68, 68, 0.12)',   start: baseUTC + 18 * 3600000,       end: baseUTC + 24 * 3600000 });
            startDay = addHours(startDay, 24);
        }

        return { chartData: data, timezones: markers };
    }, [fullTimeline, currentIndex, lookbackHours]);

    // ── Shared brush hook (fixes localStorage persistence + live-follow) ──
    const { brushRange, handleBrushChange } = useChartBrush('tv_marketSentimentBrush', chartData);

    if (chartData.length < 2) {
        return (
            <div className="flex items-center justify-center p-8 text-gray-500 font-mono text-xs border rounded-lg bg-[var(--bg-card)] border-[var(--border-subtle)]">
                AWAITING MACRO TIMELINE...
            </div>
        );
    }

    const CustomTooltip = ({ active, payload }) => {
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
        <div className="flex flex-col w-full p-4 rounded-lg shadow-sm bg-[var(--bg-card)] border border-[var(--border-subtle)] mb-4" style={{ touchAction: 'pan-y' }}>
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex gap-2 items-center">
                    <span className="text-xl">🌊</span>
                    <h3 className="text-sm font-bold uppercase text-[var(--text-secondary)] tracking-wider">Market Sentiment Analyzer</h3>
                </div>
                <div className="flex items-center gap-4 text-[10px] font-bold uppercase text-[var(--text-tertiary)]">
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-blue-500/20 border border-blue-500/50" /> ASIA</span>
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-yellow-500/20 border border-yellow-500/50" /> LONDON</span>
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-emerald-500/20 border border-emerald-500/50" /> NY AM</span>
                    <span className="flex items-center gap-1"><div className="w-2 h-2 rounded bg-red-500/20 border border-red-500/50" /> NY PM</span>
                </div>
            </div>

            {/* Chart — fixed height so height doesn't jump */}
            <div style={{ width: '100%', height: '220px' }}>
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                        <defs>
                            <linearGradient id="glowBull" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%"  stopColor="#10B981" stopOpacity={0.6} />
                                <stop offset="95%" stopColor="#10B981" stopOpacity={0.05} />
                            </linearGradient>
                            <linearGradient id="glowBear" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%"  stopColor="#EF4444" stopOpacity={0.6} />
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

                        {/*
                         * Recharts Brush: desktop drag handles (travellerWidth=18 for easier desktop grab)
                         * Mobile touch is fixed by touchAction: pan-y on the wrapper.
                         */}
                        <Brush 
                            dataKey="timestamp_ms" 
                            height={22}
                            travellerWidth={18}
                            stroke="var(--text-tertiary)" 
                            fill="var(--bg-app)"
                            tickFormatter={(unixTime) => format(new Date(unixTime), 'HH:mm')}
                            onChange={handleBrushChange}
                            startIndex={brushRange.startIndex}
                            endIndex={brushRange.endIndex}
                        />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
}

export default MarketSentimentTimeline;
