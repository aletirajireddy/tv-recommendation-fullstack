import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import { Activity, Settings, TrendingUp, TrendingDown, Layers, Zap } from 'lucide-react';
import {
    ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Brush, ReferenceDot
} from 'recharts';
import { format } from 'date-fns';
import { useChartBrush } from '../../hooks/useChartBrush';
import { classifyCoin, loadCascadeSeries } from '../../utils/cascadeUtils';
import styles from './CascadeTrendWidget.module.css';

export function CascadeTrendWidget() {
    const containerRef = useRef(null);
    const cascadeHistory = useTimeStore(s => s.cascadeHistory);
    const fetchCascadeHistory = useTimeStore(s => s.fetchCascadeHistory);
    const lastDataPush = useTimeStore(s => s.lastDataPush);
    const [isMobile, setIsMobile] = useState(false);

    // Settings
    const [viewMode, setViewMode] = useState('combined'); // 'combined' | 'individual'
    const [selectedCoins, setSelectedCoins] = useState([]);
    const [showSettings, setShowSettings] = useState(false);
    const [cascadeConfig, setCascadeConfig] = useState(loadCascadeSeries());

    useEffect(() => {
        const mql = window.matchMedia('(pointer: coarse)');
        setIsMobile(mql.matches);
        const handler = (e) => setIsMobile(e.matches);
        mql.addEventListener('change', handler);
        return () => mql.removeEventListener('change', handler);
    }, []);

    useEffect(() => {
        fetchCascadeHistory();
    }, []);

    useDataInvalidation(containerRef, fetchCascadeHistory, lastDataPush);

    // Calculate derived chart data
    const { chartData, availableCoins } = useMemo(() => {
        if (!cascadeHistory || cascadeHistory.length === 0) return { chartData: [], availableCoins: [] };
        
        let dataToProcess = cascadeHistory;
        if (dataToProcess.length === 1) {
            const clone = { ...dataToProcess[0], ts: dataToProcess[0].ts + 5*60*1000 };
            dataToProcess = [dataToProcess[0], clone];
        }

        const coinSet = new Set();
        
        const processed = dataToProcess.map(bucket => {
            const result = {
                ts: bucket.ts,
                timeLabel: format(new Date(bucket.ts), 'HH:mm'),
                coins: {},
                counts: { longBull: 0, longBear: 0, tempBull: 0, tempBear: 0, neutral: 0 },
                volSpikes: []
            };

            if (bucket.data) {
                Object.entries(bucket.data).forEach(([ticker, metrics]) => {
                    coinSet.add(ticker);
                    
                    // Reconstruct fake EMAs relative to price=100
                    const fakePrice = 100;
                    const emas = {};
                    if (metrics.m1 != null) emas.m1 = fakePrice / (metrics.m1 / 100 + 1);
                    if (metrics.m5 != null) emas.m5 = fakePrice / (metrics.m5 / 100 + 1);
                    if (metrics.m15 != null) emas.m15 = fakePrice / (metrics.m15 / 100 + 1);
                    if (metrics.h1 != null) emas.h1 = fakePrice / (metrics.h1 / 100 + 1);
                    if (metrics.h4 != null) emas.h4 = fakePrice / (metrics.h4 / 100 + 1);
                    
                    const atrs = { m15: metrics.atr15 };
                    
                    const coinObj = { emas, atrs, price: fakePrice };
                    const state = classifyCoin(coinObj, cascadeConfig.longSeries, cascadeConfig.shortSeries, cascadeConfig.equalThreshold);
                    
                    result.coins[ticker] = { state, v: metrics.v };
                    result.counts[state]++;
                    
                    if (metrics.v > 0) {
                        result.volSpikes.push(ticker);
                    }
                });
            }

            // Map counts to ranges for Area charts
            // Y-axis order: TempBear, LongBear, Neutral, LongBull, TempBull
            const tb = result.counts.tempBear;
            const lb = result.counts.longBear;
            const lbu = result.counts.longBull;
            const tbu = result.counts.tempBull;
            
            result.bearArea = -(tb + lb);
            result.bullArea = lbu + tbu;
            result.tempBear = -tb;
            result.longBear = -lb;
            result.longBull = lbu;
            result.tempBull = tbu;
            result.netTrend = result.bullArea + result.bearArea; // Net score

            return result;
        });

        const coins = Array.from(coinSet).sort();
        return { chartData: processed, availableCoins: coins };
    }, [cascadeHistory, cascadeConfig]);

    // Handle initial selected coins
    useEffect(() => {
        if (selectedCoins.length === 0 && availableCoins.length > 0) {
            setSelectedCoins(availableCoins.slice(0, 5));
        }
    }, [availableCoins, selectedCoins.length]);

    const { brushRange, handleBrushChange } = useChartBrush('tv_cascadeBrush', chartData);

    const toggleCoin = (coin) => {
        if (selectedCoins.includes(coin)) {
            setSelectedCoins(selectedCoins.filter(c => c !== coin));
        } else {
            if (selectedCoins.length < 10) { // Limit to 10 for performance
                setSelectedCoins([...selectedCoins, coin]);
            }
        }
    };

    if (chartData.length === 0) return null;

    const CustomTooltip = ({ active, payload, label }) => {
        if (active && payload && payload.length) {
            const data = payload[0].payload;
            return (
                <div className={styles.tooltipContainer}>
                    <div className={styles.tooltipTime}>{label}</div>
                    
                    {viewMode === 'combined' ? (
                        <div className={styles.combinedTooltip}>
                            <div className={styles.tooltipRow}>
                                <span className={styles.labelTempBull}>Temp Bull</span>
                                <span>{data.tempBull}</span>
                            </div>
                            <div className={styles.tooltipRow}>
                                <span className={styles.labelLongBull}>Long Bull</span>
                                <span>{data.longBull}</span>
                            </div>
                            <div className={styles.tooltipRow}>
                                <span className={styles.labelLongBear}>Long Bear</span>
                                <span>{Math.abs(data.longBear)}</span>
                            </div>
                            <div className={styles.tooltipRow}>
                                <span className={styles.labelTempBear}>Temp Bear</span>
                                <span>{Math.abs(data.tempBear)}</span>
                            </div>
                        </div>
                    ) : (
                        <div className={styles.individualTooltip}>
                            {selectedCoins.map(coin => {
                                const st = data.coins[coin];
                                if (!st) return null;
                                const stateColor = 
                                    st.state === 'longBull' ? '#10B981' :
                                    st.state === 'tempBull' ? '#34D399' :
                                    st.state === 'longBear' ? '#EF4444' :
                                    st.state === 'tempBear' ? '#F87171' : '#6B7280';
                                return (
                                    <div key={coin} className={styles.tooltipRow}>
                                        <div className="flex items-center gap-1">
                                            <span style={{ color: stateColor }}>●</span>
                                            <span className="font-mono text-xs">{coin}</span>
                                            {st.v > 0 && <Zap size={10} className="text-yellow-400 ml-1" />}
                                        </div>
                                        <span className="text-[10px] opacity-70 uppercase">{st.state}</span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                    
                    {data.volSpikes.length > 0 && (
                        <div className="mt-2 pt-2 border-t border-[var(--border)]">
                            <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
                                <Zap size={10} className="text-yellow-400" /> Volume Spikes
                            </div>
                            <div className="text-[10px] font-mono opacity-80 mt-1 max-w-[150px] flex flex-wrap gap-1">
                                {data.volSpikes.slice(0, 5).join(', ')}
                                {data.volSpikes.length > 5 && ` +${data.volSpikes.length - 5}`}
                            </div>
                        </div>
                    )}
                </div>
            );
        }
        return null;
    };

    // State numeric mapping for individual view:
    // TempBull = 2, LongBull = 1, Neutral = 0, LongBear = -1, TempBear = -2
    const stateVal = { tempBull: 2, longBull: 1, neutral: 0, longBear: -1, tempBear: -2 };
    
    // Add individual state values to data for charting
    const chartDataWithIndividual = chartData.map(d => {
        const item = { ...d };
        selectedCoins.forEach(c => {
            const st = item.coins[c];
            item[`val_${c}`] = st ? stateVal[st.state] : null;
        });
        return item;
    });

    const colors = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#eab308', '#14b8a6', '#6366f1', '#f43f5e', '#84cc16', '#06b6d4'];

    const latest = chartData[chartData.length - 1] || {};
    const isBullDominant = latest.bullArea > Math.abs(latest.bearArea) * 1.5 && latest.bullArea > 3;
    const isBearDominant = Math.abs(latest.bearArea) > latest.bullArea * 1.5 && Math.abs(latest.bearArea) > 3;
    const isNeutral = !isBullDominant && !isBearDominant;

    return (
        <div ref={containerRef} className={styles.widgetWrapper}>
            <div className={styles.header}>
                <div className="flex items-center gap-2">
                    <Layers size={18} className="text-[var(--accent-purple)]" />
                    <h3 className="text-sm font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Cascade Trend Monitor</h3>
                </div>
                
                <div className="flex gap-6 items-center mr-auto ml-8">
                    <div className="flex flex-col items-end">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Net Cascade</span>
                        <span className={`text-lg font-bold font-mono ${latest.netTrend > 0 ? 'text-[#10B981]' : latest.netTrend < 0 ? 'text-[#EF4444]' : 'text-gray-400'}`}>
                            {latest.netTrend > 0 ? '+' : ''}{latest.netTrend || 0}
                        </span>
                    </div>
                    <div className="flex flex-col items-end border-l border-[var(--border)] pl-6">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Bull Coins</span>
                        <span className="text-lg font-bold font-mono text-[#10B981]">{latest.bullArea || 0}</span>
                    </div>
                    <div className="flex flex-col items-end border-l border-[var(--border)] pl-6 hidden sm:flex">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Bear Coins</span>
                        <span className="text-lg font-bold font-mono text-[#EF4444]">{Math.abs(latest.bearArea) || 0}</span>
                    </div>
                </div>

                <div className="flex items-center gap-4">
                    <div className="flex bg-[var(--bg-app)] rounded p-1">
                        <button 
                            className={`${styles.viewToggleBtn} ${viewMode === 'combined' ? styles.active : ''}`}
                            onClick={() => setViewMode('combined')}
                        >Combined</button>
                        <button 
                            className={`${styles.viewToggleBtn} ${viewMode === 'individual' ? styles.active : ''}`}
                            onClick={() => setViewMode('individual')}
                        >Split View</button>
                    </div>
                    <button 
                        className={styles.iconBtn} 
                        onClick={() => setShowSettings(!showSettings)}
                    >
                        <Settings size={16} />
                    </button>
                </div>
            </div>

            {/* Dynamic Interpretation */}
            <div className="flex items-center gap-2 mb-4 p-2 rounded text-xs" style={{ backgroundColor: 'var(--bg-app)' }}>
                {isBullDominant && <><TrendingUp size={14} className="text-[#10B981]" /> <span className="font-semibold text-[#10B981]">Bullish Cascade:</span> <span>Market structure is expanding upward.</span></>}
                {isBearDominant && <><TrendingDown size={14} className="text-[#EF4444]" /> <span className="font-semibold text-[#EF4444]">Bearish Cascade:</span> <span>Market structure is deteriorating.</span></>}
                {isNeutral && <><Activity size={14} className="text-[#FACC15]" /> <span className="font-semibold text-[#FACC15]">Consolidating:</span> <span>Cascade states are transitioning or balanced.</span></>}
            </div>

            {showSettings && viewMode === 'individual' && (
                <div className={styles.settingsPanel}>
                    <div className="text-xs mb-2 text-[var(--text-muted)]">Select up to 10 coins to track:</div>
                    <div className="flex flex-wrap gap-1 max-h-[100px] overflow-y-auto custom-scrollbar">
                        {availableCoins.map(c => (
                            <button
                                key={c}
                                className={`${styles.coinChip} ${selectedCoins.includes(c) ? styles.selected : ''}`}
                                onClick={() => toggleCoin(c)}
                            >
                                {c}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div className="flex-1 w-full mt-2 h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartDataWithIndividual} margin={{ top: 15, right: 0, left: 10, bottom: 0 }}>
                        <defs>
                            <linearGradient id="bullGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#10B981" stopOpacity={0.8}/>
                                <stop offset="95%" stopColor="#10B981" stopOpacity={0.2}/>
                            </linearGradient>
                            <linearGradient id="bearGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#EF4444" stopOpacity={0.2}/>
                                <stop offset="95%" stopColor="#EF4444" stopOpacity={0.8}/>
                            </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.3} />
                        
                        <XAxis 
                            dataKey="timeLabel" 
                            axisLine={false} 
                            tickLine={false} 
                            tick={{ fontSize: 9, fill: 'var(--text-muted)' }}
                            minTickGap={30}
                        />
                        
                        {viewMode === 'combined' ? (
                            <YAxis hide={true} domain={['auto', 'auto']} />
                        ) : (
                            <YAxis 
                                hide={false} 
                                domain={[-2.5, 2.5]} 
                                ticks={[-2, -1, 0, 1, 2]} 
                                axisLine={false} 
                                tickLine={false}
                                width={40}
                                tickFormatter={(val) => {
                                    if (val === 2) return 'T-Bull';
                                    if (val === 1) return 'L-Bull';
                                    if (val === 0) return 'Neut';
                                    if (val === -1) return 'L-Bear';
                                    if (val === -2) return 'T-Bear';
                                    return '';
                                }}
                                tick={{ fontSize: 9, fill: 'var(--text-muted)' }}
                            />
                        )}
                        
                        <Tooltip 
                            content={<CustomTooltip />} 
                            cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.2)' }}
                            isAnimationActive={false}
                            trigger={isMobile ? 'click' : 'hover'}
                            shared={true}
                        />

                        {viewMode === 'combined' ? (
                            <>
                                {/* Combined View: Stacked areas or distinct lines for breadth */}
                                <ReferenceDot x={latest.timeLabel} y={0} r={0} stroke="none" />
                                <Area type="monotone" dataKey="tempBull" stackId="bull" fill="url(#bullGrad)" stroke="none" opacity={0.6} isAnimationActive={false}/>
                                <Area type="monotone" dataKey="longBull" stackId="bull" fill="url(#bullGrad)" stroke="none" opacity={1} isAnimationActive={false}/>
                                
                                <Area type="monotone" dataKey="tempBear" stackId="bear" fill="url(#bearGrad)" stroke="none" opacity={0.6} isAnimationActive={false}/>
                                <Area type="monotone" dataKey="longBear" stackId="bear" fill="url(#bearGrad)" stroke="none" opacity={1} isAnimationActive={false}/>
                                
                                <Line type="monotone" dataKey="bullArea" stroke="#10B981" strokeWidth={2} dot={false} isAnimationActive={false} />
                                <Line type="monotone" dataKey="bearArea" stroke="#EF4444" strokeWidth={2} dot={false} isAnimationActive={false} />
                            </>
                        ) : (
                            <>
                                {/* Individual View: One line per selected coin */}
                                {selectedCoins.map((c, i) => (
                                    <Line 
                                        key={c}
                                        type="stepAfter" 
                                        dataKey={`val_${c}`} 
                                        stroke={colors[i % colors.length]} 
                                        strokeWidth={2} 
                                        dot={false}
                                        isAnimationActive={false} 
                                        connectNulls
                                    />
                                ))}
                            </>
                        )}

                        <Brush 
                            dataKey="timeLabel" 
                            height={22}
                            travellerWidth={18}
                            stroke="var(--text-muted)" 
                            fill="var(--bg-app)"
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

export default CascadeTrendWidget;
