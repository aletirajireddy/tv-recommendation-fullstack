import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import { Activity, TrendingUp, TrendingDown, WifiOff, Zap, Layers } from 'lucide-react';
import { FreshnessChip } from '../FreshnessChip';
import {
    ComposedChart, Area, ReferenceLine,
    XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Brush
} from 'recharts';
import { format } from 'date-fns';
import { useChartBrush } from '../../hooks/useChartBrush';

// ── Palette ───────────────────────────────────────────────────────────────────
const DISC_COLOR = '#2DD4BF'; // teal  — Discovery / Screener wave
const WL_COLOR   = '#F59E0B'; // amber — Watchlist wave
const CONF_COLOR = '#A78BFA'; // violet — Confirmed overlap
// Stable activeDot objects — hoisted to avoid new object reference on every render
const WL_ACTIVE_DOT   = { r: 4, fill: WL_COLOR,   stroke: 'var(--bg-panel)', strokeWidth: 2 };
const DISC_ACTIVE_DOT = { r: 4, fill: DISC_COLOR,  stroke: 'var(--bg-panel)', strokeWidth: 2 };

// ── Tooltip (stable ref via useCallback) ─────────────────────────────────────
function PulseTooltip({ active, payload }) {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    const discCount = p.discovery_count ?? 0;
    const wlCount   = p.watchlist_count ?? 0;
    const overlap   = p.overlap_count   ?? 0;
    const sign      = v => v > 0 ? `+${v}` : `${v}`;
    const netColor  = (v) => v > 0 ? '#10B981' : v < 0 ? '#EF4444' : '#718096';

    return (
        <div style={{
            backgroundColor: 'var(--bg-panel)', border: '1px solid var(--border)',
            color: 'var(--text-main)', borderRadius: 6, padding: '10px 14px',
            minWidth: 210, fontSize: 11,
        }}>
            <div style={{ color: 'var(--text-muted)', fontWeight: 600, marginBottom: 8 }}>
                {p.timeLabel}
            </div>

            {/* Discovery pool */}
            <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 6, marginBottom: 6 }}>
                <div style={{ color: DISC_COLOR, fontWeight: 700, marginBottom: 4, fontSize: 10, letterSpacing: '0.05em' }}>
                    DISCOVERY · {discCount} coins {!p.screener_active && '(offline)'}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Bull %</span>
                    <strong style={{ color: DISC_COLOR }}>+{p.disc_bull ?? 0}%</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Bear %</span>
                    <strong style={{ color: '#EF4444' }}>{p.disc_bear ?? 0}%</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Net</span>
                    <strong style={{ color: netColor(p.disc_net ?? 0) }}>{sign(p.disc_net ?? 0)}%</strong>
                </div>
            </div>

            {/* Watchlist pool */}
            <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 6, marginBottom: 6 }}>
                <div style={{ color: WL_COLOR, fontWeight: 700, marginBottom: 4, fontSize: 10, letterSpacing: '0.05em' }}>
                    WATCHLIST · {wlCount} coins
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Bull %</span>
                    <strong style={{ color: WL_COLOR }}>+{p.wl_bull ?? 0}%</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Bear %</span>
                    <strong style={{ color: '#EF4444' }}>{p.wl_bear ?? 0}%</strong>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Net</span>
                    <strong style={{ color: netColor(p.wl_net ?? 0) }}>{sign(p.wl_net ?? 0)}%</strong>
                </div>
            </div>

            {/* Confirmed overlap */}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-muted)' }}>Confirmed (both pools)</span>
                <strong style={{ color: CONF_COLOR }}>{overlap} coins</strong>
            </div>
        </div>
    );
}

// ── Institutional status banner logic ─────────────────────────────────────────
function getBannerProps(screenerEverActive, discNet, wlNet, overlap, discCount, wlCount) {
    if (!screenerEverActive) {
        return {
            icon: <WifiOff size={13} style={{ color: '#F6AD55', flexShrink: 0 }} />,
            color: '#F6AD55',
            label: 'Screener Offline',
            detail: `Discovery wave inactive — open TradingView Screener to enable. Showing watchlist momentum only (${wlCount} coins, Δ% ±0.3% threshold).`,
        };
    }
    const bothBull  = discNet > 25 && wlNet > 25;
    const bothBear  = discNet < -25 && wlNet < -25;
    const diverging = (discNet > 20 && wlNet < -20) || (discNet < -20 && wlNet > 20);
    const discLead  = discNet > 20 && wlNet >= -10 && wlNet <= 10;
    const wlLead    = wlNet > 25 && Math.abs(discNet) < 15;
    const highConf  = overlap > 0 && discCount > 0 && (overlap / Math.min(discCount, wlCount || 1)) > 0.35;

    if (bothBull) return {
        icon:   <TrendingUp size={13} style={{ color: '#10B981', flexShrink: 0 }} />,
        color:  '#10B981',
        label:  'Strong Conviction',
        detail: `Both pools rising — discovery +${discNet}% / watchlist +${wlNet}%. Broad participation confirms institutional buy pressure.`,
    };
    if (bothBear) return {
        icon:   <TrendingDown size={13} style={{ color: '#EF4444', flexShrink: 0 }} />,
        color:  '#EF4444',
        label:  'Broad Distribution',
        detail: `Both pools declining — discovery ${discNet}% / watchlist ${wlNet}%. Risk-off signal across screener and tracked positions.`,
    };
    if (diverging) return {
        icon:   <Zap size={13} style={{ color: CONF_COLOR, flexShrink: 0 }} />,
        color:  CONF_COLOR,
        label:  'Rotation Signal',
        detail: discNet > wlNet
            ? `Discovery +${discNet}% while watchlist ${wlNet}% — new inflows not yet reflected in held positions.`
            : `Watchlist +${wlNet}% while discovery ${discNet}% — screener finding new bearish setups, exits possible.`,
    };
    if (discLead) return {
        icon:   <TrendingUp size={13} style={{ color: DISC_COLOR, flexShrink: 0 }} />,
        color:  DISC_COLOR,
        label:  'Early Inflow Signal',
        detail: `Discovery leading +${discNet}% with watchlist neutral — screener finding new setups before watchlist confirms.`,
    };
    if (wlLead) return {
        icon:   <TrendingUp size={13} style={{ color: WL_COLOR, flexShrink: 0 }} />,
        color:  WL_COLOR,
        label:  'Momentum Carry',
        detail: `Watchlist holding +${wlNet}% with weak discovery signal — existing positions running, watch for exhaustion.`,
    };
    if (highConf) return {
        icon:   <Layers size={13} style={{ color: CONF_COLOR, flexShrink: 0 }} />,
        color:  CONF_COLOR,
        label:  'High Confirmation',
        detail: `${overlap} coins confirmed in both pools (${Math.round((overlap / Math.min(discCount, wlCount || 1)) * 100)}% overlap) — institutional convergence signal.`,
    };
    return {
        icon:   <Zap size={13} style={{ color: '#FACC15', flexShrink: 0 }} />,
        color:  '#FACC15',
        label:  'Consolidation',
        detail: `Low conviction across both pools. Discovery ${discNet > 0 ? '+' : ''}${discNet}% / Watchlist ${wlNet > 0 ? '+' : ''}${wlNet}%.`,
    };
}

// ── Main widget ───────────────────────────────────────────────────────────────
export function ParticipationPulseWidget() {
    const containerRef                = useRef(null);
    const participationPulse          = useTimeStore(s => s.participationPulse);
    const fetchParticipationPulse     = useTimeStore(s => s.fetchParticipationPulse);
    const participationPulseFetchedAt = useTimeStore(s => s.participationPulseFetchedAt);
    const lastDataPush                = useTimeStore(s => s.lastDataPush);
    const [isMobile, setIsMobile]     = useState(false);

    useEffect(() => {
        const mql = window.matchMedia('(pointer: coarse)');
        setIsMobile(mql.matches);
        const handler = (e) => setIsMobile(e.matches);
        mql.addEventListener('change', handler);
        return () => mql.removeEventListener('change', handler);
    }, []);

    useEffect(() => { fetchParticipationPulse(); }, []);
    useDataInvalidation(containerRef, fetchParticipationPulse, lastDataPush);

    // Audit fix: same gap as AlphaScatter/CascadeTrendWidget — this widget only
    // ever refreshes via socket-driven invalidation (lastDataPush) with no interval
    // fallback. Per Rule #18, keep a safety-net poll so a stalled/dropped websocket
    // (SocketService has no polling transport to fall back to) doesn't leave this
    // chart frozen until a manual page reload. 5-minute cadence, matching
    // FusionDashboard's equivalent guard.
    useEffect(() => {
        const id = setInterval(() => fetchParticipationPulse(), 300_000);
        return () => clearInterval(id);
    }, [fetchParticipationPulse]);

    const [isPulsing, setIsPulsing] = useState(false);
    useEffect(() => {
        if (participationPulse && participationPulse.length > 0) {
            setIsPulsing(false);
            const t1 = setTimeout(() => setIsPulsing(true), 10);
            const t2 = setTimeout(() => setIsPulsing(false), 1300);
            return () => { clearTimeout(t1); clearTimeout(t2); };
        }
    }, [participationPulse]);

    // ── Chart data ────────────────────────────────────────────────────────────
    const chartData = useMemo(() => {
        if (!participationPulse || participationPulse.length === 0) return [];

        let src = participationPulse;
        if (src.length === 1) {
            // Recharts needs ≥2 points to render areas
            const clone = { ...src[0], time: new Date(new Date(src[0].time).getTime() + 1000).toISOString() };
            src = [src[0], clone];
        }

        return src.map(p => {
            const discNet = p.disc_net ?? 0;
            const wlNet   = p.wl_net  ?? 0;
            return {
                ...p,
                timeLabel: format(new Date(p.time), 'HH:mm'),
                // Discovery wave (teal) — split at zero for gradient fill per side
                d_pos: Math.max(0, discNet),
                d_neg: Math.min(0, discNet),
                // Watchlist wave (amber) — always active
                w_pos: Math.max(0, wlNet),
                w_neg: Math.min(0, wlNet),
            };
        });
    }, [participationPulse]);

    const { brushRange, handleBrushChange } = useChartBrush('tv_pulseBrush', chartData);

    if (chartData.length === 0) return null;

    const latest            = chartData[chartData.length - 1] || {};
    const screenerEverActive = chartData.some(p => p.screener_active);

    const discNet   = latest.disc_net        ?? 0;
    const wlNet     = latest.wl_net          ?? 0;
    const discCount = latest.discovery_count ?? 0;
    const wlCount   = latest.watchlist_count ?? 0;
    const overlap   = latest.overlap_count   ?? 0;

    const banner = getBannerProps(screenerEverActive, discNet, wlNet, overlap, discCount, wlCount);

    return (
        <div
            ref={containerRef}
            className={`flex flex-col w-full p-4 h-[400px] rounded-lg shadow-sm ${isPulsing ? 'animate-widget-glow' : ''}`}
            style={{ backgroundColor: 'var(--bg-panel)', color: 'var(--text-main)', border: '1px solid var(--border)', touchAction: 'pan-y' }}
        >
            {/* ── Header ─────────────────────────────────────────────────────── */}
            <div className="flex items-center justify-between mb-2 pb-2" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2">
                    <Activity size={18} style={{ color: DISC_COLOR }} />
                    <h3 className="text-sm font-bold uppercase" style={{ color: 'var(--text-muted)' }}>
                        Market Participation
                    </h3>
                    <FreshnessChip ts={participationPulseFetchedAt} title="Participation data last fetched from server" />
                </div>

                <div className="flex gap-3 items-center">
                    {/* Discovery pill */}
                    <div className="flex flex-col items-end">
                        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: DISC_COLOR, opacity: 0.8 }}>
                            Discovery
                        </span>
                        <span className="text-sm font-bold font-mono" style={{ color: DISC_COLOR }}>
                            {discCount}
                            <span style={{ fontSize: 9, opacity: 0.65, marginLeft: 2 }}>coins</span>
                        </span>
                    </div>

                    {/* Watchlist pill */}
                    <div className="flex flex-col items-end border-l border-[var(--border)] pl-3">
                        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: WL_COLOR, opacity: 0.8 }}>
                            Watchlist
                        </span>
                        <span className="text-sm font-bold font-mono" style={{ color: WL_COLOR }}>
                            {wlCount}
                            <span style={{ fontSize: 9, opacity: 0.65, marginLeft: 2 }}>coins</span>
                        </span>
                    </div>

                    {/* Confirmed (overlap) pill */}
                    <div className="flex flex-col items-end border-l border-[var(--border)] pl-3">
                        <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: CONF_COLOR, opacity: 0.8 }}>
                            Confirmed
                        </span>
                        <span className="text-sm font-bold font-mono" style={{ color: CONF_COLOR }}>
                            {overlap}
                            <span style={{ fontSize: 9, opacity: 0.65, marginLeft: 2 }}>both</span>
                        </span>
                    </div>

                    {/* Screener status */}
                    <div className="flex flex-col items-end border-l border-[var(--border)] pl-3">
                        <span className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Screener</span>
                        {screenerEverActive ? (
                            <span style={{ fontSize: 10, color: '#68D391', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 2 }}>
                                ● Live ({discCount})
                            </span>
                        ) : (
                            <span style={{ fontSize: 10, color: '#F6AD55', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 2 }}>
                                <WifiOff size={9} /> Offline
                            </span>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Status banner ──────────────────────────────────────────────── */}
            <div className="flex items-start gap-2 mb-3 p-2 rounded text-xs" style={{ backgroundColor: 'var(--bg-app)' }}>
                {banner.icon}
                <span style={{ color: banner.color, fontWeight: 700, flexShrink: 0 }}>{banner.label}:</span>
                <span style={{ color: 'var(--text-muted)' }}>{banner.detail}</span>
            </div>

            {/* ── Chart ──────────────────────────────────────────────────────── */}
            <div className="flex-1 min-h-[150px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                        <defs>
                            {/* Discovery (teal) — bull above 0, bear below 0 */}
                            <linearGradient id="ppDiscBull" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%"   stopColor={DISC_COLOR} stopOpacity={0.5} />
                                <stop offset="100%" stopColor={DISC_COLOR} stopOpacity={0.04} />
                            </linearGradient>
                            <linearGradient id="ppDiscBear" x1="0" y1="1" x2="0" y2="0">
                                <stop offset="0%"   stopColor={DISC_COLOR} stopOpacity={0.4} />
                                <stop offset="100%" stopColor={DISC_COLOR} stopOpacity={0.04} />
                            </linearGradient>
                            {/* Watchlist (amber) — bull above 0, bear below 0 */}
                            <linearGradient id="ppWlBull" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%"   stopColor={WL_COLOR} stopOpacity={0.45} />
                                <stop offset="100%" stopColor={WL_COLOR} stopOpacity={0.04} />
                            </linearGradient>
                            <linearGradient id="ppWlBear" x1="0" y1="1" x2="0" y2="0">
                                <stop offset="0%"   stopColor={WL_COLOR} stopOpacity={0.35} />
                                <stop offset="100%" stopColor={WL_COLOR} stopOpacity={0.04} />
                            </linearGradient>
                        </defs>

                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.4} />

                        <XAxis dataKey="timeLabel" axisLine={false} tickLine={false}
                            tick={{ fontSize: 9, fill: 'var(--text-muted)' }} minTickGap={30} />

                        {/* Fixed -100 → +100 Y-axis — same scale for both pools */}
                        <YAxis domain={[-100, 100]} axisLine={false} tickLine={false}
                            ticks={[-100, -50, 0, 50, 100]}
                            tick={{ fontSize: 8, fill: 'var(--text-muted)' }}
                            tickFormatter={v => v > 0 ? `+${v}` : `${v}`} />

                        <Tooltip content={<PulseTooltip />}
                            cursor={{ strokeDasharray: '3 3', stroke: 'rgba(255,255,255,0.15)' }}
                            isAnimationActive={false}
                            trigger={isMobile ? 'click' : 'hover'} />

                        {/* Reference lines: zero (solid), ±50 (light), ±80 (faint) */}
                        <ReferenceLine y={0}   stroke="rgba(255,255,255,0.22)" strokeWidth={1} />
                        <ReferenceLine y={50}  stroke="rgba(255,255,255,0.07)" strokeDasharray="4 4" />
                        <ReferenceLine y={-50} stroke="rgba(255,255,255,0.07)" strokeDasharray="4 4" />
                        <ReferenceLine y={80}  stroke="rgba(255,255,255,0.04)" strokeDasharray="2 6" />
                        <ReferenceLine y={-80} stroke="rgba(255,255,255,0.04)" strokeDasharray="2 6" />

                        {/* Watchlist wave (amber) — rendered first so discovery overlays it */}
                        <Area type="monotone" dataKey="w_pos"
                            stroke={WL_COLOR} strokeWidth={1.5}
                            fill="url(#ppWlBull)" baseValue={0} isAnimationActive={false}
                            activeDot={WL_ACTIVE_DOT} />
                        <Area type="monotone" dataKey="w_neg"
                            stroke={WL_COLOR} strokeWidth={1.5}
                            fill="url(#ppWlBear)" baseValue={0} isAnimationActive={false}
                            activeDot={WL_ACTIVE_DOT} />

                        {/* Discovery wave (teal) — on top; flat at 0 when screener offline */}
                        <Area type="monotone" dataKey="d_pos"
                            stroke={DISC_COLOR} strokeWidth={1.5}
                            fill="url(#ppDiscBull)" baseValue={0} isAnimationActive={false}
                            activeDot={DISC_ACTIVE_DOT} />
                        <Area type="monotone" dataKey="d_neg"
                            stroke={DISC_COLOR} strokeWidth={1.5}
                            fill="url(#ppDiscBear)" baseValue={0} isAnimationActive={false}
                            activeDot={DISC_ACTIVE_DOT} />

                        <Brush dataKey="timeLabel" height={20} travellerWidth={16}
                            stroke="var(--text-muted)" fill="var(--bg-app)"
                            onChange={handleBrushChange}
                            startIndex={brushRange.startIndex}
                            endIndex={brushRange.endIndex} />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>

            {/* ── Legend ─────────────────────────────────────────────────────── */}
            <div className="flex justify-between items-center mt-2 px-1">
                <div className="text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                    Market Breadth · Discovery vs Watchlist · −100 → +100
                </div>
                <div className="flex flex-wrap gap-3 text-[9px] font-bold uppercase" style={{ color: 'var(--text-muted)' }}>
                    <span className="flex items-center gap-1">
                        <span style={{ width: 16, height: 2, background: DISC_COLOR, display: 'inline-block', borderRadius: 1 }} />
                        Discovery
                    </span>
                    <span className="flex items-center gap-1">
                        <span style={{ width: 16, height: 2, background: WL_COLOR, display: 'inline-block', borderRadius: 1 }} />
                        Watchlist
                    </span>
                    <span className="flex items-center gap-1">
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: CONF_COLOR, display: 'inline-block' }} />
                        Confirmed
                    </span>
                </div>
            </div>
        </div>
    );
}

export default ParticipationPulseWidget;
