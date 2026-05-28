import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import { Activity, RefreshCw, Zap, TrendingUp, TrendingDown, WifiOff } from 'lucide-react';
import { FreshnessChip } from '../FreshnessChip';
import {
    ComposedChart, Line, Area, ReferenceLine,
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Brush
} from 'recharts';
import { format } from 'date-fns';
import { useChartBrush } from '../../hooks/useChartBrush';

export function ParticipationPulseWidget() {
    const containerRef              = useRef(null);
    const participationPulse        = useTimeStore(s => s.participationPulse);
    const fetchParticipationPulse   = useTimeStore(s => s.fetchParticipationPulse);
    const participationPulseFetchedAt = useTimeStore(s => s.participationPulseFetchedAt);
    const lastDataPush              = useTimeStore(s => s.lastDataPush);
    const [isMobile, setIsMobile]   = useState(false);

    useEffect(() => {
        const mql = window.matchMedia('(pointer: coarse)');
        setIsMobile(mql.matches);
        const handler = (e) => setIsMobile(e.matches);
        mql.addEventListener('change', handler);
        return () => mql.removeEventListener('change', handler);
    }, []);

    useEffect(() => { fetchParticipationPulse(); }, []);
    useDataInvalidation(containerRef, fetchParticipationPulse, lastDataPush);

    const [isPulsing, setIsPulsing] = useState(false);
    useEffect(() => {
        if (participationPulse && participationPulse.length > 0) {
            setIsPulsing(false);
            const t1 = setTimeout(() => setIsPulsing(true), 10);
            const t2 = setTimeout(() => setIsPulsing(false), 1300);
            return () => { clearTimeout(t1); clearTimeout(t2); };
        }
    }, [participationPulse]);

    const chartData = useMemo(() => {
        if (!participationPulse || participationPulse.length === 0) return [];

        let src = participationPulse;
        if (src.length === 1) {
            // Recharts needs ≥2 points for area rendering
            const clone = { ...src[0], time: new Date(new Date(src[0].time).getTime() + 1000).toISOString() };
            src = [src[0], clone];
        }

        return src.map(p => {
            const screenerCount  = p.screener_count || 0;
            const watchlistCount = p.wl_total || p.watchlist_count || 0;
            const wlNet          = p.wl_net  ?? 0;
            const wlBull         = p.wl_bull ?? 0;
            const wlBear         = p.wl_bear ?? 0;

            // Screener-based sentiment (only when screener panel is open)
            const scaler = 10;
            const scaledBull = Math.min((p.bull_score || 0) / scaler, 40);
            const scaledBear = Math.min((p.bear_score || 0) / scaler, 40);

            // Primary signal: wl_net (watchlist bulls minus bears, always available).
            // Secondary: screener band when screener is active.
            return {
                ...p,
                timeLabel:      format(new Date(p.time), 'HH:mm'),
                screener_count: screenerCount,
                watchlist_count: watchlistCount,
                wl_bull: wlBull,
                wl_bear: wlBear,
                wl_net:  wlNet,
                // Absolute 0-based areas — visible regardless of screener_count
                wl_pos:  Math.max(0, wlNet),   // green area above 0
                wl_neg:  Math.min(0, wlNet),   // red area below 0
                // Screener overlay bands (only relevant when screener_count > 0)
                scr_bull: screenerCount > 0 ? scaledBull  : null,
                scr_bear: screenerCount > 0 ? -scaledBear : null,
            };
        });
    }, [participationPulse]);

    const { brushRange, handleBrushChange } = useChartBrush('tv_pulseBrush', chartData);

    if (chartData.length === 0) return null;

    const latest = chartData[chartData.length - 1] || {};

    // Screener offline = never produced data in this window
    const screenerEverActive = chartData.some(p => (p.screener_count || 0) > 0);
    const screenerOffline    = !screenerEverActive;

    // Sentiment interpretation — prefer watchlist sentiment when screener is offline
    const netSignal = screenerOffline ? latest.wl_net : (latest.net_score ?? 0);
    const isBullDominant = screenerOffline
        ? (latest.wl_bull > (latest.wl_bear || 0) * 1.4 && latest.wl_bull > 3)
        : (latest.bull_score > (latest.bear_score || 0) * 1.5 && latest.bull_score > 5);
    const isBearDominant = screenerOffline
        ? (latest.wl_bear > (latest.wl_bull || 0) * 1.4 && latest.wl_bear > 3)
        : (latest.bear_score > (latest.bull_score || 0) * 1.5 && latest.bear_score > 5);
    const isNeutral = !isBullDominant && !isBearDominant;

    // Y-axis: centre on 0, scale to max wl_net in window (+buffer)
    const maxAbsWl = Math.max(...chartData.map(p => Math.abs(p.wl_net || 0)), 5);
    const yDomain  = [-(maxAbsWl + 3), maxAbsWl + 3];

    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload?.length) return null;
        const p = payload[0].payload;
        return (
            <div style={{
                backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border)',
                color: 'var(--text-main)', borderRadius: 6, padding: '10px 14px', minWidth: 200, fontSize: 11,
            }}>
                <div style={{ color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>{label}</div>

                <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 6, marginBottom: 6 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <span style={{ color: '#10B981' }}>Watchlist Up</span>
                        <strong style={{ color: '#10B981' }}>{p.wl_bull ?? 0} coins</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                        <span style={{ color: '#EF4444' }}>Watchlist Down</span>
                        <strong style={{ color: '#EF4444' }}>{p.wl_bear ?? 0} coins</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: 'var(--text-muted)' }}>Net Bias</span>
                        <strong style={{ color: (p.wl_net || 0) > 0 ? '#10B981' : (p.wl_net || 0) < 0 ? '#EF4444' : '#718096' }}>
                            {(p.wl_net || 0) > 0 ? '+' : ''}{p.wl_net ?? 0}
                        </strong>
                    </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <span style={{ color: 'var(--accent-purple)' }}>Watchlist Total</span>
                    <strong>{p.watchlist_count ?? 0}</strong>
                </div>
                {(p.screener_count > 0) && (
                    <>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                            <span style={{ color: 'var(--accent-blue)' }}>Screener Active</span>
                            <strong>{p.screener_count}</strong>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                            <span style={{ color: '#10B981' }}>Screener Buy Score</span>
                            <strong>+{p.bull_score}</strong>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#EF4444' }}>Screener Sell Score</span>
                            <strong>-{p.bear_score}</strong>
                        </div>
                    </>
                )}
            </div>
        );
    };

    return (
        <div
            ref={containerRef}
            className={`flex flex-col w-full p-4 h-[380px] rounded-lg shadow-sm ${isPulsing ? 'animate-widget-glow' : ''}`}
            style={{ backgroundColor: 'var(--bg-panel)', color: 'var(--text-main)', border: '1px solid var(--border)', touchAction: 'pan-y' }}
        >
            {/* ── Header ── */}
            <div className="flex items-center justify-between mb-2 pb-2" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2">
                    <Activity size={18} className="text-[var(--accent-blue)]" />
                    <h3 className="text-sm font-bold uppercase" style={{ color: 'var(--text-muted)' }}>Scout Screener Engine</h3>
                    <FreshnessChip ts={participationPulseFetchedAt} title="Participation data last fetched from server" />
                </div>

                <div className="flex gap-4 items-center">
                    {/* Watchlist sentiment */}
                    <div className="flex flex-col items-end">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Watchlist</span>
                        <span className="text-sm font-bold font-mono" style={{ color: 'var(--accent-purple)' }}>
                            {latest.watchlist_count ?? 0} tracked
                        </span>
                    </div>
                    <div className="flex flex-col items-end border-l border-[var(--border)] pl-4">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Up / Down</span>
                        <span className="text-sm font-bold font-mono">
                            <span style={{ color: '#10B981' }}>{latest.wl_bull ?? 0}↑</span>
                            {' / '}
                            <span style={{ color: '#EF4444' }}>{latest.wl_bear ?? 0}↓</span>
                        </span>
                    </div>
                    <div className="flex flex-col items-end border-l border-[var(--border)] pl-4">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                            {screenerOffline ? 'WL Net' : 'Net Rating'}
                        </span>
                        <span className={`text-lg font-bold font-mono ${netSignal > 0 ? 'text-[#10B981]' : netSignal < 0 ? 'text-[#EF4444]' : 'text-gray-400'}`}>
                            {netSignal > 0 ? '+' : ''}{netSignal}
                        </span>
                    </div>
                    {/* Screener status pill */}
                    <div className="flex flex-col items-end border-l border-[var(--border)] pl-4">
                        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Screener</span>
                        {screenerOffline ? (
                            <span style={{ fontSize: 10, color: '#f6ad55', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 3 }}>
                                <WifiOff size={10} /> Offline
                            </span>
                        ) : (
                            <span style={{ fontSize: 10, color: '#68d391', fontWeight: 700 }}>
                                ● Live ({latest.screener_count})
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Status banner ── */}
            <div className="flex items-center gap-2 mb-3 p-2 rounded text-xs" style={{ backgroundColor: 'var(--bg-app)' }}>
                {screenerOffline && (
                    <>
                        <WifiOff size={13} style={{ color: '#f6ad55', flexShrink: 0 }} />
                        <span style={{ color: '#f6ad55', fontWeight: 600 }}>Screener Offline</span>
                        <span style={{ color: 'var(--text-muted)' }}>— Open the TradingView Screener panel to enable rating signals.
                            Chart shows watchlist price bias ({latest.watchlist_count ?? 0} coins, Δ% threshold ±0.3%).</span>
                    </>
                )}
                {!screenerOffline && isBullDominant && (
                    <><TrendingUp size={13} style={{ color: '#10B981' }} />
                    <span style={{ color: '#10B981', fontWeight: 600 }}>Rating Upgrade:</span>
                    <span>Screener aggregated ratings are heavily Buy / Strong Buy.</span></>
                )}
                {!screenerOffline && isBearDominant && (
                    <><TrendingDown size={13} style={{ color: '#EF4444' }} />
                    <span style={{ color: '#EF4444', fontWeight: 600 }}>Rating Downgrade:</span>
                    <span>Screener aggregated ratings are heavily Sell / Strong Sell.</span></>
                )}
                {!screenerOffline && isNeutral && (
                    <><Zap size={13} style={{ color: '#FACC15' }} />
                    <span style={{ color: '#FACC15', fontWeight: 600 }}>Mixed Ratings:</span>
                    <span>Screener distribution is balanced or neutral.</span></>
                )}
            </div>

            {/* ── Chart ── */}
            <div className="flex-1 min-h-[160px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
                        <defs>
                            <linearGradient id="ppBull" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%"   stopColor="#10B981" stopOpacity={0.55} />
                                <stop offset="100%" stopColor="#10B981" stopOpacity={0.05} />
                            </linearGradient>
                            <linearGradient id="ppBear" x1="0" y1="1" x2="0" y2="0">
                                <stop offset="0%"   stopColor="#EF4444" stopOpacity={0.55} />
                                <stop offset="100%" stopColor="#EF4444" stopOpacity={0.05} />
                            </linearGradient>
                        </defs>

                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.4} />
                        <XAxis dataKey="timeLabel" axisLine={false} tickLine={false}
                            tick={{ fontSize: 9, fill: 'var(--text-muted)' }} minTickGap={30} />
                        <YAxis domain={yDomain} axisLine={false} tickLine={false}
                            tick={{ fontSize: 8, fill: 'var(--text-muted)' }}
                            tickFormatter={v => v > 0 ? `+${v}` : v} />

                        <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.15)' }}
                            isAnimationActive={false} trigger={isMobile ? 'click' : 'hover'} />

                        {/* Zero reference line */}
                        <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 3" />

                        {/* Watchlist bias — green area above 0, red area below 0 */}
                        <Area type="monotone" dataKey="wl_pos" stroke="none"
                            fill="url(#ppBull)" baseValue={0} isAnimationActive={false} />
                        <Area type="monotone" dataKey="wl_neg" stroke="none"
                            fill="url(#ppBear)" baseValue={0} isAnimationActive={false} />

                        {/* Watchlist net bias line (primary signal) */}
                        <Line type="monotone" dataKey="wl_net" stroke="#10B981" strokeWidth={2}
                            dot={false} isAnimationActive={false}
                            activeDot={{ r: 5, fill: '#10B981', stroke: 'var(--bg-panel)', strokeWidth: 2 }} />

                        {/* Watchlist total count line (purple) */}
                        <Line type="monotone" dataKey="watchlist_count" stroke="var(--accent-purple)"
                            strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false}
                            activeDot={{ r: 4, fill: 'var(--accent-purple)' }} />

                        {/* Screener count (blue) — only visible when screener is active */}
                        {screenerEverActive && (
                            <Line type="monotone" dataKey="screener_count" stroke="var(--accent-blue)"
                                strokeWidth={2} dot={false} isAnimationActive={false}
                                activeDot={{ r: 5, fill: 'var(--accent-blue)', stroke: 'var(--bg-panel)', strokeWidth: 2 }} />
                        )}

                        <Brush dataKey="timeLabel" height={20} travellerWidth={16}
                            stroke="var(--text-muted)" fill="var(--bg-app)"
                            onChange={handleBrushChange}
                            startIndex={brushRange.startIndex}
                            endIndex={brushRange.endIndex} />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>

            {/* ── Legend ── */}
            <div className="flex justify-between items-center mt-2 px-1">
                <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    Watchlist Price Bias · {screenerOffline ? 'Screener offline' : 'Screener + Watchlist'}
                </div>
                <div className="flex flex-wrap gap-3 text-[9px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>
                    <span className="flex items-center gap-1">
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#10B981', display: 'inline-block' }} />
                        WL Up
                    </span>
                    <span className="flex items-center gap-1">
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#EF4444', display: 'inline-block' }} />
                        WL Down
                    </span>
                    <span className="flex items-center gap-1">
                        <span style={{ width: 16, height: 2, background: 'var(--accent-purple)', display: 'inline-block', opacity: 0.7 }} />
                        WL Total
                    </span>
                    {screenerEverActive && (
                        <span className="flex items-center gap-1">
                            <span style={{ width: 16, height: 2, background: 'var(--accent-blue)', display: 'inline-block' }} />
                            Screener Count
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}

export default ParticipationPulseWidget;
