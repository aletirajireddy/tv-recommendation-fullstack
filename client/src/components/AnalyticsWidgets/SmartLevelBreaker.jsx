import React, { useMemo, useState, useEffect } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { RefreshCw, Navigation } from 'lucide-react';
import {
    ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, ZAxis, ReferenceLine
} from 'recharts';
import styles from './SmartLevelBreaker.module.css';

export const SmartLevelBreaker = () => {
    const { activeScan, refreshAll, useSmartLevelsContext } = useTimeStore();
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
        if (activeScan) {
            setIsPulsing(false);
            const trigger = setTimeout(() => setIsPulsing(true), 10);
            const timer = setTimeout(() => setIsPulsing(false), 1300);
            return () => { clearTimeout(trigger); clearTimeout(timer); };
        }
    }, [activeScan?.id]);

    const data = useMemo(() => {
        if (!activeScan || !activeScan.results) return [];

        return activeScan.results.map(r => {
            const d = r.data || r;
            
            // 1. Calculate Channel Geometry (0% = Support, 100% = Resistance, 50% = Midline)
            const sDist = parseFloat(d.logicSupportDist || d.supportDist || 0);
            const rDist = parseFloat(d.logicResistDist || d.resistDist || 0);
            const totalChannel = sDist + rDist;
            let y = 50; 
            
            if (totalChannel > 0) {
                // How far are we from support relative to the total channel distance?
                y = (sDist / totalChannel) * 100;
            }
            
            // 2. Breakouts (Crossed resistance or Crossed support via the sketch)
            // Push their visual coordinate outside the 0-100 range.
            const isBreakout = d.breakout === 1 || (totalChannel <= 2.5 && d.volSpike === 1 && (sDist < 0.3 || rDist < 0.3));
            if (isBreakout) {
                // If it's pushing green or very close to resistance
                if (d.direction === 'BULL' || rDist < sDist) y = 112; 
                else y = -12; // Pushing red or below support
            }

            // 3. Dot Dimensions (Volume & Momentum Variant)
            const momAbs = Math.abs(parseFloat(d.momScore || 0));
            // Minimum size 50, maximum around 200
            const z = 50 + (d.volSpike ? 80 : 0) + (momAbs * 20);

            // 4. Dot Categorization (Yellow vs Pink)
            // Pink = Gap distance to next level + Volumes (High rDist/sDist + Spikes)
            const isGapRunner = (rDist >= 3.0 && d.direction === 'BULL' && d.volSpike) || (sDist >= 3.0 && d.direction === 'BEAR' && d.volSpike) || isBreakout;
            
            // Yellow = Volumes + Momentum (resting/testing)
            const isMomentum = !isGapRunner && (d.volSpike || momAbs >= 2);

            let type = 'none';
            if (isGapRunner) type = 'pink';
            else if (isMomentum) type = 'yellow';

            // Filter out non-actionable coins to keep the chart clean like the drawing
            if (type === 'none') return null;

            return {
                ticker: r.cleanTicker || r.ticker,
                x: parseFloat(d.netTrend || 0),
                y,
                z,
                type,
                volSpike: d.volSpike === 1 || d.volSpike === "1",
                momScore: d.momScore,
                sDist,
                rDist,
                close: parseFloat(d.close || 0),
                roc: parseFloat(d.roc || 0),
                volumeProxy: d.volumeProxy || '--',
                ema200Dist: d.ema200Dist,
                smartLevels: useSmartLevelsContext ? (d.smartLevels || []) : [],
                direction: d.direction || 'NEUTRAL'
            };
        }).filter(Boolean);
    }, [activeScan, useSmartLevelsContext]);

    const CustomTooltip = ({ active, payload }) => {
        if (active && payload && payload.length) {
            const p = payload[0].payload;
            return (
                <div className={styles.tooltip}>
                    <div className={styles.tooltipHeader}>
                        <h4>{p.ticker}</h4>
                        <span style={{ color: p.type === 'pink' ? '#FF2E93' : '#FACC15', fontSize: '11px', fontWeight: 'bold' }}>
                            {p.type === 'pink' ? '⚡ GAP RUNNER' : '🔥 MOMENTUM'}
                        </span>
                    </div>
                    <div className={styles.tooltipBody}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '11px', fontWeight: 'bold' }}>
                            <span>💰 {p.close ? `$${p.close}` : '--'}</span>
                            <span style={{ color: p.roc > 0 ? '#10B981' : '#EF4444' }}>{p.roc > 0 ? '+' : ''}{p.roc}%</span>
                            <span style={{ color: '#FACC15' }}>📊 {p.volumeProxy}</span>
                        </div>
                        <p>Trend Flow: <span className={styles.highlight} style={{ color: p.x > 0 ? '#10B981' : '#EF4444' }}>{p.x > 0 ? '+' : ''}{p.x.toFixed(1)}</span></p>
                        <p>Current Bias: <span className={styles.highlight}>{p.direction}</span></p>
                        
                        <div className={styles.breakerSection}>
                            <div className={styles.breakerTitle}>SPEED BREAKERS</div>
                            
                            {/* EMA 200 Dist Reference */}
                            {p.ema200Dist !== undefined && p.ema200Dist !== null && (
                                <div className={`${styles.breakerRow} ${styles.ema}`}>
                                    200 EMA <span>{p.ema200Dist > 0 ? '+' : ''}{parseFloat(p.ema200Dist).toFixed(2)}%</span>
                                </div>
                            )}

                            {/* Structure Next Resist */}
                            <div className={`${styles.breakerRow} ${styles.resist}`}>
                                Resistance <span>+{p.rDist.toFixed(2)}%</span>
                            </div>
                            
                            {/* Structure Support Floor */}
                            <div className={`${styles.breakerRow} ${styles.support}`}>
                                Support <span>-{p.sDist.toFixed(2)}%</span>
                            </div>

                            {/* Institutional Speed Breakers (Smart Levels) */}
                            {p.smartLevels && p.smartLevels.length > 0 && (
                                <div style={{ marginTop: '8px' }}>
                                    <div className={styles.breakerTitle} style={{ color: '#8B5CF6' }}>INSTITUTIONAL ZONES</div>
                                    {p.smartLevels.map((sl, i) => {
                                        const distPct = ((sl.price - p.close) / p.close) * 100;
                                        // Only show relevant nearby levels within 4% to avoid noise
                                        if (Math.abs(distPct) <= 4.0) {
                                            return (
                                                <div key={i} className={styles.breakerRow} style={{ borderLeftColor: '#8B5CF6', backgroundColor: 'rgba(139, 92, 246, 0.1)' }}>
                                                    {sl.name || sl.type} <span>{distPct > 0 ? '+' : ''}{distPct.toFixed(2)}%</span>
                                                </div>
                                            );
                                        }
                                        return null;
                                    })}
                                </div>
                            )}

                        </div>
                        {p.volSpike && <div className={styles.volTag}>Burst Volume Active</div>}
                    </div>
                </div>
            );
        }
        return null;
    };

    return (
        <div className={`${styles.container} ${isPulsing ? 'animate-widget-glow' : ''}`}>
            <div className={styles.header}>
                <div className={styles.title}>
                    <Navigation size={18} style={{ color: 'var(--accent-primary)' }} />
                    <h3>SMART LEVEL BREAKER <span style={{ opacity: 0.5, fontSize: '0.8rem', fontWeight: 500 }}>Structural Channel Flow</span></h3>
                </div>
                <button className={styles.refreshBtn} onClick={() => refreshAll()} title="Refresh Geometry">
                    <RefreshCw size={14} />
                </button>
            </div>

            <div className={styles.chartArea}>
                {!activeScan ? (
                    <div className={styles.emptyState}>
                        <p>Waiting for Channel Data...</p>
                    </div>
                ) : data.length === 0 ? (
                    <div className={styles.emptyState}>
                        <p>No Breakers or Momentum Pushes Detected</p>
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height="100%">
                        <ScatterChart margin={{ top: 30, right: 30, bottom: 20, left: 10 }}>
                            <CartesianGrid strokeDasharray="2 2" stroke="rgba(255,255,255,0.05)" vertical={true} horizontal={false} />
                            
                            {/* X-Axis: Trend Momentum (-100 to +100) */}
                            <XAxis 
                                type="number" 
                                dataKey="x" 
                                domain={[-100, 100]} 
                                stroke="var(--text-tertiary)" 
                                fontSize={10} 
                                tickFormatter={(val) => val === 0 ? 'Trend Shift' : val > 0 ? `BULL +${val}` : `BEAR ${val}`}
                                tickCount={5}
                            />
                            
                            {/* Y-Axis: Normalized Position in Channel (0 to 100) */}
                            {/* Domain padded to -25 to 125 so breakout dots render safely outside the visual box */}
                            <YAxis 
                                type="number" 
                                dataKey="y" 
                                domain={[-25, 125]} 
                                hide={true} // Hidden because we use ReferenceLines instead of numbers
                            />
                            
                            {/* Z-Axis: Size mapping for Volumes + Mom */}
                            <ZAxis type="number" dataKey="z" range={[30, 250]} />
                            
                            <Tooltip cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.2)' }} content={<CustomTooltip />} isAnimationActive={false} trigger={isMobile ? 'click' : 'hover'} />
                            
                            {/* The 3 Core Channel Architecture Lines (User Sketch) */}
                            <ReferenceLine y={100} stroke="#EF4444" strokeWidth={2} label={{ position: 'top', value: 'RESISTANCE', fill: '#EF4444', fontSize: 11, fontWeight: 'bold' }} />
                            <ReferenceLine y={50} stroke="#3B82F6" strokeDasharray="3 3" strokeWidth={1} label={{ position: 'top', value: 'MIDLINE', fill: '#3B82F6', fontSize: 10, opacity: 0.7 }} />
                            <ReferenceLine y={0} stroke="#10B981" strokeWidth={2} label={{ position: 'bottom', value: 'SUPPORT', fill: '#10B981', fontSize: 11, fontWeight: 'bold' }} />

                            <Scatter name="Coins" data={data}>
                                {data.map((entry, index) => {
                                    const fillStyle = entry.type === 'pink' ? '#FF2E93' : '#FACC15';
                                    return (
                                        <Cell 
                                            key={`cell-${index}`} 
                                            fill={fillStyle} 
                                            fillOpacity={0.85}
                                            stroke={fillStyle} // To give it a nice border
                                            strokeWidth={entry.volSpike ? 2 : 0}
                                            style={{ filter: `drop-shadow(0 0 6px ${fillStyle})` }} // Neon glow
                                        />
                                    );
                                })}
                            </Scatter>
                        </ScatterChart>
                    </ResponsiveContainer>
                )}
            </div>

            <div className={styles.legend}>
                <div className={styles.legendItem}>
                    <div className={styles.dotYellow}></div>
                    <span>Testing Zones (Vol + Mom)</span>
                </div>
                <div className={styles.legendItem}>
                    <div className={styles.dotPink}></div>
                    <span>Gap Runners / Breakouts</span>
                </div>
            </div>
        </div>
    );
};
