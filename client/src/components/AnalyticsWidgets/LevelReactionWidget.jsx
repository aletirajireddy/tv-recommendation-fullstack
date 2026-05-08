import React, { useState, useMemo, useRef, useCallback } from 'react';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import { useTimeStore } from '../../store/useTimeStore';
import {
    ComposedChart, Area, Line, Bar, XAxis, YAxis, ReferenceLine,
    Tooltip, ResponsiveContainer,
} from 'recharts';
import { Activity, RefreshCw, Radar, ArrowUp, ArrowDown, Zap, ArrowRight, MoveRight, ChevronUp, ChevronDown, AlertTriangle, ArrowUpDown } from 'lucide-react';
import styles from './LevelReactionWidget.module.css';

// ─── Chip-type constants ─────────────────────────────────────────────────────
// Each chip displayed in the lane header maps to one of these 5 types.
// Used as keys in visibleChips + sortBy.
const CHIP_TYPES = ['RSI', 'RVol', 'ATR', 'EMA200', 'Dist'];
const CHIP_LABELS = { RSI: 'RSI', RVol: 'RVol', ATR: 'ATR', EMA200: 'EMA200', Dist: 'Dist %' };

const LS_CHIPS_KEY   = 'levelReaction_chips';
const LS_SORT_KEY    = 'levelReaction_sort';
const LS_FILTERS_KEY = 'levelReaction_filters';

const DEFAULT_FILTERS = { windowMin: 60, intervalMin: 5, maxDist: 5, filterSide: 'ALL', filterReact: 'ALL' };

function loadChipPrefs() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_CHIPS_KEY));
        if (s && typeof s === 'object') return s;
    } catch {}
    return { RSI: true, RVol: true, ATR: true, EMA200: true, Dist: true };
}
function loadSortPrefs() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_SORT_KEY));
        if (s?.by) return s;
    } catch {}
    return { by: 'Dist', dir: 'asc' };
}
function loadFilterPrefs() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_FILTERS_KEY));
        if (s && typeof s === 'object') return { ...DEFAULT_FILTERS, ...s };
    } catch {}
    return { ...DEFAULT_FILTERS };
}

/**
 * Return the chip TYPE string from a schema key. Needed so pickStreamDChips
 * can skip hidden chip types.
 */
function chipTypeOf(key) {
    const k = key.toLowerCase();
    if (k.includes('rsi')) return 'RSI';
    if (k.includes('relvol') || k.includes('rel_vol') || k.includes('relativevol')) return 'RVol';
    if (k.includes('atr') || k.includes('volatility')) return 'ATR';
    if (k.includes('ema') && (k.includes('dist') || k.includes('200'))) return 'EMA200';
    return null;
}

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
        const zone = v <= 30 ? 'Oversold — strong buy pressure zone'
                   : v <= 45 ? 'Mildly oversold — slight buy bias'
                   : v <= 55 ? 'Neutral — no directional edge'
                   : v <= 70 ? 'Mildly overbought — slight sell bias'
                   : 'Overbought — strong sell pressure zone';
        const tooltip = `RSI ${v.toFixed(0)} · ${zone}`;
        if (v <= 30)      return { color: '#68d391', bg: 'rgba(104,211,145,0.15)', label: `RSI ${v.toFixed(0)}`, tooltip };
        if (v <= 45)      return { color: '#9ae6b4', bg: 'rgba(154,230,180,0.10)', label: `RSI ${v.toFixed(0)}`, tooltip };
        if (v <= 55)      return { color: '#a0aec0', bg: 'rgba(160,174,192,0.08)', label: `RSI ${v.toFixed(0)}`, tooltip };
        if (v <= 70)      return { color: '#fbb6a2', bg: 'rgba(251,182,162,0.10)', label: `RSI ${v.toFixed(0)}`, tooltip };
        return             { color: '#fc8181', bg: 'rgba(252,129,129,0.15)', label: `RSI ${v.toFixed(0)}`, tooltip };
    }

    // Relative volume: relVol, rel_volume, relativeVolume …
    if (k.includes('relvol') || k.includes('rel_vol') || k.includes('relativevol')) {
        const zone = v >= 2.5 ? 'Spike — unusually high participation, potential breakout/breakdown'
                   : v >= 1.5 ? 'Elevated — above-average activity, watch for follow-through'
                   : 'Normal — no volume confirmation';
        const tooltip = `Relative Volume ${v.toFixed(2)}× · ${zone}`;
        if (v >= 2.5)     return { color: '#f6ad55', bg: 'rgba(246,173,85,0.15)',  label: `RVol ${v.toFixed(1)}×`, tooltip };
        if (v >= 1.5)     return { color: '#fefcbf', bg: 'rgba(254,252,191,0.10)', label: `RVol ${v.toFixed(1)}×`, tooltip };
        return             { color: '#718096', bg: 'rgba(113,128,150,0.08)',         label: `RVol ${v.toFixed(1)}×`, tooltip };
    }

    // EMA200 distance (ema200dist_5m, ema200_5m_dist …)
    if (k.includes('ema') && (k.includes('dist') || k.includes('200'))) {
        const sign = v >= 0 ? '+' : '';
        const zone = Math.abs(v) <= 1 ? 'Hugging EMA — price very close to level'
                   : v < -2 ? 'Well below EMA — bearish positioning'
                   : v > 3  ? 'Well above EMA — extended from level'
                   : 'Moderate distance from EMA';
        const tooltip = `EMA200 distance ${sign}${v.toFixed(2)}% · ${zone}`;
        if (Math.abs(v) <= 1)  return { color: '#63b3ed', bg: 'rgba(99,179,237,0.12)', label: `EMA ${sign}${v.toFixed(1)}%`, tooltip };
        if (v < -2)             return { color: '#fc8181', bg: 'rgba(252,129,129,0.10)', label: `EMA ${sign}${v.toFixed(1)}%`, tooltip };
        if (v > 3)              return { color: '#68d391', bg: 'rgba(104,211,145,0.10)', label: `EMA ${sign}${v.toFixed(1)}%`, tooltip };
        return                  { color: '#a0aec0', bg: 'rgba(160,174,192,0.07)',         label: `EMA ${sign}${v.toFixed(1)}%`, tooltip };
    }

    return null; // unknown / not renderable as chip
}

/**
 * Pick the most meaningful Stream D fields to surface as chips.
 * Priority: RSI, RelVol, ATR/Volatility, EMA200 distance.
 * Handles both multi-TF keys (rsi14_5m) and single-TF keys (rsi_14, relVolume, ema_200).
 * Returns max 4 chips to keep the lane header compact.
 * Respects visibleChips — hidden types are skipped entirely.
 */
// All chip lookups search the coin's OWN data keys — never the shared schema.
// The shared schema is a union across all coins; a key present there may be
// absent from this specific coin's stream_d blob, silently producing no chip.
function pickStreamDChips(data, schema, visibleChips) {
    if (!data) return [];
    const vc = visibleChips || {};
    const chips = [];
    const kl = k => k.toLowerCase();
    const dataKeys = Object.keys(data); // search only this coin's own fields

    // 1. RSI — prefer shortest TF with data; fall back to any rsi key
    if (vc.RSI !== false) {
        const TF_PRIORITY = ['_5m', '5m', '_15m', '15m', '_1h', '1h', '_4h', '4h'];
        let rsiAdded = false;
        for (const tf of TF_PRIORITY) {
            const key = dataKeys.find(k => kl(k).includes('rsi') && kl(k).endsWith(tf));
            if (key) {
                const s = streamDChipStyle(key, data[key]);
                if (s) { chips.push({ key, chipType: 'RSI', ...s }); rsiAdded = true; break; }
            }
        }
        if (!rsiAdded) {
            const rsiKey = dataKeys.find(k => kl(k).includes('rsi'));
            if (rsiKey) {
                const s = streamDChipStyle(rsiKey, data[rsiKey]);
                if (s) chips.push({ key: rsiKey, chipType: 'RSI', ...s });
            }
        }
    }

    // 2. Relative Volume
    if (vc.RVol !== false) {
        const rvolKey = dataKeys.find(k =>
            kl(k).includes('relvol') || kl(k).includes('rel_vol') || kl(k).includes('relativevol')
        );
        if (rvolKey) {
            const s = streamDChipStyle(rvolKey, data[rvolKey]);
            if (s) chips.push({ key: rvolKey, chipType: 'RVol', ...s });
        }
    }

    // 3. ATR — show A15 (15m) and A60 (1h) as separate chips when both available.
    //    Search data's OWN keys (not the shared schema) so we only find fields
    //    that are actually present for this coin — avoids the schema/data mismatch
    //    where schema has a key from another coin but this coin's data doesn't.
    if (vc.ATR !== false) {
        const dataKeys = Object.keys(data);
        const atr15Key = dataKeys.find(k => /timeresolution15/i.test(k) && /averagetruerange/i.test(k));
        const atr60Key = dataKeys.find(k => /timeresolution60/i.test(k) && /averagetruerange/i.test(k));
        // Fallback: first atr-named key, then volatility key — only when neither TF-specific found
        const fallbackKey = (!atr15Key && !atr60Key)
            ? (dataKeys.find(k => kl(k).includes('atr')) || dataKeys.find(k => kl(k).includes('volatility')))
            : null;

        const atrSlots = [
            { key: atr15Key, shortLabel: 'A15', tfDesc: '15m' },
            { key: atr60Key, shortLabel: 'A60', tfDesc: '1h'  },
            { key: fallbackKey, shortLabel: 'ATR', tfDesc: ''  },
        ];
        for (const { key, shortLabel, tfDesc } of atrSlots) {
            if (!key) continue;
            const v = parseFloat(data[key]);
            if (isNaN(v)) continue;
            const color = v >= 5 ? '#f6ad55' : v >= 2 ? '#fefcbf' : '#718096';
            const bg    = v >= 5 ? 'rgba(246,173,85,0.12)' : v >= 2 ? 'rgba(254,252,191,0.08)' : 'rgba(113,128,150,0.07)';
            const volatDesc = v >= 5 ? 'High volatility' : v >= 2 ? 'Moderate volatility' : 'Low volatility';
            const tooltip = tfDesc
                ? `${tfDesc} ATR ${v.toFixed(2)}% — avg candle range on ${tfDesc} timeframe. ${volatDesc}. Use as proximity reference for ${tfDesc} EMA distances.`
                : `ATR ${v.toFixed(2)}% — ${volatDesc}`;
            chips.push({ key, chipType: 'ATR', rawValue: v, color, bg, label: `${shortLabel} ${v.toFixed(1)}%`, tooltip });
        }
    }

    // 4. EMA200 distance
    if (vc.EMA200 !== false) {
        const emaDistKey = dataKeys.find(k => kl(k).includes('ema') && kl(k).includes('dist'));
        if (emaDistKey) {
            const s = streamDChipStyle(emaDistKey, data[emaDistKey]);
            if (s) chips.push({ key: emaDistKey, chipType: 'EMA200', ...s });
        } else {
            const emaAbsKey = dataKeys.find(k => kl(k) === 'ema_200' || kl(k) === 'ema200' || (kl(k).includes('ema') && kl(k).includes('200')));
            if (emaAbsKey) {
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
                    chips.push({ key: emaAbsKey, chipType: 'EMA200', color, bg, label: `E200 ${sign}${pct.toFixed(1)}%` });
                }
            }
        }
    }

    return chips.slice(0, 5); // up to 5 — accommodates both A15 + A60 ATR chips
}

/** Extract raw ATR value from a coin's stream_d data for sorting.
 *  Searches the coin's OWN data keys — prefers 1h (Timeresolution60), then 15m. */
function getRawATR(coin) {
    const d = coin?.stream_d?.data;
    if (!d) return null;
    const keys = Object.keys(d);
    const key = keys.find(k => /timeresolution60/i.test(k) && /averagetruerange/i.test(k))
             || keys.find(k => /timeresolution15/i.test(k) && /averagetruerange/i.test(k))
             || keys.find(k => k.toLowerCase().includes('atr'))
             || keys.find(k => k.toLowerCase().includes('volatility'));
    if (!key) return null;
    const v = parseFloat(d[key]);
    return isNaN(v) ? null : v;
}

/** Sort by a specific ATR timeframe resolution ('15' or '60'). Falls back to
 *  the other TF if the preferred one is absent, then any atr key. */
function getRawATRByTF(coin, res) {
    const d = coin?.stream_d?.data;
    if (!d) return null;
    const keys = Object.keys(d);
    const pref = res === '60' ? /timeresolution60/i : /timeresolution15/i;
    const fall = res === '60' ? /timeresolution15/i : /timeresolution60/i;
    const key = keys.find(k => pref.test(k) && /averagetruerange/i.test(k))
             || keys.find(k => fall.test(k) && /averagetruerange/i.test(k))
             || keys.find(k => k.toLowerCase().includes('atr'));
    if (!key) return null;
    const v = parseFloat(d[key]);
    return isNaN(v) ? null : v;
}

/** Extract raw RVol value from a coin's stream_d data for sorting.
 *  Searches the coin's OWN data keys — no shared schema needed. */
function getRawRVol(coin) {
    const d = coin?.stream_d?.data;
    if (!d) return null;
    const kl = k => k.toLowerCase();
    const rvolKey = Object.keys(d).find(k => kl(k).includes('relvol') || kl(k).includes('rel_vol') || kl(k).includes('relativevol'));
    if (!rvolKey) return null;
    const v = parseFloat(d[rvolKey]);
    return isNaN(v) ? null : v;
}

// ─── Stream D chips component ────────────────────────────────────────────────

function StreamDChips({ streamD, schema, visibleChips }) {
    if (!streamD?.data || !schema?.length) return null;
    const chips = pickStreamDChips(streamD.data, schema, visibleChips);
    if (!chips.length) return null;

    return (
        <div className={styles.streamDChips}>
            {chips.map(chip => (
                <span
                    key={chip.key}
                    className={styles.streamDChip}
                    style={{ color: chip.color, background: chip.bg, borderColor: chip.color + '40' }}
                    title={chip.tooltip || chip.label}
                >
                    {chip.label}
                </span>
            ))}
            <span className={styles.streamDAge} title={`Stream D updated ${timeAgo(streamD.ts)}`}>{timeAgo(streamD.ts)}</span>
        </div>
    );
}

// ─── Reaction meta ──────────────────────────────────────────────────────────

const REACTION_META = {
    BOUNCE:      { label: <span className="flex items-center gap-1"><ArrowUp size={10} /> BOUNCE</span>,      color: '#68d391', bg: 'rgba(104,211,145,0.12)' },
    REJECT:      { label: <span className="flex items-center gap-1"><ArrowDown size={10} /> REJECT</span>,    color: '#fc8181', bg: 'rgba(252,129,129,0.12)' },
    BREAK_BULL:  { label: <span className="flex items-center gap-1"><Zap size={10} /> BREAK ▲</span>,    color: '#f6ad55', bg: 'rgba(246,173,85,0.12)'  },
    BREAK_BEAR:  { label: <span className="flex items-center gap-1"><Zap size={10} /> BREAK ▼</span>,    color: '#fc8181', bg: 'rgba(252,129,129,0.08)' },
    TESTING:     { label: <span className="flex items-center gap-1"><ArrowRight size={10} /> TESTING</span>,  color: '#63b3ed', bg: 'rgba(99,179,237,0.08)'  },
    APPROACHING: { label: <span className="flex items-center gap-1"><MoveRight size={10} /> APPROACH</span>, color: '#a0aec0', bg: 'rgba(160,174,192,0.06)' },
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
            background: 'var(--bg-panel)', border: `1px solid ${sideCol.line}40`,
            borderRadius: 6, padding: '6px 10px', fontSize: 11, lineHeight: 1.7,
            boxShadow: '0 4px 20px rgba(0,0,0,0.2)', minWidth: 140,
        }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: 2 }}>{fmtTime(p.ts)}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>Price</span>
                <span style={{ color: 'var(--text-main)', fontWeight: 600 }}>{smartFmt(p.price)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>Level</span>
                <span style={{ color: sideCol.line }}>{smartFmt(coin?.levelPrice)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <span style={{ color: 'var(--text-muted)' }}>vs Level</span>
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

// Audit fix #1/#2: React.memo prevents re-render when parent filter state changes but
// this lane's data (coin, volEvents, schema) is unchanged. useMemo inside avoids
// rebuilding Recharts series on every render pass.
const ReactionLane = React.memo(function ReactionLane({ coin, windowMin, intervalMin, loading, schema, volEvents, visibleChips }) {
    const setSelectedTicker = useTimeStore(s => s.setSelectedTicker);
    const meta     = REACTION_META[coin.reaction]   || REACTION_META.APPROACHING;
    const sideCol  = SIDE_COLOR[coin.side]          || SIDE_COLOR.SUPPORT;

    // Audit fix #2: memoize series + Y domain — 16 lanes × map+minMax is hot path.
    // Also merges vol-event strength into each bucket so we can render volume bars.
    const series = useMemo(() => {
        // Build vol strength map: ts → sum of strengths
        const safeVol = volEvents || [];
        const intervalMs = (intervalMin || 5) * 60 * 1000;
        const volMap = new Map();
        for (const e of safeVol) {
            const eMs = typeof e.ts === 'number' ? e.ts : new Date(e.ts).getTime();
            let best = null, bestDiff = Infinity;
            for (const h of coin.history) {
                const diff = Math.abs(h.ts - eMs);
                if (diff < bestDiff && diff <= intervalMs * 1.5) { bestDiff = diff; best = h.ts; }
            }
            if (best !== null) volMap.set(best, (volMap.get(best) || 0) + (e.strength || 1));
        }

        // DOM Pruning: Decimate history if it's too dense (e.g. > 60 points)
        let hData = coin.history;
        if (hData.length > 60) {
            const step = Math.ceil(hData.length / 40); // Target ~40 points max
            hData = hData.filter((_, i) => i % step === 0 || i === hData.length - 1);
        }

        return hData.length
            ? hData.map(h => ({
                ts:          h.ts,
                price:       h.price,
                pct:         h.pct,
                above:       Math.max(0, h.pct),
                below:       Math.min(0, h.pct),
                volStrength: volMap.get(h.ts) || 0,
            }))
            : [
                { ts: Date.now() - windowMin * 60000, pct: coin.distPct, price: coin.close, above: Math.max(0, coin.distPct), below: Math.min(0, coin.distPct), volStrength: 0 },
                { ts: Date.now(),                     pct: coin.distPct, price: coin.close, above: Math.max(0, coin.distPct), below: Math.min(0, coin.distPct), volStrength: 0 },
            ];
    }, [coin.history, coin.distPct, coin.close, windowMin, intervalMin, volEvents]);

    const [yMin, yMax] = useMemo(() => {
        let pMin = -0.5, pMax = 0.5;
        for (const s of series) {
            if (s.pct < pMin) pMin = s.pct;
            if (s.pct > pMax) pMax = s.pct;
        }
        const pad = Math.max(0.2, (pMax - pMin) * 0.15);
        return [pMin - pad, pMax + pad];
    }, [series]);

    // Cap volume pins to the latest 5 to prevent SVG node explosion
    const pinEvents = useMemo(() => {
        const evs = volEvents || [];
        return evs.slice().sort((a,b) => new Date(b.ts) - new Date(a.ts)).slice(0, 5);
    }, [volEvents]);

    const noHistory = coin.snapshot_count === 0;

    return (
        <div className={styles.lane} style={{ borderLeftColor: sideCol.line }}>
            {/* Lane header */}
            <div className={styles.laneHeader}>
                <div className={styles.laneLeft}>
                    <span 
                        className={styles.laneTicker} 
                        onClick={() => setSelectedTicker(coin.cleanTicker || coin.ticker)}
                        style={{ cursor: 'pointer' }}
                    >
                        {coin.cleanTicker}
                    </span>
                    <span className={styles.laneSide} style={{ background: sideCol.zone, color: sideCol.line }}>
                        {sideCol.label}
                    </span>
                    <span className={styles.laneLevel}>{coin.levelLabel?.replace('EMA200_', '').replace('_', ' ')}</span>
                </div>

                <div className={styles.laneCenter}>
                    <span className={styles.lanePrice}>{smartFmt(coin.close)}</span>
                    {/* Distance from level — toggleable via visibleChips.Dist */}
                    {(visibleChips?.Dist !== false) && (
                    <span className={styles.laneDist}
                        style={{ color: coin.distPct >= 0 ? '#68d391' : '#fc8181' }}
                        title={`${coin.distPct >= 0 ? 'Price is ' + coin.distPct.toFixed(2) + '% ABOVE' : 'Price is ' + Math.abs(coin.distPct).toFixed(2) + '% BELOW'} the ${coin.levelLabel?.replace('EMA200_', '') || coin.side.toLowerCase()} level (${smartFmt(coin.levelPrice)})`}>
                        {coin.distPct > 0 ? '+' : ''}{coin.distPct.toFixed(2)}%
                        <span className={styles.distContext}>vs level</span>
                    </span>
                    )}
                    {/* Direction badge */}
                    <span className={styles.laneDir}
                        style={{
                            color:       coin.direction === 'BULL' ? '#68d391' : coin.direction === 'BEAR' ? '#fc8181' : '#a0aec0',
                            borderColor: coin.direction === 'BULL' ? 'rgba(104,211,145,0.3)' : coin.direction === 'BEAR' ? 'rgba(252,129,129,0.3)' : 'rgba(160,174,192,0.2)',
                        }}>
                        {coin.direction === 'BULL' ? <ChevronUp size={10} /> : coin.direction === 'BEAR' ? <ChevronDown size={10} /> : '—'} {coin.direction}
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
                    {/* Stream D technical chips — dynamic from schema, filtered by visibleChips */}
                    <StreamDChips streamD={coin.stream_d} schema={schema} visibleChips={visibleChips} />
                    {/* Volume badge: truth-aware (Stream C alert > Stream D RVol > Stream A edge).
                        Falls back to legacy sticky `volSpike` flag (greyed) when no recent event exists. */}
                    {(() => {
                        const safeVol = volEvents || [];
                        const fresh = safeVol.length
                            ? safeVol.slice().sort((a, b) =>
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
                                    title={`${m.name} · ${ago}m ago${safeVol.length > 1 ? ` (+${safeVol.length - 1} more)` : ''}`}>
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
                                yAxisId="pct"
                                domain={[yMin, yMax]}
                                tick={{ fontSize: 9, fill: '#4a5568' }}
                                tickFormatter={v => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`}
                                width={42}
                                tickCount={4}
                            />
                            {/* Hidden secondary axis for vol bars — domain inflated 5× so
                                bars occupy only the bottom ~20% of chart height */}
                            <YAxis
                                yAxisId="vol"
                                orientation="right"
                                domain={[0, dataMax => dataMax * 5]}
                                hide
                            />
                            <Tooltip
                                content={<LaneTooltip coin={coin} />}
                                isAnimationActive={false}
                            />

                            {/* Level = 0 line */}
                            <ReferenceLine yAxisId="pct" y={0}
                                stroke={sideCol.line} strokeWidth={1.5}
                                strokeDasharray="none"
                                label={{
                                    value: coin.levelLabel?.replace('EMA200_', '').replace(/_/g, ' ') || coin.side,
                                    fill: sideCol.line, fontSize: 9,
                                    position: 'right', offset: 4,
                                }}
                            />

                            {/* Touch zone bands ±0.3% */}
                            <ReferenceLine yAxisId="pct" y={0.3}  stroke={sideCol.line} strokeWidth={0.5} strokeDasharray="2 4" strokeOpacity={0.4} />
                            <ReferenceLine yAxisId="pct" y={-0.3} stroke={sideCol.line} strokeWidth={0.5} strokeDasharray="2 4" strokeOpacity={0.4} />

                            {/* Volume-event pins — color-coded by source, on the pct axis */}
                            {pinEvents.map((e, idx) => {
                                const m = VOL_SRC_META[e.source] || VOL_SRC_META.STREAM_A_EDGE;
                                return (
                                    <ReferenceLine key={`vol-${idx}`}
                                        yAxisId="pct"
                                        x={new Date(e.ts).getTime()}
                                        stroke={m.color} strokeOpacity={0.45}
                                        strokeDasharray="2 3" strokeWidth={1}
                                    />
                                );
                            })}

                            {/* Volume magnitude bars — bottom anchored, amber */}
                            <Bar
                                yAxisId="vol"
                                dataKey="volStrength"
                                fill="#F59E0B"
                                barSize={4}
                                radius={[2, 2, 0, 0]}
                                isAnimationActive={false}
                                opacity={0.80}
                            />

                            {/* Green area — price ABOVE level */}
                            <Area
                                yAxisId="pct"
                                type="monotone" dataKey="above"
                                stroke="none" fill="rgba(104,211,145,0.20)"
                                isAnimationActive={false} dot={false}
                                baseValue={0}
                            />

                            {/* Red area — price BELOW level */}
                            <Area
                                yAxisId="pct"
                                type="monotone" dataKey="below"
                                stroke="none" fill="rgba(252,129,129,0.22)"
                                isAnimationActive={false} dot={false}
                                baseValue={0}
                            />

                            {/* Main price path */}
                            <Line
                                yAxisId="pct"
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
}); // React.memo — ReactionLane only re-renders when its own props change

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

export const LevelReactionWidget = React.memo(function LevelReactionWidget({ filterTicker, compact }) {
    const containerRef = useRef(null);
    const lastDataPush = useTimeStore(s => s.lastDataPush);

    // ── All filter state — persisted to localStorage as one object ────────────
    const [filters, setFilters] = useState(loadFilterPrefs);
    const { windowMin, intervalMin, maxDist, filterSide, filterReact } = filters;

    const updateFilter = useCallback((key, val) => {
        setFilters(prev => {
            const next = { ...prev, [key]: val };
            try { localStorage.setItem(LS_FILTERS_KEY, JSON.stringify(next)); } catch {}
            return next;
        });
    }, []);

    // Setters keep the same names so existing JSX doesn't change
    const setWindowMin   = (v) => updateFilter('windowMin', v);
    const setIntervalMin = (v) => updateFilter('intervalMin', v);
    const setMaxDist     = (v) => updateFilter('maxDist', v);
    const setFilterSide  = (v) => updateFilter('filterSide', v);
    const setFilterReact = (v) => updateFilter('filterReact', v);

    // ── Chip visibility — persisted to localStorage ─────────────────────────
    const [visibleChips, setVisibleChips] = useState(loadChipPrefs);
    const toggleChip = useCallback((type) => {
        setVisibleChips(prev => {
            const next = { ...prev, [type]: prev[type] === false ? true : false };
            try { localStorage.setItem(LS_CHIPS_KEY, JSON.stringify(next)); } catch {}
            return next;
        });
    }, []);

    // ── Sort — persisted to localStorage ────────────────────────────────────
    // sortBy: 'Dist' | 'ATR' | 'RVol' | 'default'
    // sortDir: 'asc' | 'desc'
    const [sortPrefs, setSortPrefs] = useState(loadSortPrefs);
    const { by: sortBy, dir: sortDir } = sortPrefs;

    const handleSortClick = useCallback((chipType) => {
        setSortPrefs(prev => {
            const next = prev.by === chipType
                ? { by: chipType, dir: prev.dir === 'asc' ? 'desc' : 'asc' }  // flip direction
                : { by: chipType, dir: 'asc' };                                  // new key → reset asc
            try { localStorage.setItem(LS_SORT_KEY, JSON.stringify(next)); } catch {}
            return next;
        });
    }, []);

    // ── Reset all — clears every persisted preference back to factory defaults ─
    const resetAll = useCallback(() => {
        [LS_CHIPS_KEY, LS_SORT_KEY, LS_FILTERS_KEY].forEach(k => {
            try { localStorage.removeItem(k); } catch {}
        });
        setFilters({ ...DEFAULT_FILTERS });
        setVisibleChips({ RSI: true, RVol: true, ATR: true, EMA200: true, Dist: true });
        setSortPrefs({ by: 'Dist', dir: 'asc' });
    }, []);

    // Audit fix #5/#3/#6: combined async fetcher — level-reactions then volume-events
    // in one chained call so both share one AbortController. ref-pattern means the
    // polling interval is created once; dep changes trigger reload via useEffect.
    const { data, loading, error, reload, reloadSilent } = usePolledFetch(
        async (signal) => {
            const tickerParam = filterTicker ? `&ticker=${filterTicker}` : '';
            const r = await fetch(
                `/api/level-reactions?window_min=${windowMin}&interval=${intervalMin}&limit=16&max_dist=${maxDist}${tickerParam}`,
                { signal }
            );
            const d = await r.json();
            // Don't throw — return the error field so the hook's payload?.error check
            // sets the error banner while preserving the previous data (stale-while-error).
            if (d.error) return d;

            // Batch vol-events for all visible coins in the same poll tick
            const tickers = (d.coins || []).map(c => c.cleanTicker || c.ticker).filter(Boolean);
            let volEventsByTicker = {};
            if (tickers.length) {
                try {
                    const vr = await fetch(
                        `/api/volume-events?tickers=${encodeURIComponent(tickers.join(','))}&since_min=${windowMin}`,
                        { signal }
                    );
                    const vd = await vr.json();
                    volEventsByTicker = vd?.by_ticker || {};
                } catch { /* vol-events is non-critical */ }
            }
            return { ...d, volEventsByTicker };
        },
        { intervalMs: 300_000, deps: [windowMin, intervalMin, maxDist] }
    );

    // Viewport-priority invalidation — react to every socket push without hammering
    // the backend; off-screen instances defer until they enter the viewport.
    useDataInvalidation(containerRef, reloadSilent, lastDataPush);

    // Stream D schema: fetched once on mount (intervalMs:0 = no polling).
    const { data: schemaData } = usePolledFetch(
        () => '/api/stream-d/schema',
        { intervalMs: 0, deps: [] }
    );
    // Stable empty-array reference so React.memo on ReactionLane doesn't thrash.
    const streamDSchema = useMemo(() => schemaData?.fields || [], [schemaData]);

    // Setting state is all that's needed — deps change triggers reload via hook.
    const handleWindow   = (v) => setWindowMin(v);
    const handleInterval = (v) => setIntervalMin(v);

    const volEventsByTicker = data?.volEventsByTicker || {};

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

    // ── Sorted coins ─────────────────────────────────────────────────────────
    // Sorts the filtered `coins` array by the chosen metric; nulls always last.
    const sortedCoins = useMemo(() => {
        if (!sortBy || sortBy === 'default') return coins;
        return [...coins].sort((a, b) => {
            let av = null, bv = null;
            if (sortBy === 'Dist') {
                av = a.distPct != null ? Math.abs(a.distPct) : null;
                bv = b.distPct != null ? Math.abs(b.distPct) : null;
            } else if (sortBy === 'ATR60') {
                av = getRawATRByTF(a, '60');
                bv = getRawATRByTF(b, '60');
            } else if (sortBy === 'ATR15') {
                av = getRawATRByTF(a, '15');
                bv = getRawATRByTF(b, '15');
            } else if (sortBy === 'RVol') {
                av = getRawRVol(a);
                bv = getRawRVol(b);
            }
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            return sortDir === 'asc' ? av - bv : bv - av;
        });
    }, [coins, sortBy, sortDir]);

    return (
        <div ref={containerRef} className={styles.widget}>
            {/* ── Header ── */}
            <div className={styles.header}>
                <div className={styles.titleRow}>
                    <div className="widget-title">
                        <span className={styles.titleIcon}><Activity size={16} className="text-accent-blue" /></span>
                        <span className={styles.titleText}>LEVEL REACTION MONITOR</span>
                        <span className={styles.titleSub}>Path · Touch · Verdict</span>
                    </div>
                    <button
                        className={styles.refreshBtn}
                        onClick={() => reload()}
                        title="Refresh"
                    >
                        <RefreshCw size={14} />
                    </button>
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
                                onClick={() => setMaxDist(v)}>
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

                {/* ── Chip visibility + sort controls ─────────────────────── */}
                <div className={styles.chipToggleRow}>
                    <span className={styles.controlLabel}>Chips</span>
                    {CHIP_TYPES.map(type => {
                        const isVisible    = visibleChips[type] !== false;
                        // ATR gets two dedicated sort buttons (A15 / A60); others get one
                        const isSortable   = ['Dist', 'RVol'].includes(type);
                        const isActiveSort = sortBy === type;
                        return (
                            <span key={type} className={styles.chipToggleGroup}>
                                <button
                                    className={`${styles.chipToggleBtn} ${isVisible ? styles.chipToggleBtnOn : styles.chipToggleBtnOff}`}
                                    onClick={() => toggleChip(type)}
                                    title={isVisible ? `Hide ${CHIP_LABELS[type]} chips` : `Show ${CHIP_LABELS[type]} chips`}
                                >
                                    {CHIP_LABELS[type]}
                                </button>
                                {/* Single sort button for Dist / RVol */}
                                {isSortable && isVisible && (
                                    <button
                                        className={`${styles.sortBtn} ${isActiveSort ? styles.sortBtnActive : ''}`}
                                        onClick={() => handleSortClick(type)}
                                        title={isActiveSort ? `Sorted by ${CHIP_LABELS[type]} — click to flip` : `Sort by ${CHIP_LABELS[type]}`}
                                    >
                                        {isActiveSort ? (sortDir === 'asc' ? '▲' : '▼') : <ArrowUpDown size={8} />}
                                    </button>
                                )}
                                {/* ATR gets two sort buttons — A15 (15m) and A60 (1h) */}
                                {type === 'ATR' && isVisible && (
                                    <>
                                        <button
                                            className={`${styles.sortBtn} ${sortBy === 'ATR15' ? styles.sortBtnActive : ''}`}
                                            onClick={() => handleSortClick('ATR15')}
                                            title="Sort by 15m ATR — short-TF volatility">
                                            {sortBy === 'ATR15' ? (sortDir === 'asc' ? '▲' : '▼') : '15'}
                                        </button>
                                        <button
                                            className={`${styles.sortBtn} ${sortBy === 'ATR60' ? styles.sortBtnActive : ''}`}
                                            onClick={() => handleSortClick('ATR60')}
                                            title="Sort by 1h ATR — coin-level volatility reference">
                                            {sortBy === 'ATR60' ? (sortDir === 'asc' ? '▲' : '▼') : '60'}
                                        </button>
                                    </>
                                )}
                            </span>
                        );
                    })}
                    {/* Active sort label */}
                    {['Dist','ATR15','ATR60','RVol'].includes(sortBy) && (
                        <span className={styles.sortIndicatorLabel}>
                            sorted by {sortBy === 'ATR15' ? 'A15' : sortBy === 'ATR60' ? 'A60' : CHIP_LABELS[sortBy]} {sortDir === 'asc' ? '▲' : '▼'}
                        </span>
                    )}
                    {/* Reset all — clears every persisted preference */}
                    <button className={styles.resetBtn} onClick={resetAll} title="Reset all filters, chips and sort to defaults">
                        ↺ Reset
                    </button>
                </div>
            </div>

            {/* ── Body ── */}
            <div className={styles.body}>
                {/* Error as non-blocking banner — stale lanes stay visible beneath */}
                {error && (
                    <div className={styles.errorBanner}>
                        <AlertTriangle size={14} /> {error} {data ? '— showing last data' : ''}
                    </div>
                )}
                {!data && loading ? (
                    <div className={styles.loadingState}>
                        <div className={styles.spinner} />
                        <span>Loading reactions…</span>
                    </div>
                ) : coins.length === 0 ? (
                    <div className={styles.emptyState}>
                        <div className="flex justify-center mb-2"><Radar size={32} className="text-text-muted opacity-50" /></div>
                        <div>No coins within ±{maxDist}% of a structural level</div>
                        <div style={{ fontSize: 11, color: '#4a5568', marginTop: 4 }}>
                            Try increasing the max distance filter
                        </div>
                    </div>
                ) : (
                    <div className={styles.lanes}>
                        {sortedCoins.map(coin => (
                            <ReactionLane
                                key={coin.ticker}
                                coin={coin}
                                windowMin={windowMin}
                                intervalMin={intervalMin}
                                loading={false}
                                schema={streamDSchema}
                                volEvents={volEventsByTicker[coin.cleanTicker || coin.ticker]}
                                visibleChips={visibleChips}
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
});
