import React, { useMemo, useState, useEffect } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import styles from './AlphaScatter.module.css';
import { RefreshCw, Target, TrendingUp } from 'lucide-react';
import {
    ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ZAxis
} from 'recharts';

export function AlphaScatter() {
    const activeScan = useTimeStore(s => s.activeScan);
    const refreshAll = useTimeStore(s => s.refreshAll);
    const alphaSquad = useTimeStore(s => s.alphaSquad);
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const mql = window.matchMedia('(pointer: coarse)');
        setIsMobile(mql.matches);
        const handler = (e) => setIsMobile(e.matches);
        mql.addEventListener('change', handler);
        return () => mql.removeEventListener('change', handler);
    }, []);

    const [isPulsing, setIsPulsing] = useState(false);
    useEffect(() => {
        if (alphaSquad && alphaSquad.length > 0) {
            setIsPulsing(false);
            const trigger = setTimeout(() => setIsPulsing(true), 10);
            const timer = setTimeout(() => setIsPulsing(false), 1300);
            return () => { clearTimeout(trigger); clearTimeout(timer); };
        }
    }, [alphaSquad]);


    // The Cross-Reference Filter (Stream A x Stream C)
    const data = useMemo(() => {
        if (!activeScan || !activeScan.results) return [];

        // 1. Build a quick lookup map of mathematically verified Alpha Movers from Stream C
        const alphaMap = new Map();
        if (alphaSquad && alphaSquad.length > 0) {
            alphaSquad.forEach(coin => alphaMap.set(coin.ticker, coin));
        }

        // 2. Filter the High-Fidelity Active Scan (Stream A)
        return activeScan.results
            .filter(r => {
                const d = r.data || r;
                // Base Condition 1: Pure Volume Detection (Stream A)
                const hasVolSpike = d.volSpike === 1 || d.volSpike === "1";
                // Base Condition 2: High Volatility (Stream A)
                const isVolatile = Math.abs(parseFloat(d.roc || 0)) >= 1.5 || parseFloat(d.dailyRange || 0) > 4.0;
                // Base Condition 3: verified Alpha Acceleration (Stream C)
                const isAlphaVerified = alphaMap.has(r.ticker);

                // Coin must meet at least one volatility condition to be plotted
                return hasVolSpike || isVolatile || isAlphaVerified;
            })
            .map(r => {
                const d = r.data || r;
                const alphaData = alphaMap.get(r.ticker);
                
                return {
                    ticker: r.ticker,
                    x: parseFloat(d.netTrend || 0),           // X-Axis (-100 to 100)
                    y: parseFloat(d.score || r.score || 0),   // Y-Axis (0 to 100) // GenieScore
                    z: alphaData ? alphaData.volDelta : 50,   // Z-Axis (Dot Size = Volume Intensity) 
                    bias: d.direction || r.category || 'NEUTRAL',
                    volSpike: d.volSpike === 1 || d.volSpike === "1",
                    isAlphaVerified: !!alphaData,
                    alphaMomDelta: alphaData ? alphaData.momDelta : null
                };
            })
            .filter(point => !isNaN(point.x) && !isNaN(point.y)); // Safety check
    }, [activeScan, alphaSquad]);

    const handleRefresh = (e) => {
        e.stopPropagation();
        refreshAll();
    };

    const CustomTooltip = ({ active, payload }) => {
        if (active && payload && payload.length) {
            const d = payload[0].payload;
            return (
                <div className={styles.tooltip}>
                    <h4>{d.ticker}</h4>
                    <p>Trend Strength: <span className={d.x > 0 ? styles.bull : styles.bear}>{d.x > 0 ? '+' : ''}{d.x.toFixed(1)}</span></p>
                    <p>Setup Quality: <span className={styles.highlight}>{d.y.toFixed(0)}</span> / 100</p>
                    
                    {d.isAlphaVerified && (
                        <div className={styles.alphaTag}>
                            <TrendingUp size={12} />
                            <span>Verified Acceleration</span>
                            <span className={styles.meta}>(Mom Δ {d.alphaMomDelta > 0 ? '+' : ''}{d.alphaMomDelta?.toFixed(1)})</span>
                        </div>
                    )}
                    {d.volSpike && <div className={styles.volTag}>⚡ Burst Volume Detected</div>}
                </div>
            );
        }
        return null;
    };

    return (
        <div className={`${styles.container} ${isPulsing ? 'animate-widget-glow' : ''}`}>
            <div className={styles.header}>
                <div className={styles.title}>
                    <Target size={18} />
                    <h3>ALPHA SQUAD <span style={{opacity: 0.5, fontSize: '0.8rem', fontWeight: 500}}>Trend vs Quality</span></h3>
                </div>
                <button className={styles.refreshBtn} onClick={handleRefresh} title="Refresh Models">
                    <RefreshCw size={14} />
                </button>
            </div>

            <div className={styles.chartArea}>
                {!activeScan ? (
                    <div className={styles.emptyState}>
                        <p>Waiting for Live Scan...</p>
                        <button className={styles.loadBtn} onClick={refreshAll}>Sync Now</button>
                    </div>
                ) : data.length === 0 ? (
                    <div className={styles.emptyState}>
                        <p>No Active Alpha Setups Detected</p>
                        <span style={{fontSize: '0.8rem'}}>Market is stagnant or awaiting volume.</span>
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: -20 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" vertical={false} />
                            
                            {/* X-Axis: Trend Strength (-100 to 100) */}
                            <XAxis
                                type="number"
                                dataKey="x"
                                name="Trend Strength"
                                stroke="var(--text-tertiary)"
                                fontSize={10}
                                domain={[-100, 100]}
                                tickCount={5}
                                tickLine={false}
                            />
                            
                            {/* Y-Axis: Setup Quality (GenieScore 0 to 100) */}
                            <YAxis
                                type="number"
                                dataKey="y"
                                name="Setup Quality"
                                stroke="var(--text-tertiary)"
                                fontSize={10}
                                domain={[0, 100]}
                                tickCount={5}
                                tickLine={false}
                            />
                            
                            {/* Z-Axis helps scale the dot size slightly for verified vs unverified volume */}
                            <ZAxis type="number" dataKey="z" range={[40, 150]} />
                            
                            <Tooltip cursor={{ strokeDasharray: '3 3', stroke: 'var(--border-focus)' }} content={<CustomTooltip />} isAnimationActive={false} trigger={isMobile ? 'click' : 'hover'} />
                            
                            <Scatter name="Coins" data={data}>
                                {data.map((entry, index) => {
                                    // Elite rendering logic:
                                    // Base color by Direction, Stroke by VolSpike, Opacity by Alpha Verification
                                    const baseColor = entry.bias === 'BULLISH' || entry.bias === 'BULL' || entry.bias === 'LONG' 
                                        ? 'var(--success)' : (entry.bias === 'BEARISH' || entry.bias === 'BEAR' || entry.bias === 'SHORT' ? 'var(--error)' : 'var(--text-secondary)');
                                    
                                    const opacity = entry.isAlphaVerified ? 1 : 0.6;
                                    const stroke = entry.volSpike ? 'var(--accent-primary)' : 'none';
                                    
                                    return (
                                        <Cell 
                                            key={`cell-${index}`} 
                                            fill={baseColor} 
                                            fillOpacity={opacity}
                                            stroke={stroke}
                                            strokeWidth={entry.volSpike ? 2 : 0}
                                        />
                                    );
                                })}
                            </Scatter>
                        </ScatterChart>
                    </ResponsiveContainer>
                )}
            </div>
        </div>
    );
}
