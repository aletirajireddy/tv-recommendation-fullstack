import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
    ComposedChart, Line, Bar, XAxis, YAxis, ReferenceLine, ReferenceDot,
    Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import styles from './EMACascadeMonitor.module.css';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import { useTimeStore } from '../../store/useTimeStore';
import { Zap, ChevronUp, ChevronDown, Diamond, ArrowDown, RefreshCw } from 'lucide-react';

// Audit fix #7: cap rendered Recharts ReferenceLine/ReferenceDot to avoid
// the ~100-marker render cliff. Older events drop off; the most recent
// always survive, which is what users care about.
const MAX_VOL_PINS  = 40;
const MAX_TR_DOTS   = 40;

/* ───────────── Helpers ───────────── */

const TFS = ['m1', 'm5', 'm15', 'h1', 'h4'];

const TF_COLORS = {
    m1:  '#9ae6b4', // light green — fastest
    m5:  '#63b3ed', // sky blue
    m15: '#f6ad55', // amber
    h1:  '#d6bcfa', // soft purple
    h4:  '#fc8181', // coral — slowest / most important
};

const TF_LABELS = {
    m1: '1m', m5: '5m', m15: '15m', h1: '1h', h4: '4h',
};

const EVENT_DOT_COLOR = {
    BROKE: '#fc8181',
    RECLAIM: '#68d391',
    RESPECTED: '#68d391',
    TOUCH: '#fbd38d',
    PULLBACK_TOUCH: '#f6ad55',
    PULLBACK_HOLD: '#f6ad55',
};

const VOL_SOURCE_COLOR = {
    STREAM_C_ALERT: '#f6ad55',
    STREAM_A_EDGE:  '#63b3ed',
    STREAM_D_RVOL:  '#d6bcfa',
};

function smartFmt(price) {
    if (price == null || isNaN(price) || price === 0) return '—';
    if (price >= 1000)  return price.toFixed(2);
    if (price >= 1)     return price.toFixed(4);
    if (price >= 0.01)  return price.toFixed(5);
    if (price >= 0.001) return price.toFixed(6);
    return price.toFixed(8);
}

function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function ageStr(ms) {
    if (ms == null) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60)   return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
}

/* ───────────── Tooltip ───────────── */

function CascadeTooltip({ active, payload, label }) {
    if (!active || !payload?.length) return null;
    const point = payload[0]?.payload || {};
    return (
        <div style={{
            background: 'var(--bg-panel)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '8px 10px', fontSize: 11,
            color: 'var(--text-main)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>{fmtTime(label)}</div>
            <div style={{ marginBottom: 4 }}>
                <span style={{ color: 'var(--text-main)', fontWeight: 700 }}>Price </span>
                <span style={{ color: 'var(--text-muted)' }}>{smartFmt(point.price)}</span>
            </div>
            {TFS.map(tf => point[tf] != null && (
                <div key={tf} style={{ color: TF_COLORS[tf], fontVariantNumeric: 'tabular-nums' }}>
                    {TF_LABELS[tf]} EMA: {smartFmt(point[tf])}
                    {point.distPct?.[tf] != null && (
                        <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>
                            ({point.distPct[tf].toFixed(2)}%)
                        </span>
                    )}
                </div>
            ))}
            {point.regime && (
                <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>
                    Defense: {point.bullDefense || '—'} · Regime: {point.regime}
                </div>
            )}
        </div>
    );
}

/* ───────────── Main Widget ───────────── */

const FALLBACK_TICKERS = ['BTC', 'ETH', 'SOL', 'BNB', 'XRP'];
const WINDOWS = [
    { label: '1h',  value: 60 },
    { label: '2h',  value: 120 },
    { label: '4h',  value: 240 },
    { label: '8h',  value: 480 },
];
const INTERVALS = [
    { label: '1m', value: 1 },
    { label: '2m', value: 2 },
    { label: '5m', value: 5 },
];

export function EMACascadeMonitor({ filterTicker, compact }) {
    const containerRef   = useRef(null);
    const selectedTicker = useTimeStore(s => s.selectedTicker);
    const lastDataPush   = useTimeStore(s => s.lastDataPush);

    const [ticker,     setTicker]     = useState(filterTicker || selectedTicker || 'BTC');
    const [tickerInput,setTickerInput]= useState(filterTicker || selectedTicker || 'BTC');
    const [windowMin,  setWindowMin]  = useState(120);
    const [intervalMin,setIntervalMin]= useState(2);

    // Sync with global selection
    useEffect(() => {
        if (selectedTicker && !filterTicker) {
            setTicker(selectedTicker);
            setTickerInput(selectedTicker);
        }
    }, [selectedTicker, filterTicker]);

    // Socket push (useDataInvalidation below) is the primary refresh trigger.
    // 5-min interval is only a safety-net for missed socket events.
    const { data, loading, error, reload, reloadSilent } = usePolledFetch(
        () => `/api/ema-cascade?ticker=${encodeURIComponent(ticker)}&window_min=${windowMin}&interval=${intervalMin}`,
        { intervalMs: 300_000, deps: [ticker, windowMin, intervalMin] }
    );

    // Viewport-priority invalidation — visible widgets reload immediately on
    // every socket push; off-screen widgets are deferred via stagger queue.
    useDataInvalidation(containerRef, reloadSilent, lastDataPush);

    // Fetch dynamic quick tickers from active board (limit to 12)
    const { data: boardData, reloadSilent: reloadBoardSilent } = usePolledFetch(
        () => `/api/ema-distance-board?limit=12&max_dist=100&active_min=60`,
        { intervalMs: 300_000, deps: [] }
    );
    // Also invalidate the board ticker list on data push
    useDataInvalidation(containerRef, reloadBoardSilent, lastDataPush);

    const dynamicTickers = useMemo(() => {
        if (!boardData?.board?.length) return FALLBACK_TICKERS;
        return boardData.board.map(b => b.cleanTicker);
    }, [boardData]);

    const handleSubmitTicker = (e) => {
        e.preventDefault();
        const v = tickerInput.trim().toUpperCase();
        if (v && v !== ticker) setTicker(v);  // dep change triggers reload
    };

    const setQuickTicker = (t) => {
        setTickerInput(t);
        setTicker(t);
    };

    const setWindow = (v) => setWindowMin(v);
    const setInterval_ = (v) => setIntervalMin(v);
    const load = reload;

    /* ─── Build chart series with gap handling + volume strength ─── */
    const chartData = useMemo(() => {
        if (!data?.history?.length) return [];
        const gapSet = new Set((data.gaps || []).map(g => g.afterTs));

        // Map each volume event to the nearest history bucket (±1.5× intervalMs).
        // Accumulate strength so multiple events in one bucket stack up.
        const intervalMs = (data.interval_min || 2) * 60 * 1000;
        const volMap = new Map();
        for (const e of (data.volEvents || [])) {
            const eMs = typeof e.ts === 'number' ? e.ts : new Date(e.ts).getTime();
            let best = null, bestDiff = Infinity;
            for (const b of data.history) {
                const diff = Math.abs(b.ts - eMs);
                if (diff < bestDiff && diff <= intervalMs * 1.5) { bestDiff = diff; best = b.ts; }
            }
            if (best !== null) volMap.set(best, (volMap.get(best) || 0) + (e.strength || 1));
        }

        return data.history.map(b => ({
            ts: b.ts,
            price: b.price,
            m1: b.emas?.m1 ?? null,
            m5: b.emas?.m5 ?? null,
            m15: b.emas?.m15 ?? null,
            h1: b.emas?.h1 ?? null,
            h4: b.emas?.h4 ?? null,
            distPct: b.distPct,
            cascadeState: b.cascadeState,
            bullDefense: b.bullDefense,
            bearDefense: b.bearDefense,
            regime: b.regime,
            isGap: gapSet.has(b.ts),
            volStrength: volMap.get(b.ts) || 0,
        }));
    }, [data]);

    const yDomain = useMemo(() => {
        if (!chartData.length) return ['auto', 'auto'];
        let lo = Infinity, hi = -Infinity;
        for (const p of chartData) {
            for (const k of ['price', ...TFS]) {
                const v = p[k];
                if (v != null && !isNaN(v)) {
                    if (v < lo) lo = v;
                    if (v > hi) hi = v;
                }
            }
        }
        if (!isFinite(lo)) return ['auto', 'auto'];
        const pad = (hi - lo) * 0.05 || hi * 0.001 || 1;
        return [lo - pad, hi + pad];
    }, [chartData]);

    // Audit fix #7: cap reference markers to keep Recharts in fast path.
    // Most-recent first slice — older events drop off rather than newer ones.
    const transitions = useMemo(
        () => (data?.transitions || []).slice(-MAX_TR_DOTS),
        [data]
    );
    const volEvents = useMemo(
        () => (data?.volEvents || []).slice(-MAX_VOL_PINS),
        [data]
    );
    // Audit fix #13: memoize the reversed/sliced recent-transitions feed.
    const recentTransitions = useMemo(
        () => [...(data?.transitions || [])].reverse().slice(0, 12),
        [data]
    );

    const stackNow       = data?.stackNow       || {};
    const sourceHealth   = data?.sourceHealth   || {};
    const defense        = data?.defenseLevelNow || {};
    const lastBreak      = data?.lastBreak;
    const lastVolEventMs = data?.lastVolEventMs  || null;
    const regime         = defense.regime || 'NEUTRAL';

    const regimeClass = regime === 'BULL'
        ? styles.regimeBull
        : regime === 'BEAR' ? styles.regimeBear : styles.regimeMixed;

    return (
        <div ref={containerRef} className={styles.widget}>
            {/* ── Header ── */}
            <div className={styles.header}>
                <div className={styles.titleRow}>
                    <div className="widget-title">
                        <span className={styles.titleIcon}><Zap size={16} className="text-accent-blue" /></span>
                        <span className={styles.titleText}>EMA CASCADE MONITOR</span>
                        <span className={styles.titleSub}>200 EMA · 1m → 4h · cascade defense</span>
                    </div>
                    <button className={styles.refreshBtn} onClick={() => load()} title="Refresh">
                        <RefreshCw size={14} />
                    </button>
                </div>

                <div className={styles.controlsRow}>
                    {/* Ticker input + quick chips */}
                    <form onSubmit={handleSubmitTicker} className={styles.controlGroup}>
                        <span className={styles.controlLabel}>Coin</span>
                        <input
                            className={styles.tickerInput}
                            value={tickerInput}
                            onChange={(e) => setTickerInput(e.target.value)}
                            placeholder="BTC"
                        />
                    </form>
                    {!filterTicker && (
                        <div className={styles.controlGroup}>
                            {dynamicTickers.map(t => (
                                <button key={t}
                                    className={`${styles.pill} ${ticker === t ? styles.pillActive : ''}`}
                                    onClick={() => setQuickTicker(t)}>
                                    {t}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Window */}
                    <div className={styles.controlGroup}>
                        <span className={styles.controlLabel}>Window</span>
                        {WINDOWS.map(w => (
                            <button key={w.value}
                                className={`${styles.pill} ${windowMin === w.value ? styles.pillActive : ''}`}
                                onClick={() => setWindow(w.value)}>
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
                                onClick={() => setInterval_(i.value)}>
                                {i.label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* ── State strip ── */}
            <div className={styles.stateStrip}>
                <span className={`${styles.stateChip} ${regimeClass}`}>
                    {regime === 'BULL' ? <ChevronUp size={12} /> : regime === 'BEAR' ? <ChevronDown size={12} /> : <Diamond size={10} />} {regime}
                </span>
                <span className={styles.stateLabel}>Bull defense</span>
                <span className={styles.stateValue}>
                    {defense.bull ? TF_LABELS[defense.bull] : '—'}
                </span>
                <span className={styles.stateLabel}>Bear ceiling</span>
                <span className={styles.stateValue}>
                    {defense.bear ? TF_LABELS[defense.bear] : '—'}
                </span>
                {lastBreak && (
                    <>
                        <span className={styles.stateLabel}>Last break</span>
                        <span className={styles.stateValue}>
                            {TF_LABELS[lastBreak.tf]} @ {fmtTime(lastBreak.ts)}
                        </span>
                    </>
                )}

                {/* Source health on the right */}
                <div className={styles.healthRow}>
                    {['STREAM_A','STREAM_C','STREAM_D'].map(src => {
                        const h = sourceHealth[src];
                        if (!h?.lastSeen) {
                            return <span key={src} className={`${styles.healthChip} ${styles.healthMissing}`}>
                                {src.replace('STREAM_','')}·—
                            </span>;
                        }
                        return (
                            <span key={src}
                                className={`${styles.healthChip} ${h.stale ? styles.healthStale : styles.healthOk}`}
                                title={`Last seen ${ageStr(h.ageMs)} ago${h.stale ? ' (STALE)' : ''}`}>
                                {src.replace('STREAM_','')}·{ageStr(h.ageMs)}
                            </span>
                        );
                    })}
                    {/* Last vol spike time — shows even when no events are in current chart window */}
                    {lastVolEventMs && (
                        <span className={styles.healthChip}
                            style={{
                                color: volEvents.length ? '#f6ad55' : '#4a5568',
                                borderColor: volEvents.length ? 'rgba(246,173,85,0.3)' : 'rgba(255,255,255,0.06)',
                                display: 'flex', alignItems: 'center', gap: '2px'
                            }}
                            title={`Last volume spike: ${new Date(lastVolEventMs).toLocaleTimeString()}`}>
                            <ArrowDown size={10} /> vol·{ageStr(Date.now() - lastVolEventMs)}{volEvents.length ? ` (${volEvents.length})` : ' ago'}
                        </span>
                    )}
                </div>
            </div>

            {/* ── Body ── */}
            <div className={styles.body}>
                {loading && !data && (
                    <div className={styles.loadingState}>
                        <div className={styles.spinner} />
                        <div>Loading {ticker} cascade…</div>
                    </div>
                )}
                {error && (
                    <div className={styles.errorState}>
                        ⚠ {error}
                    </div>
                )}
                {!loading && !error && chartData.length === 0 && (
                    <div className={styles.emptyState}>
                        No data for {ticker} in the last {windowMin}m.
                    </div>
                )}

                {chartData.length > 0 && (
                    <>
                        {/* Chart */}
                        <div className={styles.chartArea}>
                            <ResponsiveContainer width="100%" height={300}>
                                <ComposedChart data={chartData}
                                    margin={{ top: 6, right: 18, left: 4, bottom: 4 }}>
                                    <XAxis
                                        dataKey="ts"
                                        type="number"
                                        domain={['dataMin','dataMax']}
                                        tick={{ fill: '#4a5568', fontSize: 9 }}
                                        tickFormatter={fmtTime}
                                        axisLine={{ stroke: 'rgba(255,255,255,0.05)' }}
                                        tickLine={false}
                                    />
                                    <YAxis
                                        yAxisId="price"
                                        domain={yDomain}
                                        tick={{ fill: '#4a5568', fontSize: 9 }}
                                        tickFormatter={smartFmt}
                                        width={62}
                                        axisLine={{ stroke: 'rgba(255,255,255,0.05)' }}
                                        tickLine={false}
                                    />
                                    {/* Secondary axis for volume bars — hidden, domain inflated
                                        so bars occupy only ~20% of chart height */}
                                    <YAxis
                                        yAxisId="vol"
                                        orientation="right"
                                        domain={[0, dataMax => dataMax * 5]}
                                        hide
                                    />
                                    <Tooltip content={<CascadeTooltip />} />

                                    {/* Volume magnitude bars — amber, bottom-anchored, scaled
                                        to ~20% height via inflated secondary YAxis domain */}
                                    <Bar
                                        yAxisId="vol"
                                        dataKey="volStrength"
                                        fill="#F59E0B"
                                        barSize={5}
                                        radius={[2, 2, 0, 0]}
                                        isAnimationActive={false}
                                        opacity={0.80}
                                        name="Vol"
                                    />

                                    {/* Price line */}
                                    <Line
                                        yAxisId="price"
                                        type="monotone" dataKey="price"
                                        stroke="#e2e8f0" strokeWidth={1.6}
                                        dot={false} isAnimationActive={false}
                                        name="Price"
                                    />

                                    {/* EMA lines per TF */}
                                    {TFS.map(tf => (
                                        <Line
                                            key={tf}
                                            yAxisId="price"
                                            type="monotone" dataKey={tf}
                                            stroke={TF_COLORS[tf]} strokeWidth={1.4}
                                            strokeDasharray={tf === 'h1' || tf === 'h4' ? '4 3' : ''}
                                            dot={false} connectNulls={false}
                                            isAnimationActive={false}
                                            name={`${TF_LABELS[tf]} EMA`}
                                        />
                                    ))}

                                    {/* Volume event vertical markers — source-color pins on price axis */}
                                    {volEvents.map((e, idx) => (
                                        <ReferenceLine
                                            key={`vol-${idx}`}
                                            yAxisId="price"
                                            x={new Date(e.ts).getTime()}
                                            stroke={VOL_SOURCE_COLOR[e.source] || '#a0aec0'}
                                            strokeOpacity={0.35}
                                            strokeDasharray="2 4"
                                        />
                                    ))}

                                    {/* Transition dots on cascade events */}
                                    {transitions.map((t, idx) => {
                                        const color = EVENT_DOT_COLOR[t.event] || '#a0aec0';
                                        return (
                                            <ReferenceDot
                                                key={`tr-${idx}`}
                                                yAxisId="price"
                                                x={t.ts} y={t.ema}
                                                r={4}
                                                fill={color}
                                                stroke="#0d1117"
                                                strokeWidth={1.2}
                                            />
                                        );
                                    })}

                                    <Legend
                                        verticalAlign="bottom"
                                        height={20}
                                        wrapperStyle={{ fontSize: 9, color: '#718096' }}
                                        iconType="line"
                                        iconSize={10}
                                    />
                                </ComposedChart>
                            </ResponsiveContainer>
                        </div>

                        {/* Cascade ladder (snapshot now) */}
                        <div className={styles.ladderRow}>
                            {TFS.map(tf => {
                                const s = stackNow[tf];
                                if (!s) {
                                    return (
                                        <div key={tf} className={styles.tfBadge}
                                             style={{ borderColor: 'rgba(255,255,255,0.06)', color: '#4a5568' }}>
                                            <div className={styles.tfTop}>
                                                <span className={styles.tfLabel}>{TF_LABELS[tf]}</span>
                                                <span className={styles.tfState}>—</span>
                                            </div>
                                            <span className={styles.tfPrice}>—</span>
                                            <span className={styles.tfSrc}>no data</span>
                                        </div>
                                    );
                                }
                                const last = chartData[chartData.length - 1];
                                const cs = last?.cascadeState?.[tf];
                                const distPct = last?.distPct?.[tf];
                                const stateClass = cs === 'ABOVE'
                                    ? styles.tfAbove
                                    : cs === 'BELOW' ? styles.tfBelow : styles.tfTesting;
                                return (
                                    <div key={tf}
                                         className={`${styles.tfBadge} ${stateClass} ${s.stale ? styles.tfStale : ''}`}
                                         title={`source=${s.source} · age ${ageStr(s.ageMs)}${s.stale ? ' (stale)' : ''}`}>
                                        <div className={styles.tfTop}>
                                            <span className={styles.tfLabel}>{TF_LABELS[tf]}</span>
                                            <span className={styles.tfState}>{cs || '—'}</span>
                                        </div>
                                        <span className={styles.tfPrice}>{smartFmt(s.price)}</span>
                                        {distPct != null && (
                                            <span className={styles.tfDist}
                                                title={`${distPct >= 0 ? 'Price is ' + distPct.toFixed(2) + '% ABOVE' : 'Price is ' + Math.abs(distPct).toFixed(2) + '% BELOW'} the ${TF_LABELS[tf]} 200 EMA`}>
                                                {distPct >= 0 ? '+' : ''}{distPct.toFixed(2)}%
                                                <span className={styles.tfDistLabel}>vs EMA200</span>
                                            </span>
                                        )}
                                        <span className={styles.tfSrc}>
                                            {s.source?.replace('STREAM_','')} · {ageStr(s.ageMs)}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>

                        {/* Recent transitions (most recent first) */}
                        {transitions.length > 0 && (
                            <div className={styles.transitionsList}>
                                {recentTransitions.map((t, idx) => (
                                    <div key={idx} className={styles.transRow}>
                                        <span className={styles.transTime}>{fmtTime(t.ts)}</span>
                                        <span className={styles.transTf}>{TF_LABELS[t.tf]}</span>
                                        <span className={`${styles.transEvent} ${styles['ev' + t.event]}`}>
                                            {t.event}
                                        </span>
                                        <span className={styles.transPrice}>
                                            px {smartFmt(t.price)} / ema {smartFmt(t.ema)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

export default EMACascadeMonitor;
