import React, { useState, useMemo } from 'react';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import styles from './DistanceTracker.module.css';

const TFS = ['m1', 'm5', 'm15', 'h1', 'h4'];
const TF_LABELS = { m1: '1m', m5: '5m', m15: '15m', h1: '1h', h4: '4h' };

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

const MAX_DISTS = [
    { label: '±1%',  value: 1 },
    { label: '±3%',  value: 3 },
    { label: '±5%',  value: 5 },
    { label: '±10%', value: 10 },
];

// Audit fix #11: React.memo on row — avoids full table re-render when only sort
// state changes (rows array is already memoized; memo here guards against any
// accidental parent re-renders).
const DistRow = React.memo(function DistRow({ r }) {
    return (
        <tr key={r.ticker} className={r.anyStale ? styles.staleRow : ''}>
            <td className={styles.tickerCell}>{r.cleanTicker}</td>
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
                return (
                    <td key={tf} className={distClass(Math.abs(d))}
                        title={src ? `source: ${src}` : ''}>
                        {src && (
                            <span className={styles.srcDot}
                                  style={{ background: SRC_COLOR[src] || '#718096' }} />
                        )}
                        {d > 0 ? '+' : ''}{d.toFixed(2)}%
                    </td>
                );
            })}
        </tr>
    );
});

export function DistanceTracker() {
    const [maxDist, setMaxDist] = useState(5);
    const [sortKey, setSortKey] = useState('minAbsDist');
    const [sortDir, setSortDir] = useState('asc');

    // Audit fix #4/#5/#6: ref-pattern poll, AbortController, tab-visibility pause.
    const { data, loading, error, reload } = usePolledFetch(
        () => `/api/ema-distance-board?limit=60&max_dist=${maxDist}&active_min=60`,
        { intervalMs: 60_000, deps: [maxDist] }
    );

    const handleSort = (key) => {
        if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        else { setSortKey(key); setSortDir('asc'); }
    };

    const rows = useMemo(() => {
        const board = data?.board || [];
        return [...board].sort((a, b) => {
            let av, bv;
            if (sortKey === 'minAbsDist') {
                av = a.minAbsDist; bv = b.minAbsDist;
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
                    <div className={styles.title}>
                        <span className={styles.titleIcon}>📐</span>
                        <span className={styles.titleText}>DISTANCE TRACKER</span>
                        <span className={styles.titleSub}>200 EMA · 1m → 4h · sortable</span>
                    </div>
                    <button className={styles.refreshBtn} onClick={() => reload()} title="Refresh">↺</button>
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
                    <div className={styles.controlGroup} style={{ marginLeft: 'auto' }}>
                        <span className={styles.controlLabel}>
                            {data?.count != null ? `${data.count} coins` : ''}
                        </span>
                    </div>
                </div>
            </div>

            <div className={styles.tableWrap}>
                {loading && !data && (
                    <div className={styles.loading}>
                        <div className={styles.spinner} />
                        <div>Loading distance board…</div>
                    </div>
                )}
                {error && <div className={styles.errorState}>⚠ {error}</div>}
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
                                    title="Closest TF distance">
                                    Closest
                                </th>
                                {TFS.map(tf => (
                                    <th key={tf}
                                        onClick={() => handleSort(tf)}
                                        className={sortKey === tf ? styles.sortActive : ''}>
                                        {TF_LABELS[tf]}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map(r => <DistRow key={r.ticker} r={r} />)}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );
}

export default DistanceTracker;
