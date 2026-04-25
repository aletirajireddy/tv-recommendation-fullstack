import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { useTimeStore } from '../../store/useTimeStore';
import socketService from '../../services/SocketService';
import { ValidatorSettingsModal } from './ValidatorSettingsModal';
import { TrialMiniChart } from './TrialMiniChart';
import { TrialExpandedModal } from './TrialExpandedModal';
import styles from './ValidatorTimelineWidget.module.css';

const RULE_LABELS = {
    TRIGGER_VALID:   'Trigger',
    EMA_5M_HOLD:     '5m EMA200 Hold',
    EMA_15M_SUSTAIN: '15m EMA200 Sustain',
    EMA_1H_ALIGN:    '1H EMA200 Align',
    EMA_4H_ALIGN:    '4H EMA200 Align (Major)',
    VOLUME_CONFIRM:  'Volume Confirmed',
    REACTIVE_ZONE:   'Reactive Zone Touch',
};

const ROLE_COLORS = { GATE: '#fc8181', MAJOR: '#f6ad55', MINOR: '#63b3ed', WEIGHT: '#718096' };

function smartFmt(price) {
    if (price == null || isNaN(price) || price === 0) return '0';
    if (price >= 1000)  return price.toFixed(2);
    if (price >= 1)     return price.toFixed(4);
    if (price >= 0.01)  return price.toFixed(5);
    if (price >= 0.001) return price.toFixed(6);
    return price.toFixed(8);
}

function fmtTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeRemaining(untilIso) {
    if (!untilIso) return null;
    const ms = new Date(untilIso) - Date.now();
    if (ms <= 0) return '0m';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${m}m ${s}s`;
}

function MoveTag({ pct }) {
    if (pct == null) return null;
    const cls = pct > 0 ? styles.movePos : pct < 0 ? styles.moveNeg : styles.moveNeutral;
    return <span className={cls}>{pct > 0 ? '+' : ''}{Number(pct).toFixed(2)}%</span>;
}

function StateBadge({ state, verdict }) {
    const display = verdict || state;
    const cls = {
        COOLDOWN: styles.stateCooldown,
        WATCHING: styles.stateWatching,
        CONFIRMED: styles.stateConfirmed,
        FAILED: styles.stateFailed,
        NEUTRAL_TIMEOUT: styles.stateNeutral,
        EARLY_FAVORABLE: styles.stateEarly,
    }[display] || styles.stateNeutral;
    const icons = {
        COOLDOWN: '⏱', WATCHING: '👀', CONFIRMED: '✅',
        FAILED: '❌', NEUTRAL_TIMEOUT: '⏹', EARLY_FAVORABLE: '⚡'
    };
    return <span className={`${styles.badgeState} ${cls}`}>{icons[display] || ''} {display?.replace('_', ' ')}</span>;
}

// Compact context strip — pulls EMA stack / vol / mood from the master_coin_store
// snapshot taken AT the trial's trigger moment. Shown inline (no click required)
// so the user sees market context without expanding rules.
function MasterContextStrip({ master }) {
    if (!master) return null;
    const a = master.stream_a || {};
    const c = master.stream_c || {};
    const items = [];
    // EMA hierarchy distances (from feature snapshot in stream A)
    const emaFmt = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
    if (a.ema200_5m_dist != null)  items.push({ k: '5m EMA',  v: emaFmt(a.ema200_5m_dist) });
    if (a.ema200_15m_dist != null) items.push({ k: '15m EMA', v: emaFmt(a.ema200_15m_dist) });
    if (a.ema200_1h_dist != null)  items.push({ k: '1h EMA',  v: emaFmt(a.ema200_1h_dist) });
    if (a.ema200_4h_dist != null)  items.push({ k: '4h EMA',  v: emaFmt(a.ema200_4h_dist) });
    if (a.rsi_h1 != null)          items.push({ k: 'RSI 1h',  v: Number(a.rsi_h1).toFixed(1) });
    if (a.vol_spike != null)       items.push({ k: 'VolSpike', v: a.vol_spike ? '✓' : '·' });
    if (a.market_mood)             items.push({ k: 'Mood',    v: a.market_mood });
    if (!items.length) return null;
    return (
        <div className={styles.masterStrip}>
            {items.map((i, idx) => (
                <span key={idx} className={styles.masterChip}>
                    <span className={styles.masterChipKey}>{i.k}</span>
                    <span className={styles.masterChipVal}>{i.v}</span>
                </span>
            ))}
        </div>
    );
}

function RuleChecklist({ rulesJson }) {
    let rules = {};
    try { rules = typeof rulesJson === 'string' ? JSON.parse(rulesJson) : (rulesJson || {}); } catch {}
    const entries = Object.entries(rules).filter(([id]) => id !== 'TRIGGER_VALID');
    if (!entries.length) return null;
    return (
        <div className={styles.rules}>
            {entries.map(([id, r]) => {
                const icon = r.passed === true ? '✓' : r.passed === false ? '✗' : '?';
                const cls = r.passed === true ? styles.rulePass : r.passed === false ? styles.ruleFail : styles.ruleUnknown;
                return (
                    <div className={styles.ruleRow} key={id}>
                        <span className={cls}>{icon}</span>
                        <span className={styles.ruleLabel}>{RULE_LABELS[id] || id}</span>
                        {r.observed && <span className={styles.ruleObserved}>{r.observed}</span>}
                        <span className={styles.roleTag} style={{ color: ROLE_COLORS[r.role] }}>{r.role}</span>
                    </div>
                );
            })}
        </div>
    );
}

function TrialCard({ trial, isResolved, onExpand }) {
    const [rulesOpen, setRulesOpen] = useState(false);
    const isLong = trial.direction === 'LONG';
    const cardCls = `${styles.trialCard} ${isLong ? styles.trialCardLong : styles.trialCardShort}`;
    const stateDisplay = trial.replay_state || trial.state;
    const remainingLabel = stateDisplay === 'COOLDOWN' ? timeRemaining(trial.cooldown_until)
        : stateDisplay === 'WATCHING' ? timeRemaining(trial.watch_until)
        : null;

    return (
        <div className={cardCls} style={{ cursor: 'default' }}
             onClick={(e) => {
                 // Toggle inline rules; don't trigger when expand button clicked.
                 if (e.target.closest('button')) return;
                 setRulesOpen(o => !o);
             }}>
            <div className={styles.trialHeader}>
                <div className={styles.trialInfo}>
                    <span className={styles.ticker}>{trial.ticker}</span>
                    <span className={`${styles.badgeDir} ${isLong ? styles.badgeLong : styles.badgeShort}`}>
                        {isLong ? '▲ LONG' : '▼ SHORT'}
                    </span>
                    <span className={styles.badgeType}>{trial.trigger_type}</span>
                    {trial.level_type && <span className={styles.badgeType}>{trial.level_type}</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {(trial.latest_move != null || trial.final_move != null) &&
                        <MoveTag pct={trial.final_move ?? trial.latest_move} />}
                    <StateBadge state={stateDisplay} verdict={isResolved ? trial.verdict : null} />
                    <button
                        onClick={(e) => { e.stopPropagation(); onExpand(trial.trial_id); }}
                        title="Expand full chart"
                        style={{
                            background: 'rgba(99,179,237,0.15)', color: '#63b3ed',
                            border: '1px solid rgba(99,179,237,0.3)', borderRadius: 4,
                            padding: '2px 8px', fontSize: 10, cursor: 'pointer',
                        }}
                    >⤢</button>
                </div>
            </div>

            <div className={styles.trialMeta}>
                <span>@ {smartFmt(Number(trial.trigger_price))}</span>
                {trial.level_price && <span>Level {smartFmt(Number(trial.level_price))}</span>}
                <span>{fmtTime(trial.detected_at)}</span>
                {isResolved && trial.resolved_at && <span>→ {fmtTime(trial.resolved_at)}</span>}
                {trial.failure_reason && <span style={{ color: '#fc8181' }}>Reason: {trial.failure_reason.replace(/_/g, ' ')}</span>}
            </div>

            {remainingLabel && (
                <div className={styles.timerRow}>
                    <span>⏱ {stateDisplay === 'COOLDOWN' ? 'Cooldown ends:' : 'Watch until:'}</span>
                    <span style={{ color: '#f6ad55', fontWeight: 600 }}>{remainingLabel}</span>
                </div>
            )}

            {/* Inline master_coin_store context — visible without expand */}
            <MasterContextStrip master={trial.master_state} />

            {/* Inline mini chart (120px) — always visible per Q2 */}
            <TrialMiniChart trial={trial} />

            {rulesOpen && (trial.latest_rules || (isResolved && trial.failure_reason)) && (
                <RuleChecklist rulesJson={trial.latest_rules} />
            )}
        </div>
    );
}

function StatsPanel({ stats }) {
    const chartData = stats
        .filter(s => s.sample_count >= 3)
        .slice(0, 10)
        .map(s => ({
            name: s.stat_key.replace(/dir=|vol=|ema1h=|ema4h=|trigger=/g, '').replace(/\|/g, ' ').trim().slice(0, 20),
            winRate: s.win_rate_30m,
            samples: s.sample_count,
            confidence: s.confidence
        }));

    return (
        <div className={styles.statsPanel}>
            <table className={styles.statsTable}>
                <thead>
                    <tr>
                        <th>Combination</th>
                        <th>Win Rate</th>
                        <th>Samples</th>
                        <th>Confidence</th>
                    </tr>
                </thead>
                <tbody>
                    {stats.slice(0, 12).map(s => {
                        const wrCls = s.win_rate_30m >= 60 ? styles.winRateHigh : s.win_rate_30m >= 45 ? styles.winRateMed : styles.winRateLow;
                        const confCls = s.confidence === 'HIGH' ? styles.confHigh : s.confidence === 'MEDIUM' ? styles.confMed : styles.confLow;
                        return (
                            <tr key={s.stat_key}>
                                <td style={{ fontSize: 10, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                    title={s.stat_key}>
                                    {s.stat_key.replace(/dir=|vol=|ema1h=|ema4h=|trigger=/g, '').replace(/\|/g, ' › ')}
                                </td>
                                <td className={wrCls}>{s.win_rate_30m}%</td>
                                <td>{s.sample_count}</td>
                                <td className={confCls}>{s.confidence}</td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>

            {chartData.length > 0 && (
                <div style={{ marginTop: 16, height: 140 }}>
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData} margin={{ top: 0, right: 8, left: -20, bottom: 0 }}>
                            <XAxis dataKey="name" tick={{ fontSize: 9, fill: '#4a5568' }} interval={0} angle={-20} textAnchor="end" />
                            <YAxis tick={{ fontSize: 9, fill: '#4a5568' }} domain={[0, 100]} />
                            <Tooltip
                                contentStyle={{ background: '#0d1117', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: 11 }}
                                formatter={(v, n) => [`${v}%`, 'Win Rate']}
                            />
                            <Bar dataKey="winRate" radius={[3, 3, 0, 0]}>
                                {chartData.map((entry, i) => (
                                    <Cell key={i} fill={entry.winRate >= 60 ? '#68d391' : entry.winRate >= 45 ? '#f6ad55' : '#fc8181'} />
                                ))}
                            </Bar>
                        </BarChart>
                    </ResponsiveContainer>
                </div>
            )}
        </div>
    );
}

export function ValidatorTimelineWidget() {
    const { currentIndex, timeline, activeScan } = useTimeStore();
    const isLive = timeline.length > 0 && currentIndex === timeline.length - 1;
    const refTime = activeScan?.timestamp || new Date().toISOString();

    const [active, setActive] = useState([]);
    const [resolved, setResolved] = useState([]);
    const [stats, setStats] = useState([]);
    const [showStats, setShowStats] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showCsvModal, setShowCsvModal] = useState(false);
    const [csvFrom, setCsvFrom] = useState('');
    const [csvTo, setCsvTo] = useState('');
    const [loading, setLoading] = useState(true);
    const [expandedTrialId, setExpandedTrialId] = useState(null);
    const pollRef = useRef(null);

    const fetchTrials = useCallback(async () => {
        try {
            const url = `/api/validator/trials?refTime=${encodeURIComponent(refTime)}&limit=20`;
            const r = await fetch(url);
            if (!r.ok) return;
            const data = await r.json();
            setActive(data.active || []);
            setResolved(data.resolved || []);
        } catch { /* silent */ } finally {
            setLoading(false);
        }
    }, [refTime]);

    const fetchStats = useCallback(async () => {
        try {
            const r = await fetch('/api/validator/stats');
            if (r.ok) setStats(await r.json());
        } catch {}
    }, []);

    useEffect(() => {
        fetchTrials();
        pollRef.current = setInterval(fetchTrials, isLive ? 10000 : 30000);
        return () => clearInterval(pollRef.current);
    }, [fetchTrials, isLive]);

    useEffect(() => {
        if (showStats) fetchStats();
    }, [showStats, fetchStats]);

    // Live socket subscription for real-time updates
    useEffect(() => {
        if (!isLive) return;
        socketService.connect();
        const handler = () => { fetchTrials(); };
        socketService.on('validator-update', handler);
        return () => socketService.off('validator-update');
    }, [isLive, fetchTrials]);

    const handleExportCsv = async () => {
        const from = csvFrom || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const to = csvTo || new Date().toISOString().slice(0, 10);
        window.location.href = `/api/validator/export?from=${from}T00:00:00Z&to=${to}T23:59:59Z`;
        setShowCsvModal(false);
    };

    const isSimulation = !isLive;
    const totalActive = active.length;
    const totalResolved = resolved.length;

    return (
        <div className={styles.widget}>
            {/* HEADER */}
            <div className={styles.header}>
                <h4 className={styles.title}>
                    🎯 3rd Umpire Validator
                    <div className={styles.badges}>
                        {isLive
                            ? <span className={styles.badgeLive}>● LIVE</span>
                            : <span className={styles.badgeReplay}>⏪ REPLAY</span>}
                        {isSimulation && <span className={styles.badgeSim}>🔬 SIMULATION</span>}
                    </div>
                </h4>
                <div className={styles.headerActions}>
                    <button className={`${styles.iconBtn} ${showStats ? styles.iconBtnActive : ''}`}
                        onClick={() => setShowStats(s => !s)}>
                        📊 Stats
                    </button>
                    <button className={styles.iconBtn} onClick={() => setShowCsvModal(true)}>
                        📥 Export
                    </button>
                    <button className={styles.iconBtn} onClick={() => setShowSettings(true)}>
                        ⚙ Settings
                    </button>
                </div>
            </div>

            {/* ACTIVE TRIALS */}
            <div className={styles.section}>
                <div className={styles.sectionTitle}>
                    Active Trials
                    <span className={styles.sectionCount}>{totalActive}</span>
                </div>
                {loading ? (
                    <div className={styles.emptyState}>Loading…</div>
                ) : totalActive === 0 ? (
                    <div className={styles.emptyState}>No active trials — waiting for Stream C smart level events</div>
                ) : (
                    <div className={styles.trialList}>
                        {active.map(t => <TrialCard key={t.trial_id} trial={t} isResolved={false} onExpand={setExpandedTrialId} />)}
                    </div>
                )}
            </div>

            <hr className={styles.divider} />

            {/* STATS PANEL */}
            {showStats && (
                <>
                    <div className={styles.section}>
                        <div className={styles.sectionTitle}>
                            Pattern Win Rates
                            <button
                                className={styles.iconBtn}
                                style={{ padding: '2px 8px', fontSize: 10 }}
                                onClick={async () => {
                                    await fetch('/api/validator/stats/rebuild', { method: 'POST' });
                                    fetchStats();
                                }}>
                                Rebuild
                            </button>
                        </div>
                        {stats.length === 0
                            ? <div className={styles.emptyState}>No stats yet — needs resolved trials</div>
                            : <StatsPanel stats={stats} />}
                    </div>
                    <hr className={styles.divider} />
                </>
            )}

            {/* RECENT VERDICTS */}
            <div className={styles.section}>
                <div className={styles.sectionTitle}>
                    Recent Verdicts
                    <span className={styles.sectionCount}>{totalResolved}</span>
                </div>
                {totalResolved === 0 ? (
                    <div className={styles.emptyState}>No resolved trials in this window</div>
                ) : (
                    <div className={styles.trialList}>
                        {resolved.map(t => <TrialCard key={t.trial_id} trial={t} isResolved={true} onExpand={setExpandedTrialId} />)}
                    </div>
                )}
            </div>

            {/* SETTINGS MODAL */}
            {showSettings && <ValidatorSettingsModal onClose={() => setShowSettings(false)} />}

            {/* TRIAL EXPANDED MODAL — full forensic chart */}
            {expandedTrialId && (
                <TrialExpandedModal trialId={expandedTrialId} onClose={() => setExpandedTrialId(null)} />
            )}

            {/* CSV EXPORT MODAL */}
            {showCsvModal && (
                <>
                    <div className={styles.overlay} onClick={() => setShowCsvModal(false)} />
                    <div className={styles.csvModal}>
                        <h4>📥 Export Training Data (CSV)</h4>
                        <label>From date</label>
                        <input type="date" value={csvFrom} onChange={e => setCsvFrom(e.target.value)} />
                        <label>To date</label>
                        <input type="date" value={csvTo} onChange={e => setCsvTo(e.target.value)} />
                        <p style={{ fontSize: 11, color: '#718096', margin: '4px 0' }}>
                            Leave blank to use last 30 days. Exports all feature columns for offline ML training.
                        </p>
                        <div className={styles.csvModalActions}>
                            <button className={styles.btnSecondary} onClick={() => setShowCsvModal(false)}>Cancel</button>
                            <button className={styles.btnPrimary} onClick={handleExportCsv}>Download CSV</button>
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
