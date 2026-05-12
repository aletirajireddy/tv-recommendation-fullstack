import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer, ReferenceLine, ReferenceDot, Legend,
} from 'recharts';
import styles from './ATRRaceWidget.module.css';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import { useTimeStore } from '../../store/useTimeStore';
import { Activity, RefreshCw, Settings } from 'lucide-react';
import {
    checkCascade, passesAtrGate, loadCascadeSeries, TF_LABELS as TF_LABELS_MAP,
} from '../../utils/cascadeUtils';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_COINS   = 10;
const MAX_DOTS    = 40;
const MAX_POINTS  = 120; // per coin after decimation

const RACE_COLORS = [
    '#F6AD55', '#63B3ED', '#68D391', '#FC8181', '#D6BCFA',
    '#F6E05E', '#76E4F7', '#FBD38D', '#9AE6B4', '#FC8181',
];

const METRICS = [
    { key: 'atr_m15',  label: 'ATR 15m',  rvol: false },
    { key: 'atr_h1',   label: 'ATR 1h',   rvol: false },
    { key: 'rvol_m15', label: 'RVOL 15m', rvol: true  },
    { key: 'rvol_h1',  label: 'RVOL 1h',  rvol: true  },
];

const FILTER_GROUPS = [
    { key: 'top10',    label: '⚡ Top 10'    },
    { key: 'longBull', label: '🟢 Long Bull' },
    { key: 'longBear', label: '🔴 Long Bear' },
    { key: 'tempBull', label: '↗ Temp Bull' },
    { key: 'tempBear', label: '↘ Temp Bear' },
];

const WINDOWS = [
    { label: '30m', value: 30  },
    { label: '1h',  value: 60  },
    { label: '2h',  value: 120 },
    { label: '4h',  value: 240 },
    { label: '8h',  value: 480 },
];

// RVOL reference lines (institutional significance levels)
const RVOL_REFS = [
    { y: 1.5, label: '1.5×', color: '#F6AD55', dash: '4 3' },
    { y: 2.0, label: '2.0×', color: '#FC8181', dash: '2 2' },
    { y: 3.0, label: '3.0×', color: '#FC8181', dash: ''    },
];

const LS_KEY      = 'raceWidget_prefs';
const RACE_DEFAULTS = {
    filterGroup: 'top10',
    metric:      'atr_m15',
    windowMin:   120,
    pinnedCoins: [],
};

function loadRacePrefs() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_KEY));
        return s ? { ...RACE_DEFAULTS, ...s } : { ...RACE_DEFAULTS };
    } catch { return { ...RACE_DEFAULTS }; }
}

function saveRacePrefs(prefs) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(prefs)); } catch {}
}

function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function decimateSeries(points, max = MAX_POINTS) {
    if (points.length <= max) return points;
    const step = Math.ceil(points.length / max);
    return points.filter((_, i) => i % step === 0 || i === points.length - 1);
}

// ── Custom tooltip ─────────────────────────────────────────────────────────────
function RaceTooltip({ active, payload, label, metric }) {
    if (!active || !payload?.length) return null;
    const metaDef = METRICS.find(m => m.key === metric);
    return (
        <div className={styles.tooltip}>
            <div className={styles.tooltipTime}>{fmtTime(label)}</div>
            {payload.map(p => p.value != null && (
                <div key={p.dataKey} className={styles.tooltipRow}>
                    <span className={styles.tooltipDot} style={{ background: p.color }} />
                    <span className={styles.tooltipTicker}>{p.dataKey}</span>
                    <span className={styles.tooltipVal}>
                        {p.value.toFixed(3)}{metaDef?.rvol ? '×' : '%'}
                    </span>
                </div>
            ))}
        </div>
    );
}

// ── Main widget ────────────────────────────────────────────────────────────────
export function ATRRaceWidget() {
    const containerRef = useRef(null);
    const lastDataPush = useTimeStore(s => s.lastDataPush);
    const [prefs, setPrefs]           = useState(loadRacePrefs);
    const { filterGroup, metric, windowMin, pinnedCoins } = prefs;

    const updatePref = useCallback((key, val) => {
        setPrefs(prev => {
            const next = { ...prev, [key]: val };
            saveRacePrefs(next);
            return next;
        });
    }, []);

    const cascadeSeries = useMemo(() => loadCascadeSeries(), []);

    // ── Board fetch — for cascade classification + top-10 ranking ─────────────
    const { data: boardData, reloadSilent: reloadBoard } = usePolledFetch(
        () => `/api/ema-distance-board?limit=50&active_min=120`,
        { intervalMs: 300_000, deps: [] }
    );
    useDataInvalidation(containerRef, reloadBoard, lastDataPush);

    // ── Classify all board coins ───────────────────────────────────────────────
    const classifiedCoins = useMemo(() => {
        if (!boardData?.board?.length) return [];
        const { longSeries, shortSeries, equalThreshold } = cascadeSeries;
        return boardData.board.map(b => {
            const longDir  = checkCascade(b.emas, longSeries,  equalThreshold);
            const shortDir = checkCascade(b.emas, shortSeries, equalThreshold);
            const atrGate  = passesAtrGate(b.emas, shortSeries, b.atrs, b.price);
            let group = 'neutral';
            if      (longDir === 'bull' && shortDir === 'bear' && atrGate) group = 'tempBear';
            else if (longDir === 'bear' && shortDir === 'bull' && atrGate) group = 'tempBull';
            else if (longDir === 'bull') group = 'longBull';
            else if (longDir === 'bear') group = 'longBear';
            return { ticker: b.cleanTicker, group, atr_m15: b.atrs?.m15 || 0 };
        });
    }, [boardData, cascadeSeries]);

    // ── Pick tickers for selected filter group (top 10 by ATR%) ───────────────
    const activeTickers = useMemo(() => {
        if (pinnedCoins.length > 0) return pinnedCoins.slice(0, MAX_COINS);
        let pool = classifiedCoins;
        if (filterGroup !== 'top10') pool = classifiedCoins.filter(c => c.group === filterGroup);
        return pool
            .sort((a, b) => b.atr_m15 - a.atr_m15)
            .slice(0, MAX_COINS)
            .map(c => c.ticker);
    }, [classifiedCoins, filterGroup, pinnedCoins]);

    // ── Metric history fetch ───────────────────────────────────────────────────
    const historyUrl = useCallback(() => {
        if (!activeTickers.length) return null;
        return `/api/coin-metric-history?tickers=${activeTickers.join(',')}&window_min=${windowMin}`;
    }, [activeTickers, windowMin]);

    const { data: historyData, loading, reloadSilent: reloadHistory } = usePolledFetch(
        historyUrl,
        { intervalMs: 300_000, deps: [activeTickers.join(','), windowMin] }
    );
    useDataInvalidation(containerRef, reloadHistory, lastDataPush);

    // ── Build Recharts pivot: [{ts, BTC, ETH, ...}] ───────────────────────────
    const { chartData, spikeDots, colorMap } = useMemo(() => {
        const coins = historyData?.coins || {};
        const tickers = Object.keys(coins).filter(t => activeTickers.includes(t));
        if (!tickers.length) return { chartData: [], spikeDots: [], colorMap: {} };

        // Assign stable colors
        const colorMap = {};
        tickers.forEach((t, i) => { colorMap[t] = RACE_COLORS[i % RACE_COLORS.length]; });

        // Collect all unique timestamps
        const tsSet = new Set();
        tickers.forEach(t => coins[t].forEach(r => tsSet.add(r.ts)));
        const allTs = [...tsSet].sort((a, b) => a - b);

        // Build lookup per ticker
        const lookup = {};
        tickers.forEach(t => {
            lookup[t] = {};
            coins[t].forEach(r => { lookup[t][r.ts] = r[metric]; });
        });

        // Pivot + decimate per ticker first then merge
        const decimatedTs = decimateSeries(allTs);
        const pivoted = decimatedTs.map(ts => {
            const row = { ts };
            tickers.forEach(t => {
                const v = lookup[t][ts];
                if (v != null) row[t] = v;
            });
            return row;
        });

        // Spike dots: flag entries where RVOL crosses 2.0×
        const metaDef = METRICS.find(m => m.key === metric);
        const spikeDots = [];
        if (metaDef?.rvol) {
            tickers.forEach(t => {
                coins[t].forEach(r => {
                    const v = r[metric];
                    if (v != null && v >= 2.0) {
                        spikeDots.push({ ts: r.ts, ticker: t, value: v, color: colorMap[t] });
                    }
                });
            });
            spikeDots.sort((a, b) => b.value - a.value);
            spikeDots.splice(MAX_DOTS); // cap
        }

        return { chartData: pivoted, spikeDots, colorMap };
    }, [historyData, activeTickers, metric]);

    // ── Ticker toggle (manual pin) ─────────────────────────────────────────────
    const togglePin = useCallback((ticker) => {
        setPrefs(prev => {
            const pinned = prev.pinnedCoins.includes(ticker)
                ? prev.pinnedCoins.filter(t => t !== ticker)
                : [...prev.pinnedCoins, ticker].slice(0, MAX_COINS);
            const next = { ...prev, pinnedCoins: pinned };
            saveRacePrefs(next);
            return next;
        });
    }, []);

    const resetPrefs = () => {
        try { localStorage.removeItem(LS_KEY); } catch {}
        setPrefs({ ...RACE_DEFAULTS });
    };

    const metaDef = METRICS.find(m => m.key === metric) || METRICS[0];

    return (
        <div ref={containerRef} className={styles.widget}>
            {/* ── Header ── */}
            <div className={styles.header}>
                <div className={styles.titleRow}>
                    <div className="widget-title">
                        <Activity size={16} style={{ color: 'var(--accent-blue)' }} />
                        <span className={styles.titleText}>ATR RACE</span>
                        <span className={styles.titleSub}>Multi-coin momentum flow</span>
                    </div>
                    <div style={{ display: 'flex', gap: 4 }}>
                        <button className={styles.iconBtn} onClick={resetPrefs} title="Reset to defaults">↺</button>
                        <button className={styles.iconBtn} onClick={reloadHistory} title="Refresh">
                            <RefreshCw size={13} />
                        </button>
                    </div>
                </div>

                {/* Filter group row */}
                <div className={styles.filterRow}>
                    {FILTER_GROUPS.map(g => (
                        <button
                            key={g.key}
                            className={`${styles.filterBtn} ${filterGroup === g.key && pinnedCoins.length === 0 ? styles.filterActive : ''}`}
                            onClick={() => { updatePref('filterGroup', g.key); updatePref('pinnedCoins', []); }}
                        >
                            {g.label}
                        </button>
                    ))}
                </div>

                {/* Metric + window row */}
                <div className={styles.controlsRow}>
                    <div className={styles.controlGroup}>
                        {METRICS.map(m => (
                            <button
                                key={m.key}
                                className={`${styles.pill} ${metric === m.key ? styles.pillActive : ''}`}
                                onClick={() => updatePref('metric', m.key)}
                            >
                                {m.label}
                            </button>
                        ))}
                    </div>
                    <div className={styles.controlGroup}>
                        {WINDOWS.map(w => (
                            <button
                                key={w.value}
                                className={`${styles.pill} ${windowMin === w.value ? styles.pillActive : ''}`}
                                onClick={() => updatePref('windowMin', w.value)}
                            >
                                {w.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Active coin chips */}
                {activeTickers.length > 0 && (
                    <div className={styles.coinChips}>
                        {activeTickers.map((t, i) => (
                            <button
                                key={t}
                                className={`${styles.coinChip} ${pinnedCoins.includes(t) ? styles.coinChipPinned : ''}`}
                                style={{ borderColor: colorMap[t] || 'var(--border)', color: colorMap[t] || 'var(--text-muted)' }}
                                onClick={() => togglePin(t)}
                                title={pinnedCoins.includes(t) ? 'Click to unpin' : 'Click to pin'}
                            >
                                {t}
                            </button>
                        ))}
                        {pinnedCoins.length > 0 && (
                            <button className={styles.clearPinBtn} onClick={() => updatePref('pinnedCoins', [])}>
                                ✕ clear pins
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* ── Chart ── */}
            <div className={styles.chartArea}>
                {loading && !historyData && (
                    <div className={styles.emptyState}><div className={styles.spinner} />Loading race data…</div>
                )}
                {!loading && chartData.length === 0 && (
                    <div className={styles.emptyState}>
                        No {metaDef.label} data yet — history builds as Stream D pushes arrive.
                    </div>
                )}
                {chartData.length > 0 && (
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 16, right: 20, left: 0, bottom: 4 }}>
                            <CartesianGrid strokeDasharray="2 2" stroke="rgba(255,255,255,0.04)" vertical={false} />
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
                            <YAxis
                                tick={{ fill: '#4a5568', fontSize: 9 }}
                                tickLine={false}
                                axisLine={{ stroke: 'rgba(255,255,255,0.05)' }}
                                width={40}
                                tickFormatter={v => metaDef.rvol ? `${v.toFixed(1)}×` : `${v.toFixed(2)}%`}
                            />
                            <Tooltip
                                content={<RaceTooltip metric={metric} />}
                                isAnimationActive={false}
                            />

                            {/* RVOL institutional reference lines */}
                            {metaDef.rvol && RVOL_REFS.map(r => (
                                <ReferenceLine
                                    key={r.y}
                                    y={r.y}
                                    stroke={r.color}
                                    strokeOpacity={0.4}
                                    strokeDasharray={r.dash}
                                    label={{ value: r.label, fill: r.color, fontSize: 9, position: 'right' }}
                                />
                            ))}

                            {/* One line per coin */}
                            {activeTickers.map(t => (
                                <Line
                                    key={t}
                                    type="monotone"
                                    dataKey={t}
                                    stroke={colorMap[t] || '#888'}
                                    strokeWidth={1.6}
                                    dot={false}
                                    connectNulls={false}
                                    isAnimationActive={false}
                                />
                            ))}

                            {/* Volume spike dots — sized by RVOL magnitude */}
                            {spikeDots.map((d, i) => (
                                <ReferenceDot
                                    key={`spike-${i}`}
                                    x={d.ts}
                                    y={d.value}
                                    r={Math.min(3 + (d.value - 2) * 1.5, 7)}
                                    fill={d.color}
                                    stroke="#0d1117"
                                    strokeWidth={1}
                                />
                            ))}

                            <Legend
                                verticalAlign="bottom"
                                height={18}
                                wrapperStyle={{ fontSize: 9, color: '#718096' }}
                                iconType="line"
                                iconSize={10}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                )}
            </div>

            {/* ── Footer note ── */}
            <div className={styles.footer}>
                <span>Cascade settings from EMA Monitor apply here</span>
                {metaDef.rvol && <span className={styles.footerDot}>● bubble = RVOL ≥ 2.0×</span>}
            </div>
        </div>
    );
}

export default ATRRaceWidget;
