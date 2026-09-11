import React, { useEffect, useState, useRef, useMemo, useCallback } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import {
    Activity, ArrowRight, ArrowUp, ArrowDown, Flame, Snowflake,
    GitBranch, BarChart3, ListTree, TrendingUp, TrendingDown, Gauge,
} from 'lucide-react';
import {
    ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
    ReferenceLine, Brush,
} from 'recharts';
import { format } from 'date-fns';
import { useChartBrush } from '../../hooks/useChartBrush';
import { checkCascade, passesAtrGate, classifyCoin, loadCascadeSeries } from '../../utils/cascadeUtils';
import { LastSyncBadge, ResetPrefsButton } from '../Shared/WidgetHeaderBadges';
import { useWidgetPrefs } from '../../hooks/useWidgetPrefs';
import styles from './CascadeTrendWidget.module.css';

/* ─── Cascade Chip Trend (best-of-both)
   Primary view: 4 independent chip-count lines over time (matches EMA Cascade
   Monitor's solid long chips + dotted short ↗/↘ chips).
   Plus header insights: Wyckoff Phase, Velocity 30m, Flips 60m.
   Plus tabbed footer: live Transitions / per-coin Paths / Flow Matrix.       */

const COLORS = {
    longBull:  '#10B981',
    longBear:  '#EF4444',
    shortBull: '#34D399',
    shortBear: '#F87171',
};

// 5-state mutually-exclusive classification (for coin-paths / transitions / flow)
const STATE_META = {
    longBull: { weight:  2, color: '#10B981', light: '#10B98133', short: 'LB+',  label: 'Long Bull'  },
    tempBull: { weight:  1, color: '#34D399', light: '#34D39933', short: 'SB↗',  label: 'Short Bull' },
    neutral:  { weight:  0, color: '#6B7280', light: '#6B728022', short: '—',    label: 'Neutral'    },
    tempBear: { weight: -1, color: '#F87171', light: '#F8717133', short: 'SB↘',  label: 'Short Bear' },
    longBear: { weight: -2, color: '#EF4444', light: '#EF444433', short: 'LB-',  label: 'Long Bear'  },
};

function tickerShort(t) {
    const clean = (t || '').split(':').pop() || '';
    return clean.replace(/USDT(\.P)?$/i, '').slice(0, 6);
}

function getPhase(score, velocity) {
    if (Math.abs(score) < 15 && Math.abs(velocity) < 5) return { label: 'CONSOLIDATION',     color: '#6B7280', icon: Activity     };
    if (score >  30 && velocity >  5)                   return { label: 'MARKUP',            color: '#10B981', icon: TrendingUp   };
    if (score >  30 && velocity < -5)                   return { label: 'DISTRIBUTION',      color: '#F59E0B', icon: TrendingDown };
    if (score < -30 && velocity < -5)                   return { label: 'MARKDOWN',          color: '#EF4444', icon: TrendingDown };
    if (score < -30 && velocity >  5)                   return { label: 'ACCUMULATION',      color: '#3B82F6', icon: TrendingUp   };
    if (Math.abs(velocity) > 10)                        return { label: 'REVERSAL BREWING',  color: '#A855F7', icon: GitBranch    };
    return                                                     { label: 'TRANSITION',        color: '#6B7280', icon: Activity     };
}

export function CascadeTrendWidget() {
    const containerRef        = useRef(null);
    const cascadeHistory      = useTimeStore(s => s.cascadeHistory);
    const fetchCascadeHistory = useTimeStore(s => s.fetchCascadeHistory);
    const lastDataPush        = useTimeStore(s => s.lastDataPush);
    const [config]            = useState(loadCascadeSeries());
    const [isMobile, setIsMobile]   = useState(false);
    const [lastFetchedAt, setLastFetchedAt] = useState(null);

    // Persisted UI prefs — survive reloads, reset via header button
    const [uiPrefs, setUIPrefs, resetUIPrefs] = useWidgetPrefs('cascadeTrend_prefs', {
        visibleLongBull:  true,
        visibleLongBear:  true,
        visibleShortBull: true,
        visibleShortBear: true,
        bottomView: 'transitions', // transitions | coins | flow
        coinSort:   'volatile',    // volatile | recent | bullish | bearish
    });
    const visible = {
        longBull:  uiPrefs.visibleLongBull,
        longBear:  uiPrefs.visibleLongBear,
        shortBull: uiPrefs.visibleShortBull,
        shortBear: uiPrefs.visibleShortBear,
    };
    const setVisible = (updater) => {
        const next = typeof updater === 'function' ? updater(visible) : updater;
        setUIPrefs({
            visibleLongBull:  next.longBull,
            visibleLongBear:  next.longBear,
            visibleShortBull: next.shortBull,
            visibleShortBear: next.shortBear,
        });
    };
    const bottomView = uiPrefs.bottomView;
    const setBottomView = (v) => setUIPrefs({ bottomView: v });
    const coinSort = uiPrefs.coinSort;
    const setCoinSort = (v) => setUIPrefs({ coinSort: v });

    useEffect(() => {
        const mql = window.matchMedia('(pointer: coarse)');
        setIsMobile(mql.matches);
        const handler = (e) => setIsMobile(e.matches);
        mql.addEventListener('change', handler);
        return () => mql.removeEventListener('change', handler);
    }, []);

    // Wrap fetchCascadeHistory so we can stamp lastFetchedAt on every successful sync
    const fetchAndStamp = useCallback(async () => {
        try {
            await fetchCascadeHistory();
            setLastFetchedAt(Date.now());
        } catch {}
    }, [fetchCascadeHistory]);

    useEffect(() => { fetchAndStamp(); }, []);
    useDataInvalidation(containerRef, fetchAndStamp, lastDataPush);

    // Audit fix: cascadeHistory otherwise only refreshes via the viewport-priority
    // invalidation above, which itself only fires on the socket-driven lastDataPush
    // signal. Per Rule #18, socket-driven refresh should always keep an interval
    // fallback — a stalled websocket (SocketService has no polling transport to
    // fall back to) would otherwise leave this chart frozen with no recovery short
    // of a full page reload. 5-minute safety net, matching FusionDashboard.
    useEffect(() => {
        const id = setInterval(() => fetchAndStamp(), 300_000);
        return () => clearInterval(id);
    }, [fetchAndStamp]);

    // ─── Build timeline + coin series (one pass, multiple data shapes) ──────
    // tickersByChip in each bucket = { longBull: ['BTC',…], longBear:[…], … }
    // so the tooltip can show WHICH coins were in each category at that time.
    const { timeline, coinSeries, allCoins, sparse } = useMemo(() => {
        if (!cascadeHistory || cascadeHistory.length === 0) {
            return { timeline: [], coinSeries: {}, allCoins: [], sparse: false };
        }
        const { longSeries, shortSeries, equalThreshold } = config;

        // Recharts <Line> needs ≥2 points to draw. If the API only returned a
        // single bucket (rare — only first few minutes after Stream D boot),
        // clone it forward by 5 min so the chart renders a horizontal segment.
        let source = cascadeHistory;
        const isSparse = source.length < 2;
        if (isSparse && source.length === 1) {
            source = [source[0], { ...source[0], ts: source[0].ts + 5 * 60 * 1000 }];
        }

        const tl     = [];
        const series = {};
        const coinSet = new Set();

        for (const bucket of source) {
            // Per-chip ticker lists for this bucket — used by tooltip & flip detector
            const tickersByChip = { longBull: [], longBear: [], shortBull: [], shortBear: [] };
            const stateCounts = { longBull: 0, tempBull: 0, neutral: 0, tempBear: 0, longBear: 0 };

            if (bucket.data) {
                for (const [ticker, m] of Object.entries(bucket.data)) {
                    coinSet.add(ticker);

                    // Reconstruct fake EMAs from dist% readings
                    const fakePrice = 100;
                    const emas = {};
                    if (m.m1  != null) emas.m1  = fakePrice / (m.m1  / 100 + 1);
                    if (m.m5  != null) emas.m5  = fakePrice / (m.m5  / 100 + 1);
                    if (m.m15 != null) emas.m15 = fakePrice / (m.m15 / 100 + 1);
                    if (m.h1  != null) emas.h1  = fakePrice / (m.h1  / 100 + 1);
                    if (m.h4  != null) emas.h4  = fakePrice / (m.h4  / 100 + 1);

                    // Independent chip categorisation (chart lines + tooltip lists)
                    const longDir  = checkCascade(emas, longSeries,  equalThreshold);
                    const shortDir = checkCascade(emas, shortSeries, equalThreshold);
                    const atrOk    = passesAtrGate(emas, shortSeries, { m15: m.atr15 }, fakePrice);
                    if (longDir  === 'bull')             tickersByChip.longBull.push(ticker);
                    if (longDir  === 'bear')             tickersByChip.longBear.push(ticker);
                    if (shortDir === 'bull' && atrOk)    tickersByChip.shortBull.push(ticker);
                    if (shortDir === 'bear' && atrOk)    tickersByChip.shortBear.push(ticker);

                    // 5-state exclusive classification (for transitions / coin paths / flow)
                    const exclusiveState = classifyCoin(
                        { emas, atrs: { m15: m.atr15 }, price: fakePrice },
                        longSeries, shortSeries, equalThreshold
                    );
                    stateCounts[exclusiveState]++;

                    if (!series[ticker]) series[ticker] = [];
                    series[ticker].push({ ts: bucket.ts, state: exclusiveState, v: m.v || 0 });
                }
            }

            const rawScore = (
                stateCounts.longBull * 2 + stateCounts.tempBull * 1 +
                stateCounts.tempBear * -1 + stateCounts.longBear * -2
            );
            const totalCoins = Object.values(stateCounts).reduce((a, b) => a + b, 0);
            const score = totalCoins > 0 ? Math.round((rawScore / (totalCoins * 2)) * 100) : 0;

            tl.push({
                ts: bucket.ts,
                timeLabel: format(new Date(bucket.ts), 'HH:mm'),
                longBull:  tickersByChip.longBull.length,
                longBear:  tickersByChip.longBear.length,
                shortBull: tickersByChip.shortBull.length,
                shortBear: tickersByChip.shortBear.length,
                score, totalCoins,
                tickersByChip,
            });
        }

        // Annotate each bucket with the COINS THAT JOINED / LEFT each chip
        // compared to the previous bucket — this is the backtest signal.
        for (let i = 1; i < tl.length; i++) {
            const cur = tl[i].tickersByChip;
            const prev = tl[i - 1].tickersByChip;
            const flips = {};
            for (const k of ['longBull','longBear','shortBull','shortBear']) {
                const curSet = new Set(cur[k]);
                const prevSet = new Set(prev[k]);
                flips[k] = {
                    joined: cur[k].filter(t => !prevSet.has(t)),
                    left:   prev[k].filter(t => !curSet.has(t)),
                };
            }
            tl[i].flips = flips;
        }

        return { timeline: tl, coinSeries: series, allCoins: Array.from(coinSet).sort(), sparse: isSparse };
    }, [cascadeHistory, config]);

    // ─── Derived KPIs (phase, velocity, transitions, flow) ───────────────────
    const kpis = useMemo(() => {
        if (timeline.length === 0) return null;
        const latest = timeline[timeline.length - 1];
        const back = Math.min(6, timeline.length - 1); // ~30min @ 5-min buckets
        const earlier = timeline[timeline.length - 1 - back];
        const velocity = earlier ? (latest.score - earlier.score) : 0;

        const cutoffMs = (latest.ts || Date.now()) - 60 * 60 * 1000;
        let transitionCount = 0;
        const transitions = [];
        for (const ticker of Object.keys(coinSeries)) {
            const arr = coinSeries[ticker];
            for (let i = 1; i < arr.length; i++) {
                if (arr[i].ts < cutoffMs) continue;
                if (arr[i].state !== arr[i - 1].state) {
                    transitionCount++;
                    transitions.push({ ts: arr[i].ts, ticker, from: arr[i - 1].state, to: arr[i].state, v: arr[i].v });
                }
            }
        }
        transitions.sort((a, b) => b.ts - a.ts);
        const phase = getPhase(latest.score, velocity);
        return { latest, velocity, phase, transitions, transitionCount };
    }, [timeline, coinSeries]);

    // ─── Sorted coin list for "Coin Paths" view ──────────────────────────────
    const sortedCoins = useMemo(() => {
        if (!allCoins.length) return [];
        const rows = allCoins.map(t => {
            const series = coinSeries[t] || [];
            const latest = series[series.length - 1];
            let flips = 0;
            for (let i = Math.max(1, series.length - 30); i < series.length; i++) {
                if (series[i].state !== series[i - 1].state) flips++;
            }
            const score = latest ? STATE_META[latest.state]?.weight ?? 0 : 0;
            const lastFlipTs = (series.length > 1 && series[series.length - 1].state !== series[series.length - 2].state)
                ? series[series.length - 1].ts : 0;
            return { ticker: t, series, latest, flips, score, lastFlipTs };
        });
        switch (coinSort) {
            case 'volatile': return rows.sort((a, b) => b.flips - a.flips);
            case 'bullish':  return rows.sort((a, b) => b.score - a.score);
            case 'bearish':  return rows.sort((a, b) => a.score - b.score);
            case 'recent':
            default:         return rows.sort((a, b) => b.lastFlipTs - a.lastFlipTs);
        }
    }, [allCoins, coinSeries, coinSort]);

    // ─── Flow matrix ─────────────────────────────────────────────────────────
    const flowMatrix = useMemo(() => {
        if (!kpis) return [];
        const pairs = {};
        for (const t of kpis.transitions) {
            const key = `${t.from}→${t.to}`;
            if (!pairs[key]) pairs[key] = { from: t.from, to: t.to, count: 0, tickers: [] };
            pairs[key].count++;
            if (pairs[key].tickers.length < 8) pairs[key].tickers.push(t.ticker);
        }
        return Object.values(pairs).sort((a, b) => b.count - a.count).slice(0, 8);
    }, [kpis]);

    const { brushRange, handleBrushChange } = useChartBrush('tv_cascadeBrush_v3', timeline);

    if (timeline.length === 0) {
        return (
            <div ref={containerRef} className={styles.widgetWrapper}>
                <div className={styles.emptyState}>
                    <Activity size={26} opacity={0.4} />
                    <div>Waiting for Stream D cascade data…</div>
                </div>
            </div>
        );
    }

    const latest = timeline[timeline.length - 1];
    const PhaseIcon = kpis.phase.icon;

    // ─── Tooltip — shows ticker names per chip + transitions vs previous bucket ─
    const CustomTooltip = ({ active, payload, label }) => {
        if (!active || !payload || !payload.length) return null;
        const d = payload[0].payload;
        const tbc   = d.tickersByChip || { longBull: [], longBear: [], shortBull: [], shortBear: [] };
        const flips = d.flips         || null;
        return (
            <div className={styles.tooltipContainer}>
                <div className={styles.tooltipTime}>
                    {label} · <span style={{ color: d.score > 0 ? COLORS.longBull : d.score < 0 ? COLORS.longBear : 'var(--text-muted)' }}>
                        Score {d.score > 0 ? '+' : ''}{d.score}
                    </span>
                </div>
                {[
                    { k: 'longBull',  label: 'Long Bull',   dotted: false },
                    { k: 'longBear',  label: 'Long Bear',   dotted: false },
                    { k: 'shortBull', label: 'Short Bull ↗', dotted: true  },
                    { k: 'shortBear', label: 'Short Bear ↘', dotted: true  },
                ].map(({ k, label, dotted }) => {
                    const tickers = tbc[k] || [];
                    return (
                        <div key={k} className={styles.tooltipChipBlock}>
                            <div className={styles.tooltipRow}>
                                <span
                                    className={dotted ? styles.ttDotted : styles.ttSolid}
                                    style={{ background: dotted ? 'transparent' : COLORS[k], borderColor: COLORS[k] }}
                                />
                                <span className={styles.tooltipLabel}>{label}</span>
                                <span className={styles.tooltipVal} style={{ color: COLORS[k] }}>{d[k]}</span>
                            </div>
                            {tickers.length > 0 && (
                                <div className={styles.tooltipTickers}>
                                    {tickers.slice(0, 12).map(t => {
                                        const isNew = flips?.[k]?.joined?.includes(t);
                                        return (
                                            <span key={t}
                                                  className={`${styles.ttTicker} ${isNew ? styles.ttTickerNew : ''}`}
                                                  style={isNew ? { borderColor: COLORS[k], color: COLORS[k] } : undefined}>
                                                {isNew && '+'}{tickerShort(t)}
                                            </span>
                                        );
                                    })}
                                    {tickers.length > 12 && (
                                        <span className={styles.ttTickerMore}>+{tickers.length - 12}</span>
                                    )}
                                </div>
                            )}
                            {flips?.[k]?.left?.length > 0 && (
                                <div className={styles.tooltipTickers}>
                                    {flips[k].left.slice(0, 8).map(t => (
                                        <span key={t} className={`${styles.ttTicker} ${styles.ttTickerLeft}`}>
                                            −{tickerShort(t)}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        );
    };

    const toggle = (key) => setVisible(v => ({ ...v, [key]: !v[key] }));
    const HeaderChip = ({ k, label, arrow, dotted }) => (
        <button
            onClick={() => toggle(k)}
            className={`${styles.headerChip} ${visible[k] ? '' : styles.headerChipOff}`}
            style={{ borderColor: visible[k] ? COLORS[k] + '88' : 'var(--border)' }}
            title={visible[k] ? 'Hide line' : 'Show line'}
        >
            <span
                className={dotted ? styles.chipDotted : styles.chipSolid}
                style={{
                    background: !dotted && visible[k] ? COLORS[k] : 'transparent',
                    borderColor: COLORS[k],
                    color: COLORS[k],
                }}
            />
            <span className={styles.chipLabel}>{label}{arrow}</span>
            <span className={styles.chipCount} style={{ color: visible[k] ? COLORS[k] : 'var(--text-muted)' }}>
                {latest[k]}
            </span>
        </button>
    );

    return (
        <div ref={containerRef} className={styles.widgetWrapper}>
            {/* ─── HEADER ──────────────────────────────────────────────── */}
            <div className={styles.header}>
                <div className={styles.titleBlock}>
                    <h3 className={styles.title}>Cascade Chip Trend</h3>
                    <span className={styles.subtitle}>
                        long {config.longSeries.join('→')} · short {config.shortSeries.join('→')}
                    </span>
                </div>

                <div className={styles.chipRow}>
                    <HeaderChip k="longBull"  label="Long Bull"   arrow=""   dotted={false} />
                    <HeaderChip k="longBear"  label="Long Bear"   arrow=""   dotted={false} />
                    <HeaderChip k="shortBull" label="Short Bull " arrow="↗"  dotted={true}  />
                    <HeaderChip k="shortBear" label="Short Bear " arrow="↘"  dotted={true}  />
                </div>

                <div className={styles.headerActions}>
                    <LastSyncBadge ts={lastFetchedAt} />
                    <ResetPrefsButton onReset={resetUIPrefs} title="Reset chip visibility, view, and sort to defaults" />
                </div>
            </div>

            {/* ─── INSIGHTS STRIP — Phase + Score + Velocity + Flips ──── */}
            <div className={styles.insightsStrip}>
                <div className={styles.phaseBadge}
                    style={{ color: kpis.phase.color, borderColor: kpis.phase.color + '66', background: kpis.phase.color + '11' }}
                    title="Wyckoff-style market phase derived from regime score × 30m velocity">
                    <PhaseIcon size={11} /> {kpis.phase.label}
                </div>

                <div className={styles.kpi} title="Regime score: weighted (Long Bull +2, Short Bull +1, Short Bear -1, Long Bear -2), normalised to ±100">
                    <Gauge size={10} className={styles.kpiIcon}/>
                    <span className={styles.kpiLabel}>Score</span>
                    <span className={styles.kpiVal} style={{ color: latest.score > 0 ? COLORS.longBull : latest.score < 0 ? COLORS.longBear : 'var(--text-muted)' }}>
                        {latest.score > 0 ? '+' : ''}{latest.score}
                    </span>
                </div>

                <div className={styles.kpi} title="Change in regime score over the last ~30 minutes — early regime-shift detector">
                    {kpis.velocity > 0 ? <ArrowUp size={10} color={COLORS.longBull}/> :
                     kpis.velocity < 0 ? <ArrowDown size={10} color={COLORS.longBear}/> :
                     <ArrowRight size={10}/>}
                    <span className={styles.kpiLabel}>Velocity 30m</span>
                    <span className={styles.kpiVal} style={{ color: kpis.velocity > 0 ? COLORS.longBull : kpis.velocity < 0 ? COLORS.longBear : 'var(--text-muted)' }}>
                        {kpis.velocity > 0 ? '+' : ''}{kpis.velocity}
                    </span>
                </div>

                <div className={styles.kpi} title="Number of coin state changes in the last 60 minutes — market churn level">
                    <GitBranch size={10} className={styles.kpiIcon}/>
                    <span className={styles.kpiLabel}>Flips 60m</span>
                    <span className={styles.kpiVal} style={{ color: kpis.transitionCount > 20 ? '#F59E0B' : 'var(--text-main)' }}>
                        {kpis.transitionCount}
                    </span>
                    {kpis.transitionCount > 20 ? <Flame size={9} color="#F59E0B"/> :
                     kpis.transitionCount < 5 ? <Snowflake size={9} color="var(--text-muted)"/> : null}
                </div>
            </div>

            {/* ─── CHART ───────────────────────────────────────────────── */}
            <div className={styles.chartArea}>
                {sparse && (
                    <div className={styles.sparseHint}>
                        Only 1 data bucket so far — chart will populate as Stream D scans accumulate
                        (one bucket per 5 min).
                    </div>
                )}
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={timeline} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="2 4" vertical={false} stroke="var(--border)" opacity={0.4} />
                        <XAxis dataKey="timeLabel" axisLine={false} tickLine={false}
                            tick={{ fontSize: 10, fill: 'var(--text-muted)' }} minTickGap={40} />
                        <YAxis axisLine={false} tickLine={false} width={28}
                            tick={{ fontSize: 9, fill: 'var(--text-muted)' }} allowDecimals={false}
                            domain={[0, (dataMax) => Math.max(dataMax + 1, 5)]} />
                        <ReferenceLine y={0} stroke="var(--text-muted)" strokeOpacity={0.4} />
                        <Tooltip content={<CustomTooltip />}
                            cursor={{ stroke: 'rgba(255,255,255,0.25)', strokeWidth: 1, strokeDasharray: '3 3' }}
                            isAnimationActive={false}
                            trigger={isMobile ? 'click' : 'hover'} />

                        {/* Small dots show each data point — critical when timeline is short
                            (lines collapse to single segments otherwise). Active dot enlarges
                            on hover to show the exact bucket being inspected. */}
                        {visible.longBull && (
                            <Line type="monotone" dataKey="longBull"
                                stroke={COLORS.longBull} strokeWidth={2.2}
                                dot={false}
                                activeDot={{ r: 4, stroke: '#fff', strokeWidth: 1 }}
                                isAnimationActive={false} />
                        )}
                        {visible.longBear && (
                            <Line type="monotone" dataKey="longBear"
                                stroke={COLORS.longBear} strokeWidth={2.2}
                                dot={false}
                                activeDot={{ r: 4, stroke: '#fff', strokeWidth: 1 }}
                                isAnimationActive={false} />
                        )}
                        {visible.shortBull && (
                            <Line type="monotone" dataKey="shortBull"
                                stroke={COLORS.shortBull} strokeWidth={1.8} strokeDasharray="4 3"
                                dot={false}
                                activeDot={{ r: 4, stroke: '#fff', strokeWidth: 1 }}
                                isAnimationActive={false} />
                        )}
                        {visible.shortBear && (
                            <Line type="monotone" dataKey="shortBear"
                                stroke={COLORS.shortBear} strokeWidth={1.8} strokeDasharray="4 3"
                                dot={false}
                                activeDot={{ r: 4, stroke: '#fff', strokeWidth: 1 }}
                                isAnimationActive={false} />
                        )}

                        <Brush
                            dataKey="timeLabel" height={20} travellerWidth={16}
                            stroke="var(--text-muted)" fill="var(--bg-app)"
                            onChange={handleBrushChange}
                            startIndex={brushRange.startIndex} endIndex={brushRange.endIndex}
                            tickFormatter={() => ''}
                        />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>

            {/* ─── BOTTOM TABBED PANEL ─────────────────────────────────── */}
            <div className={styles.bottomBar}>
                <div className={styles.tabRow}>
                    <button className={`${styles.tabBtn} ${bottomView === 'transitions' ? styles.tabActive : ''}`}
                        onClick={() => setBottomView('transitions')}>
                        <GitBranch size={11}/> Transitions
                        {kpis.transitionCount > 0 && <span className={styles.tabBadge}>{kpis.transitionCount}</span>}
                    </button>
                    <button className={`${styles.tabBtn} ${bottomView === 'coins' ? styles.tabActive : ''}`}
                        onClick={() => setBottomView('coins')}>
                        <ListTree size={11}/> Coin Paths
                    </button>
                    <button className={`${styles.tabBtn} ${bottomView === 'flow' ? styles.tabActive : ''}`}
                        onClick={() => setBottomView('flow')}>
                        <BarChart3 size={11}/> Flow
                        {flowMatrix.length > 0 && <span className={styles.tabBadge}>{flowMatrix.length}</span>}
                    </button>
                </div>

                {bottomView === 'transitions' && (
                    <div className={styles.scrollPanel}>
                        {kpis.transitions.slice(0, 25).map((t, i) => {
                            const fromM = STATE_META[t.from];
                            const toM   = STATE_META[t.to];
                            const isBullish = toM.weight > fromM.weight;
                            return (
                                <div key={i} className={styles.transitionRow} style={{ borderLeftColor: toM.color }}>
                                    <span className={styles.tickerSm}>{tickerShort(t.ticker)}</span>
                                    <span className={styles.statePill} style={{ background: fromM.light, color: fromM.color }}>{fromM.short}</span>
                                    <ArrowRight size={10} color={isBullish ? COLORS.longBull : COLORS.longBear}/>
                                    <span className={styles.statePill} style={{ background: toM.light, color: toM.color }}>{toM.short}</span>
                                    <span className={styles.timeSm}>{format(new Date(t.ts), 'HH:mm')}</span>
                                </div>
                            );
                        })}
                        {kpis.transitions.length === 0 && (
                            <div className={styles.emptyHint}>No state transitions in the last hour — market is stable.</div>
                        )}
                    </div>
                )}

                {bottomView === 'coins' && (
                    <>
                        <div className={styles.sortBar}>
                            <span className={styles.sortLabel}>Sort:</span>
                            {[['volatile','Most Flips'], ['recent','Recent Flip'], ['bullish','Most Bullish'], ['bearish','Most Bearish']].map(([k, l]) => (
                                <button key={k} className={`${styles.sortBtn} ${coinSort === k ? styles.sortActive : ''}`}
                                    onClick={() => setCoinSort(k)}>{l}</button>
                            ))}
                        </div>
                        <div className={styles.scrollPanel}>
                            {sortedCoins.slice(0, 30).map(({ ticker, series, latest: c, flips }) => (
                                <div key={ticker} className={styles.coinPathRow}>
                                    <span className={styles.tickerSm}>{tickerShort(ticker)}</span>
                                    <div className={styles.coinPathStrip}>
                                        {series.slice(-40).map((pt, i) => (
                                            <div key={i} className={styles.coinPathCell}
                                                style={{ background: STATE_META[pt.state]?.color || '#444' }}
                                                title={`${format(new Date(pt.ts), 'HH:mm')} · ${STATE_META[pt.state]?.label}`} />
                                        ))}
                                    </div>
                                    <span className={styles.coinPathState} style={{ color: STATE_META[c?.state]?.color || 'var(--text-muted)' }}>
                                        {STATE_META[c?.state]?.short || '—'}
                                    </span>
                                    {flips > 0 && <span className={styles.flipsBadge}>{flips}×</span>}
                                </div>
                            ))}
                            {sortedCoins.length === 0 && <div className={styles.emptyHint}>No coin data yet.</div>}
                        </div>
                    </>
                )}

                {bottomView === 'flow' && (
                    <div className={styles.scrollPanel}>
                        {flowMatrix.map((f, i) => {
                            const fromM = STATE_META[f.from];
                            const toM   = STATE_META[f.to];
                            const isBullish  = toM.weight > fromM.weight;
                            const isReversal = (fromM.weight < 0 && toM.weight > 0) || (fromM.weight > 0 && toM.weight < 0);
                            return (
                                <div key={i} className={styles.flowRow}>
                                    <div className={styles.flowPair}>
                                        <span className={styles.statePill} style={{ background: fromM.light, color: fromM.color }}>{fromM.label}</span>
                                        <ArrowRight size={12} color={isBullish ? COLORS.longBull : COLORS.longBear}/>
                                        <span className={styles.statePill} style={{ background: toM.light, color: toM.color }}>{toM.label}</span>
                                        {isReversal && <span className={styles.reversalBadge}>REVERSAL</span>}
                                    </div>
                                    <div className={styles.flowCount}>{f.count} coin{f.count !== 1 ? 's' : ''}</div>
                                    <div className={styles.flowTickers}>
                                        {f.tickers.map(t => <span key={t} className={styles.flowTicker}>{tickerShort(t)}</span>)}
                                    </div>
                                </div>
                            );
                        })}
                        {flowMatrix.length === 0 && <div className={styles.emptyHint}>No transitions in window — market is stable.</div>}
                    </div>
                )}
            </div>
        </div>
    );
}

export default CascadeTrendWidget;
