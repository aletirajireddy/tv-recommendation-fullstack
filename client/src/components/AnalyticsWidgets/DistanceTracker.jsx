import React, { useState, useMemo, useEffect, useCallback, lazy, Suspense } from 'react';
import { FreshnessChip } from '../FreshnessChip';
import { ResetPrefsButton } from '../Shared/WidgetHeaderBadges';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useTimeStore } from '../../store/useTimeStore';
import socketService from '../../services/SocketService';
import { checkCascade } from '../../utils/cascadeUtils';
import { Ruler, RefreshCw, AlertTriangle, Bell, LayoutGrid, List } from 'lucide-react';
import styles from './DistanceTracker.module.css';

// Lazy-load the modal so the chunk only ships when a user actually clicks "create alert"
const SmartAlertCreateModal = lazy(() =>
    import('../SmartAlerts/SmartAlertCreateModal').then(m => ({ default: m.SmartAlertCreateModal || m.default }))
);

const TFS = ['m1', 'm5', 'm15', 'h1', 'h4'];
const TF_LABELS = { m1: '1m', m5: '5m', m15: '15m', h1: '1h', h4: '4h' };

function fmtAtr(val) {
    if (val == null || isNaN(val)) return '—';
    return val.toFixed(2) + '%';
}

const SRC_COLOR = {
    STREAM_D: '#9ae6b4',
    STREAM_C: '#f6ad55',
    STREAM_A: '#63b3ed',
};

function smartFmt(price) {
    if (price == null || isNaN(price) || price === 0) return '—';
    if (price >= 1000)  return price.toFixed(2);
    if (price >= 1)     return price.toFixed(4);
    if (price >= 0.01)  return price.toFixed(5);
    if (price >= 0.001) return price.toFixed(6);
    return price.toFixed(8);
}

function distClass(absPct) {
    if (absPct == null) return styles.distEmpty;
    if (absPct < 0.5) return styles.distGood;
    if (absPct < 2)   return styles.distMid;
    return styles.distBad;
}

// Long-series cascade uses same 3-TF default as EMACascadeMonitor
const LONG_SERIES = ['h4', 'h1', 'm15'];

// Cascade display helpers
const CASCADE_LABEL = { bull: '↑Bull', bear: '↓Bear', neutral: '—' };
const CASCADE_COLOR = { bull: '#68d391', bear: '#fc8181', neutral: '#718096' };
const CASCADE_TITLE = {
    bull: 'Long Bull cascade: h4 EMA < h1 EMA < 15m EMA (shorter EMAs higher = uptrend stacking)',
    bear: 'Long Bear cascade: h4 EMA > h1 EMA > 15m EMA (shorter EMAs lower = downtrend stacking)',
    neutral: 'Neutral: EMA stack not aligned in either direction',
};

// RVOL formatter + color
function fmtRvol(v) {
    if (v == null || isNaN(v)) return '—';
    return v.toFixed(2) + '×';
}
function rvolColor(v) {
    if (v == null) return 'var(--text-muted)';
    if (v >= 2.0) return '#68d391';
    if (v >= 1.5) return '#9ae6b4';
    if (v >= 1.2) return '#f6ad55';
    return 'var(--text-muted)';
}

// Entry quality score: cascade alignment bonus + RVOL bonus.
// Higher = better long setup; negative = short setup or avoid.
// Does NOT include distance (that's already the primary sort).
function computeEntryScore(cascadeState, rvol) {
    const cascadeScore = cascadeState === 'bull' ? 2 : cascadeState === 'bear' ? -2 : 0;
    const rvolScore    = (rvol ?? 0) >= 2.0 ? 2 : (rvol ?? 0) >= 1.5 ? 1 : (rvol ?? 0) >= 1.2 ? 0.5 : 0;
    return +(cascadeScore + rvolScore).toFixed(1);
}

// Big Board cell color: above EMA = green, near = orange, below = red
function bigBoardColor(dist) {
    if (dist == null) return 'rgba(255,255,255,0.04)';
    if (dist >  2)  return 'rgba(104,211,145,0.25)';
    if (dist >  0)  return 'rgba(104,211,145,0.12)';
    if (dist > -0.5) return 'rgba(246,173,85,0.35)';  // near EMA ±0.5%
    if (dist > -2)  return 'rgba(252,129,129,0.12)';
    return 'rgba(252,129,129,0.28)';
}

const MAX_DISTS = [
    { label: '±1%',  value: 1 },
    { label: '±3%',  value: 3 },
    { label: '±5%',  value: 5 },
    { label: '±10%', value: 10 },
];

const LS_DIST_KEY = 'distanceTracker_prefs';

function loadDistPrefs(defaultMaxDist) {
    try {
        const s = JSON.parse(localStorage.getItem(LS_DIST_KEY));
        if (s && typeof s === 'object') return {
            maxDist: defaultMaxDist,
            sortKey: 'minAbsDist',
            sortDir: 'asc',
            ...s,
        };
    } catch {}
    return { maxDist: defaultMaxDist, sortKey: 'minAbsDist', sortDir: 'asc' };
}

// Audit fix #11: React.memo on row — avoids full table re-render when only sort
// state changes (rows array is already memoized; memo here guards against any
// accidental parent re-renders).
const DistRow = React.memo(function DistRow({ r, onCreateAlert }) {
    const setSelectedTicker = useTimeStore(s => s.setSelectedTicker);
    const scoreColor = r.entryScore >= 3 ? '#68d391' : r.entryScore >= 1 ? '#9ae6b4' : r.entryScore <= -2 ? '#fc8181' : '#718096';
    return (
        <tr className={`${r.anyStale ? styles.staleRow : ''} ${r.isSqueezed ? styles.squeezedRow : ''}`}>
            <td
                className={styles.tickerCell}
                onClick={() => setSelectedTicker(r.ticker)}
                style={{ cursor: 'pointer' }}
            >
                {r.cleanTicker}
                {r.isSqueezed && <span className={styles.squeezeBadge} title="2+ EMAs within 0.5% delta">SQUEEZE</span>}
            </td>
            <td className={styles.priceCell}>{smartFmt(r.price)}</td>
            <td>
                <span className={styles.tfCell}>{TF_LABELS[r.minTf]}</span>{' '}
                <span className={distClass(r.minAbsDist)}>
                    {r.minAbsDist < 0.01 ? '<0.01' : r.minAbsDist.toFixed(2)}%
                </span>
            </td>
            {TFS.map(tf => {
                const d = r.dists?.[tf];
                const src = r.sources?.[tf];
                if (d == null) {
                    return <td key={tf} className={styles.distEmpty}>—</td>;
                }
                const ema = r.emas?.[tf];
                const atr = r.atrs?.[tf];
                const canAlert = ema != null && r.price != null;
                return (
                    <td key={tf}
                        className={`${distClass(Math.abs(d))} ${styles.alertableCell}`}
                        title={canAlert
                            ? `Click to create smart alert · src: ${src || '—'}${atr ? ` · ATR ${atr.toFixed(2)}%` : ''}`
                            : (src ? `source: ${src}` : '')}
                        onClick={canAlert ? () => onCreateAlert({
                            ticker: r.ticker, cleanTicker: r.cleanTicker,
                            timeframe: tf, price: r.price, ema, atr, distancePct: d,
                        }) : undefined}
                        style={canAlert ? { cursor: 'pointer' } : undefined}
                    >
                        {src && (
                            <span className={styles.srcDot}
                                  style={{ background: SRC_COLOR[src] || '#718096' }} />
                        )}
                        {d > 0 ? '+' : ''}{d.toFixed(2)}%
                        {canAlert && <Bell size={9} className={styles.alertHint} />}
                    </td>
                );
            })}
            {/* ATR15 — 15m ATR% */}
            <td className={styles.atrCell} title="ATR at 15m timeframe (% of price)">
                {fmtAtr(r.atrs?.m15)}
            </td>
            {/* ATR60 — 1h ATR% */}
            <td className={styles.atrCell} title="ATR at 1h timeframe (% of price)">
                {fmtAtr(r.atrs?.h1)}
            </td>
            {/* Cascade alignment (h4 → h1 → 15m EMA stack) */}
            <td className={styles.cascadeCell}
                title={CASCADE_TITLE[r.cascadeState] || ''}>
                <span style={{ color: CASCADE_COLOR[r.cascadeState] || '#718096', fontWeight: 600, fontSize: 11 }}>
                    {CASCADE_LABEL[r.cascadeState] || '—'}
                </span>
            </td>
            {/* RVOL — 15m relative volume */}
            <td className={styles.rvolCell}
                title="15m relative volume (RVOL ≥1.5 = elevated institutional interest)">
                <span style={{ color: rvolColor(r.rvolM15), fontWeight: r.rvolM15 >= 1.5 ? 700 : 400 }}>
                    {fmtRvol(r.rvolM15)}
                </span>
            </td>
            {/* Entry quality score */}
            <td className={styles.scoreCell}
                title={`Entry quality score: cascade (${r.cascadeState}) + RVOL. Higher = stronger long setup; negative = avoid / short setup.`}>
                <span style={{ color: scoreColor, fontWeight: 700 }}>
                    {r.entryScore != null ? (r.entryScore > 0 ? '+' : '') + r.entryScore : '—'}
                </span>
            </td>
        </tr>
    );
});

// BigBoard: coins × TFs color-coded by EMA distance — spot alignment at a glance
const BIG_BOARD_TFS = ['m1', 'm5', 'm15', 'h1', 'h4'];

function BigBoard({ rows }) {
    if (!rows || rows.length === 0) return null;
    return (
        <div style={{ overflowX: 'auto', marginBottom: 4 }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 10, width: '100%', tableLayout: 'auto' }}>
                <thead>
                    <tr>
                        <th style={{ padding: '3px 6px', textAlign: 'left', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap', fontSize: 10 }}>
                            Coin
                        </th>
                        {BIG_BOARD_TFS.map(tf => (
                            <th key={tf} style={{ padding: '3px 6px', textAlign: 'center', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10 }}>
                                {TF_LABELS[tf]}
                            </th>
                        ))}
                        <th style={{ padding: '3px 6px', textAlign: 'center', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10 }}>Cascade</th>
                        <th style={{ padding: '3px 6px', textAlign: 'center', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10 }}>RVOL</th>
                        <th style={{ padding: '3px 6px', textAlign: 'center', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10 }}>Score</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(r => {
                        const scoreColor = r.entryScore >= 3 ? '#68d391' : r.entryScore >= 1 ? '#9ae6b4' : r.entryScore <= -2 ? '#fc8181' : '#718096';
                        return (
                            <tr key={r.ticker}>
                                <td style={{ padding: '2px 6px', color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap', fontSize: 10 }}>
                                    {r.cleanTicker}
                                </td>
                                {BIG_BOARD_TFS.map(tf => {
                                    const d = r.dists?.[tf];
                                    const bg = bigBoardColor(d);
                                    return (
                                        <td key={tf} style={{
                                            padding: '2px 5px',
                                            textAlign: 'center',
                                            background: bg,
                                            color: d == null ? 'var(--text-muted)' : d > 0 ? '#9ae6b4' : d < -2 ? '#fc8181' : '#f6ad55',
                                            fontWeight: 500,
                                            borderRadius: 2,
                                            minWidth: 40,
                                        }}>
                                            {d == null ? '—' : `${d > 0 ? '+' : ''}${d.toFixed(1)}%`}
                                        </td>
                                    );
                                })}
                                <td style={{ padding: '2px 5px', textAlign: 'center', color: CASCADE_COLOR[r.cascadeState] || '#718096', fontWeight: 600 }}>
                                    {CASCADE_LABEL[r.cascadeState] || '—'}
                                </td>
                                <td style={{ padding: '2px 5px', textAlign: 'center', color: rvolColor(r.rvolM15), fontWeight: r.rvolM15 >= 1.5 ? 700 : 400 }}>
                                    {fmtRvol(r.rvolM15)}
                                </td>
                                <td style={{ padding: '2px 5px', textAlign: 'center', color: scoreColor, fontWeight: 700 }}>
                                    {r.entryScore != null ? (r.entryScore > 0 ? '+' : '') + r.entryScore : '—'}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

export function DistanceTracker({ filterTicker, compact }) {
    const defaultMaxDist = compact ? 10 : 5;
    const [distPrefs, setDistPrefs] = useState(() => loadDistPrefs(defaultMaxDist));
    const { maxDist, sortKey, sortDir } = distPrefs;

    const updateDistPref = (key, val) => {
        setDistPrefs(prev => {
            const next = { ...prev, [key]: val };
            try { localStorage.setItem(LS_DIST_KEY, JSON.stringify(next)); } catch {}
            return next;
        });
    };
    const setMaxDist = (v) => updateDistPref('maxDist', v);
    const setSortKey = (v) => updateDistPref('sortKey', v);
    const setSortDir = (v) => updateDistPref('sortDir', v);

    const resetDist = () => {
        try { localStorage.removeItem(LS_DIST_KEY); } catch {}
        setDistPrefs({ maxDist: defaultMaxDist, sortKey: 'minAbsDist', sortDir: 'asc' });
    };

    // Big Board toggle
    const [bigBoardOpen, setBigBoardOpen] = useState(false);

    // Smart-alert modal state
    const [alertPrefill, setAlertPrefill] = useState(null);
    // useCallback: stable reference so React.memo on DistRow isn't defeated every render
    const handleCreateAlert = useCallback((prefill) => setAlertPrefill(prefill), []);
    const closeModal        = useCallback(() => setAlertPrefill(null), []);

    // Audit fix #4/#5/#6: ref-pattern poll
    const { data, loading, error, reload, reloadSilent, lastFetchedAt } = usePolledFetch(
        () => {
            const tParam = filterTicker ? `&ticker=${filterTicker}&max_dist=100` : `&max_dist=${maxDist}`;
            return `/api/ema-distance-board?limit=60${tParam}&active_min=60`;
        },
        { intervalMs: 300_000, deps: [maxDist, filterTicker] }
    );

    // Live socket updates — use reloadSilent so stale rows stay visible
    // during the background refresh instead of flashing a spinner.
    useEffect(() => {
        const socket = socketService.connect();

        // Debounce: batch updates from a single scan tick collapse to 1 fetch
        let timeout;
        const handler = () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => reloadSilent(), 1000);
        };

        socket.on('scan-update', handler);
        socket.on('smart-level-update', handler);
        socket.on('stream-d-update', handler);

        return () => {
            clearTimeout(timeout);
            socket.off('scan-update', handler);
            socket.off('smart-level-update', handler);
            socket.off('stream-d-update', handler);
        };
    }, [reloadSilent]);

    const handleSort = (key) => {
        if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        else { setSortKey(key); setSortDir('asc'); }
    };

    const rows = useMemo(() => {
        const board = data?.board || [];

        const enhancedBoard = board.map(r => {
            // Squeeze detection: all available EMA distances within ±0.5%
            const absDists = Object.values(r.dists || {}).filter(v => v != null).map(Math.abs);
            let isSqueezed = false;
            if (absDists.length >= 2) {
                const max = Math.max(...absDists);
                const min = Math.min(...absDists);
                if (max - min <= 0.5) isSqueezed = true;
            }
            // Cascade: use EMA prices derived from dists (checkCascade needs price values)
            // checkCascade accepts { tf: emaPrice } — reconstruct from dist%
            const emasPrices = {};
            for (const tf of LONG_SERIES) {
                const d = r.dists?.[tf];
                if (d != null && r.price) {
                    emasPrices[tf] = r.price / (1 + d / 100);
                }
            }
            const cascadeState = checkCascade(emasPrices, LONG_SERIES);
            const rvolM15      = r.rvolM15 ?? null;
            const entryScore   = computeEntryScore(cascadeState, rvolM15);
            return { ...r, isSqueezed, cascadeState, rvolM15, entryScore };
        });

        return enhancedBoard.sort((a, b) => {
            let av, bv;
            if (sortKey === 'minAbsDist') {
                av = a.minAbsDist; bv = b.minAbsDist;
            } else if (sortKey === 'atr15') {
                av = a.atrs?.m15 ?? Infinity; bv = b.atrs?.m15 ?? Infinity;
            } else if (sortKey === 'atr60') {
                av = a.atrs?.h1 ?? Infinity; bv = b.atrs?.h1 ?? Infinity;
            } else if (sortKey === 'entryScore') {
                // Higher score = better — always desc-first
                av = a.entryScore ?? -Infinity; bv = b.entryScore ?? -Infinity;
            } else if (sortKey === 'rvolM15') {
                av = a.rvolM15 ?? -Infinity; bv = b.rvolM15 ?? -Infinity;
            } else if (sortKey === 'cascadeState') {
                // Order: bull(2) → neutral(0) → bear(-2) when asc; invert when desc
                const CASC_ORDER = { bull: 2, neutral: 0, bear: -2 };
                av = CASC_ORDER[a.cascadeState] ?? 0; bv = CASC_ORDER[b.cascadeState] ?? 0;
            } else if (TFS.includes(sortKey)) {
                av = a.dists?.[sortKey] != null ? Math.abs(a.dists[sortKey]) : Infinity;
                bv = b.dists?.[sortKey] != null ? Math.abs(b.dists[sortKey]) : Infinity;
            } else {
                av = a.cleanTicker; bv = b.cleanTicker;
            }
            if (av < bv) return sortDir === 'asc' ? -1 : 1;
            if (av > bv) return sortDir === 'asc' ? 1 : -1;
            return 0;
        });
    }, [data, sortKey, sortDir]);

    return (
        <div className={styles.widget}>
            <div className={styles.header}>
                <div className={styles.titleRow}>
                    <div className="widget-title">
                        <span className={styles.titleIcon}><Ruler size={16} className="text-accent-blue" /></span>
                        <span className={styles.titleText}>DISTANCE TRACKER</span>
                        <span className={styles.titleSub}>200 EMA · 1m → 4h · sortable</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <FreshnessChip ts={lastFetchedAt} title="Board data last fetched from server" />
                        <ResetPrefsButton onReset={resetDist} title="Reset distance / sort to defaults" />
                        <button
                            className={`${styles.refreshBtn} ${bigBoardOpen ? styles.pillActive : ''}`}
                            onClick={() => setBigBoardOpen(v => !v)}
                            title={bigBoardOpen ? 'Hide Big Board heatmap' : 'Show Big Board — all TF distances as color grid'}
                            style={{ display: 'flex', alignItems: 'center', gap: 3 }}
                        >
                            {bigBoardOpen ? <List size={14} /> : <LayoutGrid size={14} />}
                        </button>
                        <button className={styles.refreshBtn} onClick={() => reload()} title="Refresh">
                            <RefreshCw size={14} />
                        </button>
                    </div>
                </div>
                <div className={styles.controlsRow}>
                    <div className={styles.controlGroup}>
                        <span className={styles.controlLabel}>Within</span>
                        {MAX_DISTS.map(m => (
                            <button key={m.value}
                                className={`${styles.pill} ${maxDist === m.value ? styles.pillActive : ''}`}
                                onClick={() => setMaxDist(m.value)}>
                                {m.label}
                            </button>
                        ))}
                    </div>
                    {data?.count != null && (
                        <span className={styles.controlLabel}>{data.count} coins</span>
                    )}
                    <button className={styles.resetBtn} onClick={resetDist} title="Reset filter and sort to defaults">
                        ↺ Reset
                    </button>
                </div>
            </div>

            {bigBoardOpen && rows.length > 0 && (
                <div className={styles.bigBoardPanel}>
                    <div className={styles.bigBoardTitle}>
                        <LayoutGrid size={12} style={{ marginRight: 4, verticalAlign: 'middle' }} />
                        Big Board — EMA distance heatmap (all TFs)
                    </div>
                    <BigBoard rows={rows} />
                </div>
            )}

            <div className={styles.tableWrap}>
                {loading && !data && (
                    <div className={styles.loading}>
                        <div className={styles.spinner} />
                        <div>Loading distance board…</div>
                    </div>
                )}
                {error && <div className={styles.errorState}><AlertTriangle size={14} /> {error}</div>}
                {!loading && !error && rows.length === 0 && (
                    <div className={styles.empty}>
                        No coins within ±{maxDist}% of a 200 EMA.
                    </div>
                )}
                {rows.length > 0 && (
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th onClick={() => handleSort('cleanTicker')}
                                    className={sortKey === 'cleanTicker' ? styles.sortActive : ''}>
                                    Coin
                                </th>
                                <th>Price</th>
                                <th onClick={() => handleSort('minAbsDist')}
                                    className={sortKey === 'minAbsDist' ? styles.sortActive : ''}
                                    title="% distance from the closest 200 EMA timeframe (positive = above EMA, negative = below)">
                                    Closest<br /><span className={styles.thSub}>vs EMA200</span>
                                </th>
                                {TFS.map(tf => (
                                    <th key={tf}
                                        onClick={() => handleSort(tf)}
                                        className={sortKey === tf ? styles.sortActive : ''}
                                        title={`% distance from ${TF_LABELS[tf]} 200 EMA (+ = above, − = below)`}>
                                        {TF_LABELS[tf]}<br /><span className={styles.thSub}>% vs EMA</span>
                                    </th>
                                ))}
                                <th onClick={() => handleSort('atr15')}
                                    className={`${styles.atrHeader} ${sortKey === 'atr15' ? styles.sortActive : ''}`}
                                    title="15m ATR as % of price — use to calibrate Smart Alert multiplier">
                                    A15<br /><span className={styles.thSub}>ATR%</span>
                                </th>
                                <th onClick={() => handleSort('atr60')}
                                    className={`${styles.atrHeader} ${sortKey === 'atr60' ? styles.sortActive : ''}`}
                                    title="1h ATR as % of price — use to calibrate Smart Alert multiplier">
                                    A60<br /><span className={styles.thSub}>ATR%</span>
                                </th>
                                <th onClick={() => handleSort('cascadeState')}
                                    className={sortKey === 'cascadeState' ? styles.sortActive : ''}
                                    title="EMA cascade alignment: Bull = h4 EMA < h1 EMA < 15m EMA (uptrend stacking). Bear = opposite. Click to sort.">
                                    Cascade<br /><span className={styles.thSub}>h4→h1→15m</span>
                                </th>
                                <th onClick={() => handleSort('rvolM15')}
                                    className={sortKey === 'rvolM15' ? styles.sortActive : ''}
                                    title="15m Relative Volume — ≥1.5× signals elevated institutional interest near the EMA level">
                                    RVOL<br /><span className={styles.thSub}>15m×</span>
                                </th>
                                <th onClick={() => handleSort('entryScore')}
                                    className={sortKey === 'entryScore' ? styles.sortActive : ''}
                                    title="Entry Quality Score: Cascade alignment + RVOL. Higher = stronger setup. Negative = avoid or short.">
                                    Score<br /><span className={styles.thSub}>quality</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(r => <DistRow key={r.ticker} r={r} onCreateAlert={handleCreateAlert} />)}
                        </tbody>
                    </table>
                )}
            </div>

            {alertPrefill && (
                <Suspense fallback={null}>
                    <SmartAlertCreateModal
                        open={!!alertPrefill}
                        prefill={alertPrefill}
                        onClose={closeModal}
                        onCreated={() => { /* badge auto-updates via socket */ }}
                    />
                </Suspense>
            )}
        </div>
    );
}

export default DistanceTracker;
