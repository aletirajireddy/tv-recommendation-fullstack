import React, { useEffect, useState } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { Activity, RefreshCw, Zap, TrendingUp, TrendingDown } from 'lucide-react';
import {
    ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts';
import { format } from 'date-fns';

export function ParticipationPulseWidget() {
    const {
        participationPulse, fetchParticipationPulse, lookbackHours, setLookbackHours, pulseLoading
    } = useTimeStore();
    const [isMobile, setIsMobile] = useState(false);
    const [rangeMinutes, setRangeMinutes] = useState(45); // Default 45m zoom for wide layout

    useEffect(() => {
        const mql = window.matchMedia('(pointer: coarse)');
        setIsMobile(mql.matches);
        const handler = (e) => setIsMobile(e.matches);
        mql.addEventListener('change', handler);
        return () => mql.removeEventListener('change', handler);
    }, []);

    useEffect(() => {
        fetchParticipationPulse();
    }, []);

    const [isPulsing, setIsPulsing] = useState(false);
    useEffect(() => {
        if (participationPulse && participationPulse.length > 0) {
            setIsPulsing(false);
            const trigger = setTimeout(() => setIsPulsing(true), 10);
            const timer = setTimeout(() => setIsPulsing(false), 1300);
            return () => { clearTimeout(trigger); clearTimeout(timer); };
        }
    }, [participationPulse]);

    const chartData = React.useMemo(() => {
        if (!participationPulse || participationPulse.length === 0) return [];
        
        // Filter by selected range RELATIVE to the last data point's time (prevents clock drift issues)
        const lastPoint = participationPulse[participationPulse.length - 1];
        const lastTime = new Date(lastPoint.time).getTime();
        const cutoff = lastTime - (rangeMinutes * 60 * 1000);
        
        const filtered = participationPulse.filter(p => new Date(p.time).getTime() >= cutoff);
        
        // If range is extremely small (0-3 points), show at least 15 points to keep graph stability
        let dataToProcess = filtered.length > 3 ? filtered : participationPulse.slice(-15);

        // FATAL FIX: Recharts needs at least 2 points to draw anything. 
        // If we only have 1 point (scout just started), clone it with a 1ms offset to force a render.
        if (dataToProcess.length === 1) {
            const clone = { ...dataToProcess[0], time: new Date(new Date(dataToProcess[0].time).getTime() + 1000).toISOString() };
            dataToProcess = [dataToProcess[0], clone];
        }

        return dataToProcess.map(p => {
            const base = p.active_count || 0;
            const rawBull = p.bullish_heat || 0;
            const rawBear = p.bearish_heat || 0;
            
            const scaler = 10; 
            const scaledBull = Math.min(rawBull / scaler, 40);
            const scaledBear = Math.min(rawBear / scaler, 40);

            return {
                ...p,
                timeLabel: format(new Date(p.time), 'HH:mm'),
                bull_range: [base, base + scaledBull],     
                bear_range: [base - scaledBear, base],     
                // Flattened props for YAxis domain calculation safety
                y_max: base + scaledBull + 5,
                y_min: base - scaledBear - 5
            };
        });
    }, [participationPulse, rangeMinutes]);

    if(chartData.length === 0) return null;

    const latest = chartData[chartData.length - 1] || {};

    const isBullDominant = latest.bullish_heat > (latest.bearish_heat * 1.5) && latest.bullish_heat > 10;
    const isBearDominant = latest.bearish_heat > (latest.bullish_heat * 1.5) && latest.bearish_heat > 10;
    const isNeutral = !isBullDominant && !isBearDominant;

    // Custom Tooltip Component
    const CustomTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            const p = payload[0].payload;
            return (
                <div className="p-3 rounded-lg shadow-lg border" style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', minWidth: '180px'}}>
                    <div className="font-bold mb-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{label}</div>
                    
                    <div className="flex justify-between items-center py-2 text-sm font-mono border-b border-gray-700/50 mb-2">
                        <span style={{ color: '#FF2E93', fontSize: '0.75rem', fontWeight: 600 }}>ACTIVE COINS</span>
                        <span className="font-bold text-[#FF2E93] text-lg">{p.active_count}</span>
                    </div>

                    <div className="flex justify-between items-center py-1 text-xs font-mono">
                        <span className="text-[#10B981]">Bullish Heat</span>
                        <span className="font-bold">+{p.bullish_heat}</span>
                    </div>
                    <div className="flex justify-between items-center py-1 text-xs font-mono">
                        <span className="text-[#EF4444]">Bearish Heat</span>
                        <span className="font-bold">-{p.bearish_heat}</span>
                    </div>
                </div>
            );
        }
        return null;
    };

    return (
        <div className={`flex flex-col w-full p-4 h-full rounded-lg shadow-sm ${isPulsing ? 'animate-widget-glow' : ''}`} style={{ backgroundColor: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
            
            <div className="flex items-center justify-between mb-2 pb-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <div className="flex items-center gap-2">
                    <Activity size={18} className="text-[#FF2E93]" />
                    <h3 className="text-sm font-bold uppercase" style={{ color: 'var(--text-secondary)' }}>Scout Screener Engine</h3>
                </div>
                
                <div className="flex gap-4 items-center">
                    <div className="flex items-center bg-[var(--bg-app)] rounded-md p-0.5 border border-[var(--border-subtle)] mr-2">
                        {[15, 30, 45, 60, 120].map(m => (
                            <button
                                key={m}
                                onClick={() => setRangeMinutes(m)}
                                className={`px-2 py-0.5 text-[9px] font-bold rounded transition-colors ${rangeMinutes === m ? 'bg-[#FF2E93] text-white' : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}`}
                            >
                                {m >= 60 ? `${m/60}H` : `${m}M`}
                            </button>
                        ))}
                    </div>

                    <div className="flex flex-col items-end">
                        <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Active Scanned</span>
                        <span className="text-lg font-bold font-mono text-[#FF2E93]">{latest.active_count || 0}</span>
                    </div>
                    <div className="flex flex-col items-end">
                        <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Net Internal Flow</span>
                        <span className={`text-lg font-bold font-mono ${latest.net_heat > 0 ? 'text-[#10B981]' : latest.net_heat < 0 ? 'text-[#EF4444]' : 'text-gray-400'}`}>
                            {latest.net_heat > 0 ? '+' : ''}{latest.net_heat || 0}
                        </span>
                    </div>
                </div>
            </div>

            {/* Dynamic Interpretation */}
            <div className="flex items-center gap-2 mb-4 p-2 rounded text-xs" style={{ backgroundColor: 'var(--bg-app)' }}>
                {isBullDominant && <><TrendingUp size={14} className="text-[#10B981]" /> <span className="font-semibold text-[#10B981]">Bull Expansion:</span> <span>Internal momentum of scanned coins is heavily bullish.</span></>}
                {isBearDominant && <><TrendingDown size={14} className="text-[#EF4444]" /> <span className="font-semibold text-[#EF4444]">Bear Contraction:</span> <span>Scanned coins are breaking down structurally.</span></>}
                {isNeutral && <><Zap size={14} className="text-[#FACC15]" /> <span className="font-semibold text-[#FACC15]">Mixed Distribution:</span> <span>Internal strength is fragmented. Choppy momentum.</span></>}
            </div>

            <div className="flex-1 min-h-[160px] w-full mt-2">
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 15, right: 0, left: 10, bottom: 0 }}>
                        <defs>
                            <linearGradient id="colorBull" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#10B981" stopOpacity={0.8}/>
                                <stop offset="95%" stopColor="#10B981" stopOpacity={0.1}/>
                            </linearGradient>
                            <linearGradient id="colorBear" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#EF4444" stopOpacity={0.1}/>
                                <stop offset="95%" stopColor="#EF4444" stopOpacity={0.8}/>
                            </linearGradient>
                        </defs>
                        <XAxis 
                            dataKey="timeLabel" 
                            axisLine={false} 
                            tickLine={false} 
                            tick={{ fontSize: 9, fill: 'var(--text-tertiary)' }}
                            minTickGap={30}
                        />
                        {/* Show YAxis slightly padded so mountains don't crop */}
                        <YAxis hide={true} domain={['dataMin', 'dataMax']} />
                        
                        <Tooltip 
                            content={<CustomTooltip />} 
                            cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,46,147,0.3)' }}
                            isAnimationActive={false}
                            trigger={isMobile ? 'click' : 'hover'}
                            shared={true}
                        />
                        
                        {/* 1. Bearish Valley */}
                        <Area 
                            type="linear" 
                            dataKey="bear_range" 
                            stroke="none" 
                            fill="url(#colorBear)" 
                            isAnimationActive={false}
                        />

                        {/* 2. Bullish Mountain */}
                        <Area 
                            type="linear" 
                            dataKey="bull_range" 
                            stroke="none" 
                            fill="url(#colorBull)" 
                            isAnimationActive={false}
                        />

                        {/* 3. The Baseline Active Count (Hidden lines to help YAxis domain) */}
                        <Line dataKey="y_max" hide stroke="none" />
                        <Line dataKey="y_min" hide stroke="none" />

                        <Line 
                            type="linear" 
                            dataKey="active_count" 
                            stroke="#FF2E93" 
                            strokeWidth={3} 
                            dot={false}
                            isAnimationActive={false} 
                            activeDot={{ r: 6, fill: '#FF2E93', stroke: 'var(--bg-card)', strokeWidth: 2 }}
                        />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
            
            <div className="flex justify-between items-center mt-4 px-2">
                <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Geometric Heat Flow Overlay</div>
                <div className="flex gap-4 text-[10px] font-bold uppercase" style={{ color: 'var(--text-tertiary)' }}>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full shadow-[0_0_6px_#10B981] bg-[#10B981]"></span> Internal Bulls</span>
                    <span className="flex items-center gap-1"><span className="w-4 h-[3px] shadow-[0_0_6px_#FF2E93] bg-[#FF2E93]"></span> Scanned Count</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full shadow-[0_0_6px_#EF4444] bg-[#EF4444]"></span> Internal Bears</span>
                </div>
            </div>
            
        </div>
    );
}

export default ParticipationPulseWidget;
