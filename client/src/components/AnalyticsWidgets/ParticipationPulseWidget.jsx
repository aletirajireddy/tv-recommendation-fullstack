import React, { useEffect, useState } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { Activity, RefreshCw, Zap, TrendingUp, TrendingDown } from 'lucide-react';
import {
    ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Brush
} from 'recharts';
import { format } from 'date-fns';
import { useChartBrush } from '../../hooks/useChartBrush';

export function ParticipationPulseWidget() {
    const participationPulse = useTimeStore(s => s.participationPulse);
    const fetchParticipationPulse = useTimeStore(s => s.fetchParticipationPulse);
    const pulseLoading = useTimeStore(s => s.pulseLoading);
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
        
        let dataToProcess = participationPulse.length > 120 ? participationPulse.slice(-120) : participationPulse;

        // Force minimum 2 points for Recharts area rendering
        if (dataToProcess.length === 1) {
            const clone = { ...dataToProcess[0], time: new Date(new Date(dataToProcess[0].time).getTime() + 1000).toISOString() };
            dataToProcess = [dataToProcess[0], clone];
        }

        return dataToProcess.map(p => {
            const screenerCount = p.screener_count || 0;
            const watchlistCount = p.watchlist_count || 0;
            const rawBull = p.bull_score || 0;
            const rawBear = p.bear_score || 0;
            
            const scaler = 10; 
            const scaledBull = Math.min(rawBull / scaler, 40);
            const scaledBear = Math.min(rawBear / scaler, 40);

            return {
                ...p,
                timeLabel: format(new Date(p.time), 'HH:mm'),
                bull_range: [screenerCount, screenerCount + scaledBull],     
                bear_range: [screenerCount - scaledBear, screenerCount],     
                // Flattened props representing baseline values
                screener_count: screenerCount,
                watchlist_count: watchlistCount,
            };
        });
    }, [participationPulse]);

    // ── Shared brush hook (fixes localStorage persistence + live-follow) ──
    const { brushRange, handleBrushChange } = useChartBrush('tv_pulseBrush', chartData);

    if(chartData.length === 0) return null;

    const latest = chartData[chartData.length - 1] || {};

    const isBullDominant = latest.bull_score > (latest.bear_score * 1.5) && latest.bull_score > 5;
    const isBearDominant = latest.bear_score > (latest.bull_score * 1.5) && latest.bear_score > 5;
    const isNeutral = !isBullDominant && !isBearDominant;

    // Custom Tooltip Component
    const CustomTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            const p = payload[0].payload;
            return (
                <div className="p-3 rounded-lg shadow-lg border" style={{ backgroundColor: 'var(--bg-card)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)', minWidth: '180px'}}>
                    <div className="font-bold mb-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{label}</div>
                    
                    <div className="flex justify-between items-center py-2 text-sm font-mono border-b border-gray-700/50 mb-1">
                        <span style={{ color: '#FF2E93', fontSize: '0.75rem', fontWeight: 600 }}>SCREENER COUNT</span>
                        <span className="font-bold text-[#FF2E93] text-lg">{p.screener_count}</span>
                    </div>
                    <div className="flex justify-between items-center py-2 text-sm font-mono border-b border-gray-700/50 mb-2">
                        <span style={{ color: '#3B82F6', fontSize: '0.75rem', fontWeight: 600 }}>WATCHLIST COUNT</span>
                        <span className="font-bold text-[#3B82F6] text-lg">{p.watchlist_count}</span>
                    </div>

                    <div className="flex justify-between items-center py-1 text-xs font-mono">
                        <span className="text-[#10B981]">Total Buy Score</span>
                        <span className="font-bold">+{p.bull_score}</span>
                    </div>
                    <div className="flex justify-between items-center py-1 text-xs font-mono">
                        <span className="text-[#EF4444]">Total Sell Score</span>
                        <span className="font-bold">-{p.bear_score}</span>
                    </div>
                </div>
            );
        }
        return null;
    };

    return (
        <div className={`flex flex-col w-full p-4 h-[350px] rounded-lg shadow-sm ${isPulsing ? 'animate-widget-glow' : ''}`} style={{ backgroundColor: 'var(--bg-card)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)', touchAction: 'pan-y' }}>
            
            <div className="flex items-center justify-between mb-2 pb-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <div className="flex items-center gap-2">
                    <Activity size={18} className="text-[#FF2E93]" />
                    <h3 className="text-sm font-bold uppercase" style={{ color: 'var(--text-secondary)' }}>Scout Screener Engine</h3>
                </div>
                
                <div className="flex gap-6 items-center">
                    <div className="flex flex-col items-end">
                        <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Total Screener</span>
                        <span className="text-lg font-bold font-mono text-[#FF2E93]">{latest.screener_count || 0}</span>
                    </div>
                    <div className="flex flex-col items-end border-l border-[var(--border-subtle)] pl-6">
                        <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Tracked Watchlist</span>
                        <span className="text-lg font-bold font-mono text-[#3B82F6]">{latest.watchlist_count || 0}</span>
                    </div>
                    <div className="flex flex-col items-end border-l border-[var(--border-subtle)] pl-6">
                        <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>Net Rating</span>
                        <span className={`text-lg font-bold font-mono ${latest.net_score > 0 ? 'text-[#10B981]' : latest.net_score < 0 ? 'text-[#EF4444]' : 'text-gray-400'}`}>
                            {latest.net_score > 0 ? '+' : ''}{latest.net_score || 0}
                        </span>
                    </div>
                </div>
            </div>

            {/* Dynamic Interpretation */}
            <div className="flex items-center gap-2 mb-4 p-2 rounded text-xs" style={{ backgroundColor: 'var(--bg-app)' }}>
                {isBullDominant && <><TrendingUp size={14} className="text-[#10B981]" /> <span className="font-semibold text-[#10B981]">Rating Upgrade:</span> <span>Screener aggregated ratings are heavily Buy/Strong Buy.</span></>}
                {isBearDominant && <><TrendingDown size={14} className="text-[#EF4444]" /> <span className="font-semibold text-[#EF4444]">Rating Downgrade:</span> <span>Screener aggregated ratings are heavily Sell/Strong Sell.</span></>}
                {isNeutral && <><Zap size={14} className="text-[#FACC15]" /> <span className="font-semibold text-[#FACC15]">Mixed Ratings:</span> <span>Screener distribution is balanced or neutral.</span></>}
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
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border-subtle)" opacity={0.5} />
                        <XAxis 
                            dataKey="timeLabel" 
                            axisLine={false} 
                            tickLine={false} 
                            tick={{ fontSize: 9, fill: 'var(--text-tertiary)' }}
                            minTickGap={30}
                        />
                        <YAxis hide={true} domain={[dataMin => dataMin - 10, dataMax => dataMax + 10]} />
                        
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

                        {/* 3. Screener Count Overlay Line */}
                        <Line 
                            type="linear" 
                            dataKey="screener_count" 
                            stroke="#FF2E93" 
                            strokeWidth={2} 
                            dot={false}
                            isAnimationActive={false} 
                            activeDot={{ r: 6, fill: '#FF2E93', stroke: 'var(--bg-card)', strokeWidth: 2 }}
                        />
                        
                        {/* 4. Watchlist Count Overlay Line */}
                        <Line 
                            type="linear" 
                            dataKey="watchlist_count" 
                            stroke="#3B82F6" 
                            strokeWidth={3} 
                            dot={false}
                            isAnimationActive={false} 
                            activeDot={{ r: 6, fill: '#3B82F6', stroke: 'var(--bg-card)', strokeWidth: 2 }}
                        />

                        {/* Recharts Brush: desktop drag handles & optimized for mobile via touchAction */}
                        <Brush 
                            dataKey="timeLabel" 
                            height={22}
                            travellerWidth={18}
                            stroke="var(--text-tertiary)" 
                            fill="var(--bg-app)"
                            onChange={handleBrushChange}
                            startIndex={brushRange.startIndex}
                            endIndex={brushRange.endIndex}
                        />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
            
            <div className="flex justify-between items-center mt-4 px-2">
                <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Geometric Heat Flow Overlay</div>
                <div className="flex flex-wrap gap-4 text-[10px] font-bold uppercase" style={{ color: 'var(--text-tertiary)' }}>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full shadow-[0_0_6px_#10B981] bg-[#10B981]"></span> Buy Ratings</span>
                    <span className="flex items-center gap-1"><span className="w-4 h-[3px] shadow-[0_0_6px_#FF2E93] bg-[#FF2E93]"></span> Screener Count</span>
                    <span className="flex items-center gap-1"><span className="w-4 h-[3px] shadow-[0_0_6px_#3B82F6] bg-[#3B82F6]"></span> Watchlist Count</span>
                    <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full shadow-[0_0_6px_#EF4444] bg-[#EF4444]"></span> Sell Ratings</span>
                </div>
            </div>
            
        </div>
    );
}

export default ParticipationPulseWidget;
