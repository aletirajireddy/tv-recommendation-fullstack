import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTimeStore } from '../../store/useTimeStore';
import { useDataInvalidation } from '../../hooks/useDataInvalidation';
import socketService from '../../services/SocketService';
import { ValidatorSettingsModal } from './ValidatorSettingsModal';
import { TrialExpandedModal } from './TrialExpandedModal';
import { TrialMiniChart } from './TrialMiniChart';
import { Target, Settings, Maximize2 } from 'lucide-react';
import styles from './ValidatorTimelineWidget.module.css';

function smartFmt(price) {
    if (price == null || isNaN(price) || price === 0) return '0';
    if (price >= 1000)  return price.toFixed(2);
    if (price >= 1)     return price.toFixed(4);
    return price.toFixed(6);
}

function cleanTicker(t) {
    if (!t) return '';
    return t.split(':')[1]?.replace('USDT.P', '') || t.replace('USDT.P', '');
}

function fmtTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function MoveTag({ pct }) {
    if (pct == null) return null;
    const color = pct > 0 ? 'var(--accent-green)' : pct < 0 ? 'var(--accent-red)' : 'var(--text-muted)';
    return <span style={{ color, marginLeft: 4 }}>{pct > 0 ? '+' : ''}{Number(pct).toFixed(2)}%</span>;
}

function StateBadge({ state, verdict }) {
    const display = verdict || state;
    const cls = {
        COOLDOWN: styles.stateCooldown,
        WATCHING: styles.stateWatching,
        CONFIRMED: styles.stateConfirmed,
        FAILED: styles.stateFailed,
    }[display] || '';
    return <span className={`${styles.badgeState} ${cls}`}>{display?.replace('_', ' ')}</span>;
}


function RuleStrip({ rulesJson }) {
    if (!rulesJson) return <div className={styles.ruleStrip}><span className={styles.ruleDotEmpty} /></div>;
    let rules = {};
    try { rules = typeof rulesJson === 'string' ? JSON.parse(rulesJson) : rulesJson; } catch { return null; }

    const RULE_IDS = ['EMA_5M_HOLD', 'EMA_15M_SUSTAIN', 'EMA_1H_ALIGN', 'EMA_4H_ALIGN', 'VOLUME_CONFIRM', 'REACTIVE_ZONE'];
    
    return (
        <div className={styles.ruleStrip}>
            {RULE_IDS.map(id => {
                const r = rules[id];
                const status = r ? (r.passed ? 'pass' : 'fail') : 'none';
                return (
                    <div 
                        key={id} 
                        className={`${styles.ruleDot} ${styles['ruleDot_' + status]}`} 
                        title={`${id.replace(/_/g, ' ')}: ${r?.passed ? 'PASSED' : r?.passed === false ? 'FAILED' : 'WAITING'}`}
                    />
                );
            })}
        </div>
    );
}

function CooldownProgress({ trial }) {
    const [timeLeft, setTimeLeft] = useState('');
    
    useEffect(() => {
        if (trial.state !== 'COOLDOWN') return;
        const target = new Date(trial.cooldown_until).getTime();
        
        const update = () => {
            const diff = target - Date.now();
            if (diff <= 0) {
                setTimeLeft('READY');
                return;
            }
            const m = Math.floor(diff / 60000);
            const s = Math.floor((diff % 60000) / 1000);
            setTimeLeft(`${m}:${s.toString().padStart(2, '0')}`);
        };
        
        update();
        const timer = setInterval(update, 1000);
        return () => clearInterval(timer);
    }, [trial.state, trial.cooldown_until]);

    if (trial.state !== 'COOLDOWN') return null;
    return <span className={styles.cooldownTime}>{timeLeft}</span>;
}

function MasterContextStrip({ master }) {
    if (!master) return null;
    const a = master.stream_a || {};
    const items = [];
    
    // Distances
    if (a.ema50Dist != null) items.push({ k: 'E50', v: `${a.ema50Dist > 0 ? '+' : ''}${a.ema50Dist.toFixed(1)}%` });
    if (a.ema200Dist != null) items.push({ k: 'E200', v: `${a.ema200Dist > 0 ? '+' : ''}${a.ema200Dist.toFixed(1)}%` });
    
    // HTF Alignment
    if (a.htfFlags != null) {
        const isBull = a.htfFlags > 0;
        items.push({ k: 'HTF', v: isBull ? 'BULL' : 'BEAR' });
    }

    // Momentum & Volume
    if (a.momScore != null) items.push({ k: 'MOM', v: a.momScore });
    if (a.volSpike != null && a.volSpike > 1) items.push({ k: 'VOL', v: `x${Number(a.volSpike).toFixed(1)}` });
    
    // RSI
    if (a.rsi_h1 != null) items.push({ k: 'RSI', v: Math.round(a.rsi_h1) });
    
    if (!items.length) return null;
    return (
        <div className={styles.masterStrip}>
            {items.map((i, idx) => (
                <span key={idx} className={styles.masterChip}>
                    {i.k} <span className={styles.masterChipVal}>{i.v}</span>
                </span>
            ))}
        </div>
    );
}

function TrialCard({ trial, isResolved, onExpand }) {
    const setSelectedTicker = useTimeStore(s => s.setSelectedTicker);
    const isLong = trial.direction === 'LONG';
    const cardCls = `${styles.trialCard} ${isLong ? styles.trialCardLong : styles.trialCardShort}`;
    const stateDisplay = trial.replay_state || trial.state;

    return (
        <div className={cardCls} onClick={() => setSelectedTicker(trial.ticker)}>
            <div className={styles.trialMain}>
                <div className={styles.trialInfo}>
                    <div className={styles.infoRow}>
                        {/* SECTION 1: IDENTITY */}
                        <div className={styles.infoSection}>
                            <div className={styles.tickerBlock}>
                                <span className={styles.ticker}>{cleanTicker(trial.ticker)}</span>
                                <span className={`${styles.badgeDir} ${isLong ? styles.badgeLong : styles.badgeShort}`}>
                                    {isLong ? 'LONG' : 'SHORT'}
                                </span>
                            </div>
                            <div className={styles.moveTag}>
                                <MoveTag pct={trial.final_move ?? trial.latest_move} />
                            </div>
                        </div>

                        {/* SECTION 2: META STATS */}
                        <div className={styles.infoSection}>
                            <div className={styles.metaRow}>
                                <div className={styles.metaGroupCompact}>
                                    <span className={styles.metaLabel}>TRG</span>
                                    <span className={styles.metaVal}>{smartFmt(Number(trial.trigger_price))}</span>
                                </div>
                                <div className={styles.metaGroupCompact}>
                                    <span className={styles.metaLabel}>TIME</span>
                                    <span className={styles.metaVal}>{fmtTime(trial.detected_at)}</span>
                                </div>
                                <div className={styles.metaGroupCompact}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <StateBadge state={stateDisplay} verdict={isResolved ? trial.verdict : null} />
                                        <CooldownProgress trial={trial} />
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* SECTION 3: ANALYTICS */}
                        <div className={styles.infoSection}>
                            <div className={styles.trialAnalytics}>
                                <MasterContextStrip master={trial.master_state} />
                                <RuleStrip rulesJson={trial.latest_rules} />
                            </div>
                        </div>
                    </div>

                    <button
                        className={styles.expandBtnHeader}
                        onClick={(e) => { e.stopPropagation(); onExpand(trial.trial_id); }}
                        title="Forensic Details"
                    >
                        <Maximize2 size={14} />
                    </button>
                </div>

                <div className={styles.trialVisuals}>
                    <TrialMiniChart trial={trial} />
                </div>
            </div>
        </div>
    );

}

// ── Collapsed-mode live highlights ticker ─────────────────────────────────────
// Shows a compact horizontal scrolling summary of active trials + recent
// verdicts. Updates automatically whenever active/resolved state changes.
function CollapsedHighlights({ active, resolved }) {
    const items = useMemo(() => {
        const out = [];
        for (const t of active.slice(0, 8)) {
            const ticker = cleanTicker(t.ticker);
            const isLong = t.direction === 'LONG';
            const move = t.latest_move ?? t.final_move;
            const moveFmt = move != null ? `${move > 0 ? '+' : ''}${Number(move).toFixed(2)}%` : null;
            const state = (t.replay_state || t.state || '').replace('_', ' ');
            out.push({ key: t.trial_id, type: 'active', ticker, isLong, moveFmt, state });
        }
        for (const t of resolved.slice(0, 5)) {
            const ticker = cleanTicker(t.ticker);
            const isLong = t.direction === 'LONG';
            const move = t.final_move ?? t.latest_move;
            const moveFmt = move != null ? `${move > 0 ? '+' : ''}${Number(move).toFixed(2)}%` : null;
            const confirmed = t.verdict === 'CONFIRMED';
            out.push({ key: t.trial_id + '-r', type: 'resolved', ticker, isLong, moveFmt, confirmed, verdict: t.verdict });
        }
        return out;
    }, [active, resolved]);

    if (!items.length) return (
        <div className={styles.collapsedEmpty}>No active trials · awaiting scan data…</div>
    );

    return (
        <div className={styles.collapsedTicker}>
            <span className={styles.tickerLabel}>LIVE</span>
            <div className={styles.tickerTrack}>
                {items.map(item => (
                    <span key={item.key} className={styles.tickerChip}
                        style={{ borderColor: item.isLong ? 'rgba(104,211,145,0.25)' : 'rgba(252,129,129,0.25)' }}>
                        {/* Direction arrow */}
                        <svg width="9" height="9" viewBox="0 0 9 9" fill="none"
                            style={{ flexShrink: 0 }}
                            aria-hidden="true">
                            {item.isLong
                                ? <polyline points="1,7 4.5,2 8,7" stroke="#68d391" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                                : <polyline points="1,2 4.5,7 8,2" stroke="#fc8181" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
                            }
                        </svg>

                        {/* Coin ticker */}
                        <span style={{ color: item.isLong ? '#68d391' : '#fc8181', fontWeight: 800 }}>
                            {item.ticker}
                        </span>

                        {/* State or verdict */}
                        {item.type === 'active' && (
                            <span className={styles.tickerState}>{item.state}</span>
                        )}
                        {item.type === 'resolved' && (
                            <span style={{
                                fontSize: 8, fontWeight: 900, padding: '0 3px',
                                borderRadius: 3,
                                color: item.confirmed ? '#68d391' : '#fc8181',
                                background: item.confirmed ? 'rgba(104,211,145,0.1)' : 'rgba(252,129,129,0.1)',
                            }}>
                                {item.confirmed ? '✓ CONF' : '✗ FAIL'}
                            </span>
                        )}

                        {/* Move % */}
                        {item.moveFmt && (
                            <span style={{
                                color: item.moveFmt.startsWith('+') ? '#68d391' : '#fc8181',
                                fontWeight: 700, fontSize: 10,
                            }}>
                                {item.moveFmt}
                            </span>
                        )}
                    </span>
                ))}
            </div>
        </div>
    );
}

// ── Accessible collapse toggle button ─────────────────────────────────────────
function CollapseButton({ collapsed, onToggle }) {
    return (
        <button
            className={styles.collapseBtn}
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand 3rd Umpire panel' : 'Collapse 3rd Umpire panel'}
            type="button"
        >
            <svg
                width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                aria-hidden="true"
                style={{
                    transition: 'transform 0.25s ease',
                    transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                }}
            >
                <polyline points="6 9 12 15 18 9" />
            </svg>
        </button>
    );
}

export const ValidatorTimelineWidget = React.memo(function ValidatorTimelineWidget() {
    const containerRef = useRef(null);
    const { currentIndex, timeline, activeScan } = useTimeStore();
    const lastDataPush = useTimeStore(s => s.lastDataPush);
    const isLive = timeline.length > 0 && currentIndex === timeline.length - 1;
    const refTime = activeScan?.timestamp || new Date().toISOString();

    const [active, setActive] = useState([]);
    const [resolved, setResolved] = useState([]);
    const [showSettings, setShowSettings] = useState(false);
    const [loading, setLoading] = useState(true);
    const [expandedTrialId, setExpandedTrialId] = useState(null);
    // Persist collapsed state to localStorage so it survives page reloads.
    const [isCollapsed, setIsCollapsed] = useState(() => {
        try { return localStorage.getItem('3rdUmpire_collapsed') === 'true'; } catch { return false; }
    });
    const toggleCollapsed = (c) => {
        const next = typeof c === 'boolean' ? c : (prev => !prev);
        // Support both direct boolean and function updater from CollapseButton
        setIsCollapsed(prev => {
            const newVal = typeof next === 'function' ? next(prev) : next;
            try { localStorage.setItem('3rdUmpire_collapsed', String(newVal)); } catch {}
            return newVal;
        });
    };
    const pollRef = useRef(null);
    const refTimeRef = useRef(refTime);
    refTimeRef.current = refTime;

    // In-flight guard: cancel any pending request before issuing a new one.
    // Fixes the triple-fetch on mount caused by isLive flipping false→true while the
    // [fetchTrials, isLive] effect is also re-running. Without this, 3 simultaneous
    // requests for the same data race (each ~2.5s, all 63KB) — wasting backend CPU
    // and bandwidth. With AbortController, only the latest call survives.
    const inflightRef = useRef(null);

    const fetchTrials = useCallback(async () => {
        // Cancel any prior in-flight request — only the most recent one matters.
        if (inflightRef.current) inflightRef.current.abort();
        const controller = new AbortController();
        inflightRef.current = controller;

        try {
            const url = `/api/validator/trials?refTime=${encodeURIComponent(refTimeRef.current)}&limit=12`;
            const r = await fetch(url, { signal: controller.signal });
            if (r.ok) {
                const data = await r.json();
                setActive(data.active || []);
                setResolved(data.resolved || []);
            }
        } catch (err) {
            // Swallow AbortError (intentional cancel); log other errors for diagnosis
            if (err.name !== 'AbortError') {
                console.error('[ValidatorTimeline] trials fetch failed:', err);
            }
        } finally {
            // Only clear loading + inflight if this is still the latest request
            if (inflightRef.current === controller) {
                inflightRef.current = null;
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        fetchTrials();
        pollRef.current = setInterval(fetchTrials, isLive ? 10000 : 30000);
        return () => {
            clearInterval(pollRef.current);
            // Cancel any in-flight request on unmount/re-run to free the connection
            if (inflightRef.current) inflightRef.current.abort();
        };
    }, [fetchTrials, isLive]);

    // Explicit socket subscription for validator state machine events
    useEffect(() => {
        if (!isLive) return;
        const handler = () => { fetchTrials(); };
        socketService.on('validator-update', handler);
        return () => socketService.off('validator-update', handler);
    }, [isLive, fetchTrials]);

    // Viewport-priority invalidation: also reload on scan-update / stream-d-update
    // so validator data stays in sync with the rest of the dashboard push cycle.
    useDataInvalidation(containerRef, fetchTrials, lastDataPush);

    return (
        <div ref={containerRef} className={styles.widget}>
            {/* ── Header row ── */}
            <div className={styles.header}>
                <CollapseButton collapsed={isCollapsed} onToggle={toggleCollapsed} />

                <h4 className={`widget-title ${styles.widgetTitle}`}>
                    <Target size={16} strokeWidth={2.5} className="text-accent-blue" />
                    3RD UMPIRE
                    <div className={styles.badges}>
                        {isLive
                            ? <span className={styles.badgeLive}>LIVE</span>
                            : <span className={styles.badgeReplay}>REPLAY</span>}
                    </div>
                </h4>

                <div className={styles.headerActions}>
                    <button className={styles.iconBtn} onClick={() => setShowSettings(true)}
                        aria-label="Validator settings">
                        <Settings size={14} />
                    </button>
                </div>
            </div>

            {/* ── Collapsed-mode live highlights ── */}
            {isCollapsed && (
                <CollapsedHighlights active={active} resolved={resolved} />
            )}

            {!isCollapsed && (
                <div className={styles.validatorGrid}>
                    {/* ACTIVE COLUMN */}
                    <div className={styles.section}>
                        <div className="widget-title">
                            Active Trials <span className={styles.sectionCount}>{active.length}</span>
                        </div>
                        {loading ? <div className={styles.emptyState}>...</div> : (
                            <div className={styles.trialList}>
                                {active.map(t => <TrialCard key={t.trial_id} trial={t} isResolved={false} onExpand={setExpandedTrialId} />)}
                                {active.length === 0 && <div className={styles.emptyState}>No Active Trials</div>}
                            </div>
                        )}
                    </div>

                    {/* VERDICTS COLUMN */}
                    <div className={styles.section}>
                        <div className="widget-title">
                            Recent Verdicts <span className={styles.sectionCount}>{resolved.length}</span>
                        </div>
                        <div className={styles.trialList}>
                            {resolved.map(t => <TrialCard key={t.trial_id} trial={t} isResolved={true} onExpand={setExpandedTrialId} />)}
                            {resolved.length === 0 && <div className={styles.emptyState}>No Verdicts</div>}
                        </div>
                    </div>
                </div>
            )}

            {showSettings && <ValidatorSettingsModal onClose={() => setShowSettings(false)} />}
            {expandedTrialId && <TrialExpandedModal trialId={expandedTrialId} onClose={() => setExpandedTrialId(null)} />}
        </div>
    );
});
