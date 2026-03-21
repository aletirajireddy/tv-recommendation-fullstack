import React, { useEffect } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { format } from 'date-fns';
import { Zap, TrendingUp, TrendingDown } from 'lucide-react';

export function ParticipationPulseWidget() {
    const { participationPulse, fetchParticipationPulse } = useTimeStore();

    useEffect(() => {
        fetchParticipationPulse();
    }, []);

    if (!participationPulse || participationPulse.length === 0) {
        return null;
    }

    // Process data for chart: We want outflows to be negative for a mirrored chart
    const chartData = participationPulse.map(p => ({
        ...p,
        outflow_display: -p.outflow, // For stacked feeling below zero
        timeLabel: format(new Date(p.time), 'HH:mm')
    }));

    // Find latest stats
    const latest = chartData[chartData.length - 1] || {};
    const prev = chartData[chartData.length - 2] || { inflow: 0, outflow: 0, net: 0, total_visible: 0 };
    
    // Determine overall Pulse status
    const isAccelerating = latest.inflow > latest.outflow && latest.net > 0;
    const isExhausted = latest.inflow === 0 && latest.outflow > 0;
    const isRotating = latest.inflow > 0 && latest.outflow > 0;

    // Helper to get heat color
    const getHeatColor = (heatScore) => {
        if (heatScore >= 30) return '#10B981'; // Strong Bull (Green)
        if (heatScore >= 10) return '#34D399'; // Mild Bull
        if (heatScore <= -30) return '#EF4444'; // Strong Bear (Red)
        if (heatScore <= -10) return '#F87171'; // Mild Bear
        return '#9CA3AF'; // Neutral (Gray)
    };

    return (
        <div className="flex flex-col w-full p-4 mb-4 rounded-lg shadow-sm" style={{ backgroundColor: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
            
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                    <Zap size={18} className="text-[#8B5CF6]" />
                    <h3 className="text-sm font-bold uppercase" style={{ color: 'var(--text-secondary)' }}>Market Participation Pulse</h3>
                </div>
                
                <div className="flex gap-4">
                    <div className="flex flex-col items-end">
                        <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Total Active</span>
                        <span className="text-sm font-bold font-mono">{latest.total_visible || 0}</span>
                    </div>
                    <div className="flex flex-col items-end">
                        <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Net Flow</span>
                        <span className={`text-sm font-bold font-mono ${latest.net > 0 ? 'text-[var(--success)]' : latest.net < 0 ? 'text-[var(--error)]' : ''}`}>
                            {latest.net > 0 ? '+' : ''}{latest.net || 0}
                        </span>
                    </div>
                </div>
            </div>

            {/* Dynamic Status Interpretation */}
            <div className="flex items-center gap-2 mb-4 p-2 rounded text-xs" style={{ backgroundColor: 'var(--bg-app)' }}>
                {isAccelerating && <><TrendingUp size={14} className="text-[var(--success)]" /> <span className="font-semibold text-[var(--success)]">Accelerating:</span> <span>New capital/momentum is entering the active list.</span></>}
                {isExhausted && <><TrendingDown size={14} className="text-[var(--error)]" /> <span className="font-semibold text-[var(--error)]">Exhausting:</span> <span>Move is fading. Coins dropping off with no new buyers.</span></>}
                {isRotating && !isAccelerating && !isExhausted && <><Zap size={14} className="text-[#8B5CF6]" /> <span className="font-semibold text-[#8B5CF6]">Rotating:</span> <span>Capital is rapidly shifting between assets.</span></>}
                {!isAccelerating && !isExhausted && !isRotating && <span className="text-gray-500">Stable Market: Minimal change in participation.</span>}
            </div>

            <div className="h-[120px] w-full mt-2">
                <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
                        <defs>
                            {/* Gradients to represent dynamic Inflow Heat. For simplicity in AreaChart, we map the latest heat, or fallback to solid colors if AreaChart doesn't support array-based dynamic stops well. */}
                            <linearGradient id="colorInflow" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={getHeatColor(latest.inflow_heat)} stopOpacity={0.8}/>
                                <stop offset="95%" stopColor={getHeatColor(latest.inflow_heat)} stopOpacity={0.1}/>
                            </linearGradient>
                            <linearGradient id="colorOutflow" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={getHeatColor(latest.outflow_heat)} stopOpacity={0.1}/>
                                <stop offset="95%" stopColor={getHeatColor(latest.outflow_heat)} stopOpacity={0.8}/>
                            </linearGradient>
                        </defs>
                        <XAxis 
                            dataKey="timeLabel" 
                            axisLine={false} 
                            tickLine={false} 
                            tick={{ fontSize: 9, fill: 'var(--text-tertiary)' }}
                            minTickGap={30}
                        />
                        <Tooltip 
                            contentStyle={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-subtle)', borderRadius: '8px', fontSize: '11px' }}
                            labelStyle={{ color: 'var(--text-secondary)', fontWeight: 'bold', marginBottom: '4px' }}
                            formatter={(value, name, props) => {
                                if (name === 'inflow') return [`${value} coins (Heat: ${props.payload.inflow_heat})`, '⬆️ Inflow'];
                                if (name === 'outflow_display') return [`${Math.abs(value)} coins (Heat: ${props.payload.outflow_heat})`, '⬇️ Outflow'];
                                return [value, name];
                            }}
                        />
                        <ReferenceLine y={0} stroke="var(--border-subtle)" strokeDasharray="3 3" />
                        <Area 
                            type="monotone" 
                            dataKey="inflow" 
                            stroke={getHeatColor(latest.inflow_heat)} 
                            fillOpacity={1} 
                            fill="url(#colorInflow)" 
                            isAnimationActive={false}
                        />
                        <Area 
                            type="monotone" 
                            dataKey="outflow_display" 
                            stroke={getHeatColor(latest.outflow_heat)} 
                            fillOpacity={1} 
                            fill="url(#colorOutflow)" 
                            isAnimationActive={false}
                        />
                    </AreaChart>
                </ResponsiveContainer>
            </div>
            
            <div className="flex justify-between items-center mt-2 px-2">
                <div className="text-[9px] uppercase tracking-wider text-gray-400">Time-Series Aggregation (5m Intervals)</div>
                <div className="flex gap-3 text-[9px] uppercase text-gray-400">
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-[#10B981]"></span> Bullish Heat</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-gray-400"></span> Neutral</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-[#EF4444]"></span> Bearish Heat</span>
                </div>
            </div>
            
        </div>
    );
}

export default ParticipationPulseWidget;
