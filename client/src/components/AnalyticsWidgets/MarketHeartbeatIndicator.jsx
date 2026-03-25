import React, { useMemo, useState } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import {
    ComposedChart, Area, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Brush, ReferenceArea
} from 'recharts';
import { format, startOfDay, addHours } from 'date-fns';

export function MarketHeartbeatIndicator() {
    const timeline = useTimeStore(s => s.timeline);
    const analyticsData = useTimeStore(s => s.analyticsData);

    const [brushRange, setBrushRange] = useState(() => {
        try {
            const saved = localStorage.getItem('tv_heartbeatBrush');
            if (saved) return JSON.parse(saved);
        } catch (e) {}
        return { startIndex: undefined, endIndex: undefined, isLive: true, windowSize: 0 };
    });


    const { chartData, timezones } = useMemo(() => {
        if (!timeline || timeline.length === 0) return { chartData: [], timezones: [] };

        const data = timeline.map(scan => {
            const rawMood = scan.mood || 0; // Fix: use scan.mood from V3 /api/ai/history
            return {
                timestamp_ms: new Date(scan.timestamp).getTime(),
                timeLabel: format(new Date(scan.timestamp), 'HH:mm'),
                rawMood: rawMood,
                bullArea: Math.max(0, rawMood), // Ensure it does not render negative
                bearArea: Math.min(0, rawMood), // Bound strictly below 0
                alertCount: 0 
            };
        });

        // 2. Map exact Alert Frequencies from time_spread to the closest scan timeframe
        if (analyticsData?.time_spread) {
            analyticsData.time_spread.forEach(bucket => {
                const bTimeMs = new Date(bucket.start_time || bucket.time).getTime();
                let closestIdx = -1;
                let minDiff = Infinity;
                
                for (let i = 0; i < data.length; i++) {
                    const diff = Math.abs(data[i].timestamp_ms - bTimeMs);
                    if (diff < minDiff) {
                        minDiff = diff;
                        closestIdx = i;
                    }
                }
                
                if (closestIdx !== -1 && minDiff < (30 * 60 * 1000)) { // Only snap if within 30 mins
                    data[closestIdx].alertCount += bucket.count;
                }
            });
        }

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
    }, [timeline]);

    const handleBrushChange = (newRange) => {
        if (newRange && newRange.startIndex !== undefined) {
            const isAtEnd = newRange.endIndex === chartData.length - 1;
            const size = newRange.endIndex - newRange.startIndex;
            const state = { startIndex: newRange.startIndex, endIndex: newRange.endIndex, isLive: isAtEnd, windowSize: size };
            setBrushRange(state);
            localStorage.setItem('tv_heartbeatBrush', JSON.stringify(state));
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

    if(chartData.length === 0) return null;

    const CustomTooltip = ({ active, payload }) => {
        if (active && payload && payload.length) {
            const p = payload[0].payload;
            return (
                <div className="p-2 rounded shadow-lg border bg-[var(--bg-card)] border-[var(--border-subtle)] text-[var(--text-primary)] min-w-[150px] text-xs font-mono">
                    <div className="font-bold mb-1 text-[var(--text-secondary)]">{p.timeLabel}</div>
                    <div className="flex justify-between items-center py-1">
                        <span className="text-[#F59E0B] font-bold">Alert Intensity</span>
                        <span className="font-bold">{p.alertCount}</span>
                    </div>
                    <div className="flex justify-between items-center py-1 border-t border-[var(--border-subtle)]">
                        <span className={p.rawMood > 0 ? "text-[#10B981]" : "text-[#EF4444]"}>Genie Score</span>
                        <span className="font-bold">{p.rawMood > 0 ? '+' : ''}{p.rawMood}</span>
                    </div>
                </div>
            );
        }
        return null;
    };

    return (
        <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 4, left: 8, zIndex: 10, fontSize: '10px', fontWeight: 'bold', color: 'var(--text-tertiary)', letterSpacing: '0.5px' }}>
                MARKET HEARTBEAT
            </div>
            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={chartData} margin={{ top: 20, right: 0, left: 0, bottom: 0 }}>
                    <defs>
                        <linearGradient id="hbBull" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#10B981" stopOpacity={0.6}/>
                            <stop offset="95%" stopColor="#10B981" stopOpacity={0.0}/>
                        </linearGradient>
                        <linearGradient id="hbBear" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#EF4444" stopOpacity={0.0}/>
                            <stop offset="95%" stopColor="#EF4444" stopOpacity={0.6}/>
                        </linearGradient>
                    </defs>
                    
                    <XAxis 
                        dataKey="timestamp_ms" 
                        type="number" 
                        scale="time" 
                        domain={['dataMin', 'dataMax']} 
                        hide
                    />
                    
                    {/* Primary Y-Axis for Mood Score (-100 to 100) */}
                    <YAxis yAxisId="mood" domain={[-100, 100]} hide />
                    
                    {/* Secondary Y-Axis for Alert Count (0 to Max) */}
                    <YAxis yAxisId="alerts" orientation="right" domain={[0, 'dataMax']} hide />

                    <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.05)' }} />

                    {timezones.map((tz, i) => (
                        <ReferenceArea 
                            key={`hb-tz-${i}`}
                            x1={tz.start} 
                            x2={tz.end} 
                            fill={tz.fill} 
                            strokeOpacity={0}
                            ifOverflow="hidden"
                        />
                    ))}

                    <Area 
                        yAxisId="mood"
                        type="step" 
                        dataKey="bullArea" 
                        stroke="#10B981" 
                        fill="url(#hbBull)" 
                        isAnimationActive={false}
                    />
                    <Area 
                        yAxisId="mood"
                        type="step" 
                        dataKey="bearArea" 
                        stroke="#EF4444" 
                        fill="url(#hbBear)" 
                        isAnimationActive={false}
                    />

                    {/* Alert intensity plotted as a Bar on the secondary axis */}
                    <Bar 
                        yAxisId="alerts"
                        dataKey="alertCount" 
                        fill="#F59E0B" 
                        barSize={3}
                        radius={[2, 2, 0, 0]}
                        isAnimationActive={false}
                    />
                    
                    <Brush 
                        dataKey="timestamp_ms" 
                        height={16} 
                        stroke="var(--text-tertiary)" 
                        fill="var(--bg-card)"
                        tickFormatter={() => ''} /* Hide text to save space */
                        onChange={handleBrushChange}
                        {...(brushRange ? { startIndex: brushRange.startIndex, endIndex: brushRange.endIndex } : {})}
                    />
                </ComposedChart>
            </ResponsiveContainer>
        </div>
    );
}

export default MarketHeartbeatIndicator;
