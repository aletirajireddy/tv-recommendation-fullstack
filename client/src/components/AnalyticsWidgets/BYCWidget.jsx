import React, { useState, useCallback, useRef, useEffect, useMemo, memo } from 'react';
import {
    Filter, Play, Save, ChevronDown, ChevronUp, Plus, X,
    Bookmark, BarChart2, List, TrendingUp, Trash2, RefreshCw, Radio,
} from 'lucide-react';
import styles from './BYCWidget.module.css';
import socketService from '../../services/SocketService';

const POLL_MS    = 60_000; // auto-poll every 60s (socket handles sub-minute freshness)
const THROTTLE_MS = 15_000; // minimum gap between any two auto-runs

// ─── Field & Operator definitions ────────────────────────────────────────────

const FIELDS = [
    // RSI
    { id: 'rsi_m5',   label: 'RSI 5m',       group: 'RSI',       step: 1,   defaultVal: 30  },
    { id: 'rsi_m15',  label: 'RSI 15m',      group: 'RSI',       step: 1,   defaultVal: 30  },
    { id: 'rsi_m30',  label: 'RSI 30m',      group: 'RSI',       step: 1,   defaultVal: 40  },
    { id: 'rsi_h1',   label: 'RSI 1h',       group: 'RSI',       step: 1,   defaultVal: 40  },
    // RVOL
    { id: 'rvol_m15', label: 'RVOL 15m',     group: 'RVOL',      step: 0.1, defaultVal: 1.5 },
    { id: 'rvol_h1',  label: 'RVOL 1h',      group: 'RVOL',      step: 0.1, defaultVal: 1.5 },
    // ATR%
    { id: 'atr_m15',  label: 'ATR% 15m',     group: 'ATR%',      step: 0.1, defaultVal: 1   },
    { id: 'atr_h1',   label: 'ATR% 1h',      group: 'ATR%',      step: 0.1, defaultVal: 1   },
    { id: 'atr_h4',   label: 'ATR% 4h',      group: 'ATR%',      step: 0.1, defaultVal: 1   },
    // EMA200 distance %
    { id: 'dist_m1',  label: 'EMA Dist 1m',  group: 'EMA Dist%', step: 0.1, defaultVal: 0   },
    { id: 'dist_m5',  label: 'EMA Dist 5m',  group: 'EMA Dist%', step: 0.1, defaultVal: 0   },
    { id: 'dist_m15', label: 'EMA Dist 15m', group: 'EMA Dist%', step: 0.1, defaultVal: 0   },
    { id: 'dist_h1',  label: 'EMA Dist 1h',  group: 'EMA Dist%', step: 0.1, defaultVal: 0   },
    { id: 'dist_h4',  label: 'EMA Dist 4h',  group: 'EMA Dist%', step: 0.1, defaultVal: 0   },
    // Market
    { id: 'change_pct', label: 'Change %',   group: 'Market',    step: 0.1, defaultVal: 0   },
    { id: 'volume',     label: 'Volume $',   group: 'Market',    step: 1e5, defaultVal: 1e6  },
    { id: 'price',      label: 'Price',      group: 'Market',    step: 1,   defaultVal: 100  },
];

const OPS_NUMERIC = [
    { value: '>',  label: '> above'   },
    { value: '<',  label: '< below'   },
    { value: '>=', label: '≥ at least'},
    { value: '<=', label: '≤ at most' },
    { value: '=',  label: '= equals'  },
];
const OPS_EMA = [
    ...OPS_NUMERIC,
    { value: 'above_ema', label: '▲ above EMA'  },
    { value: 'below_ema', label: '▼ below EMA'  },
    { value: 'at_ema',    label: '≈ at EMA ±%' },
];
const getOps = (fieldId) =>
    fieldId.startsWith('dist_') ? OPS_EMA : OPS_NUMERIC;

// ─── Built-in presets ─────────────────────────────────────────────────────────

const BUILTIN_PRESETS = [
    {
        id: 'rsi_os_cascade',
        name: 'RSI Oversold Cascade',
        icon: '📉',
        mode: 'AND',
        clauses: [
            { field: 'rsi_m15', op: '<', value: 30 },
            { field: 'rsi_h1',  op: '<', value: 40 },
        ],
    },
    {
        id: 'rsi_ob_cascade',
        name: 'RSI Overbought Cascade',
        icon: '📈',
        mode: 'AND',
        clauses: [
            { field: 'rsi_m15', op: '>', value: 70 },
            { field: 'rsi_h1',  op: '>', value: 60 },
        ],
    },
    {
        id: 'high_rvol',
        name: 'High RVOL Momentum',
        icon: '⚡',
        mode: 'AND',
        clauses: [
            { field: 'rvol_m15',   op: '>',  value: 1.5 },
            { field: 'change_pct', op: '>',  value: 1   },
        ],
    },
    {
        id: 'bull_pullback',
        name: 'Bull EMA Pullback',
        icon: '🎯',
        mode: 'AND',
        clauses: [
            { field: 'dist_h1',  op: '>',  value: 0   },
            { field: 'dist_m15', op: '>',  value: -1  },
            { field: 'dist_m15', op: '<=', value: 0.5 },
        ],
    },
    {
        id: 'surge',
        name: 'Momentum Surge',
        icon: '🚀',
        mode: 'AND',
        clauses: [
            { field: 'rvol_m15',   op: '>', value: 2 },
            { field: 'change_pct', op: '>', value: 3 },
            { field: 'dist_m15',   op: 'above_ema', value: 0 },
        ],
    },
    {
        id: 'ema_any_os',
        name: 'Multi-TF Oversold OR',
        icon: '🔍',
        mode: 'OR',
        clauses: [
            { field: 'rsi_m15', op: '<', value: 30 },
            { field: 'rsi_m30', op: '<', value: 30 },
            { field: 'rsi_h1',  op: '<', value: 35 },
        ],
    },
];

// ─── Persistence ─────────────────────────────────────────────────────────────

const LS_ACTIVE = 'byc_active';
const LS_PRESETS = 'byc_user_presets';

const loadActive = () => {
    try { const s = JSON.parse(localStorage.getItem(LS_ACTIVE)); return s || null; } catch { return null; }
};
const loadUserPresets = () => {
    try { return JSON.parse(localStorage.getItem(LS_PRESETS)) || []; } catch { return []; }
};
const saveActive = (clauses, mode) => {
    try { localStorage.setItem(LS_ACTIVE, JSON.stringify({ clauses, mode })); } catch {}
};
const saveUserPresets = (presets) => {
    try { localStorage.setItem(LS_PRESETS, JSON.stringify(presets)); } catch {}
};

// ─── Sub-components ───────────────────────────────────────────────────────────

// ─── Memoised sub-components — only re-render when their own props change ─────

// Mini RSI candle: body = h1 (series1) to m30 (series2), white line = m15 (temp)
const MiniRsiCandle = memo(function MiniRsiCandle({ rsi, oversold = 30, overbought = 70 }) {
    const W = 36, H = 76;
    const y = (v) => v != null ? H - (v / 100) * H : null;
    const yOS = H - (oversold  / 100) * H;
    const yOB = H - (overbought / 100) * H;
    const s1y = y(rsi?.h1);
    const s2y = y(rsi?.m30);
    const ty  = y(rsi?.m15);

    const hasBody = s1y != null && s2y != null;
    const bodyTop = hasBody ? Math.min(s1y, s2y) : 0;
    const bodyBot = hasBody ? Math.max(s1y, s2y) : H;
    const allOS  = (rsi?.h1 ?? 50) < oversold  && (rsi?.m30 ?? 50) < oversold;
    const allOB  = (rsi?.h1 ?? 50) > overbought && (rsi?.m30 ?? 50) > overbought;
    const bodyFill = allOS ? '#ef4444' : allOB ? '#22c55e' : 'rgba(255,255,255,0.18)';

    // m15 direction vs m30
    const dir = (ty != null && s2y != null)
        ? (rsi.m15 > (rsi.m30 ?? 50) ? 'up' : rsi.m15 < (rsi.m30 ?? 50) ? 'down' : 'flat')
        : 'flat';

    return (
        <svg width={W} height={H} style={{ display: 'block', flexShrink: 0 }}>
            {/* Zone bands */}
            <rect x={0} y={0}    width={W} height={yOB}      fill="rgba(34,197,94,0.05)" />
            <rect x={0} y={yOS}  width={W} height={H - yOS}  fill="rgba(239,68,68,0.05)" />
            {/* Zone lines */}
            <line x1={0} y1={yOB} x2={W} y2={yOB} stroke="rgba(34,197,94,0.25)"  strokeWidth={0.5} strokeDasharray="2,2" />
            <line x1={0} y1={yOS} x2={W} y2={yOS} stroke="rgba(239,68,68,0.25)"  strokeWidth={0.5} strokeDasharray="2,2" />
            <line x1={0} y1={H/2} x2={W} y2={H/2} stroke="rgba(255,255,255,0.07)" strokeWidth={0.5} />
            {/* Body */}
            {hasBody && (
                <rect x={8} y={bodyTop} width={W - 16} height={Math.max(2, bodyBot - bodyTop)}
                      fill={bodyFill} rx={1} />
            )}
            {/* m15 line */}
            {ty != null && (
                <line x1={2} y1={ty} x2={W - 2} y2={ty}
                      stroke="rgba(255,255,255,0.9)" strokeWidth={1.5} />
            )}
            {/* Direction triangle */}
            {ty != null && dir === 'up' && (
                <polygon points={`${W-1},${ty} ${W-5},${ty+4} ${W-5},${ty-4}`}
                         fill="rgba(255,255,255,0.8)" />
            )}
            {ty != null && dir === 'down' && (
                <polygon points={`${W-1},${ty} ${W-5},${ty-4} ${W-5},${ty+4}`}
                         fill="rgba(255,255,255,0.8)" />
            )}
        </svg>
    );
});

// EMA dist bars: five TFs, centered track, green=above/red=below
const EmaDistBars = memo(function EmaDistBars({ dist, compact = false }) {
    const TFS = [
        { id: 'm1',  label: '1m' },
        { id: 'm5',  label: '5m' },
        { id: 'm15', label: '15m' },
        { id: 'h1',  label: '1h' },
        { id: 'h4',  label: '4h' },
    ];
    return (
        <div className={compact ? styles.emaBarsCompact : styles.emaBars}>
            {TFS.map(({ id, label }) => {
                const v = dist?.[id];
                const clamped = v != null ? Math.max(-10, Math.min(10, v)) : null;
                const isPos = clamped > 0, isNeg = clamped < 0;
                const barW = clamped != null ? Math.abs(clamped) * 5 : 0; // 5% per unit
                const color = isPos ? 'var(--accent-green)' : isNeg ? 'var(--accent-red)' : 'rgba(255,255,255,0.2)';
                return (
                    <div key={id} className={styles.emaBarRow}>
                        <span className={styles.emaBarLabel}>{label}</span>
                        <div className={styles.emaBarTrack}>
                            <div className={styles.emaBarCenter} />
                            {clamped != null && (
                                <div
                                    className={styles.emaBarFill}
                                    style={{
                                        width: `${barW}%`,
                                        background: color,
                                        left: isPos ? '50%' : 'auto',
                                        right: isNeg ? '50%' : 'auto',
                                    }}
                                />
                            )}
                        </div>
                        <span className={styles.emaBarVal} style={{ color: v != null ? color : 'var(--text-muted)' }}>
                            {v != null ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—'}
                        </span>
                    </div>
                );
            })}
        </div>
    );
});

// Inline metric grid for the coin detail panel
const MetricsGrid = memo(function MetricsGrid({ coin }) {
    const rows = [
        ['Price',     coin.price != null ? `$${coin.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : '—', null],
        ['Change',    coin.change_pct != null ? `${coin.change_pct > 0 ? '+' : ''}${coin.change_pct.toFixed(2)}%` : '—',
                      coin.change_pct > 0 ? 'var(--accent-green)' : coin.change_pct < 0 ? 'var(--accent-red)' : null],
        ['Volume',    fmtVol(coin.volume), null],
        ['RVOL 15m',  coin.rvol?.m15 != null ? coin.rvol.m15.toFixed(2) + 'x' : '—',
                      (coin.rvol?.m15 ?? 0) > 1.5 ? 'var(--accent-orange)' : null],
        ['RVOL 1h',   coin.rvol?.h1  != null ? coin.rvol.h1.toFixed(2)  + 'x' : '—', null],
        ['ATR% 15m',  coin.atr?.m15  != null ? coin.atr.m15.toFixed(2) + '%' : '—', null],
        ['ATR% 1h',   coin.atr?.h1   != null ? coin.atr.h1.toFixed(2)  + '%' : '—', null],
        ['ATR% 4h',   coin.atr?.h4   != null ? coin.atr.h4.toFixed(2)  + '%' : '—', null],
        ['Source',    coin.src, null],
    ];
    return (
        <div className={styles.metricsGrid}>
            {rows.map(([label, val, color]) => (
                <React.Fragment key={label}>
                    <span className={styles.metricLabel}>{label}</span>
                    <span className={styles.metricVal} style={color ? { color } : undefined}>{val}</span>
                </React.Fragment>
            ))}
        </div>
    );
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtVol(v) {
    if (v == null) return '—';
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(0);
}

function rsiColor(v) {
    if (v == null) return 'var(--text-muted)';
    if (v < 30) return '#ef4444';
    if (v > 70) return '#22c55e';
    return 'var(--text-muted)';
}

function chgColor(v) {
    if (v == null) return 'var(--text-muted)';
    return v > 0 ? 'var(--accent-green)' : v < 0 ? 'var(--accent-red)' : 'var(--text-muted)';
}

// ─── Main Widget ──────────────────────────────────────────────────────────────

export function BYCWidget() {
    // ── State — lazy initialisers so localStorage is read ONCE, not every render
    const [expanded,     setExpanded]     = useState(true);
    const [clauses,      setClauses]      = useState(() => loadActive()?.clauses || []);
    const [mode,         setMode]         = useState(() => loadActive()?.mode    || 'AND');
    const [viewMode,     setViewMode]     = useState('list');
    const [expandedCoin, setExpandedCoin] = useState(null);
    const [autoRun,      setAutoRun]      = useState(true);

    const [showPresets,    setShowPresets]    = useState(false);
    const [showSaveDialog, setShowSaveDialog] = useState(false);
    const [saveName,       setSaveName]       = useState('');
    const [userPresets,    setUserPresets]    = useState(loadUserPresets);

    const [data,    setData]    = useState(null);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState(null);
    const [lastRun, setLastRun] = useState(null);

    // ── Refs — updated inline in setters (no useEffect overhead)
    const presetsRef   = useRef(null);
    const pollRef      = useRef(null);        // setInterval handle
    const debounceRef  = useRef(null);        // scheduleAutoRun debounce
    const clausesRef   = useRef(clauses);
    const modeRef      = useRef(mode);
    const autoRunRef   = useRef(autoRun);
    const loadingRef   = useRef(false);       // prevents concurrent runs
    const lastRunMsRef = useRef(0);           // throttle: tracks last run timestamp

    // Close presets dropdown on outside click
    useEffect(() => {
        if (!showPresets) return;
        const handler = (e) => {
            if (presetsRef.current && !presetsRef.current.contains(e.target)) setShowPresets(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showPresets]);

    // Persist active query whenever clauses/mode change
    const persist = (c, m) => saveActive(c, m);

    // ── Query runner — stable, reads live values via refs ──
    const runQuery = useCallback(async (overrideClauses, overrideMode) => {
        const c = overrideClauses ?? clausesRef.current;
        const m = overrideMode   ?? modeRef.current;
        if (!c || c.length === 0) return;
        if (loadingRef.current) return;          // prevent concurrent runs
        loadingRef.current = true;
        lastRunMsRef.current = Date.now();
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams({ clauses: JSON.stringify(c), mode: m });
            const res = await fetch(`/api/byc-screener?${params}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const payload = await res.json();
            // Skip re-render if data hasn't changed
            setData(prev => JSON.stringify(prev) === JSON.stringify(payload) ? prev : payload);
            setLastRun(new Date());
        } catch (e) {
            setError(e.message);
        } finally {
            loadingRef.current = false;
            setLoading(false);
        }
    }, []); // stable — all state accessed via refs

    // ── Auto-poll every 60s ──
    useEffect(() => {
        clearInterval(pollRef.current);
        if (autoRun && clausesRef.current.length > 0) {
            runQuery(); // immediate run on mount / autoRun toggle
            pollRef.current = setInterval(() => {
                if (autoRunRef.current && clausesRef.current.length > 0) runQuery();
            }, POLL_MS);
        }
        return () => clearInterval(pollRef.current);
    }, [autoRun, runQuery]);

    // ── Socket: re-run on Stream D batch update (fires ~every 2min, NOT per-coin) ──
    // Uses 'stream-d-update' — the actual event emitted by server/index.js line ~937.
    // Deliberately NOT listening to 'smart-level-update' (fires per-coin, too noisy).
    useEffect(() => {
        const handleStreamD = () => {
            if (!autoRunRef.current || clausesRef.current.length === 0) return;
            if (loadingRef.current) return;
            // Throttle: skip if last run was < THROTTLE_MS ago
            if (Date.now() - lastRunMsRef.current < THROTTLE_MS) return;
            runQuery();
        };
        const sock = socketService.connect();
        sock.on('stream-d-update', handleStreamD);
        return () => sock.off('stream-d-update', handleStreamD);
    }, [runQuery]);

    // ── Clause / mode setters — update refs inline, no useEffect overhead ──
    const scheduleAutoRun = useCallback((nextClauses, nextMode) => {
        clearTimeout(debounceRef.current);
        if (!autoRunRef.current) return;
        debounceRef.current = setTimeout(() => runQuery(nextClauses, nextMode), 700);
    }, [runQuery]);

    const addClause = useCallback(() => {
        const f = FIELDS[0];
        const next = [...clausesRef.current, { field: f.id, op: '<', value: f.defaultVal }];
        clausesRef.current = next;
        setClauses(next);
        persist(next, modeRef.current);
        // Don't auto-run on add — user likely hasn't configured the new clause yet
    }, []);

    const removeClause = useCallback((i) => {
        const next = clausesRef.current.filter((_, idx) => idx !== i);
        clausesRef.current = next;
        setClauses(next);
        persist(next, modeRef.current);
        scheduleAutoRun(next, modeRef.current);
    }, [scheduleAutoRun]);

    const updateClause = useCallback((i, patch) => {
        const next = clausesRef.current.map((c, idx) => idx === i ? { ...c, ...patch } : c);
        clausesRef.current = next;
        setClauses(next);
        persist(next, modeRef.current);
        scheduleAutoRun(next, modeRef.current);
    }, [scheduleAutoRun]);

    const setModeAndPersist = useCallback((m) => {
        modeRef.current = m;
        setMode(m);
        persist(clausesRef.current, m);
        scheduleAutoRun(clausesRef.current, m);
    }, [scheduleAutoRun]);

    const clearAll = useCallback(() => {
        clearTimeout(debounceRef.current);
        clausesRef.current = [];
        setClauses([]);
        persist([], modeRef.current);
        setData(null);
    }, []);

    // Full reset: clear clauses, mode, all saved presets, results
    const resetAll = useCallback(() => {
        clearTimeout(debounceRef.current);
        clearInterval(pollRef.current);
        clausesRef.current = [];
        modeRef.current    = 'AND';
        autoRunRef.current = true;
        setClauses([]);
        setMode('AND');
        setAutoRun(true);
        setData(null);
        setError(null);
        setLastRun(null);
        setExpandedCoin(null);
        try { localStorage.removeItem(LS_ACTIVE); } catch {}
    }, []);

    // ── Preset actions ──
    const loadPreset = useCallback((preset) => {
        clausesRef.current = [...preset.clauses];
        modeRef.current    = preset.mode;
        setClauses([...preset.clauses]);
        setMode(preset.mode);
        persist(preset.clauses, preset.mode);
        setShowPresets(false);
        setExpanded(true);
        runQuery(preset.clauses, preset.mode);
    }, [runQuery]);

    const savePreset = () => {
        if (!saveName.trim()) return;
        const newPreset = { id: `u_${Date.now()}`, name: saveName.trim(), icon: '📌', mode, clauses: [...clauses] };
        const next = [...userPresets, newPreset];
        setUserPresets(next);
        saveUserPresets(next);
        setSaveName('');
        setShowSaveDialog(false);
    };

    const deleteUserPreset = (id) => {
        const next = userPresets.filter(p => p.id !== id);
        setUserPresets(next);
        saveUserPresets(next);
    };

    // ── Render helpers ──
    const coins      = data?.coins  || [];
    const matchCount = data?.matched ?? 0;

    // These are derived from the static FIELDS constant — computed once via useMemo
    const FIELD_MAP   = useMemo(() => Object.fromEntries(FIELDS.map(f => [f.id, f])), []);
    const fieldGroups = useMemo(() => FIELDS.reduce((acc, f) => {
        (acc[f.group] = acc[f.group] || []).push(f);
        return acc;
    }, {}), []);

    return (
        <div className={styles.widget}>

            {/* ─── HEADER ─── */}
            <div className={styles.header}>
                <div className={styles.headerLeft}>
                    <Filter size={13} className={styles.headerIcon} />
                    <span className={styles.title}>BYOC SCREENER</span>

                    {/* Compact clause summary when collapsed */}
                    {!expanded && clauses.length > 0 && (
                        <div className={styles.clauseChips}>
                            {clauses.slice(0, 3).map((c, i) => (
                                <span key={i} className={styles.clauseChip}>
                                    {FIELD_MAP[c.field]?.label} {c.op} {['above_ema','below_ema','at_ema'].includes(c.op) ? '' : c.value}
                                </span>
                            ))}
                            {clauses.length > 3 && (
                                <span className={styles.clauseChip}>+{clauses.length - 3}</span>
                            )}
                        </div>
                    )}
                </div>

                <div className={styles.headerRight}>
                    {data && !loading && (
                        <span className={styles.matchBadge}>{matchCount} coins</span>
                    )}

                    {/* AND / OR toggle */}
                    <div className={styles.modeToggle}>
                        <button
                            className={`${styles.modeBtn} ${mode === 'AND' ? styles.modeBtnOn : ''}`}
                            onClick={() => setModeAndPersist('AND')}
                            title="All clauses must match"
                        >AND</button>
                        <button
                            className={`${styles.modeBtn} ${mode === 'OR' ? styles.modeBtnOn : ''}`}
                            onClick={() => setModeAndPersist('OR')}
                            title="Any clause must match"
                        >OR</button>
                    </div>

                    {/* Presets dropdown */}
                    <div className={styles.presetsWrap} ref={presetsRef}>
                        <button
                            className={`${styles.iconBtn} ${showPresets ? styles.iconBtnOn : ''}`}
                            onClick={() => setShowPresets(!showPresets)}
                            title="Presets"
                        >
                            <Bookmark size={13} />
                        </button>
                        {showPresets && (
                            <div className={styles.presetsDropdown}>
                                <div className={styles.presetsSectionLabel}>BUILT-IN</div>
                                {BUILTIN_PRESETS.map(p => (
                                    <button key={p.id} className={styles.presetRow} onClick={() => loadPreset(p)}>
                                        <span className={styles.presetIcon}>{p.icon}</span>
                                        <span className={styles.presetName}>{p.name}</span>
                                        <span className={styles.presetMeta}>{p.mode} · {p.clauses.length}</span>
                                    </button>
                                ))}
                                {userPresets.length > 0 && (
                                    <>
                                        <div className={styles.presetsSectionLabel}>SAVED</div>
                                        {userPresets.map(p => (
                                            <div key={p.id} className={styles.presetRowWrap}>
                                                <button className={styles.presetRow} onClick={() => loadPreset(p)}>
                                                    <span className={styles.presetIcon}>{p.icon}</span>
                                                    <span className={styles.presetName}>{p.name}</span>
                                                    <span className={styles.presetMeta}>{p.mode} · {p.clauses.length}</span>
                                                </button>
                                                <button className={styles.presetDelete} onClick={() => deleteUserPreset(p.id)} title="Delete">
                                                    <Trash2 size={10} />
                                                </button>
                                            </div>
                                        ))}
                                    </>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Live auto-refresh toggle */}
                    <button
                        className={`${styles.liveBtn} ${autoRun ? styles.liveBtnOn : ''}`}
                        onClick={() => { const next = !autoRun; autoRunRef.current = next; setAutoRun(next); }}
                        title={autoRun ? 'Live — click to pause auto-refresh' : 'Paused — click to enable auto-refresh'}
                    >
                        <Radio size={10} />
                        {autoRun ? 'LIVE' : 'PAUSED'}
                    </button>

                    {/* Manual run */}
                    <button
                        className={`${styles.runBtn} ${loading ? styles.runBtnLoading : ''}`}
                        onClick={() => runQuery(clauses, mode)}
                        disabled={loading}
                        title="Run screener now"
                    >
                        {loading ? <RefreshCw size={11} className={styles.spinner} /> : <Play size={11} />}
                        {loading ? 'Scanning' : 'Run'}
                    </button>

                    {/* Reset — clears all clauses and saved state */}
                    {(clauses.length > 0 || data) && (
                        <button
                            className={styles.resetBtn}
                            onClick={resetAll}
                            title="Reset screener — clear all clauses and results"
                        >
                            <Trash2 size={11} />
                            Reset
                        </button>
                    )}

                    {/* Expand / collapse */}
                    <button className={styles.iconBtn} onClick={() => setExpanded(!expanded)}>
                        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                </div>
            </div>

            {expanded && (
                <>
                {/* ─── BUILDER PANEL ─── */}
                <div className={styles.builderPanel}>
                    {clauses.length === 0 && (
                        <div className={styles.emptyBuilder}>
                            No clauses — click <strong>+ Add Clause</strong> or load a <strong>Preset</strong>
                        </div>
                    )}

                    {clauses.map((clause, i) => {
                        const fd = FIELD_MAP[clause.field] || FIELDS[0];
                        const ops = getOps(clause.field);
                        const noValue = ['above_ema', 'below_ema'].includes(clause.op);
                        const isDistField = clause.field.startsWith('dist_');
                        const isRsiField  = clause.field.startsWith('rsi');

                        return (
                            <div key={i} className={styles.clauseRow}>
                                <span className={styles.clauseConnector}>
                                    {i === 0 ? 'WHERE' : mode}
                                </span>

                                {/* Field */}
                                <select
                                    className={styles.clauseSelect}
                                    value={clause.field}
                                    onChange={e => {
                                        const newFd = FIELD_MAP[e.target.value] || FIELDS[0];
                                        updateClause(i, { field: e.target.value, value: newFd.defaultVal });
                                    }}
                                >
                                    {Object.entries(fieldGroups).map(([group, fields]) => (
                                        <optgroup key={group} label={group}>
                                            {fields.map(f => (
                                                <option key={f.id} value={f.id}>{f.label}</option>
                                            ))}
                                        </optgroup>
                                    ))}
                                </select>

                                {/* Operator */}
                                <select
                                    className={styles.clauseSelectSm}
                                    value={clause.op}
                                    onChange={e => updateClause(i, { op: e.target.value })}
                                >
                                    {ops.map(o => (
                                        <option key={o.value} value={o.value}>{o.label}</option>
                                    ))}
                                </select>

                                {/* Value */}
                                {noValue
                                    ? <span className={styles.clauseImplicit}>
                                        {clause.op === 'above_ema' ? '(> 0%)' : '(< 0%)'}
                                      </span>
                                    : <input
                                        type="number"
                                        className={styles.clauseInput}
                                        step={fd.step}
                                        value={clause.value}
                                        onChange={e => updateClause(i, { value: parseFloat(e.target.value) || 0 })}
                                      />
                                }

                                {/* Quick zone buttons */}
                                {isRsiField && (
                                    <div className={styles.quickGroup}>
                                        <button className={styles.quickBtn} title="Oversold <30"
                                            onClick={() => updateClause(i, { op: '<', value: 30 })}>OS</button>
                                        <button className={styles.quickBtn} title="Mid <50"
                                            onClick={() => updateClause(i, { op: '<', value: 50 })}>50</button>
                                        <button className={styles.quickBtn} title="Overbought >70"
                                            onClick={() => updateClause(i, { op: '>', value: 70 })}>OB</button>
                                    </div>
                                )}
                                {isDistField && (
                                    <div className={styles.quickGroup}>
                                        <button className={styles.quickBtn} title="Above EMA"
                                            onClick={() => updateClause(i, { op: 'above_ema', value: 0 })}>▲</button>
                                        <button className={styles.quickBtn} title="Below EMA"
                                            onClick={() => updateClause(i, { op: 'below_ema', value: 0 })}>▼</button>
                                        <button className={styles.quickBtn} title="At EMA ±0.5%"
                                            onClick={() => updateClause(i, { op: 'at_ema', value: 0.5 })}>≈</button>
                                    </div>
                                )}

                                <button className={styles.removeBtn} onClick={() => removeClause(i)} title="Remove">
                                    <X size={11} />
                                </button>
                            </div>
                        );
                    })}

                    {/* Builder footer */}
                    <div className={styles.builderFooter}>
                        <button className={styles.addBtn} onClick={addClause}>
                            <Plus size={12} /> Add Clause
                        </button>
                        {clauses.length > 0 && (
                            <>
                                <button className={styles.clearBtn} onClick={clearAll} title="Clear all clauses">
                                    Clear all
                                </button>
                                {!showSaveDialog ? (
                                    <button className={styles.saveBtn} onClick={() => setShowSaveDialog(true)}>
                                        <Save size={11} /> Save preset
                                    </button>
                                ) : (
                                    <div className={styles.saveDialog}>
                                        <input
                                            className={styles.saveInput}
                                            value={saveName}
                                            onChange={e => setSaveName(e.target.value)}
                                            placeholder="Preset name…"
                                            autoFocus
                                            onKeyDown={e => {
                                                if (e.key === 'Enter')  savePreset();
                                                if (e.key === 'Escape') setShowSaveDialog(false);
                                            }}
                                        />
                                        <button className={styles.saveConfirmBtn} onClick={savePreset}>Save</button>
                                        <button className={styles.iconBtn} onClick={() => setShowSaveDialog(false)}>
                                            <X size={11} />
                                        </button>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>

                {/* ─── RESULTS PANEL ─── */}
                {(data || loading || error) && (
                    <div className={styles.resultsPanel}>
                        {/* Results header */}
                        <div className={styles.resultsHeader}>
                            <div className={styles.resultsMeta}>
                                {loading && <span className={styles.scanningText}>Scanning…</span>}
                                {!loading && data && (
                                    <span className={styles.matchInfo}>
                                        <strong>{matchCount}</strong> coin{matchCount !== 1 ? 's' : ''} matched
                                        {lastRun && (
                                            <span className={styles.lastRunTime}> · {lastRun.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                        )}
                                    </span>
                                )}
                                {error && <span className={styles.errorText}>Error: {error}</span>}
                            </div>
                            <div className={styles.viewTabs}>
                                {[
                                    { id: 'list', label: 'List',  Icon: List      },
                                    { id: 'rsi',  label: 'RSI',   Icon: BarChart2  },
                                    { id: 'ema',  label: 'EMA',   Icon: TrendingUp },
                                ].map(({ id, label, Icon }) => (
                                    <button
                                        key={id}
                                        className={`${styles.viewTab} ${viewMode === id ? styles.viewTabOn : ''}`}
                                        onClick={() => { setViewMode(id); setExpandedCoin(null); }}
                                    >
                                        <Icon size={11} /> {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Empty state */}
                        {!loading && data && coins.length === 0 && (
                            <div className={styles.noResults}>
                                No coins match — try loosening a clause or switching to OR mode
                            </div>
                        )}

                        {/* ── LIST VIEW ── */}
                        {viewMode === 'list' && !loading && coins.length > 0 && (
                            <div className={styles.listWrap}>
                                <div className={styles.listHead}>
                                    <span>Coin</span>
                                    <span>Change</span>
                                    <span>RSI 15m</span>
                                    <span>RSI 1h</span>
                                    <span>RVOL</span>
                                    <span>Dist 15m</span>
                                    <span>ATR%</span>
                                    <span>Vol</span>
                                </div>
                                {coins.map(coin => (
                                    <React.Fragment key={coin.ticker}>
                                        <div
                                            className={`${styles.listRow} ${expandedCoin === coin.ticker ? styles.listRowOpen : ''}`}
                                            onClick={() => setExpandedCoin(expandedCoin === coin.ticker ? null : coin.ticker)}
                                        >
                                            <span className={styles.coinLabel}>
                                                <span className={styles.coinClean}>{coin.clean}</span>
                                                <span className={styles.coinSrc}>{coin.src}</span>
                                            </span>
                                            <span style={{ color: chgColor(coin.change_pct) }}>
                                                {coin.change_pct != null ? `${coin.change_pct > 0 ? '+' : ''}${coin.change_pct.toFixed(1)}%` : '—'}
                                            </span>
                                            <span style={{ color: rsiColor(coin.rsi?.m15) }}>{coin.rsi?.m15 ?? '—'}</span>
                                            <span style={{ color: rsiColor(coin.rsi?.h1)  }}>{coin.rsi?.h1  ?? '—'}</span>
                                            <span style={{ color: (coin.rvol?.m15 ?? 0) > 1.5 ? 'var(--accent-orange)' : 'var(--text-muted)' }}>
                                                {coin.rvol?.m15 != null ? coin.rvol.m15.toFixed(1) + 'x' : '—'}
                                            </span>
                                            <span style={{ color: (coin.dist?.m15 ?? 0) > 0 ? 'var(--accent-green)' : (coin.dist?.m15 ?? 0) < 0 ? 'var(--accent-red)' : 'var(--text-muted)' }}>
                                                {coin.dist?.m15 != null ? `${coin.dist.m15 > 0 ? '+' : ''}${coin.dist.m15.toFixed(1)}%` : '—'}
                                            </span>
                                            <span className={styles.atrCell}>
                                                {coin.atr?.m15 != null ? coin.atr.m15.toFixed(2) + '%' : '—'}
                                            </span>
                                            <span className={styles.volCell}>{fmtVol(coin.volume)}</span>
                                        </div>

                                        {expandedCoin === coin.ticker && (
                                            <div className={styles.detailCard}>
                                                <div className={styles.detailGrid}>
                                                    {/* RSI candle */}
                                                    <div className={styles.detailSection}>
                                                        <div className={styles.detailTitle}>RSI Candle
                                                            <span className={styles.detailHint}> (1h|30m body · 15m line)</span>
                                                        </div>
                                                        <div className={styles.rsiDetailRow}>
                                                            <MiniRsiCandle rsi={coin.rsi} />
                                                            <div className={styles.rsiDetailVals}>
                                                                {[['1h','h1'],['30m','m30'],['15m','m15'],['5m','m5']].map(([lbl, key]) => (
                                                                    <div key={key} className={styles.rsiValLine}>
                                                                        <span className={styles.rsiTfTag}>{lbl}</span>
                                                                        <span style={{ color: rsiColor(coin.rsi?.[key]), fontWeight: 700, fontSize: 13 }}>
                                                                            {coin.rsi?.[key] ?? '—'}
                                                                        </span>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    {/* EMA dist bars */}
                                                    <div className={styles.detailSection}>
                                                        <div className={styles.detailTitle}>EMA200 Distance %</div>
                                                        <EmaDistBars dist={coin.dist} />
                                                    </div>
                                                    {/* Metrics */}
                                                    <div className={styles.detailSection}>
                                                        <div className={styles.detailTitle}>Metrics</div>
                                                        <MetricsGrid coin={coin} />
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </React.Fragment>
                                ))}
                            </div>
                        )}

                        {/* ── RSI GRID VIEW ── */}
                        {viewMode === 'rsi' && !loading && coins.length > 0 && (
                            <>
                            <div className={styles.rsiGrid}>
                                {coins.map(coin => {
                                    const allOS = (coin.rsi?.h1 ?? 50) < 30 && (coin.rsi?.m30 ?? 50) < 30;
                                    const allOB = (coin.rsi?.h1 ?? 50) > 70 && (coin.rsi?.m30 ?? 50) > 70;
                                    return (
                                        <div
                                            key={coin.ticker}
                                            className={`${styles.rsiCard} ${expandedCoin === coin.ticker ? styles.rsiCardOpen : ''} ${allOS ? styles.rsiCardOS : allOB ? styles.rsiCardOB : ''}`}
                                            onClick={() => setExpandedCoin(expandedCoin === coin.ticker ? null : coin.ticker)}
                                            title={coin.ticker}
                                        >
                                            <div className={styles.rsiCardHeader}>
                                                <span className={styles.rsiCardName}>{coin.clean}</span>
                                                <span className={styles.rsiCardChg} style={{ color: chgColor(coin.change_pct) }}>
                                                    {coin.change_pct != null ? `${coin.change_pct > 0 ? '+' : ''}${coin.change_pct.toFixed(1)}%` : '—'}
                                                </span>
                                            </div>
                                            <MiniRsiCandle rsi={coin.rsi} />
                                            <div className={styles.rsiCardFoot}>
                                                <span style={{ color: rsiColor(coin.rsi?.m15) }}>15m·{coin.rsi?.m15 ?? '—'}</span>
                                                <span style={{ color: rsiColor(coin.rsi?.h1) }}>1h·{coin.rsi?.h1  ?? '—'}</span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                            {/* Detail below grid */}
                            {expandedCoin && (() => {
                                const coin = coins.find(c => c.ticker === expandedCoin);
                                if (!coin) return null;
                                return (
                                    <div className={styles.detailCard}>
                                        <div className={styles.detailGrid}>
                                            <div className={styles.detailSection}>
                                                <div className={styles.detailTitle}>RSI Candle</div>
                                                <div className={styles.rsiDetailRow}>
                                                    <MiniRsiCandle rsi={coin.rsi} />
                                                    <div className={styles.rsiDetailVals}>
                                                        {[['1h','h1'],['30m','m30'],['15m','m15'],['5m','m5']].map(([lbl,key]) => (
                                                            <div key={key} className={styles.rsiValLine}>
                                                                <span className={styles.rsiTfTag}>{lbl}</span>
                                                                <span style={{ color: rsiColor(coin.rsi?.[key]), fontWeight: 700, fontSize: 13 }}>{coin.rsi?.[key] ?? '—'}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className={styles.detailSection}>
                                                <div className={styles.detailTitle}>EMA200 Distance %</div>
                                                <EmaDistBars dist={coin.dist} />
                                            </div>
                                            <div className={styles.detailSection}>
                                                <div className={styles.detailTitle}>Metrics</div>
                                                <MetricsGrid coin={coin} />
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()}
                            </>
                        )}

                        {/* ── EMA GRID VIEW ── */}
                        {viewMode === 'ema' && !loading && coins.length > 0 && (
                            <>
                            <div className={styles.emaGrid}>
                                {coins.map(coin => {
                                    const d15 = coin.dist?.m15 ?? 0;
                                    const dh1 = coin.dist?.h1  ?? 0;
                                    const bull = d15 > 0 && dh1 > 0;
                                    const bear = d15 < 0 && dh1 < 0;
                                    return (
                                        <div
                                            key={coin.ticker}
                                            className={`${styles.emaCard} ${expandedCoin === coin.ticker ? styles.emaCardOpen : ''} ${bull ? styles.emaCardBull : bear ? styles.emaCardBear : ''}`}
                                            onClick={() => setExpandedCoin(expandedCoin === coin.ticker ? null : coin.ticker)}
                                        >
                                            <div className={styles.emaCardHeader}>
                                                <span className={styles.emaCardName}>{coin.clean}</span>
                                                <span style={{ color: chgColor(coin.change_pct), fontSize: 10, fontWeight: 700 }}>
                                                    {coin.change_pct != null ? `${coin.change_pct > 0 ? '+' : ''}${coin.change_pct.toFixed(1)}%` : '—'}
                                                </span>
                                            </div>
                                            <EmaDistBars dist={coin.dist} compact />
                                            {coin.rvol?.m15 != null && (
                                                <div className={styles.emaCardRvol}>
                                                    RVOL&nbsp;
                                                    <span style={{ color: coin.rvol.m15 > 1.5 ? 'var(--accent-orange)' : 'var(--text-muted)' }}>
                                                        {coin.rvol.m15.toFixed(1)}x
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            {expandedCoin && (() => {
                                const coin = coins.find(c => c.ticker === expandedCoin);
                                if (!coin) return null;
                                return (
                                    <div className={styles.detailCard}>
                                        <div className={styles.detailGrid}>
                                            <div className={styles.detailSection}>
                                                <div className={styles.detailTitle}>RSI Candle</div>
                                                <div className={styles.rsiDetailRow}>
                                                    <MiniRsiCandle rsi={coin.rsi} />
                                                    <div className={styles.rsiDetailVals}>
                                                        {[['1h','h1'],['30m','m30'],['15m','m15'],['5m','m5']].map(([lbl,key]) => (
                                                            <div key={key} className={styles.rsiValLine}>
                                                                <span className={styles.rsiTfTag}>{lbl}</span>
                                                                <span style={{ color: rsiColor(coin.rsi?.[key]), fontWeight: 700, fontSize: 13 }}>{coin.rsi?.[key] ?? '—'}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                            <div className={styles.detailSection}>
                                                <div className={styles.detailTitle}>EMA200 Distance %</div>
                                                <EmaDistBars dist={coin.dist} />
                                            </div>
                                            <div className={styles.detailSection}>
                                                <div className={styles.detailTitle}>Metrics</div>
                                                <MetricsGrid coin={coin} />
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()}
                            </>
                        )}
                    </div>
                )}
                </>
            )}
        </div>
    );
}
