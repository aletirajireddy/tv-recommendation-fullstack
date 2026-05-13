// RSI Grid Wall — per-coin RSI "candle" on a 0-100 scale.
// Candle body = span between configured cascade series TF RSI values.
// White line  = temp TF (wick) RSI, with directional arrow.
// Amber ⚡     = cascade active AND temp TF near 50 (pullback entry zone).

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { FreshnessChip } from '../FreshnessChip';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useTimeStore } from '../../store/useTimeStore';
import socketService from '../../services/SocketService';
import { BarChart2, RefreshCw, AlertTriangle, Settings } from 'lucide-react';
import styles from './RSIGridWall.module.css';

/* ─── Constants ─────────────────────────────────────────────────────────── */
const TF_OPTS  = ['h1', 'm30', 'm15', 'm5'];
const TF_LABEL = { h1: '1h', m30: '30m', m15: '15m', m5: '5m' };

const CASCADE_META = {
    BEAR_CASCADE:  { color: '#fc8181', bg: 'rgba(252,129,129,0.10)', label: '🔴 BEAR CASCADE',  short: 'BEAR'   },
    BULL_CASCADE:  { color: '#68d391', bg: 'rgba(104,211,145,0.10)', label: '🟢 BULL CASCADE',  short: 'BULL'   },
    PARTIAL_BEAR:  { color: '#f6ad55', bg: 'rgba(246,173,85,0.08)',  label: '🟠 PARTIAL BEAR',  short: 'P·BEAR' },
    PARTIAL_BULL:  { color: '#9ae6b4', bg: 'rgba(154,230,180,0.07)', label: '🟡 PARTIAL BULL',  short: 'P·BULL' },
    NEUTRAL:       { color: '#718096', bg: 'rgba(255,255,255,0.02)', label: '— NEUTRAL',          short: '—'      },
};

const LS_KEY   = 'rsiGridWall_prefs';
const DEFAULTS = {
    seriesTFs:    ['h1', 'm30'],
    tempTF:       'm15',
    oversold:     30,
    overbought:   70,
    pullbackZone: 5,
    filter:       'all',
};

function loadPrefs() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_KEY));
        return s ? { ...DEFAULTS, ...s } : { ...DEFAULTS };
    } catch { return { ...DEFAULTS }; }
}

/* ─── RSI Candle SVG ────────────────────────────────────────────────────── */
function RsiCandle({ rsi, seriesTFs, tempTF, oversold, overbought, cascadeState, tempDir, pullback }) {
    const W = 48, H = 88;
    const y = (v) => H - (v / 100) * H;

    const yOB  = y(overbought);              // upper zone boundary
    const yOS  = y(oversold);               // lower zone boundary
    const yMid = y(50);

    // Body: spans between the two series TF RSI values on the 0-100 scale
    const s1 = rsi[seriesTFs[0]] ?? null;
    const s2 = (seriesTFs[1] && seriesTFs[1] !== seriesTFs[0]) ? (rsi[seriesTFs[1]] ?? null) : null;
    const hasBody    = s1 != null && s2 != null;
    const bodyTop    = hasBody ? Math.min(y(s1), y(s2)) : null;
    const bodyBottom = hasBody ? Math.max(y(s1), y(s2)) : null;
    const bodyH      = hasBody ? Math.max(bodyBottom - bodyTop, 2.5) : 0;
    const singleVal  = !hasBody ? (s1 ?? s2) : null;

    // White line: temp TF position
    const tempVal = rsi[tempTF] ?? null;
    const yTemp   = tempVal != null ? y(tempVal) : null;

    const bodyColor = (CASCADE_META[cascadeState] || CASCADE_META.NEUTRAL).color;
    const cx = W / 2;
    const CW = 14; // candle body width

    return (
        <svg width={W} height={H} style={{ display: 'block', flexShrink: 0 }}>
            {/* Zone backgrounds */}
            <rect x={0} y={0}    width={W} height={yOB}      fill="rgba(104,211,145,0.07)" />
            <rect x={0} y={yOS}  width={W} height={H - yOS}  fill="rgba(252,129,129,0.07)" />

            {/* Reference lines */}
            <line x1={0} y1={yOB}  x2={W} y2={yOB}  stroke="rgba(104,211,145,0.4)"  strokeWidth={0.8} strokeDasharray="3 2" />
            <line x1={0} y1={yMid} x2={W} y2={yMid}  stroke="rgba(255,255,255,0.1)"  strokeWidth={0.7} strokeDasharray="2 3" />
            <line x1={0} y1={yOS}  x2={W} y2={yOS}   stroke="rgba(252,129,129,0.4)"  strokeWidth={0.8} strokeDasharray="3 2" />

            {/* Candle body — two series TFs */}
            {hasBody && (
                <rect
                    x={cx - CW / 2} y={bodyTop}
                    width={CW} height={bodyH}
                    fill={bodyColor}
                    opacity={cascadeState === 'NEUTRAL' ? 0.28 : 0.72}
                    rx={2}
                />
            )}
            {/* Single TF only — tick line */}
            {singleVal != null && (
                <line
                    x1={cx - CW / 2} y1={y(singleVal)}
                    x2={cx + CW / 2} y2={y(singleVal)}
                    stroke={bodyColor} strokeWidth={2.5} opacity={0.65} strokeLinecap="round"
                />
            )}

            {/* White line — temp TF RSI */}
            {yTemp != null && (
                <line
                    x1={0} y1={yTemp} x2={W} y2={yTemp}
                    stroke={pullback ? '#f6ad55' : 'rgba(255,255,255,0.88)'}
                    strokeWidth={pullback ? 2 : 1.5}
                />
            )}
            {/* Arrow tip — shows temp TF direction */}
            {yTemp != null && tempDir === 'up' && (
                <polygon
                    points={`${W},${yTemp}  ${W - 5},${yTemp + 4}  ${W - 5},${yTemp}`}
                    fill="rgba(255,255,255,0.65)"
                />
            )}
            {yTemp != null && tempDir === 'down' && (
                <polygon
                    points={`${W},${yTemp}  ${W - 5},${yTemp - 4}  ${W - 5},${yTemp}`}
                    fill="rgba(255,255,255,0.65)"
                />
            )}

            {/* Pullback highlight border */}
            {pullback && (
                <rect x={0.5} y={0.5} width={W - 1} height={H - 1}
                    fill="none" stroke="rgba(246,173,85,0.5)" strokeWidth={1.5} rx={3} />
            )}
        </svg>
    );
}

/* ─── RSI value badge ───────────────────────────────────────────────────── */
function RsiVal({ value, oversold, overbought }) {
    if (value == null) return <span style={{ color: '#4a5568', fontSize: 9 }}>—</span>;
    const zone  = value < oversold ? 'os' : value > overbought ? 'ob' : 'mid';
    const color = zone === 'os' ? '#fc8181' : zone === 'ob' ? '#68d391' : '#718096';
    return (
        <span style={{ color, fontVariantNumeric: 'tabular-nums', fontSize: 10,
                       fontWeight: zone !== 'mid' ? 700 : 400 }}>
            {value.toFixed(1)}
        </span>
    );
}

/* ─── Settings panel ────────────────────────────────────────────────────── */
function SettingsPanel({ prefs, onApply, onClose }) {
    const [local, setLocal] = useState({ ...prefs });

    const toggleSeries = (tf) => {
        setLocal(p => {
            const has = p.seriesTFs.includes(tf);
            if (has && p.seriesTFs.length <= 1) return p;
            const next = has ? p.seriesTFs.filter(t => t !== tf) : [...p.seriesTFs, tf];
            return { ...p, seriesTFs: next };
        });
    };

    return (
        <div className={styles.settingsPanel}>
            <div className={styles.settingsRow}>
                <span className={styles.settingsLabel}>CASCADE SERIES TFs</span>
                <div className={styles.tfGroup}>
                    {TF_OPTS.map(tf => (
                        <button key={tf}
                            className={`${styles.tfBtn} ${local.seriesTFs.includes(tf) ? styles.tfBtnOn : ''}`}
                            onClick={() => toggleSeries(tf)}
                            disabled={local.tempTF === tf}
                            title={local.tempTF === tf ? 'Currently the temp TF — change temp first' : `Toggle ${TF_LABEL[tf]} in cascade series`}>
                            {TF_LABEL[tf]}
                        </button>
                    ))}
                </div>
                <span className={styles.settingsHint}>candle body</span>
            </div>
            <div className={styles.settingsRow}>
                <span className={styles.settingsLabel}>TEMP / WICK TF</span>
                <div className={styles.tfGroup}>
                    {TF_OPTS.map(tf => (
                        <button key={tf}
                            className={`${styles.tfBtn} ${local.tempTF === tf ? styles.tfBtnWhite : ''}`}
                            onClick={() => setLocal(p => ({ ...p, tempTF: tf }))}
                            disabled={local.seriesTFs.includes(tf)}
                            title={local.seriesTFs.includes(tf) ? 'In use as series TF' : `Use ${TF_LABEL[tf]} as the white line`}>
                            {TF_LABEL[tf]}
                        </button>
                    ))}
                </div>
                <span className={styles.settingsHint}>white line</span>
            </div>
            <div className={styles.settingsRow}>
                <span className={styles.settingsLabel}>OVERSOLD / OVERBOUGHT</span>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input type="number" className={styles.numInput} min={5} max={45}
                        value={local.oversold}
                        onChange={e => setLocal(p => ({ ...p, oversold: +e.target.value }))} />
                    <span style={{ color: '#718096', fontSize: 9 }}>/</span>
                    <input type="number" className={styles.numInput} min={55} max={95}
                        value={local.overbought}
                        onChange={e => setLocal(p => ({ ...p, overbought: +e.target.value }))} />
                </div>
            </div>
            <div className={styles.settingsRow}>
                <span className={styles.settingsLabel}>PULLBACK ZONE ± AROUND 50</span>
                <input type="number" className={styles.numInput} min={2} max={15}
                    value={local.pullbackZone}
                    onChange={e => setLocal(p => ({ ...p, pullbackZone: +e.target.value }))} />
                <span className={styles.settingsHint}>⚡ trigger width</span>
            </div>
            <div className={styles.settingsFooter}>
                <button className={styles.resetBtn}
                    onClick={() => setLocal({ ...DEFAULTS, filter: local.filter })}>
                    Reset defaults
                </button>
                <button className={styles.applyBtn}
                    onClick={() => { onApply(local); onClose(); }}>
                    Apply
                </button>
            </div>
        </div>
    );
}

/* ─── Main widget ────────────────────────────────────────────────────────── */
export function RSIGridWall() {
    const setSelectedTicker = useTimeStore(s => s.setSelectedTicker);
    const [prefs, setPrefs]       = useState(loadPrefs);
    const [showSettings, setShowSettings] = useState(false);

    const apiUrl = useMemo(() => {
        const p = new URLSearchParams({
            series_tfs:    prefs.seriesTFs.join(','),
            temp_tf:       prefs.tempTF,
            oversold:      prefs.oversold,
            overbought:    prefs.overbought,
            pullback_zone: prefs.pullbackZone,
        });
        return `/api/rsi-grid-wall?${p}`;
    }, [prefs.seriesTFs, prefs.tempTF, prefs.oversold, prefs.overbought, prefs.pullbackZone]);

    const { data, loading, error, reload, reloadSilent, lastFetchedAt } = usePolledFetch(
        () => apiUrl,
        { intervalMs: 30_000, deps: [apiUrl] }
    );

    useEffect(() => {
        const socket = socketService.connect();
        let t;
        const handler = () => { clearTimeout(t); t = setTimeout(() => reloadSilent(), 800); };
        socket.on('stream-d-update', handler);
        return () => { clearTimeout(t); socket.off('stream-d-update', handler); };
    }, [reloadSilent]);

    const applyPrefs = useCallback((next) => {
        setPrefs(next);
        localStorage.setItem(LS_KEY, JSON.stringify(next));
    }, []);

    const setFilter = useCallback((f) => {
        const next = { ...prefs, filter: f };
        setPrefs(next);
        localStorage.setItem(LS_KEY, JSON.stringify(next));
    }, [prefs]);

    const cfg       = data?.config || {};
    const seriesTFs = cfg.seriesTFs  || prefs.seriesTFs;
    const tempTF    = cfg.tempTF     || prefs.tempTF;
    const oversold  = cfg.oversold   ?? prefs.oversold;
    const overbought = cfg.overbought ?? prefs.overbought;

    const allCoins  = data?.coins || [];

    const counts = useMemo(() => ({
        bear:     allCoins.filter(c => c.cascadeState === 'BEAR_CASCADE').length,
        bull:     allCoins.filter(c => c.cascadeState === 'BULL_CASCADE').length,
        pullback: allCoins.filter(c => c.pullback).length,
        partial:  allCoins.filter(c => c.cascadeState === 'PARTIAL_BEAR' || c.cascadeState === 'PARTIAL_BULL').length,
    }), [allCoins]);

    const coins = useMemo(() => {
        if (prefs.filter === 'bear')     return allCoins.filter(c => c.cascadeState === 'BEAR_CASCADE');
        if (prefs.filter === 'bull')     return allCoins.filter(c => c.cascadeState === 'BULL_CASCADE');
        if (prefs.filter === 'pullback') return allCoins.filter(c => c.pullback);
        if (prefs.filter === 'partial')  return allCoins.filter(c => c.cascadeState === 'PARTIAL_BEAR' || c.cascadeState === 'PARTIAL_BULL');
        return allCoins;
    }, [allCoins, prefs.filter]);

    return (
        <div className={styles.widget}>
            {/* ── Header ── */}
            <div className={styles.header}>
                <div className={styles.titleRow}>
                    <div className="widget-title">
                        <span className={styles.titleIcon}><BarChart2 size={16} className="text-accent-blue" /></span>
                        <span className={styles.titleText}>RSI GRID WALL</span>
                        <span className={styles.titleSub}>
                            {seriesTFs.map(t => TF_LABEL[t]).join('+')} cascade body · {TF_LABEL[tempTF]} wick line
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <FreshnessChip ts={lastFetchedAt} title="Last fetched" />
                        <button className={styles.iconBtn}
                            onClick={() => setShowSettings(s => !s)}
                            title="Settings"
                            style={{ color: showSettings ? 'var(--accent-blue)' : undefined }}>
                            <Settings size={14} />
                        </button>
                        <button className={styles.iconBtn} onClick={() => reload()} title="Refresh">
                            <RefreshCw size={14} />
                        </button>
                    </div>
                </div>

                {/* Settings panel (collapsible) */}
                {showSettings && (
                    <SettingsPanel
                        prefs={prefs}
                        onApply={applyPrefs}
                        onClose={() => setShowSettings(false)}
                    />
                )}

                {/* Filter chips */}
                <div className={styles.filterRow}>
                    {[
                        { key: 'all',      label: `All (${allCoins.length})` },
                        { key: 'bear',     label: `🔴 Bear (${counts.bear})` },
                        { key: 'bull',     label: `🟢 Bull (${counts.bull})` },
                        { key: 'pullback', label: `⚡ Entry (${counts.pullback})` },
                        { key: 'partial',  label: `🟠 Partial (${counts.partial})` },
                    ].map(f => (
                        <button key={f.key}
                            className={`${styles.filterChip} ${prefs.filter === f.key ? styles.filterActive : ''}`}
                            onClick={() => setFilter(f.key)}>
                            {f.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* ── States ── */}
            {loading && !data && (
                <div className={styles.loading}><div className={styles.spinner} /> Loading RSI data…</div>
            )}
            {error && (
                <div className={styles.error}><AlertTriangle size={13} /> {error}</div>
            )}
            {!loading && !error && allCoins.length === 0 && (
                <div className={styles.empty}>
                    No RSI data yet — waiting for Stream D push
                    <span style={{ fontSize: 9, opacity: 0.6, display: 'block', marginTop: 4 }}>
                        RSI columns added to DB; first data arrives on next scan cycle
                    </span>
                </div>
            )}

            {/* ── Grid ── */}
            {coins.length > 0 && (
                <div className={styles.grid}>
                    {coins.map(c => {
                        const meta = CASCADE_META[c.cascadeState] || CASCADE_META.NEUTRAL;
                        return (
                            <div key={c.ticker}
                                className={`${styles.card} ${c.pullback ? styles.cardPulse : ''}`}
                                style={{ '--card-accent': meta.color, background: meta.bg }}
                                onClick={() => setSelectedTicker(c.clean)}
                                title={`${c.clean} — ${meta.label}${c.pullback ? ' ⚡ Entry zone' : ''}`}>

                                {/* Card header */}
                                <div className={styles.cardHeader}>
                                    <span className={styles.cardCoin}>{c.clean}</span>
                                    <span className={styles.cardBadge}
                                        style={{ color: meta.color, borderColor: meta.color + '55' }}>
                                        {meta.short}
                                    </span>
                                    {c.pullback && (
                                        <span className={styles.entryPip} title="Cascade active + temp TF near 50">⚡</span>
                                    )}
                                </div>

                                {/* RSI Candle + scale labels side by side */}
                                <div className={styles.candleRow}>
                                    <RsiCandle
                                        rsi={c.rsi}
                                        seriesTFs={seriesTFs}
                                        tempTF={tempTF}
                                        oversold={oversold}
                                        overbought={overbought}
                                        cascadeState={c.cascadeState}
                                        tempDir={c.tempDir}
                                        pullback={c.pullback}
                                    />
                                    <div className={styles.scaleLabels}>
                                        <span style={{ color: 'rgba(104,211,145,0.7)', fontSize: 8 }}>{overbought}</span>
                                        <span style={{ color: 'rgba(255,255,255,0.2)', fontSize: 8 }}>50</span>
                                        <span style={{ color: 'rgba(252,129,129,0.7)', fontSize: 8 }}>{oversold}</span>
                                    </div>
                                </div>

                                {/* RSI values row */}
                                <div className={styles.rsiRow}>
                                    {seriesTFs.map(tf => (
                                        <div key={tf} className={styles.rsiCell}>
                                            <span className={styles.rsiTfLabel}>{TF_LABEL[tf]}</span>
                                            <RsiVal value={c.rsi[tf]} oversold={oversold} overbought={overbought} />
                                        </div>
                                    ))}
                                    {/* Temp TF — separated by a subtle divider */}
                                    <div className={styles.rsiCell} style={{ paddingLeft: 5, borderLeft: '1px solid rgba(255,255,255,0.07)' }}>
                                        <span className={styles.rsiTfLabel} style={{ color: 'rgba(255,255,255,0.45)' }}>
                                            {TF_LABEL[tempTF]}
                                            <span style={{ fontSize: 7, marginLeft: 1 }}>
                                                {c.tempDir === 'up' ? '↑' : c.tempDir === 'down' ? '↓' : '─'}
                                            </span>
                                        </span>
                                        <RsiVal value={c.rsi[tempTF]} oversold={oversold} overbought={overbought} />
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* ── Legend ── */}
            <div className={styles.legend}>
                <span>Body = {seriesTFs.map(t => TF_LABEL[t]).join('+')} RSI span</span>
                <span style={{ color: 'rgba(255,255,255,0.7)' }}>White line = {TF_LABEL[tempTF]} RSI</span>
                <span><span style={{ color: '#fc8181' }}>█</span> both &lt;{oversold}</span>
                <span><span style={{ color: '#68d391' }}>█</span> both &gt;{overbought}</span>
                <span><span style={{ color: '#f6ad55' }}>█</span> partial</span>
                <span style={{ marginLeft: 'auto' }}>⚡ = cascade + {TF_LABEL[tempTF]} near 50</span>
            </div>
        </div>
    );
}

export default RSIGridWall;
