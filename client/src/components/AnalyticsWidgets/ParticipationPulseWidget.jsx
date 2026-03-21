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

    const chartData = React.useMemo(() => {
        if (!participationPulse || participationPulse.length === 0) return [];
        return participationPulse.map(p => {
            const base = p.active_count || 0;
            const rawBull = p.bullish_heat || 0;
            const rawBear = p.bearish_heat || 0;
            
            // Dynamic scaling to prevent the oscillator from blowing out the chart if heat > 300
            // We want the peak visual mountain to be around 25-30 units max visually
            const scaler = 10; 
            const scaledBull = Math.min(rawBull / scaler, 40);
            const scaledBear = Math.min(rawBear / scaler, 40);

            return {
                ...p,
                timeLabel: format(new Date(p.time), 'HH:mm'),
                bull_range: [base, base + scaledBull],     // Sits ON TOP of the Pink Line
                bear_range: [base - scaledBear, base],     // Hangs BELOW the Pink Line
                scaled_bull: scaledBull,
                scaled_bear: scaledBear
            };
        });
    }, [participationPulse]);

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
        <div className="flex flex-col w-full p-4 h-full rounded-lg shadow-sm" style={{ backgroundColor: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
            
            <div className="flex items-center justify-between mb-2 pb-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <div className="flex items-center gap-2">
                    <Activity size={18} className="text-[#FF2E93]" />
                    <h3 className="text-sm font-bold uppercase" style={{ color: 'var(--text-secondary)' }}>Scout Screener Engine</h3>
                </div>
                
                <div className="flex gap-4">
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
                        {/* Hide YAxis but let it calculate boundaries correctly so mountains don't crop off top of container */}
                        <YAxis hide={true} domain={['auto', 'auto']} />
                        
                        <Tooltip 
                            content={<CustomTooltip />} 
                            cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.1)' }}
                            isAnimationActive={false}
                            trigger={isMobile ? 'click' : 'hover'}
                        />
                        
                        {/* 1. Bearish Valley (Hangs identically below pink line) */}
                        <Area 
                            type="monotone" 
                            dataKey="bear_range" 
                            stroke="none" 
                            fill="url(#colorBear)" 
                            isAnimationActive={false}
                        />

                        {/* 2. Bullish Mountain (Sits identically on top of pink line) */}
                        <Area 
                            type="monotone" 
                            dataKey="bull_range" 
                            stroke="none" 
                            fill="url(#colorBull)" 
                            isAnimationActive={false}
                        />

                        {/* 3. The Baseline Active Count (Pink Line seamlessly separating the mountains/valleys) */}
                        <Line 
                            type="monotone" 
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
