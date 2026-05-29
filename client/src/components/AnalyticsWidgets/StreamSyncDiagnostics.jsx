import React, { useState, useMemo, useEffect, useRef } from 'react';
import styles from './StreamSyncDiagnostics.module.css';
import { FreshnessChip } from '../FreshnessChip';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import { useTimeStore } from '../../store/useTimeStore';
import { GitCompareArrows, RefreshCw, AlertTriangle, CheckCircle, CircleSlash, Clock } from 'lucide-react';

/* ───────────── Constants ───────────── */

const WINDOWS = [
    { label: '1h', value: 60 },
    { label: '2h', value: 120 },
    { label: '4h', value: 240 },
    { label: '8h', value: 480 },
];
const TOLERANCES = [
    { label: '±2m', value: 2 },
    { label: '±5m', value: 5 },
    { label: '±10m', value: 10 },
];

const STATUS_META = {
    SYNCED:   { label: 'Synced',   color: '#48bb78', cls: 'cellSynced',   icon: CheckCircle },
    DIVERGED: { label: 'Diverged', color: '#f6ad55', cls: 'cellDiverged', icon: AlertTriangle },
    EMPTY_B:  { label: 'Empty B',  color: '#fc8181', cls: 'cellEmpty',    icon: CircleSlash },
    STALE:    { label: 'Stale',    color: '#718096', cls: 'cellStale',    icon: Clock },
};

const LS_KEY = 'streamSync_prefs';
const DEFAULTS = { windowMin: 120, toleranceMin: 5 };

function loadPrefs() {
    try {
        const s = JSON.parse(localStorage.getItem(LS_KEY));
        return s && typeof s === 'object' ? { ...DEFAULTS, ...s } : { ...DEFAULTS };
    } catch { return { ...DEFAULTS }; }
}

function fmtTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtTimeSec(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtOffset(sec) {
    if (sec == null) return '—';
    const a = Math.abs(sec);
    const m = Math.floor(a / 60), s = a % 60;
    const sign = sec < 0 ? '−' : '+';
    return m > 0 ? `${sign}${m}m ${s}s` : `${sign}${s}s`;
}

/* ───────────── Coin chip ───────────── */

function CoinDot({ present }) {
    return (
        <span
            className={`${styles.coinDot} ${present ? styles.dotOn : styles.dotOff}`}
            title={present ? 'present' : 'absent'}
        />
    );
}

/* ───────────── Main Widget ───────────── */

export function StreamSyncDiagnostics() {
    const containerRef = useRef(null);
    const lastDataPush = useTimeStore(s => s.lastDataPush);

    const [prefs, setPrefs] = useState(loadPrefs);
    const { windowMin, toleranceMin } = prefs;
    const [selectedId, setSelectedId] = useState(null);
    const [showOnlyIssues, setShowOnlyIssues] = useState(false);

    const updatePref = (key, val) => {
        setPrefs(prev => {
            const next = { ...prev, [key]: val };
            try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {}
            return next;
        });
    };

    const { data, loading, error, reload, reloadSilent, lastFetchedAt } = usePolledFetch(
        () => `/api/stream-sync?window_min=${windowMin}&tolerance_min=${toleranceMin}`,
        { intervalMs: 60_000, deps: [windowMin, toleranceMin] }
    );
    useDataInvalidation(containerRef, reloadSilent, lastDataPush);

    const cycles = data?.cycles || [];
    const summary = data?.summary || { synced: 0, diverged: 0, emptyB: 0, stale: 0 };
    const events = data?.events || [];

    // Ribbon is oldest→newest (left→right); API returns newest-first.
    const ribbon = useMemo(() => [...cycles].reverse(), [cycles]);

    // Auto-select most recent cycle (or first issue) when data loads / changes.
    useEffect(() => {
        if (!cycles.length) { setSelectedId(null); return; }
        const stillExists = cycles.some(c => c.cycleId === selectedId);
        if (!stillExists) setSelectedId(cycles[0].cycleId);
    }, [cycles, selectedId]);

    const selected = useMemo(
        () => cycles.find(c => c.cycleId === selectedId) || null,
        [cycles, selectedId]
    );

    // Per-coin rows for the selected cycle — divergent coins float to top.
    const coinRows = useMemo(() => {
        if (!selected) return [];
        const aSet = new Set(selected.aCoins || []);
        const dSet = new Set(selected.dCoins || []);
        const rows = (selected.bCoins || []).map(ticker => {
            const inA = aSet.has(ticker), inD = dSet.has(ticker);
            let rank;
            if (!inA && !inD)      rank = 0; // in neither — worst
            else if (inA !== inD)  rank = 1; // diverged
            else                   rank = 2; // both present
            return { ticker, inA, inD, rank };
        });
        rows.sort((a, b) => a.rank - b.rank || a.ticker.localeCompare(b.ticker));
        return rows;
    }, [selected]);

    const visibleCoinRows = useMemo(
        () => showOnlyIssues ? coinRows.filter(r => r.rank < 2) : coinRows,
        [coinRows, showOnlyIssues]
    );

    return (
        <div ref={containerRef} className={styles.widget}>
            {/* ── Header ── */}
            <div className={styles.header}>
                <div className={styles.titleRow}>
                    <div className="widget-title">
                        <span className={styles.titleIcon}><GitCompareArrows size={16} /></span>
                        <span>STREAM SYNC DIAGNOSTICS</span>
                        <span className={styles.titleSub}>B → A · D cycle alignment</span>
                    </div>
                    <div className={styles.headerControls}>
                        <FreshnessChip ts={lastFetchedAt} title="Diagnostics last fetched" />
                        <button className={styles.iconBtn} onClick={() => reload()} title="Refresh">
                            <RefreshCw size={14} />
                        </button>
                    </div>
                </div>

                <div className={styles.controlsRow}>
                    <div className={styles.controlGroup}>
                        <span className={styles.controlLabel}>Window</span>
                        {WINDOWS.map(w => (
                            <button key={w.value}
                                className={`${styles.pill} ${windowMin === w.value ? styles.pillActive : ''}`}
                                onClick={() => updatePref('windowMin', w.value)}>
                                {w.label}
                            </button>
                        ))}
                    </div>
                    <div className={styles.controlGroup}>
                        <span className={styles.controlLabel}>Tolerance</span>
                        {TOLERANCES.map(t => (
                            <button key={t.value}
                                className={`${styles.pill} ${toleranceMin === t.value ? styles.pillActive : ''}`}
                                onClick={() => updatePref('toleranceMin', t.value)}
                                title="Time window for matching A/D data to each B publish">
                                {t.label}
                            </button>
                        ))}
                    </div>

                    {/* Summary chips */}
                    <div className={styles.summaryChips}>
                        <span className={`${styles.sumChip} ${styles.sumSynced}`}>{summary.synced} synced</span>
                        <span className={`${styles.sumChip} ${styles.sumDiverged}`}>{summary.diverged} diverged</span>
                        {summary.emptyB > 0 && <span className={`${styles.sumChip} ${styles.sumEmpty}`}>{summary.emptyB} empty</span>}
                        {summary.stale  > 0 && <span className={`${styles.sumChip} ${styles.sumStale}`}>{summary.stale} stale</span>}
                    </div>
                </div>
            </div>

            {/* ── Body ── */}
            <div className={styles.body}>
                {loading && !data && (
                    <div className={styles.loadingState}><div className={styles.spinner} />Loading cycles…</div>
                )}
                {error && <div className={styles.errorState}>⚠ {error}</div>}
                {!loading && !error && cycles.length === 0 && (
                    <div className={styles.emptyState}>No Stream B cycles in the last {windowMin}m.</div>
                )}

                {cycles.length > 0 && (
                    <>
                        {/* ── Legend ── */}
                        <div className={styles.legendRow}>
                            {Object.entries(STATUS_META).map(([k, m]) => (
                                <span key={k} className={styles.legendItem}>
                                    <span className={styles.legendSwatch} style={{ background: m.color }} />
                                    {m.label}
                                </span>
                            ))}
                            <span className={styles.legendHint}>oldest → newest · click a cell to inspect</span>
                        </div>

                        {/* ── Cycle ribbon ── */}
                        <div className={styles.ribbon}>
                            {ribbon.map(c => {
                                const m = STATUS_META[c.status] || STATUS_META.STALE;
                                const isSel = c.cycleId === selectedId;
                                const divCount = (c.inAnotD?.length || 0) + (c.inDnotA?.length || 0) + (c.inNeither?.length || 0);
                                return (
                                    <button
                                        key={c.cycleId}
                                        className={`${styles.cell} ${styles[m.cls]} ${isSel ? styles.cellSelected : ''}`}
                                        onClick={() => setSelectedId(c.cycleId)}
                                        title={`${fmtTimeSec(c.ts)} · ${m.label}\nB:${c.bCount}  A:${c.aCount}  D:${c.dCount}${divCount ? `\n${divCount} divergent` : ''}`}
                                    >
                                        <span className={styles.cellTime}>{fmtTime(c.ts)}</span>
                                        <span className={styles.cellCount}>{c.bCount}</span>
                                        {divCount > 0 && c.status === 'DIVERGED' && (
                                            <span className={styles.cellBadge}>{divCount}</span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>

                        {/* ── Selected cycle detail ── */}
                        {selected && (
                            <div className={styles.detail}>
                                {/* Lane / timing diagram */}
                                <div className={styles.lanes}>
                                    <div className={styles.lane}>
                                        <span className={`${styles.laneTag} ${styles.tagB}`}>B</span>
                                        <span className={styles.laneTime}>{fmtTimeSec(selected.ts)}</span>
                                        <span className={styles.laneMeta}>{selected.bCount} coins (reference list)</span>
                                    </div>
                                    <div className={styles.lane}>
                                        <span className={`${styles.laneTag} ${styles.tagA}`}>A</span>
                                        <span className={styles.laneTime}>{selected.aHas ? fmtTimeSec(selected.aTs) : 'no scan'}</span>
                                        <span className={styles.laneMeta}>
                                            {selected.aHas
                                                ? <>{selected.aCount} coins · offset {fmtOffset(selected.aOffsetSec)}</>
                                                : <span className={styles.laneStale}>no Stream A scan within ±{toleranceMin}m</span>}
                                        </span>
                                    </div>
                                    <div className={styles.lane}>
                                        <span className={`${styles.laneTag} ${styles.tagD}`}>D</span>
                                        <span className={styles.laneTime}>{selected.dHas ? `${selected.dBucketCount} buckets` : 'no data'}</span>
                                        <span className={styles.laneMeta}>
                                            {selected.dHas
                                                ? <>{selected.dCount} coins within ±{toleranceMin}m</>
                                                : <span className={styles.laneStale}>no Stream D metrics within ±{toleranceMin}m</span>}
                                        </span>
                                    </div>
                                </div>

                                {/* Divergence summary */}
                                <div className={styles.divSummary}>
                                    <DivGroup label="In A, not D" coins={selected.inAnotD} tone="warnA" />
                                    <DivGroup label="In D, not A" coins={selected.inDnotA} tone="warnD" />
                                    <DivGroup label="In neither" coins={selected.inNeither} tone="bad" />
                                    <DivGroup label="Orphan in A (not B)" coins={selected.extraInA} tone="muted" />
                                    <DivGroup label="Orphan in D (not B)" coins={selected.extraInD} tone="muted" />
                                </div>

                                {/* Per-coin matrix */}
                                <div className={styles.matrixHeader}>
                                    <span className={styles.matrixTitle}>
                                        B-list coverage ({coinRows.length})
                                    </span>
                                    <label className={styles.issuesToggle}>
                                        <input
                                            type="checkbox"
                                            checked={showOnlyIssues}
                                            onChange={e => setShowOnlyIssues(e.target.checked)}
                                        />
                                        only issues
                                    </label>
                                    <span className={styles.matrixCols}><span>A</span><span>D</span></span>
                                </div>
                                <div className={styles.matrix}>
                                    {visibleCoinRows.length === 0 && (
                                        <div className={styles.matrixEmpty}>
                                            {showOnlyIssues ? 'No divergent coins — fully in sync ✓' : 'No coins in this cycle.'}
                                        </div>
                                    )}
                                    {visibleCoinRows.map(r => (
                                        <div key={r.ticker}
                                            className={`${styles.coinRow} ${r.rank === 0 ? styles.rowBad : r.rank === 1 ? styles.rowWarn : ''}`}>
                                            <span className={styles.coinName}>{r.ticker}</span>
                                            <span className={styles.coinDots}>
                                                <CoinDot present={r.inA} />
                                                <CoinDot present={r.inD} />
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* ── Event log ── */}
                        {events.length > 0 && (
                            <details className={styles.eventLog}>
                                <summary className={styles.eventSummary}>
                                    Event log · {events.length} marker{events.length > 1 ? 's' : ''}
                                </summary>
                                <div className={styles.eventList}>
                                    {events.map((e, i) => (
                                        <div key={i} className={styles.eventRow}>
                                            <span className={styles.eventTime}>{fmtTimeSec(e.ts)}</span>
                                            <span className={`${styles.eventType} ${styles.evEMPTY_B}`}>{e.type}</span>
                                            <span className={styles.eventMsg}>{e.message}</span>
                                        </div>
                                    ))}
                                </div>
                            </details>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}

/* ───────────── Divergence group chip-row ───────────── */

function DivGroup({ label, coins, tone }) {
    const toneCls = {
        warnA: styles.divWarnA, warnD: styles.divWarnD,
        bad: styles.divBad, muted: styles.divMuted,
    }[tone] || '';
    const n = coins?.length || 0;
    return (
        <div className={`${styles.divGroup} ${n === 0 ? styles.divEmpty : ''}`}>
            <span className={`${styles.divLabel} ${toneCls}`}>{label}</span>
            <span className={styles.divCount}>{n}</span>
            {n > 0 && (
                <span className={styles.divCoins}>
                    {coins.slice(0, 12).map(c => <span key={c} className={styles.divChip}>{c}</span>)}
                    {n > 12 && <span className={styles.divMore}>+{n - 12}</span>}
                </span>
            )}
        </div>
    );
}

export default StreamSyncDiagnostics;
