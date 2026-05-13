// MomentumPulse — combines Stream C per-coin state (change%, volume, RSI matrix,
// ROC momentum) with Stream D rolling history (RVOL, ATR, EMA-distance).
//
// Data hierarchy:
//   change% / volume → Stream C today_change_pct / today_volume  (per-coin, fresher)
//   RSI             → coin_metric_history rsi_m15/m30/h1 (Stream D 2-min cadence)
//                     falling back to Stream C rsi_matrix
//   RVOL / ATR / EMA dist → coin_metric_history rolling buckets

import React, { useState, useMemo, useEffect } from 'react';
import { FreshnessChip } from '../FreshnessChip';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useTimeStore } from '../../store/useTimeStore';
import socketService from '../../services/SocketService';
import { Zap, RefreshCw, AlertTriangle, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import styles from './MomentumPulse.module.css';

/* ─── Signal colours / labels ───────────────────────────────────────────── */
const SIGNAL_META = {
    SURGING:   { color: '#68d391', bg: 'rgba(104,211,145,0.12)', label: '🚀 SURGING'   },
    BUILDING:  { color: '#9ae6b4', bg: 'rgba(154,230,180,0.10)', label: '📈 BUILDING'  },
    RSI_OS:    { color: '#b794f4', bg: 'rgba(183,148,244,0.12)', label: '🔵 RSI OS'    }, // multi-TF oversold
    RSI_OB:    { color: '#fbd38d', bg: 'rgba(251,211,141,0.10)', label: '🟡 RSI OB'    }, // multi-TF overbought
    AT_EMA:    { color: '#63b3ed', bg: 'rgba(99,179,237,0.10)',  label: '— AT EMA'     },
    FADING:    { color: '#f6ad55', bg: 'rgba(246,173,85,0.10)',  label: '📉 FADING'    },
    EXTENDED:  { color: '#fc8181', bg: 'rgba(252,129,129,0.10)', label: '⚠ EXTENDED'  },
    STRETCHED: { color: '#9f7aea', bg: 'rgba(159,122,234,0.10)', label: '⚠ STRETCHED' },
    WATCH:     { color: '#718096', bg: 'rgba(255,255,255,0.03)', label: '👁 WATCH'     },
};

const DIST_COLOR = {
    extended_high: '#fc8181',
    above:         '#9ae6b4',
    near_ema:      '#63b3ed',
    below:         '#feb2b2',
    extended_low:  '#b794f4',
    neutral:       '#718096',
};

const RVOL_TREND_ICON  = { rising: '↑', fading: '↓', flat: '—' };
const RVOL_TREND_COLOR = { rising: '#68d391', fading: '#fc8181', flat: '#718096' };

/* ─── Volume formatter ──────────────────────────────────────────────────── */
function fmtVol(v) {
    if (v == null || v === 0) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(0);
}

/* ─── RSI zone badge ────────────────────────────────────────────────────── */
function RsiDot({ value }) {
    if (value == null) return <span style={{ color: '#4a5568', fontSize: 9 }}>—</span>;
    const zone  = value < 30 ? 'os' : value > 70 ? 'ob' : 'mid';
    const color = zone === 'os' ? '#b794f4' : zone === 'ob' ? '#fbd38d' : '#718096';
    const weight = zone !== 'mid' ? 700 : 400;
    return (
        <span style={{ color, fontVariantNumeric: 'tabular-nums', fontSize: 10, fontWeight: weight }}>
            {value.toFixed(0)}
        </span>
    );
}

/* ─── Mini RVOL sparkline ───────────────────────────────────────────────── */
function RvolSpark({ values = [], thresh = 1.2 }) {
    if (!values.length) return <span style={{ color: '#4a5568', fontSize: 9 }}>—</span>;
    const max  = Math.max(...values, thresh * 1.2, 0.1);
    const W = 48, H = 16;
    const pts = values.map((v, i) => {
        const x = (i / (values.length - 1 || 1)) * W;
        const y = H - (v / max) * H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const threshY = H - (thresh / max) * H;
    const last = values[values.length - 1];
    const lx = W, ly = H - (last / max) * H;
    return (
        <svg width={W} height={H} style={{ display: 'block' }}>
            <line x1={0} y1={threshY} x2={W} y2={threshY}
                stroke="rgba(246,173,85,0.35)" strokeWidth={1} strokeDasharray="2 2" />
            <polyline points={pts} fill="none" stroke="#63b3ed" strokeWidth={1.2} />
            <circle cx={lx} cy={ly} r={2} fill={last >= thresh ? '#68d391' : '#4a5568'} />
        </svg>
    );
}

/* ─── Persistence bar ───────────────────────────────────────────────────── */
function PersistBar({ n, max = 10 }) {
    const pct   = Math.min(n / max, 1);
    const color = n >= 8 ? '#68d391' : n >= 4 ? '#f6ad55' : '#63b3ed';
    return (
        <div className={styles.persistWrap} title={`${n} consecutive elevated-RVOL buckets (×2min)`}>
            <div className={styles.persistTrack}>
                <div className={styles.persistFill} style={{ width: `${pct * 100}%`, background: color }} />
            </div>
            <span className={styles.persistN} style={{ color }}>{n}</span>
        </div>
    );
}

/* ─── Sort helpers ───────────────────────────────────────────────────────── */
const SORT_KEYS = ['changePct', 'volume', 'rvolNow', 'rvolPersist', 'distNow', 'atrNow', 'rsi_m15', 'rsi_h1'];
const SORT_LABELS = {
    changePct:   'Chg%',
    volume:      'Vol',
    rvolNow:     'RVOL',
    rvolPersist: 'Persist',
    distNow:     'EMA Dist',
    atrNow:      'ATR%',
    rsi_m15:     'RSI15',
    rsi_h1:      'RSI1h',
};

/* ─── Main widget ────────────────────────────────────────────────────────── */
export function MomentumPulse() {
    const setSelectedTicker = useTimeStore(s => s.setSelectedTicker);
    const [sortKey, setSortKey] = useState('rvolPersist');
    const [sortDir, setSortDir] = useState('desc');
    const [filter,  setFilter]  = useState('all');

    const { data, loading, error, reload, reloadSilent, lastFetchedAt } = usePolledFetch(
        () => '/api/momentum-pulse',
        { intervalMs: 30_000, deps: [] }
    );

    useEffect(() => {
        const socket = socketService.connect();
        let t;
        const handler = () => { clearTimeout(t); t = setTimeout(() => reloadSilent(), 800); };
        socket.on('stream-d-update', handler);
        socket.on('scan-update',     handler);
        return () => { clearTimeout(t); socket.off('stream-d-update', handler); socket.off('scan-update', handler); };
    }, [reloadSilent]);

    const rows = useMemo(() => {
        const all = data?.coins || [];
        const filtered = filter === 'all'      ? all
            : filter === 'surging'  ? all.filter(c => c.signal === 'SURGING' || c.signal === 'BUILDING')
            : filter === 'rsi'      ? all.filter(c => c.signal === 'RSI_OS'  || c.signal === 'RSI_OB')
            : filter === 'extended' ? all.filter(c => c.signal === 'EXTENDED' || c.signal === 'STRETCHED')
            : filter === 'fading'   ? all.filter(c => c.signal === 'FADING')
            : all;
        return [...filtered].sort((a, b) => {
            const av = a[sortKey] ?? -Infinity;
            const bv = b[sortKey] ?? -Infinity;
            return sortDir === 'desc' ? bv - av : av - bv;
        });
    }, [data, sortKey, sortDir, filter]);

    const handleSort = (key) => {
        if (key === sortKey) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
        else { setSortKey(key); setSortDir('desc'); }
    };
    const sortArrow = (key) => key === sortKey ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';

    const counts = useMemo(() => {
        const all = data?.coins || [];
        return {
            surging:  all.filter(c => c.signal === 'SURGING' || c.signal === 'BUILDING').length,
            rsi:      all.filter(c => c.signal === 'RSI_OS'  || c.signal === 'RSI_OB').length,
            extended: all.filter(c => c.signal === 'EXTENDED' || c.signal === 'STRETCHED').length,
            fading:   all.filter(c => c.signal === 'FADING').length,
        };
    }, [data]);

    // How many coins have fresh Stream C data vs Stream B fallback
    const srcStats = useMemo(() => {
        const all = data?.coins || [];
        return {
            sc: all.filter(c => c.src === 'STREAM_C').length,
            sb: all.filter(c => c.src === 'STREAM_B').length,
        };
    }, [data]);

    return (
        <div className={styles.widget}>
            {/* ── Header ── */}
            <div className={styles.header}>
                <div className={styles.titleRow}>
                    <div className="widget-title">
                        <span className={styles.titleIcon}><Zap size={16} className="text-accent-blue" /></span>
                        <span className={styles.titleText}>MOMENTUM PULSE</span>
                        <span className={styles.titleSub}>
                            Stream C+D · change · RVOL persist · RSI · EMA dist
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {srcStats.sc > 0 && (
                            <span style={{ fontSize: 8, color: '#68d391', opacity: 0.8 }}
                                title={`${srcStats.sc} coins from Stream C (per-coin), ${srcStats.sb} from Stream B fallback`}>
                                C:{srcStats.sc} B:{srcStats.sb}
                            </span>
                        )}
                        <FreshnessChip ts={lastFetchedAt} title="Last fetched" />
                        <button className={styles.iconBtn} onClick={() => reload()} title="Refresh">
                            <RefreshCw size={14} />
                        </button>
                    </div>
                </div>

                {/* Filter chips */}
                <div className={styles.filterRow}>
                    {[
                        { key: 'all',      label: `All (${data?.coins?.length ?? 0})` },
                        { key: 'surging',  label: `🚀 Surging (${counts.surging})`   },
                        { key: 'rsi',      label: `RSI OS/OB (${counts.rsi})`        },
                        { key: 'extended', label: `⚠ Extended (${counts.extended})`  },
                        { key: 'fading',   label: `📉 Fading (${counts.fading})`     },
                    ].map(f => (
                        <button key={f.key}
                            className={`${styles.filterChip} ${filter === f.key ? styles.filterActive : ''}`}
                            onClick={() => setFilter(f.key)}>
                            {f.label}
                        </button>
                    ))}
                    <span className={styles.hint}
                        title="Change% and Volume from Stream C (per-coin) when available, Stream B otherwise. RSI from Stream D 2-min history.">
                        ⓘ C=Stream C · D=Stream D 2min
                    </span>
                </div>
            </div>

            {/* ── States ── */}
            {loading && !data && (
                <div className={styles.loading}><div className={styles.spinner} /> Loading…</div>
            )}
            {error && (
                <div className={styles.error}><AlertTriangle size={13} /> {error}</div>
            )}
            {!loading && !error && rows.length === 0 && (
                <div className={styles.empty}>No data — waiting for Stream C/D push</div>
            )}

            {/* ── Table ── */}
            {rows.length > 0 && (
                <div className={styles.tableWrap}>
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th className={styles.thCoin}>Coin</th>
                                <th className={styles.thSignal}>Signal</th>
                                <th>Price</th>
                                {SORT_KEYS.map(k => (
                                    <th key={k}
                                        className={`${styles.thSort} ${sortKey === k ? styles.thActive : ''}`}
                                        onClick={() => handleSort(k)}
                                        title={
                                            k === 'rvolPersist' ? 'Consecutive 2-min buckets with RVOL ≥ 1.2×'
                                            : k === 'distNow'   ? '% distance from 15m EMA200'
                                            : k === 'rsi_m15'   ? 'RSI 14 · 15m (from Stream D)'
                                            : k === 'rsi_h1'    ? 'RSI 14 · 1h (from Stream D / Stream C)'
                                            : k === 'volume'    ? 'Today volume from Stream C'
                                            : ''
                                        }>
                                        {SORT_LABELS[k]}{sortArrow(k)}
                                    </th>
                                ))}
                                <th>RVOL↕</th>
                                <th title="RVOL last 15 buckets (30 min)">Spark</th>
                                <th title="Data source: C=Stream C, B=Stream B">Src</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(c => {
                                const sig      = SIGNAL_META[c.signal] || SIGNAL_META.WATCH;
                                const dc       = c.changePct ?? 0;
                                const dcColor  = dc > 0 ? '#68d391' : dc < 0 ? '#fc8181' : '#718096';
                                const distColor = DIST_COLOR[c.distState] || '#718096';
                                const rvolColor = (c.rvolNow ?? 0) >= (data?.rvolThresh ?? 1.2) ? '#f6ad55' : '#718096';
                                const rvolWeight = (c.rvolNow ?? 0) >= (data?.rvolThresh ?? 1.2) ? 700 : 400;

                                // How stale is the Stream C data?
                                const scAgeMin = c.scTs
                                    ? Math.round((Date.now() - new Date(c.scTs).getTime()) / 60000)
                                    : null;

                                return (
                                    <tr key={c.ticker} className={styles.row}
                                        style={{ '--sig-bg': sig.bg }}
                                        onClick={() => setSelectedTicker(c.clean)}>

                                        {/* Coin */}
                                        <td className={styles.tdCoin}>
                                            <span className={styles.coinName}>{c.clean}</span>
                                        </td>

                                        {/* Signal badge */}
                                        <td className={styles.tdSignal}>
                                            <span className={styles.signalBadge}
                                                style={{ background: sig.bg, color: sig.color, borderColor: sig.color + '50' }}>
                                                {sig.label}
                                            </span>
                                        </td>

                                        {/* Price */}
                                        <td className={styles.tdNum}>
                                            {c.price != null
                                                ? c.price.toLocaleString(undefined, { maximumFractionDigits: 4 })
                                                : '—'}
                                        </td>

                                        {/* Chg% */}
                                        <td className={styles.tdNum} style={{ color: dcColor }}>
                                            {dc > 0 && <ArrowUpRight size={10} />}
                                            {dc < 0 && <ArrowDownRight size={10} />}
                                            {dc > 0 ? '+' : ''}{dc.toFixed(2)}%
                                        </td>

                                        {/* Volume (Stream C) */}
                                        <td className={styles.tdNum} style={{ color: '#a0aec0' }}>
                                            {fmtVol(c.volume)}
                                        </td>

                                        {/* RVOL now */}
                                        <td className={styles.tdNum}
                                            style={{ color: rvolColor, fontWeight: rvolWeight }}>
                                            {c.rvolNow != null ? c.rvolNow.toFixed(2) + '×' : '—'}
                                        </td>

                                        {/* Persist bar */}
                                        <td><PersistBar n={c.rvolPersist} max={15} /></td>

                                        {/* EMA dist */}
                                        <td className={styles.tdNum} style={{ color: distColor }}>
                                            {c.distNow != null
                                                ? (c.distNow > 0 ? '+' : '') + c.distNow.toFixed(2) + '%'
                                                : '—'}
                                        </td>

                                        {/* ATR% */}
                                        <td className={styles.tdNum} style={{ color: '#718096' }}>
                                            {c.atrNow != null ? c.atrNow.toFixed(2) + '%' : '—'}
                                        </td>

                                        {/* RSI 15m */}
                                        <td className={styles.tdNum}><RsiDot value={c.rsi_m15} /></td>

                                        {/* RSI 1h */}
                                        <td className={styles.tdNum}><RsiDot value={c.rsi_h1} /></td>

                                        {/* RVOL trend */}
                                        <td className={styles.tdNum}
                                            style={{ color: RVOL_TREND_COLOR[c.rvolTrend] || '#718096', fontWeight: 600 }}>
                                            {RVOL_TREND_ICON[c.rvolTrend] || '—'}
                                        </td>

                                        {/* Sparkline */}
                                        <td><RvolSpark values={c.rvolSpark} thresh={data?.rvolThresh ?? 1.2} /></td>

                                        {/* Source indicator */}
                                        <td className={styles.tdNum}>
                                            <span title={`${c.src}${scAgeMin != null ? ` · ${scAgeMin}m ago` : ''}`}
                                                style={{
                                                    fontSize: 8,
                                                    color: c.src === 'STREAM_C' ? '#68d391' : '#718096',
                                                    opacity: 0.7,
                                                }}>
                                                {c.src === 'STREAM_C' ? `C·${scAgeMin ?? '?'}m` : 'B'}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* ── Footer legend ── */}
            <div className={styles.legend}>
                <span>EMA Dist: <span style={{ color:'#fc8181' }}>red=extended↑</span> <span style={{ color:'#9ae6b4' }}>green=above</span> <span style={{ color:'#63b3ed' }}>blue=near</span> <span style={{ color:'#b794f4' }}>purple=stretched↓</span></span>
                <span>RSI: <span style={{ color:'#b794f4' }}>purple&lt;30=OS</span> <span style={{ color:'#fbd38d' }}>yellow&gt;70=OB</span></span>
                <span style={{ marginLeft: 'auto' }}>C=Stream C · B=Stream B fallback</span>
            </div>
        </div>
    );
}

export default MomentumPulse;
