import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    ComposedChart, Area, Line, XAxis, YAxis, ReferenceLine,
    Tooltip, ResponsiveContainer,
} from 'recharts';
import styles from './LevelReactionWidget.module.css';

// ─── Helpers ────────────────────────────────────────────────────────────────

function smartFmt(price) {
    if (price == null || isNaN(price) || price === 0) return '0';
    if (price >= 1000)  return price.toFixed(2);
    if (price >= 1)     return price.toFixed(4);
    if (price >= 0.01)  return price.toFixed(5);
    if (price >= 0.001) return price.toFixed(6);
    return price.toFixed(8);
}
function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function timeAgo(isoStr) {
    if (!isoStr) return '';
    const s = Math.round((Date.now() - new Date(isoStr)) / 1000);
    if (s < 60)  return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
}

// ─── Stream D chip helpers ───────────────────────────────────────────────────

/**
 * Returns { color, bg, label } for a known Stream D field and its value.
 * RSI zones, EMA proximity, ATR, RelVol — all colour-coded by significance.
 */
function streamDChipStyle(key, value) {
    const k = key.toLowerCase();
    const v = parseFloat(value);
    if (isNaN(v)) return null;

    // RSI fields: rsi14_5m, rsi14_15m, rsi14_1h, rsi14_4h …
    if (k.includes('rsi')) {
        if (v <= 30)      return { color: '#68d391', bg: 'rgba(104,211,145,0.15)', label: `RSI ${v.toFixed(0)}` };
        if (v <= 45)      return { color: '#9ae6b4', bg: 'rgba(154,230,180,0.10)', label: `RSI ${v.toFixed(0)}` };
        if (v <= 55)      return { color: '#a0aec0', bg: 'rgba(160,174,192,0.08)', label: `RSI ${v.toFixed(0)}` };
        if (v <= 70)      return { color: '#fbb6a2', bg: 'rgba(251,182,162,0.10)', label: `RSI ${v.toFixed(0)}` };
        return             { color: '#fc8181', bg: 'rgba(252,129,129,0.15)', label: `RSI ${v.toFixed(0)}` };
    }

    // Relative volume: relVol, rel_volume, relativeVolume …
    if (k.includes('relvol') || k.includes('rel_vol') || k.includes('relativevol')) {
        if (v >= 2.5)     return { color: '#f6ad55', bg: 'rgba(246,173,85,0.15)',  label: `RVol ${v.toFixed(1)}×` };
        if (v >= 1.5)     return { color: '#fefcbf', bg: 'rgba(254,252,191,0.10)', label: `RVol ${v.toFixed(1)}×` };
        return             { color: '#718096', bg: 'rgba(113,128,150,0.08)',         label: `RVol ${v.toFixed(1)}×` };
    }

    // ATR / volatility
    if (k.includes('atr') || k.includes('volatility')) {
        if (v >= 5)       return { color: '#f6ad55', bg: 'rgba(246,173,85,0.12)',  label: `ATR ${v.toFixed(1)}%` };
        if (v >= 2)       return { color: '#fefcbf', bg: 'rgba(254,252,191,0.08)', label: `ATR ${v.toFixed(1)}%` };
        return             { color: '#718096', bg: 'rgba(113,128,150,0.07)',         label: `ATR ${v.toFixed(1)}%` };
    }

    // EMA200 distance (ema200dist_5m, ema200_5m_dist …)
    if (k.includes('ema') && (k.includes('dist') || k.includes('200'))) {
        const sign = v >= 0 ? '+' : '';
        if (Math.abs(v) <= 1)  return { color: '#63b3ed', bg: 'rgba(99,179,237,0.12)', label: `EMA ${sign}${v.toFixed(1)}%` };
        if (v < -2)             return { color: '#fc8181', bg: 'rgba(252,129,129,0.10)', label: `EMA ${sign}${v.toFixed(1)}%` };
        if (v > 3)              return { color: '#68d391', bg: 'rgba(104,211,145,0.10)', label: `EMA ${sign}${v.toFixed(1)}%` };
        return                  { color: '#a0aec0', bg: 'rgba(160,174,192,0.07)',         label: `EMA ${sign}${v.toFixed(1)}%` };
    }

    return null; // unknown / not renderable as chip
}

/**
 * Pick the most meaningful Stream D fields to surface as chips.
 * Priority: RSI, RelVol, ATR/Volatility, EMA200 distance.
 * Handles both multi-TF keys (rsi14_5m) and single-TF keys (rsi_14, relVolume, ema_200).
 * Returns max 4 chips to keep the lane header compact.
 */
function pickStreamDChips(data, schema) {
    if (!data || !schema?.length) return [];

    const chips = [];
    const kl = k => k.toLowerCase();

    // 1. RSI — prefer multi-TF keys by shortest timeframe, else fall back to any RSI key
    const TF_PRIORITY = ['_5m', '5m', '_15m', '15m', '_1h', '1h', '_4h', '4h'];
    let rsiAdded = false;
    for (const tf of TF_PRIORITY) {
        const key = schema.find(k => kl(k).includes('rsi') && kl(k).endsWith(tf));
        if (key && data[key] != null) {
            const s = streamDChipStyle(key, data[key]);
            if (s) { chips.push({ key, ...s }); rsiAdded = true; break; }
        }
    }
    if (!rsiAdded) {
        // Fallback: any key that contains 'rsi' (handles rsi_14, rsi14, RSI(14), etc.)
        const rsiKey = schema.find(k => kl(k).includes('rsi'));
        if (rsiKey && data[rsiKey] != null) {
            const s = streamDChipStyle(rsiKey, data[rsiKey]);
            if (s) chips.push({ key: rsiKey, ...s });
        }
    }

    // 2. Relative Volume — matches relVolume, rel_volume, relVol, relativevolume
    const rvolKey = schema.find(k =>
        kl(k).includes('relvol') ||
        kl(k).includes('rel_vol') ||
        kl(k).includes('relativevol')
    );
    if (rvolKey && data[rvolKey] != null) {
        const s = streamDChipStyle(rvolKey, data[rvolKey]);
        if (s) chips.push({ key: rvolKey, ...s });
    }

    // 3. ATR % or Volatility (prefer ATR, fall back to volatility)
    const atrKey = schema.find(k => kl(k).includes('atr'))
                || schema.find(k => kl(k).includes('volatility'));
    if (atrKey && data[atrKey] != null) {
        const s = streamDChipStyle(atrKey, data[atrKey]);
        if (s) chips.push({ key: atrKey, ...s });
    }

    // 4. EMA200 distance — supports absolute ema_200 price (compute % from close)
    //    OR pre-computed dist fields (ema200dist_5m, ema200_5m_dist, etc.)
    if (chips.length < 4) {
        // Check for pre-computed dist key first
        const emaDistKey = schema.find(k => kl(k).includes('ema') && kl(k).includes('dist'));
        if (emaDistKey && data[emaDistKey] != null) {
            const s = streamDChipStyle(emaDistKey, data[emaDistKey]);
            if (s) chips.push({ key: emaDistKey, ...s });
        } else {
            // Compute from absolute ema_200 / ema200 price and close
            const emaAbsKey = schema.find(k => kl(k) === 'ema_200' || kl(k) === 'ema200' || (kl(k).includes('ema') && kl(k).includes('200')));
            if (emaAbsKey && data[emaAbsKey] != null) {
                const emaPrice  = parseFloat(data[emaAbsKey]);
                const closePrice = parseFloat(data.close || data.price || 0);
                if (!isNaN(emaPrice) && emaPrice > 0 && closePrice > 0) {
                    const pct  = ((closePrice - emaPrice) / emaPrice) * 100;
                    const sign = pct >= 0 ? '+' : '';
                    let color, bg;
                    if (Math.abs(pct) <= 1)  { color = '#63b3ed'; bg = 'rgba(99,179,237,0.12)'; }
                    else if (pct < -2)        { color = '#fc8181'; bg = 'rgba(252,129,129,0.10)'; }
                    else if (pct > 3)         { color = '#68d391'; bg = 'rgba(104,211,145,0.10)'; }
                    else                      { color = '#a0aec0'; bg = 'rgba(160,174,192,0.07)'; }
                    chips.push({ key: emaAbsKey, color, bg, label: `E200 ${sign}${pct.toFixed(1)}%` });
                }
            }
        }
    }

    return chips.slice(0, 4);
}

// ─── Stream D chips component ────────────────────────────────────────────────

function StreamDChips({ streamD, schema }) {
    if (!streamD?.data || !schema?.length) return null;
    const chips = pickStreamDChips(streamD.data, schema);
    if (!chips.length) return null;

    return (
        <div className={styles.streamDChips} title={`Stream D · ${timeAgo(streamD.ts)}`}>
            {chips.map(chip => (
                <span
                    key={chip.key}
                    className={styles.streamDChip}
                    style={{ color: chip.color, background: chip.bg, borderColor: chip.color + '40' }}
                >
                    {chip.label}
                </span>
            ))}
            <span className={styles.streamDAge}>{timeAgo(streamD.ts)}</span>
        </div>
    );
}

// ─── Reaction meta ──────────────────────────────────────────────────────────

const REACTION_META = {
    BOUNCE:      { label: '↑ BOUNCE',      color: '#68d391', bg: 'rgba(104,211,145,0.12)' },
    REJECT:      { label: '↓ REJECT',      color: '#fc8181', bg: 'rgba(252,129,129,0.12)' },
    BREAK_BULL:  { label: '⚡ BREAK ▲',    color: '#f6ad55', bg: 'rgba(246,173,85,0.12)'  },
    BREAK_BEAR:  { label: '⚡ BREAK ▼',    color: '#fc8181', bg: 'rgba(252,129,129,0.08)' },
    TESTING:     { label: '→ TESTING',     color: '#63b3ed', bg: 'rgba(99,179,237,0.08)'  },
    APPROACHING: { label: '⟶ APPROACH',    color: '#a0aec0', bg: 'rgba(160,174,192,0.06)' },
};

const SIDE_COLOR = {
    SUPPORT:    { line: '#68d391', zone: 'rgba(104,211,145,0.15)', label: 'S' },
    RESISTANCE: { line: '#fc8181', zone: 'rgba(252,129,129,0.15)', label: 'R' },
};

// ─── Custom tooltip ──────────────────────────────────────────────────────────

function LaneTooltip({ active, payload, coin }) {
    if (!active || !payload?.length) return null;
    const p = payload.find(x => x.dataKey === 'pct')?.payload || payload[0].payload;
    const sideCol = SIDE_COLOR[coin?.side] || SIDE_COLOR.SUPPORT;
    return (
        <div style={{
            background: '#0d1117', border: `1px solid ${sideCol.line}40`,
            borderRadius: 6, padding: '6px 10px', fontSize: 11, lineHeight: 1.7,
            boxShadow: '0 4px 20px rgba(0,0,0,0.7)', minWidth: 140,
        }}>
            <div style={{ color: '#718096', marginBottom: 2 }}>{fmtTime(p.ts)}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: '#a0aec0' }}>Price</span>
                <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{smartFmt(p.price)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: '#a0aec0' }}>Level</span>
                <span style={{ color: sideCol.line }}>{smartFmt(coin?.levelPrice)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: '#a0aec0' }}>vs Level</span>
                <span style={{ color: p.pct >= 0 ? '#68d391' : '#fc8181', fontWeight: 700 }}>
                    {p.pct > 0 ? '+' : ''}{p.pct?.toFixed(3)}%
                </span>
            </div>
        </div>
    );
}

// ─── Single swim lane ────────────────────────────────────────────────────────

// Volume-event source styling — truth-aware spike provenance
const VOL_SRC_META = {
    STREAM_C_ALERT: { label: 'C', color: '#f6ad55', bg: 'rgba(246,173,85,0.18)', name: 'Stream-C alert (truth)' },
    STREAM_A_EDGE:  { label: 'A', color: '#63b3ed', bg: 'rgba(99,179,237,0.15)', name: 'Stream-A rising edge' },
    STREAM_D_RVOL:  { label: 'D', color: '#d6bcfa', bg: 'rgba(214,188,250,0.15)', name: 'Stream-D RelVol ≥ 2×' },
};
// Source priority: C (truth) > D (live) > A (sticky-but-edge-detected)
const VOL_SRC_PRIORITY = { STREAM_C_ALERT: 3, STREAM_D_RVOL: 2, STREAM_A_EDGE: 1 };

function ReactionLane({ coin, windowMin, loading, schema, volEvents = [] }) {
    const meta     = REACTION_META[coin.reaction]   || REACTION_META.APPROACHING;
    const sideCol  = SIDE_COLOR[coin.side]          || SIDE_COLOR.SUPPORT;
    const isSupport = coin.side === 'SUPPORT';

    // Split history into above/below sections for dual-color area
    // We build two synthetic series — above (pct > 0) and below (pct < 0)
    const series = coin.history.length
        ? coin.history.map(h => ({
            ts:     h.ts,
            price:  h.price,
            pct:    h.pct,
            above:  Math.max(0, h.pct),  // green fill (above level)
            below:  Math.min(0, h.pct),  // red fill (below level)
        }))
        // If no history: synthetic flat line at distPct to show current position
        : [
            { ts: Date.now() - windowMin * 60000, pct: coin.distPct, price: coin.close, above: Math.max(0, coin.distPct), below: Math.min(0, coin.distPct) },
            { ts: Date.now(),                     pct: coin.distPct, price: coin.close, above: Math.max(0, coin.distPct), below: Math.min(0, coin.distPct) },
        ];

    const pcts  = series.map(s => s.pct);
    const pMin  = Math.min(...pcts, -0.5);
    const pMax  = Math.max(...pcts,  0.5);
    const pad   = Math.max(0.2, (pMax - pMin) * 0.15);
    const yMin  = pMin - pad;
    const yMax  = pMax + pad;

    const noHistory = coin.snapshot_count === 0;

    return (
        <div className={styles.lane} style={{ borderLeftColor: sideCol.line }}>
            {/* Lane header */}
            <div className={styles.laneHeader}>
                <div className={styles.laneLeft}>
                    <span className={styles.laneTicker}>{coin.cleanTicker}</span>
                    <span className={styles.laneSide} style={{ background: sideCol.zone, color: sideCol.line }}>
                        {sideCol.label}
                    </span>
                    <span className={styles.laneLevel}>{coin.levelLabel?.replace('EMA200_', '').replace('_', ' ')}</span>
                </div>

                <div className={styles.laneCenter}>
                    <span className={styles.lanePrice}>{smartFmt(coin.close)}</span>
                    {/* Distance from level — core signal */}
                    <span className={styles.laneDist}
                        style={{ color: coin.distPct >= 0 ? '#68d391' : '#fc8181' }}>
                        {coin.distPct > 0 ? '+' : ''}{coin.distPct.toFixed(2)}%
                    </span>
                    {/* Direction badge */}
                    <span className={styles.laneDir}
                        style={{
                            color:       coin.direction === 'BULL' ? '#68d391' : coin.direction === 'BEAR' ? '#fc8181' : '#a0aec0',
                            borderColor: coin.direction === 'BULL' ? 'rgba(104,211,145,0.3)' : coin.direction === 'BEAR' ? 'rgba(252,129,129,0.3)' : 'rgba(160,174,192,0.2)',
                        }}>
                        {coin.direction === 'BULL' ? '▲' : coin.direction === 'BEAR' ? '▼' : '—'} {coin.direction}
                    </span>
                    {/* Trend flow */}
                    {coin.netTrend !== 0 && (
                        <span className={styles.laneTrend}
                            style={{ color: coin.netTrend > 0 ? '#68d391' : '#fc8181' }}>
                            {coin.netTrend > 0 ? '+' : ''}{coin.netTrend}
                        </span>
                    )}
                </div>

                <div className={styles.laneRight}>
                    {/* Stream D technical chips — dynamic from schema */}
                    <StreamDChips streamD={coin.stream_d} schema={schema} />
                    {/* Volume badge: truth-aware (Stream C alert > Stream D RVol > Stream A edge).
                        Falls back to legacy sticky `volSpike` flag (greyed) when no recent event exists. */}
                    {(() => {
                        const fresh = volEvents.length
                            ? volEvents.slice().sort((a, b) =>
                                (VOL_SRC_PRIORITY[b.source] || 0) - (VOL_SRC_PRIORITY[a.source] || 0)
                                || new Date(b.ts) - new Date(a.ts)
                            )[0]
                            : null;
                        if (fresh) {
                            const m = VOL_SRC_META[fresh.source] || VOL_SRC_META.STREAM_A_EDGE;
                            const ago = Math.round((Date.now() - new Date(fresh.ts)) / 60000);
                            return (
                                <span className={styles.volBadge}
                                    style={{ color: m.color, background: m.bg, borderColor: m.color + '60' }}
                                    title={`${m.name} · ${ago}m ago${volEvents.length > 1 ? ` (+${volEvents.length - 1} more)` : ''}`}>
                                    VOL·{m.label} {ago}m
                                </span>
                            );
                        }
                        if (coin.volSpike) {
                            return (
                                <span className={styles.volBadge}
                                    style={{ opacity: 0.45 }}
                                    title="Stream-A sticky flag (no recent rising-edge — likely stale)">
                                    VOL·stale
                                </span>
                            );
                        }
                        return null;
                    })()}
                    <span className={styles.reactionBadge}
                        style={{ color: meta.color, background: meta.bg, borderColor: meta.color + '40' }}>
                        {meta.label}
                    </span>
                    <span className={styles.snapshotCount}>{coin.snapshot_count}pts</span>
                </div>
            </div>

            {/* Chart */}
            <div className={styles.laneChart}>
                {loading ? (
                    <div className={styles.laneLoading}>Loading…</div>
                ) : noHistory ? (
                    <div className={styles.laneEmpty}>
                        <span>📭 No price history yet</span>
                        <span style={{ fontSize: 9, color: '#4a5568' }}>Builds as scans arrive</span>
                    </div>
                ) : (
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={series} margin={{ top: 4, right: 56, left: 0, bottom: 0 }}>
                            <XAxis
                                dataKey="ts" type="number" scale="time"
                                domain={['dataMin', 'dataMax']}
                                tickFormatter={fmtTime}
                                tick={{ fontSize: 9, fill: '#4a5568' }}
                                tickCount={4}
                            />
                            <YAxis
                                domain={[yMin, yMax]}
                                tick={{ fontSize: 9, fill: '#4a5568' }}
                                tickFormatter={v => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
                                width={42}
                                tickCount={4}
                            />
                            <Tooltip
                                content={<LaneTooltip coin={coin} />}
                                isAnimationActive={false}
                            />

                            {/* Level = 0 line */}
                            <ReferenceLine y={0}
                                stroke={sideCol.line} strokeWidth={1.5}
                                strokeDasharray="none"
                                label={{
                                    value: coin.levelLabel?.replace('EMA200_', '').replace(/_/g, ' ') || coin.side,
                                    fill: sideCol.line, fontSize: 9,
                                    position: 'right', offset: 4,
                                }}
                            />

                            {/* Touch zone bands ±0.3% */}
                            <ReferenceLine y={0.3}  stroke={sideCol.line} strokeWidth={0.5} strokeDasharray="2 4" strokeOpacity={0.4} />
                            <ReferenceLine y={-0.3} stroke={sideCol.line} strokeWidth={0.5} strokeDasharray="2 4" strokeOpacity={0.4} />

                            {/* Volume-event pins — color-coded by source (truthful spike moments) */}
                            {volEvents.map((e, idx) => {
                                const m = VOL_SRC_META[e.source] || VOL_SRC_META.STREAM_A_EDGE;
                                return (
                                    <ReferenceLine key={`vol-${idx}`}
                                        x={new Date(e.ts).getTime()}
                                        stroke={m.color} strokeOpacity={0.55}
                                        strokeDasharray="2 3" strokeWidth={1}
                                        label={{ value: m.label, position: 'top', fill: m.color, fontSize: 9 }}
                                    />
                                );
                            })}

                            {/* Green area — price ABOVE level */}
                            <Area
                                type="monotone" dataKey="above"
                                stroke="none" fill="rgba(104,211,145,0.20)"
                                isAnimationActive={false} dot={false}
                                baseValue={0}
                            />

                            {/* Red area — price BELOW level */}
                            <Area
                                type="monotone" dataKey="below"
                                stroke="none" fill="rgba(252,129,129,0.22)"
                                isAnimationActive={false} dot={false}
                                baseValue={0}
                            />

                            {/* Main price path */}
                            <Line
                                type="monotone" dataKey="pct"
                                stroke={sideCol.line} strokeWidth={2}
                                dot={false}
                                activeDot={{ r: 3, fill: sideCol.line, strokeWidth: 0 }}
                                isAnimationActive={false}
                            />
                        </ComposedChart>
                    </ResponsiveContainer>
                )}
            </div>
        </div>
    );
}

// ─── Main widget ─────────────────────────────────────────────────────────────

const WINDOWS = [
    { label: '30m', value: 30 },
    { label: '1h',  value: 60 },
    { label: '2h',  value: 120 },
];

const INTERVALS = [
    { label: '1m',  value: 1  },
    { label: '5m',  value: 5  },
    { label: '15m', value: 15 },
];

export function LevelReactionWidget() {
    const [data,        setData]        = useState(null);
    const [loading,     setLoading]     = useState(true);
    const [error,       setError]       = useState(null);
    const [windowMin,   setWindowMin]   = useState(60);
    const [intervalMin, setIntervalMin] = useState(5);
    const [maxDist,     setMaxDist]     = useState(5);
    const [filterSide,  setFilterSide]  = useState('ALL'); // ALL / SUPPORT / RESISTANCE
    const [filterReact, setFilterReact] = useState('ALL'); // ALL / BOUNCE / REJECT / TESTING / BREAK
    const [streamDSchema, setStreamDSchema] = useState([]);
    const [volEventsByTicker, setVolEventsByTicker] = useState({});
    const pollRef = useRef(null);

    // Fetch Stream D schema once on mount (dynamic field discovery)
    useEffect(() => {
        fetch('/api/stream-d/schema')
            .then(r => r.json())
            .then(d => { if (d.fields?.length) setStreamDSchema(d.fields); })
            .catch(() => {}); // non-critical — chips just won't render
    }, []);

    const load = useCallback(async (wMin = windowMin, iMin = intervalMin, mDist = maxDist) => {
        setLoading(true);
        setError(null);
        try {
            const r = await fetch(
                `/api/level-reactions?window_min=${wMin}&interval=${iMin}&limit=16&max_dist=${mDist}`
            );
            const d = await r.json();
            if (d.error) { setError(d.error); return; }
            setData(d);

            // Side-fetch truthful volume events for the visible coins (one batched call)
            const tickers = (d.coins || []).map(c => c.cleanTicker || c.ticker).filter(Boolean);
            if (tickers.length) {
                try {
                    const vr = await fetch(
                        `/api/volume-events?tickers=${encodeURIComponent(tickers.join(','))}&since_min=${wMin}`
                    );
                    const vd = await vr.json();
                    setVolEventsByTicker(vd?.by_ticker || {});
                } catch { /* non-critical */ }
            } else {
                setVolEventsByTicker({});
            }
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    }, [windowMin, intervalMin, maxDist]);

    useEffect(() => { load(); }, []);

    // Auto-refresh every 90s
    useEffect(() => {
        pollRef.current = setInterval(() => load(), 90_000);
        return () => clearInterval(pollRef.current);
    }, [load]);

    const handleWindow = (v) => { setWindowMin(v); load(v, intervalMin, maxDist); };
    const handleInterval = (v) => { setIntervalMin(v); load(windowMin, v, maxDist); };

    // Filtered coins
    const coins = (data?.coins || []).filter(c => {
        if (filterSide !== 'ALL' && c.side !== filterSide) return false;
        if (filterReact !== 'ALL') {
            if (filterReact === 'BREAK' && !c.reaction.startsWith('BREAK')) return false;
            if (filterReact !== 'BREAK' && c.reaction !== filterReact) return false;
        }
        return true;
    });

    const reactionCounts = (data?.coins || []).reduce((acc, c) => {
        const key = c.reaction.startsWith('BREAK') ? 'BREAK' : c.reaction;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});

    return (
        <div className={styles.widget}>
            {/* ── Header ── */}
            <div className={styles.header}>
                <div className={styles.titleRow}>
                    <div className={styles.title}>
                        <span className={styles.titleIcon}>⟳</span>
                        <span className={styles.titleText}>LEVEL REACTION MONITOR</span>
                        <span className={styles.titleSub}>Path · Touch · Verdict</span>
                    </div>
                    <button
                        className={styles.refreshBtn}
                        onClick={() => load()}
                        title="Refresh"
                    >↺</button>
                </div>

                {/* Controls row */}
                <div className={styles.controlsRow}>
                    {/* Window */}
                    <div className={styles.controlGroup}>
                        <span className={styles.controlLabel}>Window</span>
                        {WINDOWS.map(w => (
                            <button key={w.value}
                                className={`${styles.pill} ${windowMin === w.value ? styles.pillActive : ''}`}
                                onClick={() => handleWindow(w.value)}>
                                {w.label}
                            </button>
                        ))}
                    </div>

                    {/* Interval */}
                    <div className={styles.controlGroup}>
                        <span className={styles.controlLabel}>Bucket</span>
                        {INTERVALS.map(i => (
                            <button key={i.value}
                                className={`${styles.pill} ${intervalMin === i.value ? styles.pillActive : ''}`}
                                onClick={() => handleInterval(i.value)}>
                                {i.label}
                            </button>
                        ))}
                    </div>

                    {/* Dist filter */}
                    <div className={styles.controlGroup}>
                        <span className={styles.controlLabel}>Max dist</span>
                        {[2, 3, 5].map(v => (
                            <button key={v}
                                className={`${styles.pill} ${maxDist === v ? styles.pillActive : ''}`}
                                onClick={() => { setMaxDist(v); load(windowMin, intervalMin, v); }}>
                                ±{v}%
                            </button>
                        ))}
                    </div>

                    {/* Scan age */}
                    {data?.scan_ts && (
                        <span className={styles.scanAge}>
                            scan {timeAgo(data.scan_ts)} · {data.total_in_scan} coins
                        </span>
                    )}
                </div>

                {/* Reaction filter tabs */}
                <div className={styles.filterRow}>
                    <span className={styles.controlLabel}>Filter</span>
                    {[
                        { key: 'ALL',         label: `All (${data?.coins?.length || 0})` },
                        { key: 'BOUNCE',      label: `↑ Bounce (${reactionCounts.BOUNCE || 0})`,     color: '#68d391' },
                        { key: 'REJECT',      label: `↓ Reject (${reactionCounts.REJECT || 0})`,     color: '#fc8181' },
                        { key: 'TESTING',     label: `→ Testing (${reactionCounts.TESTING || 0})`,   color: '#63b3ed' },
                        { key: 'BREAK',       label: `⚡ Break (${reactionCounts.BREAK || 0})`,      color: '#f6ad55' },
                        { key: 'APPROACHING', label: `⟶ Approach (${reactionCounts.APPROACHING || 0})`, color: '#a0aec0' },
                    ].map(({ key, label, color }) => (
                        <button key={key}
                            className={`${styles.filterPill} ${filterReact === key ? styles.filterPillActive : ''}`}
                            style={filterReact === key && color ? { borderColor: color, color } : {}}
                            onClick={() => setFilterReact(key)}>
                            {label}
                        </button>
                    ))}

                    <span style={{ marginLeft: 'auto' }} />

                    {/* Side filter */}
                    {[
                        { key: 'ALL',        label: 'All sides' },
                        { key: 'SUPPORT',    label: '▲ Support',    color: '#68d391' },
                        { key: 'RESISTANCE', label: '▼ Resistance', color: '#fc8181' },
                    ].map(({ key, label, color }) => (
                        <button key={key}
                            className={`${styles.filterPill} ${filterSide === key ? styles.filterPillActive : ''}`}
                            style={filterSide === key && color ? { borderColor: color, color } : {}}
                            onClick={() => setFilterSide(key)}>
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            {/* ── Body ── */}
            <div className={styles.body}>
                {error ? (
                    <div className={styles.errorState}>⚠ {error}</div>
                ) : !data && loading ? (
                    <div className={styles.loadingState}>
                        <div className={styles.spinner} />
                        <span>Loading reactions…</span>
                    </div>
                ) : coins.length === 0 ? (
                    <div className={styles.emptyState}>
                        <div style={{ fontSize: 28 }}>📡</div>
                        <div>No coins within ±{maxDist}% of a structural level</div>
                        <div style={{ fontSize: 11, color: '#4a5568', marginTop: 4 }}>
                            Try increasing the max distance filter
                        </div>
                    </div>
                ) : (
                    <div className={styles.lanes}>
                        {coins.map(coin => (
                            <ReactionLane
                                key={coin.ticker}
                                coin={coin}
                                windowMin={windowMin}
                                loading={false}
                                schema={streamDSchema}
                                volEvents={volEventsByTicker[coin.cleanTicker || coin.ticker] || []}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* ── Legend ── */}
            <div className={styles.legend}>
                {Object.entries(REACTION_META).map(([key, m]) => (
                    <span key={key} className={styles.legendItem} style={{ color: m.color }}>
                        {m.label}
                    </span>
                ))}
                <span className={styles.legendSep} />
                <span className={styles.legendItem} style={{ color: '#68d391' }}>▬ Support</span>
                <span className={styles.legendItem} style={{ color: '#fc8181' }}>▬ Resistance</span>
                <span className={styles.legendItem} style={{ color: '#718096', fontSize: 9 }}>
                    Chart Y = % from level (0 = exact level)
                </span>
            </div>
        </div>
    );
}
