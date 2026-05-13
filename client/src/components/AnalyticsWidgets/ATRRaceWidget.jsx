import React, { useState, useMemo, useRef, useCallback } from 'react';
import { FreshnessChip } from '../FreshnessChip';
import styles from './ATRRaceWidget.module.css';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import { useTimeStore } from '../../store/useTimeStore';
import { Activity, RefreshCw, Settings, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import {
    checkCascade, passesAtrGate,
    loadCascadeSeries, saveCascadeSeries,
    validateCascadeSettings,
    TF_ORDER, TF_LABELS, CASCADE_SERIES_DEFAULTS,
} from '../../utils/cascadeUtils';

// ── Filter / sort options ─────────────────────────────────────────────────────
const LONG_OPTS  = [{ key: 'all', label: '⚡ All' }, { key: 'bull', label: '▲ Bull' }, { key: 'bear', label: '▼ Bear' }];
const SHORT_OPTS = [{ key: 'any', label: 'Any' }, { key: 'bull', label: '↗ Bull' }, { key: 'bear', label: '↘ Bear' }, { key: 'none', label: '— None' }];
const SORT_OPTS  = [
    { key: 'bull',    label: '▲ Bull first' },
    { key: 'bear',    label: '▼ Bear first' },
    { key: 'counter', label: '↺ Counter'    },
    { key: 'atr',     label: 'ATR% high'    },
    { key: 'name',    label: 'A – Z'        },
];

// ── Persistence ───────────────────────────────────────────────────────────────
const LS_KEY   = 'cascadeBoard_prefs';
const DEFAULTS = { longFilter: 'all', shortFilter: 'any', filterClause: 'and', sortBy: 'bull' };
function loadPrefs() {
    try { const s = JSON.parse(localStorage.getItem(LS_KEY)); return s ? { ...DEFAULTS, ...s } : { ...DEFAULTS }; }
    catch { return { ...DEFAULTS }; }
}
function savePrefs(p) { try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch {} }

function coinMatchesFilter(coin, longFilter, shortFilter, clause) {
    const longMatch  = longFilter  === 'all' || coin.longDir  === longFilter;
    const shortMatch = shortFilter === 'any' ? true
                     : shortFilter === 'none' ? coin.shortDir === 'neutral'
                     : coin.shortDir === shortFilter;
    return clause === 'or' ? (longMatch || shortMatch) : (longMatch && shortMatch);
}

// ── Settings panel ────────────────────────────────────────────────────────────
function SettingsPanel({ onClose }) {
    const init = loadCascadeSeries();
    const [draftLong,   setDraftLong]   = useState(init.longSeries);
    const [draftShort,  setDraftShort]  = useState(init.shortSeries);
    const [draftThresh, setDraftThresh] = useState(init.equalThreshold);
    const validation = useMemo(() => validateCascadeSettings(draftLong, draftShort), [draftLong, draftShort]);

    const toggle = (tf, list, setList, other) =>
        list.includes(tf) ? setList(list.filter(t => t !== tf))
                          : (!other.includes(tf) && setList([...list, tf]));

    const handleApply = () => {
        if (!validation.isValid) return;
        saveCascadeSeries({ longSeries: draftLong, shortSeries: draftShort, equalThreshold: Number(draftThresh) });
        onClose(true);
    };
    const handleReset = () => {
        setDraftLong(CASCADE_SERIES_DEFAULTS.longSeries);
        setDraftShort(CASCADE_SERIES_DEFAULTS.shortSeries);
        setDraftThresh(CASCADE_SERIES_DEFAULTS.equalThreshold);
    };

    return (
        <div className={styles.settingsOverlay}>
            <div className={styles.settingsHeader}>
                <span className={styles.settingsTitle}>Cascade Series Settings</span>
                <button className={styles.settingsClose} onClick={() => onClose(false)}>✕</button>
            </div>
            {[
                { label: 'Long-term series (min 2)', list: draftLong, set: setDraftLong, other: draftShort, cls: styles.tfBtnLong },
                { label: 'Counter-trend series (min 1)', list: draftShort, set: setDraftShort, other: draftLong, cls: styles.tfBtnShort },
            ].map(({ label, list, set, other, cls }) => (
                <div className={styles.settingsSection} key={label}>
                    <div className={styles.settingsSectionLabel}>{label}</div>
                    <div className={styles.tfRow}>
                        {TF_ORDER.map(tf => {
                            const active  = list.includes(tf);
                            const blocked = other.includes(tf);
                            return (
                                <button key={tf} disabled={blocked}
                                    className={`${styles.tfBtn} ${active ? cls : ''} ${blocked ? styles.tfBtnBlocked : ''}`}
                                    onClick={() => toggle(tf, list, set, other)}
                                    title={blocked ? 'Already used in other series' : ''}
                                >{blocked ? <s>{TF_LABELS[tf]}</s> : TF_LABELS[tf]}</button>
                            );
                        })}
                    </div>
                </div>
            ))}
            <div className={styles.settingsSection}>
                <label className={styles.settingsSectionLabel}>
                    Equal threshold &nbsp;
                    <input type="number" min="0" max="2" step="0.05" className={styles.threshInput}
                        value={draftThresh} onChange={e => setDraftThresh(e.target.value)} /> %
                </label>
            </div>
            {validation.errors.length > 0 && (
                <div className={styles.validationErrors}><XCircle size={11} />{validation.errors.map((e, i) => <div key={i}>{e}</div>)}</div>
            )}
            {validation.warnings.length > 0 && validation.errors.length === 0 && (
                <div className={styles.validationWarnings}><AlertTriangle size={11} />{validation.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
            )}
            <div className={styles.settingsActions}>
                <button className={styles.settingsResetBtn}  onClick={handleReset}>Reset defaults</button>
                <button className={styles.settingsCancelBtn} onClick={() => onClose(false)}>Cancel</button>
                <button className={styles.settingsApplyBtn}  onClick={handleApply} disabled={!validation.isValid}>
                    {validation.isValid ? <CheckCircle size={11} /> : <XCircle size={11} />} Apply
                </button>
            </div>
        </div>
    );
}

// ── EMA200 Candle Card ────────────────────────────────────────────────────────
//
// ── Settings-driven candle model ─────────────────────────────────────────────
//
//  longSeries  = ['h4','h1','m15']  (user-configurable, longest → shortest)
//  shortSeries = ['m5','m1']        (user-configurable, counter-trend wick TFs)
//
//  Body sections driven entirely from settings — no hardcoded TF names:
//
//    longSeries[0]     → ANCHOR     (h4) — always body floor/ceiling
//    longSeries[1]     → CORE       (h1) — normal body top (bull) / bottom (bear)
//    longSeries[2..n]  → EXPANSION  (m15) — body extends here when:
//                          • price hasn't entered the CORE↔EXT gap (not broken)
//                          • shortDir === 'neutral' (no wick counter-play)
//
//  Body CONTRACTS back to ANCHOR↔CORE the moment price enters the CORE↔EXT gap.
//
//    shortSeries       → WICK zone  (m5,m1) — merged wick when both same side
//
//  Bull expanded (SOL-like, price above all longSeries):
//   ┌───┐ 15m  ← body top (expanded)
//   │ ▲ │
//   │   │ 1h   ← core boundary — still a level line inside body
//   │   │
//   └───┘ 4h   ← body bottom (anchor)
//
//  Bull normal (price entered 1h↔15m zone, or wick counter-play active):
//   ─── 15m  ← just a level line above body
//   ┌───┐ 1h  ← body top
//   └───┘ 4h  ← body bottom

const TF_STYLE = {
    h4:  { color: '#f6ad55', dash: false, w: 1 },
    h1:  { color: '#63b3ed', dash: false, w: 2 },  // bolder — core boundary
    m15: { color: '#68D391', dash: false, w: 1 },
    m5:  { color: '#a78bfa', dash: true,  w: 1 },
    m1:  { color: '#b794f4', dash: true,  w: 1 },
};

const MIN_LABEL_GAP = 7;

function EMACandle({ row, longSeries, shortSeries }) {
    const { ticker, longDir, shortDir, emas, price, atr_m15 } = row;
    if (!emas || !price) return null;

    const allTFs   = [...new Set([...longSeries, ...shortSeries])];
    const validTFs = allTFs.filter(tf => emas[tf] > 0);
    const allVals  = [...validTFs.map(tf => emas[tf]), price];
    if (allVals.length < 2) return null;

    const rawLo = Math.min(...allVals);
    const rawHi = Math.max(...allVals);
    if (rawHi === rawLo) return null;

    const pad     = (rawHi - rawLo) * 0.12;
    const vizLo   = rawLo - pad;
    const vizHi   = rawHi + pad;
    const vizSpan = vizHi - vizLo;
    const toTop   = v => ((vizHi - v) / vizSpan) * 100;

    // ── Body: settings-driven anchor / core / expansion ──────────────────────
    const anchorTF  = longSeries[0];                  // deepest (e.g. h4)
    const coreTF    = longSeries[1];                  // second  (e.g. h1)
    const extTFs    = longSeries.slice(2);            // expansion zone (e.g. ['m15'])

    const anchorV = emas[anchorTF];
    const coreV   = emas[coreTF];
    if (!anchorV || !coreV) return null;

    // Expansion: body grows to include extTFs only when:
    //   1. shortDir === 'neutral' — no counter-trend play on short series
    //   2. price is still beyond the outermost ext EMA (price > m15 for bull)
    // When counter-trend is active (wick visible), body stays at anchor↔core only.
    const extVals = extTFs.map(tf => emas[tf]).filter(v => v > 0);
    let isExpanded = false;
    if (extVals.length > 0 && shortDir === 'neutral' && longDir !== 'neutral') {
        isExpanded = longDir === 'bull'
            ? extVals.every(v => price > v)
            : extVals.every(v => price < v);
    }

    // Collect all EMA values that define the body boundaries
    const bodyEmaVals = [anchorV, coreV, ...(isExpanded ? extVals : [])].filter(v => v > 0);
    const bodyTopV    = Math.max(...bodyEmaVals);
    const bodyBotV    = Math.min(...bodyEmaVals);
    const bodyTopPct  = toTop(bodyTopV);
    const bodyH       = toTop(bodyBotV) - bodyTopPct;

    // "Broken" state: price has fallen through the entire long-series structure.
    // Bull cascade but price < anchor (4h) → structure intact by EMA stacking
    // but price is below all of it — show as broken (dimmed red) not green.
    // Bear cascade but price > anchor → same logic inverted.
    const bodyBroken = (longDir === 'bull' && price < bodyBotV) ||
                       (longDir === 'bear' && price > bodyTopV);

    const bodyBg  = bodyBroken         ? 'rgba(252,129,129,0.10)' :
                    longDir === 'bull'  ? 'rgba(104,211,145,0.20)' :
                    longDir === 'bear'  ? 'rgba(252,129,129,0.20)' : 'rgba(255,255,255,0.04)';
    const bodyBdr = bodyBroken         ? 'rgba(252,129,129,0.35)' :
                    longDir === 'bull'  ? 'rgba(104,211,145,0.60)' :
                    longDir === 'bear'  ? 'rgba(252,129,129,0.60)' : 'rgba(255,255,255,0.10)';

    // ── Short-series wick ─────────────────────────────────────────────────────
    // Reference = coreV (longSeries[1], e.g. h1).
    // Wick merges when ALL shortSeries TFs are on the same side of coreV.
    const shortVals    = shortSeries.map(tf => emas[tf]).filter(v => v > 0);
    const shortSameDir = shortVals.length >= 2 && coreV > 0 &&
        (shortVals.every(v => v > coreV) || shortVals.every(v => v < coreV));
    const wickTopPct   = shortSameDir ? toTop(Math.max(...shortVals)) : 0;
    const wickH        = shortSameDir ? toTop(Math.min(...shortVals)) - wickTopPct : 0;

    // ── EMA level rows (overlap stagger) ─────────────────────────────────────
    const rawLevels = validTFs
        .map(tf => ({ tf, rawTop: toTop(emas[tf]) }))
        .sort((a, b) => a.rawTop - b.rawTop);

    const levels = rawLevels.reduce((acc, lvl) => {
        const prev = acc[acc.length - 1];
        const dispTop = (prev && lvl.rawTop - prev.dispTop < MIN_LABEL_GAP)
            ? prev.dispTop + MIN_LABEL_GAP : lvl.rawTop;
        return [...acc, { ...lvl, dispTop }];
    }, []);

    // ── Gap labels between adjacent levels ───────────────────────────────────
    const allLevelsSorted = [
        ...validTFs.map(tf => ({ id: tf, v: emas[tf] })),
        { id: 'price', v: price },
    ].sort((a, b) => b.v - a.v);

    const gaps = [];
    for (let i = 0; i < allLevelsSorted.length - 1; i++) {
        const hi  = allLevelsSorted[i].v;
        const lo  = allLevelsSorted[i + 1].v;
        const pct = ((hi - lo) / lo) * 100;
        gaps.push({ midTop: toTop((hi + lo) / 2), text: `${pct.toFixed(2)}%` });
    }

    const pRawTop     = toTop(price);
    // Broken state overrides ticker accent and card border to red
    const accentColor = bodyBroken        ? '#FC8181' :
                        longDir === 'bull' ? '#68D391' :
                        longDir === 'bear' ? '#FC8181' : '#4a5568';
    const cardBorder  = bodyBroken        ? 'rgba(252,129,129,0.28)' :
                        longDir === 'bull' ? 'rgba(104,211,145,0.28)' :
                        longDir === 'bear' ? 'rgba(252,129,129,0.28)' : 'var(--border)';

    const handleClick = () => {
        try { localStorage.setItem('emaCascade_ticker', ticker); } catch {}
        document.getElementById('section-cascade')?.scrollIntoView({ behavior: 'smooth' });
    };

    return (
        <div className={styles.candleCard}
            style={{ borderColor: cardBorder }}
            onClick={handleClick}
            title={`${ticker} — click to open in EMA Monitor`}>

            {/* ── Card header ── */}
            <div className={styles.candleHeader}>
                <span className={styles.candleTicker} style={{ color: accentColor }}>{ticker}</span>
                <div className={styles.candleRight}>
                    {shortDir !== 'neutral' && (
                        <span className={`${styles.counterChip} ${shortDir === 'bull' ? styles.counterBull : styles.counterBear}`}>
                            {shortDir === 'bull' ? '↗' : '↘'}
                        </span>
                    )}
                    {atr_m15 > 0 && (
                        <span className={styles.atrMini}>{atr_m15.toFixed(2)}%</span>
                    )}
                </div>
            </div>

            {/* ── Candle visualization ── */}
            <div className={styles.candleViz}>

                {/* Center stick — full range */}
                <div className={styles.cStick} style={{
                    top:    `${toTop(rawHi)}%`,
                    height: `${toTop(rawLo) - toTop(rawHi)}%`,
                }} />

                {/* Short-series wick (5m+1m merged when same direction vs body ref) */}
                {shortSameDir && wickH > 0.3 && (
                    <div className={styles.cWick} style={{
                        top:    `${wickTopPct}%`,
                        height: `${wickH}%`,
                    }} />
                )}

                {/* Cascade body — longSeries[0] to longSeries[1] */}
                {bodyH > 0.3 && (
                    <div className={styles.cBody} style={{
                        top:         `${bodyTopPct}%`,
                        height:      `${bodyH}%`,
                        background:  bodyBg,
                        borderColor: bodyBdr,
                    }} />
                )}

                {/* EMA200 level lines — line at rawTop (accurate price), label at dispTop (staggered) */}
                {levels.map(({ tf, rawTop, dispTop }) => {
                    const s      = TF_STYLE[tf] || { color: '#718096', dash: false, w: 1 };
                    const isBody = tf === coreTF;
                    const asWick = shortSeries.includes(tf) && shortSameDir;
                    const op     = asWick ? 0.40 : 1;
                    return (
                        <React.Fragment key={tf}>
                            {/* Horizontal line at TRUE EMA price position */}
                            <div style={{
                                position: 'absolute',
                                left: 24, right: 0,
                                top: `${rawTop}%`,
                                height: 0,
                                borderTop: `${isBody ? 2 : s.w}px ${(s.dash || asWick) ? 'dashed' : 'solid'} ${s.color}`,
                                opacity: op,
                                transform: 'translateY(-50%)',
                                zIndex: 3,
                                pointerEvents: 'none',
                            }} />
                            {/* Label at staggered position (avoids overlap without moving the line) */}
                            <span style={{
                                position: 'absolute',
                                top: `${dispTop}%`,
                                left: 0,
                                width: 22,
                                textAlign: 'right',
                                transform: 'translateY(-50%)',
                                fontSize: 8,
                                fontWeight: 700,
                                color: s.color,
                                whiteSpace: 'nowrap',
                                opacity: op,
                                zIndex: 4,
                                pointerEvents: 'none',
                                lineHeight: 1,
                            }}>
                                {TF_LABELS[tf]}
                            </span>
                        </React.Fragment>
                    );
                })}

                {/* Gap % labels between adjacent levels (right-aligned) */}
                {gaps.map((g, i) => (
                    <div key={i} className={styles.gapLbl} style={{ top: `${g.midTop}%` }}>
                        {g.text}
                    </div>
                ))}

                {/* Current price line */}
                <div className={styles.priceRow} style={{ top: `${pRawTop}%` }}>
                    <span className={styles.pLbl}>P</span>
                    <div className={styles.priceLine} />
                </div>
            </div>
        </div>
    );
}

// ── Main widget ───────────────────────────────────────────────────────────────
export function ATRRaceWidget() {
    const containerRef = useRef(null);
    const lastDataPush = useTimeStore(s => s.lastDataPush);

    const [prefs, setPrefs]               = useState(loadPrefs);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [cascadeSeries, setCascadeSeries] = useState(loadCascadeSeries);

    const { longFilter, shortFilter, filterClause, sortBy } = prefs;
    const updatePref = useCallback((key, val) => {
        setPrefs(prev => { const next = { ...prev, [key]: val }; savePrefs(next); return next; });
    }, []);

    const { data: boardData, loading, reloadSilent, lastFetchedAt } = usePolledFetch(
        () => '/api/ema-distance-board?limit=50&active_min=120',
        { intervalMs: 300_000, deps: [] }
    );
    useDataInvalidation(containerRef, reloadSilent, lastDataPush);

    const allRows = useMemo(() => {
        if (!boardData?.board?.length) return [];
        const { longSeries, shortSeries, equalThreshold } = cascadeSeries;
        return boardData.board.map(b => {
            const longDir  = checkCascade(b.emas, longSeries,  equalThreshold);
            const shortDir = checkCascade(b.emas, shortSeries, equalThreshold);
            const atrGate  = passesAtrGate(b.emas, shortSeries, b.atrs, b.price);
            const strength = longSeries.slice(0, -1).reduce((s, tf, i) => {
                const eF = b.emas?.[longSeries[i]], eT = b.emas?.[longSeries[i + 1]];
                if (!eF || !eT) return s;
                const pct = ((eT - eF) / eF) * 100;
                return s + (pct > equalThreshold ? 1 : pct < -equalThreshold ? -1 : 0);
            }, 0);
            return {
                ticker:  b.cleanTicker,
                longDir,
                shortDir: (shortDir !== 'neutral' && atrGate) ? shortDir : 'neutral',
                atr_m15:  b.atrs?.m15 || 0,
                strength,
                emas:     b.emas  || {},
                dists:    b.dists || {},
                price:    b.price || 0,
            };
        });
    }, [boardData, cascadeSeries]);

    const displayRows = useMemo(() => {
        const filtered = allRows.filter(r => coinMatchesFilter(r, longFilter, shortFilter, filterClause));
        const sorted = [...filtered];
        if (sortBy === 'bull')    sorted.sort((a, b) => b.strength - a.strength);
        if (sortBy === 'bear')    sorted.sort((a, b) => a.strength - b.strength);
        if (sortBy === 'counter') sorted.sort((a, b) =>
            (b.shortDir !== 'neutral' ? 1 : 0) - (a.shortDir !== 'neutral' ? 1 : 0) || b.atr_m15 - a.atr_m15);
        if (sortBy === 'atr')     sorted.sort((a, b) => b.atr_m15 - a.atr_m15);
        if (sortBy === 'name')    sorted.sort((a, b) => a.ticker.localeCompare(b.ticker));
        return sorted;
    }, [allRows, longFilter, shortFilter, filterClause, sortBy]);

    const handleSettingsClose = (applied) => {
        setSettingsOpen(false);
        if (applied) setCascadeSeries(loadCascadeSeries());
    };

    const { longSeries, shortSeries } = cascadeSeries;

    return (
        <div ref={containerRef} className={styles.widget}>
            {settingsOpen && <SettingsPanel onClose={handleSettingsClose} />}

            {/* ── Header ── */}
            <div className={styles.header}>
                <div className={styles.titleRow}>
                    <div className="widget-title">
                        <Activity size={16} style={{ color: 'var(--accent-blue)' }} />
                        <span className={styles.titleText}>EMA200 CANDLE WALL</span>
                        <span className={styles.titleSub}>
                            Body = {longSeries.map(tf => TF_LABELS[tf]).join('→')} · expands when price beyond {TF_LABELS[longSeries[longSeries.length-1]]} &amp; no counter · wick = {shortSeries.map(tf => TF_LABELS[tf]).join('+')} · % = gap between levels
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <FreshnessChip ts={lastFetchedAt} title="Board data last fetched from server" />
                        <button className={styles.iconBtn}
                            onClick={() => { try { localStorage.removeItem(LS_KEY); } catch {} setPrefs({ ...DEFAULTS }); }}
                            title="Reset filters">↺</button>
                        <button className={styles.iconBtn} onClick={() => setSettingsOpen(o => !o)} title="Cascade settings">
                            <Settings size={13} />
                        </button>
                        <button className={styles.iconBtn} onClick={reloadSilent} title="Refresh">
                            <RefreshCw size={13} />
                        </button>
                    </div>
                </div>

                <div className={styles.filterRow}>
                    <span className={styles.filterLabel}>Long:</span>
                    {LONG_OPTS.map(o => (
                        <button key={o.key}
                            className={`${styles.filterBtn} ${longFilter === o.key ? styles.filterActive : ''}`}
                            onClick={() => updatePref('longFilter', o.key)}>{o.label}</button>
                    ))}
                    <div className={styles.clauseToggle}>
                        <button className={`${styles.clauseBtn} ${filterClause === 'and' ? styles.clauseActive : ''}`}
                            onClick={() => updatePref('filterClause', 'and')}>AND</button>
                        <button className={`${styles.clauseBtn} ${filterClause === 'or'  ? styles.clauseActive : ''}`}
                            onClick={() => updatePref('filterClause', 'or')}>OR</button>
                    </div>
                    <span className={styles.filterLabel}>Counter:</span>
                    {SHORT_OPTS.map(o => (
                        <button key={o.key}
                            className={`${styles.filterBtn} ${shortFilter === o.key ? styles.filterActive : ''}`}
                            onClick={() => updatePref('shortFilter', o.key)}>{o.label}</button>
                    ))}
                    <span className={styles.matchCount}>{displayRows.length} / {allRows.length} coins</span>
                </div>

                <div className={styles.controlsRow}>
                    <span className={styles.filterLabel}>Sort:</span>
                    {SORT_OPTS.map(o => (
                        <button key={o.key}
                            className={`${styles.pill} ${sortBy === o.key ? styles.pillActive : ''}`}
                            onClick={() => updatePref('sortBy', o.key)}>{o.label}</button>
                    ))}
                </div>
            </div>

            {/* ── Candle grid ── */}
            <div className={styles.boardArea}>
                {loading && !boardData && (
                    <div className={styles.emptyState}>
                        <div className={styles.spinner} />
                        Loading EMA200 data…
                    </div>
                )}
                {!loading && displayRows.length === 0 && (
                    <div className={styles.emptyState}>No coins match current filter.</div>
                )}
                {displayRows.length > 0 && (
                    <div className={styles.candleGrid}>
                        {displayRows.map(r => (
                            <EMACandle key={r.ticker} row={r}
                                longSeries={longSeries}
                                shortSeries={shortSeries}
                            />
                        ))}
                    </div>
                )}
            </div>

            <div className={styles.footer}>
                <span>
                    Body expands → {longSeries.map(tf => TF_LABELS[tf]).join('→')} when price beyond {TF_LABELS[longSeries[longSeries.length-1]]} &amp; no counter &nbsp;·&nbsp;
                    Wick = {shortSeries.map(tf => TF_LABELS[tf]).join('+')} &nbsp;·&nbsp;
                    % = gap between adjacent levels
                </span>
            </div>
        </div>
    );
}

export default ATRRaceWidget;
