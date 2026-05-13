import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
    ComposedChart, Bar, Line, XAxis, YAxis, ReferenceLine, ReferenceDot,
    Tooltip, ResponsiveContainer, Brush, Cell,
} from 'recharts';
import { FreshnessChip } from '../FreshnessChip';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useChartBrush } from '../../hooks/useChartBrush';
import socketService from '../../services/SocketService';
import { Activity, RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import styles from './SmartMoodChart.module.css';

const HOURS_OPTIONS = [
    { label: '1h',  value: 1  },
    { label: '2h',  value: 2  },
    { label: '4h',  value: 4  },
    { label: '8h',  value: 8  },
    { label: '24h', value: 24 },
];
const INTERVAL_OPTIONS = [
    { label: '1m',  value: 1  },
    { label: '5m',  value: 5  },
    { label: '15m', value: 15 },
];
const VOL_SOURCE_COLOR = {
    STREAM_D_RVOL:  '#d6bcfa',
    STREAM_C_ALERT: '#f6ad55',
    STREAM_A_EDGE:  '#63b3ed',
};
const VOL_SOURCE_LABEL = {
    STREAM_D_RVOL:  'D',
    STREAM_C_ALERT: 'C',
    STREAM_A_EDGE:  'A',
};
const SHIFT_COLOR = {
    net_cross:     { bull: '#68d391', bear: '#fc8181' },
    mood_cross:    { bull: '#63b3ed', bear: '#f6ad55' },
    momentum_flip: { bull: '#9ae6b4', bear: '#feb2b2' },
};
const SHIFT_LABEL = {
    net_cross:     'NET✕',
    mood_cross:    'MOOD✕',
    momentum_flip: 'FLIP',
};

function moodLabel(score) {
    if (score >  60) return 'EUPHORIC';
    if (score >  20) return 'BULLISH';
    if (score > -20) return 'NEUTRAL';
    if (score > -60) return 'BEARISH';
    return 'PANIC';
}

const LS_KEY = 'smartMoodChart_prefs';
const DEFAULTS = { hours: 8, intervalMin: 5 };

function loadPrefs() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_KEY));
        return s ? { ...DEFAULTS, ...s } : { ...DEFAULTS };
    } catch { return { ...DEFAULTS }; }
}

function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function moodColor(score) {
    if (score >  40) return '#68d391';
    if (score >  10) return '#9ae6b4';
    if (score > -10) return '#a0aec0';
    if (score > -40) return '#feb2b2';
    return '#fc8181';
}

/* ─── Rich tooltip — built inside main component to close over live event arrays ── */
function makeTooltip(volEvents, streamCEvents, intervalMin) {
    const halfMs = (intervalMin * 60 * 1000) / 2;

    return function ChartTooltip({ active, payload, label }) {
        if (!active || !payload?.length) return null;
        const d  = payload[0]?.payload || {};
        const mc = moodColor(d.mood ?? 0);
        const ml = moodLabel(d.mood ?? 0);

        // Live proximity lookup — finds coins within ±half-bucket of the hovered time.
        // This works even when no mood scan happened in that exact bucket.
        const nearVol = (volEvents || []).filter(e => Math.abs(e.ts - label) <= halfMs);
        const nearSC  = (streamCEvents || []).filter(e => Math.abs(e.ts - label) <= halfMs);

        // Deduplicate, keep highest-strength vol entry per coin
        const volMap = new Map();
        for (const e of nearVol) {
            const c = e.clean || e.ticker;
            if (!volMap.has(c) || (e.strength || 0) > (volMap.get(c).strength || 0))
                volMap.set(c, e);
        }
        const scMap = new Map();
        for (const e of nearSC) {
            const c = e.clean || e.ticker;
            if (!scMap.has(c)) scMap.set(c, e.direction);
        }

        const volCoins = [...volMap.entries()].map(([c, e]) => ({
            c, s: e.source, str: +(e.strength || 1).toFixed(2)
        })).sort((a, b) => b.str - a.str);
        const scCoins = [...scMap.entries()].map(([c, dir]) => ({ c, d: dir }));

        return (
            <div className={styles.tooltip}>
                <div className={styles.tooltipTime}>{fmtTime(label)}</div>

                {/* Mood */}
                <div className={styles.tooltipRow}>
                    <span className={styles.tooltipLabel}>Mood</span>
                    <span style={{ color: mc, fontWeight: 700 }}>
                        {d.mood != null ? (d.mood > 0 ? '+' : '') + d.mood : '—'}
                    </span>
                    <span className={styles.tooltipBadge} style={{ background: mc + '22', color: mc }}>{ml}</span>
                </div>

                {/* Breadth — explain what bull/bear means */}
                <div className={styles.tooltipRow}>
                    <span className={styles.tooltipLabel}>Breadth</span>
                    <span style={{ color: '#68d391' }} title="positionCode ≥ 300: price above multi-TF EMAs">{d.bull ?? '—'}▲</span>
                    <span style={{ color: '#fc8181', marginLeft: 6 }} title="positionCode 100–199: price below EMAs">{d.bear ?? '—'}▼</span>
                    <span style={{ color: d.net >= 0 ? '#68d391' : '#fc8181', marginLeft: 6, fontWeight: 600 }}>
                        net {d.net != null ? (d.net > 0 ? '+' : '') + d.net : '—'}
                    </span>
                </div>

                {/* Vol spikes — proximity-matched */}
                {volCoins.length > 0 && (
                    <div className={styles.tooltipSection}>
                        <div className={styles.tooltipSectionLabel}>Vol spikes ({volCoins.length})</div>
                        <div className={styles.coinPillRow}>
                            {volCoins.map((v, i) => (
                                <span key={i} className={styles.coinPill}
                                    style={{ borderColor: (VOL_SOURCE_COLOR[v.s] || '#718096') + '80',
                                             color: VOL_SOURCE_COLOR[v.s] || '#a0aec0' }}>
                                    {v.c}
                                    <span className={styles.srcTag}>{VOL_SOURCE_LABEL[v.s] || '?'}</span>
                                    {v.str > 1.2 && <span className={styles.strTag}>{v.str}×</span>}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {/* Stream C alerts — proximity-matched, shows which coin turned */}
                {scCoins.length > 0 && (
                    <div className={styles.tooltipSection}>
                        <div className={styles.tooltipSectionLabel}>
                            Turned {scCoins.filter(s => s.d > 0).length > 0 ? '🟢' : ''}
                            {scCoins.filter(s => s.d < 0).length > 0 ? '🔴' : ''} via Stream C
                        </div>
                        <div className={styles.coinPillRow}>
                            {scCoins.map((s, i) => (
                                <span key={i} className={styles.coinPill}
                                    style={{ borderColor: (s.d > 0 ? '#68d391' : '#fc8181') + '80',
                                             color: s.d > 0 ? '#68d391' : '#fc8181' }}>
                                    {s.c}{s.d > 0 ? ' ▲' : ' ▼'}
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {volCoins.length === 0 && scCoins.length === 0 && (
                    <div style={{ fontSize: 9, color: '#4a5568', marginTop: 4 }}>No events in this bucket</div>
                )}
            </div>
        );
    };
}

/* ─── Main widget ─────────────────────────────────────────────────────── */
export function SmartMoodChart() {
    const [prefs, setPrefs] = useState(loadPrefs);
    const { hours, intervalMin } = prefs;

    const updatePref = (key, val) => setPrefs(prev => {
        const next = { ...prev, [key]: val };
        try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
        return next;
    });

    const { data, loading, error, reload, reloadSilent, lastFetchedAt } = usePolledFetch(
        () => `/api/smart-mood-chart?hours=${hours}&interval_min=${intervalMin}`,
        { intervalMs: 120_000, deps: [hours, intervalMin] }
    );

    // Live socket refresh
    useEffect(() => {
        const socket = socketService.connect();
        let t;
        const handler = () => { clearTimeout(t); t = setTimeout(() => reloadSilent(), 1500); };
        socket.on('scan-update',        handler);
        socket.on('smart-level-update', handler);
        return () => { clearTimeout(t); socket.off('scan-update', handler); socket.off('smart-level-update', handler); };
    }, [reloadSilent]);

    const chartData    = data?.timeline     || [];
    const volEvents    = useMemo(() => (data?.volEvents    || []).slice(-400), [data]);
    const streamCEvents= useMemo(() => (data?.streamCEvents|| []).slice(-400), [data]);
    const shifts       = data?.shifts       || [];

    // Memoize the tooltip so it only recreates when event arrays or interval change
    const TooltipContent = useMemo(
        () => makeTooltip(volEvents, streamCEvents, intervalMin),
        [volEvents, streamCEvents, intervalMin]
    );

    // Brush with live-view — auto-follows right edge; draggable range
    const { brushRange, handleBrushChange } = useChartBrush('smartMoodChart_brush', chartData);

    const netDomain = useMemo(() => {
        if (!chartData.length) return [-30, 30];
        let lo = 0, hi = 0;
        for (const d of chartData) { if (d.net < lo) lo = d.net; if (d.net > hi) hi = d.net; }
        const pad = Math.max(5, Math.ceil(Math.max(Math.abs(lo), Math.abs(hi)) * 0.2));
        return [Math.floor(lo - pad), Math.ceil(hi + pad)];
    }, [chartData]);

    const latest   = chartData[chartData.length - 1];
    const prev     = chartData[chartData.length - 2];
    const moodDelta = latest && prev ? latest.mood - prev.mood : null;

    return (
        <div className={styles.widget}>

            {/* ── Header ── */}
            <div className={styles.header}>
                <div className={styles.titleRow}>
                    <div className="widget-title">
                        <span className={styles.titleIcon}><Activity size={16} className="text-accent-blue" /></span>
                        <span className={styles.titleText}>SMART MOOD CHART</span>
                        <span className={styles.titleSub}>breadth · mood · shift detection</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <FreshnessChip ts={lastFetchedAt} title="Last fetched from server" />
                        <button className={styles.refreshBtn} onClick={() => reload()} title="Refresh">
                            <RefreshCw size={14} />
                        </button>
                    </div>
                </div>

                <div className={styles.controlsRow}>
                    <div className={styles.controlGroup}>
                        <span className={styles.controlLabel}>Window</span>
                        {HOURS_OPTIONS.map(o => (
                            <button key={o.value}
                                className={`${styles.pill} ${hours === o.value ? styles.pillActive : ''}`}
                                onClick={() => updatePref('hours', o.value)}>
                                {o.label}
                            </button>
                        ))}
                    </div>
                    <div className={styles.controlGroup}>
                        <span className={styles.controlLabel}>Bucket</span>
                        {INTERVAL_OPTIONS.map(o => (
                            <button key={o.value}
                                className={`${styles.pill} ${intervalMin === o.value ? styles.pillActive : ''}`}
                                onClick={() => updatePref('intervalMin', o.value)}>
                                {o.label}
                            </button>
                        ))}
                    </div>
                    {/* Live indicator */}
                    {brushRange.isLive && (
                        <span className={styles.liveDot} title="Auto-following latest data">● LIVE</span>
                    )}
                </div>
            </div>

            {/* ── Stats strip ── */}
            {latest && (
                <div className={styles.statsStrip}>
                    <div className={styles.statBlock}>
                        <span className={styles.statLabel}>Mood</span>
                        <span className={styles.statValue} style={{ color: moodColor(latest.mood) }}>
                            {latest.mood > 0 ? '+' : ''}{latest.mood}
                            {moodDelta != null && moodDelta !== 0 && (
                                <span style={{ fontSize: 10, color: moodDelta > 0 ? '#68d391' : '#fc8181', marginLeft: 2 }}>
                                    {moodDelta > 0 ? '↑' : '↓'}
                                </span>
                            )}
                        </span>
                        <span className={styles.statSub} style={{ color: moodColor(latest.mood) }}>
                            {moodLabel(latest.mood)}
                        </span>
                    </div>
                    <div className={styles.statDivider} />
                    <div className={styles.statBlock}
                        title="Coins with positionCode ≥ 300 — price is ABOVE the EMA stack across multiple timeframes (NOT just day change %)">
                        <span className={styles.statLabel}>Bull ▲</span>
                        <span className={styles.statValue} style={{ color: '#68d391' }}>{latest.bull}</span>
                        <span className={styles.statSub} style={{ color: '#4a5568' }}>EMA above</span>
                    </div>
                    <div className={styles.statBlock}
                        title="Coins with positionCode 100–199 — price is BELOW the EMA stack (NOT day change %)">
                        <span className={styles.statLabel}>Bear ▼</span>
                        <span className={styles.statValue} style={{ color: '#fc8181' }}>{latest.bear}</span>
                        <span className={styles.statSub} style={{ color: '#4a5568' }}>EMA below</span>
                    </div>
                    <div className={styles.statBlock}>
                        <span className={styles.statLabel}>Net</span>
                        <span className={styles.statValue} style={{ color: latest.net >= 0 ? '#68d391' : '#fc8181' }}>
                            {latest.net > 0 ? '+' : ''}{latest.net}
                        </span>
                    </div>
                    {/* Recent shift chips */}
                    <div className={styles.shiftGroup}>
                        {shifts.length === 0 && (
                            <span className={styles.shiftChip} style={{ color: '#4a5568', borderColor: 'rgba(255,255,255,0.06)' }}>
                                <Minus size={9} /> no shifts
                            </span>
                        )}
                        {shifts.slice(-4).reverse().map((s, i) => {
                            const color = SHIFT_COLOR[s.type]?.[s.direction] || '#718096';
                            return (
                                <span key={i} className={styles.shiftChip}
                                    style={{ borderColor: color + '60', color }}>
                                    {s.direction === 'bull' ? <TrendingUp size={9} /> : <TrendingDown size={9} />}
                                    {SHIFT_LABEL[s.type]} {fmtTime(s.ts)}
                                </span>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* ── Chart ── */}
            <div className={styles.chartWrap}>
                {loading && !data && (
                    <div className={styles.loading}><div className={styles.spinner} /> Loading…</div>
                )}
                {error && <div className={styles.error}>⚠ {error}</div>}
                {!loading && !error && chartData.length === 0 && (
                    <div className={styles.empty}>No mood data in the last {hours}h</div>
                )}

                {chartData.length > 0 && (
                    <ResponsiveContainer width="100%" height={260}>
                        <ComposedChart data={chartData} margin={{ top: 6, right: 30, left: 2, bottom: 2 }}>
                            <XAxis
                                dataKey="ts"
                                type="number"
                                scale="time"
                                domain={['dataMin', 'dataMax']}
                                tickFormatter={fmtTime}
                                tick={{ fill: '#4a5568', fontSize: 9 }}
                                tickLine={false}
                                axisLine={{ stroke: 'rgba(255,255,255,0.05)' }}
                            />
                            {/* Left Y: net breadth */}
                            <YAxis
                                yAxisId="net"
                                domain={netDomain}
                                tick={{ fill: '#4a5568', fontSize: 9 }}
                                width={26}
                                axisLine={false}
                                tickLine={false}
                                tickCount={5}
                            />
                            {/* Right Y: mood −100 → +100 */}
                            <YAxis
                                yAxisId="mood"
                                orientation="right"
                                domain={[-100, 100]}
                                tick={{ fill: '#4a5568', fontSize: 9 }}
                                width={26}
                                axisLine={false}
                                tickLine={false}
                                ticks={[-100, -50, 0, 50, 100]}
                            />

                            <Tooltip content={<TooltipContent />} />

                            {/* Zero reference lines */}
                            <ReferenceLine yAxisId="net"  y={0} stroke="rgba(255,255,255,0.1)" strokeDasharray="3 3" />
                            <ReferenceLine yAxisId="mood" y={0} stroke="rgba(255,255,255,0.06)" />

                            {/* Net breadth bars — center-zero */}
                            <Bar yAxisId="net" dataKey="net" barSize={6} isAnimationActive={false} radius={[2, 2, 0, 0]} name="Net breadth">
                                {chartData.map((d, i) => (
                                    <Cell key={i} fill={d.net >= 0 ? 'rgba(104,211,145,0.55)' : 'rgba(252,129,129,0.55)'} />
                                ))}
                            </Bar>

                            {/* Mood score line */}
                            <Line
                                yAxisId="mood"
                                type="monotone"
                                dataKey="mood"
                                stroke="#63b3ed"
                                strokeWidth={1.8}
                                dot={false}
                                isAnimationActive={false}
                                name="Mood"
                            />

                            {/* Volume spike vertical markers */}
                            {volEvents.map((e, i) => (
                                <ReferenceLine
                                    key={`vol-${i}`}
                                    yAxisId="net"
                                    x={e.ts}
                                    stroke={VOL_SOURCE_COLOR[e.source] || '#718096'}
                                    strokeOpacity={0.4}
                                    strokeWidth={1}
                                    strokeDasharray="2 4"
                                />
                            ))}

                            {/* Stream C alert dots — top/bottom of mood axis */}
                            {streamCEvents.map((e, i) => (
                                <ReferenceDot
                                    key={`sc-${i}`}
                                    yAxisId="mood"
                                    x={e.ts}
                                    y={e.direction > 0 ? 88 : -88}
                                    r={3}
                                    fill={e.direction > 0 ? '#68d391' : '#fc8181'}
                                    stroke="none"
                                />
                            ))}

                            {/* Shift detection vertical markers */}
                            {shifts.map((s, i) => {
                                const color = SHIFT_COLOR[s.type]?.[s.direction] || '#718096';
                                return (
                                    <ReferenceLine
                                        key={`shift-${i}`}
                                        yAxisId="mood"
                                        x={s.ts}
                                        stroke={color}
                                        strokeWidth={1.5}
                                        strokeOpacity={0.75}
                                        label={{ value: SHIFT_LABEL[s.type], position: 'insideTopLeft', fill: color, fontSize: 8 }}
                                    />
                                );
                            })}

                            {/* Slim Brush — live-follows right edge, draggable range */}
                            <Brush
                                dataKey="ts"
                                height={10}
                                travellerWidth={6}
                                stroke="rgba(255,255,255,0.15)"
                                fill="rgba(0,0,0,0.25)"
                                tickFormatter={() => ''}
                                startIndex={brushRange.startIndex}
                                endIndex={brushRange.endIndex}
                                onChange={handleBrushChange}
                            />
                        </ComposedChart>
                    </ResponsiveContainer>
                )}
            </div>

            {/* ── Legend ── */}
            <div className={styles.legend}>
                <span className={styles.legendItem}><span style={{ background:'rgba(104,211,145,0.55)', display:'inline-block', width:10, height:8, borderRadius:2, marginRight:4 }}/>Net▲</span>
                <span className={styles.legendItem}><span style={{ background:'rgba(252,129,129,0.55)', display:'inline-block', width:10, height:8, borderRadius:2, marginRight:4 }}/>Net▼</span>
                <span className={styles.legendItem}><span style={{ background:'#63b3ed', display:'inline-block', width:18, height:2, borderRadius:1, marginRight:4, verticalAlign:'middle' }}/>Mood</span>
                <span className={styles.legendItem}><span style={{ background:'#d6bcfa', display:'inline-block', width:2, height:10, marginRight:4, verticalAlign:'middle', opacity:0.6 }}/>VolD</span>
                <span className={styles.legendItem}><span style={{ background:'#f6ad55', display:'inline-block', width:2, height:10, marginRight:4, verticalAlign:'middle', opacity:0.6 }}/>VolC</span>
                <span className={styles.legendItem}><span style={{ background:'#63b3ed', display:'inline-block', width:2, height:10, marginRight:4, verticalAlign:'middle', opacity:0.6 }}/>VolA</span>
                <span className={styles.legendItem}><span style={{ background:'#68d391', display:'inline-block', width:6, height:6, borderRadius:'50%', marginRight:4, verticalAlign:'middle' }}/>C▲</span>
                <span className={styles.legendItem}><span style={{ background:'#fc8181', display:'inline-block', width:6, height:6, borderRadius:'50%', marginRight:4, verticalAlign:'middle' }}/>C▼</span>
                <span className={styles.legendItem} style={{ color:'#718096' }}>│ shift</span>
            </div>
        </div>
    );
}

export default SmartMoodChart;
