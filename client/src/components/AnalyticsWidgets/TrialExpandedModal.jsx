import React, { useState, useEffect, useMemo } from 'react';
import {
    ComposedChart, Line, Area, Scatter,
    XAxis, YAxis, Tooltip, Legend,
    ReferenceLine, ReferenceArea,
    ResponsiveContainer,
} from 'recharts';
import { 
    X, ChevronUp, ChevronDown, CheckCircle2, XCircle, 
    Square, Inbox, Flag, Check, Zap, Info, Clock, 
    BarChart3, Activity, ShieldCheck, Target
} from 'lucide-react';
import styles from './TrialExpandedModal.module.css';

/**
 * TrialExpandedModal — Full forensic price chart for a single trial.
 */

function smartFmt(price) {
    if (price == null || isNaN(price) || price === 0) return '0';
    if (price >= 1000)  return price.toFixed(2);
    if (price >= 1)     return price.toFixed(4);
    if (price >= 0.01)  return price.toFixed(5);
    if (price >= 0.001) return price.toFixed(6);
    return price.toFixed(8);
}

function fmtTime(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtTimeFull(ms) {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const VERDICT_COLOR = { 
    CONFIRMED: 'var(--accent-green)', 
    FAILED: 'var(--accent-red)', 
    NEUTRAL_TIMEOUT: 'var(--text-muted)', 
    EARLY_FAVORABLE: 'var(--warning)' 
};

const STATE_COLOR = { 
    COOLDOWN: 'var(--text-muted)', 
    WATCHING: 'var(--accent-blue)', 
    RESOLVED: 'var(--accent-green)' 
};

const EMA_DEFS = [
    { key: 'ema200_4h',  color: '#2b6cb0', dash: '2 7', label: '4h EMA200' },
    { key: 'ema200_1h',  color: '#3182ce', dash: '2 5', label: '1h EMA200' },
    { key: 'ema200_15m', color: '#4299e1', dash: '2 4', label: '15m EMA200' },
    { key: 'ema200_5m',  color: '#63b3ed', dash: '3 3', label: '5m EMA200' },
];

export function TrialExpandedModal({ trialId, onClose }) {
    const [ohlc, setOhlc] = useState(null);
    const [stateLog, setStateLog] = useState([]);
    const [trial, setTrial] = useState(null);
    const [error, setError] = useState(null);
    const [intervalMin, setIntervalMin] = useState(5);
    const [loadingOhlc, setLoadingOhlc] = useState(true);

    const loadOhlc = (iv) => {
        setLoadingOhlc(true);
        fetch(`/api/validator/trial/${encodeURIComponent(trialId)}/ohlc?interval=${iv}`)
            .then(r => r.json())
            .then(d => { if (d.error) setError(d.error); else setOhlc(d); })
            .catch(e => setError(e.message))
            .finally(() => setLoadingOhlc(false));
    };

    useEffect(() => {
        loadOhlc(intervalMin);
        fetch(`/api/validator/trial/${encodeURIComponent(trialId)}/timeline`)
            .then(r => r.json())
            .then(d => {
                if (d.state_log)  setStateLog(d.state_log);
                if (d.trial)      setTrial(d.trial);
            })
            .catch(() => {});
    }, [trialId]);

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const handleInterval = (iv) => { setIntervalMin(iv); loadOhlc(iv); };

    const series = useMemo(() => {
        if (!ohlc?.candles) return [];
        return ohlc.candles.map(c => ({
            t: c.ts,
            price: c.close,
            samples: c.samples,
        }));
    }, [ohlc]);

    const { pMin, pMax } = useMemo(() => {
        if (!ohlc || series.length === 0) return { pMin: 0, pMax: 1 };
        const lvl = ohlc.levels;
        const all = [
            ...series.map(s => s.price),
            lvl.trigger, lvl.smart_level,
            lvl.ema200_5m, lvl.ema200_15m, lvl.ema200_1h, lvl.ema200_4h,
        ].filter(p => p != null && p > 0);
        const mn = Math.min(...all);
        const mx = Math.max(...all);
        const pad = (mx - mn) * 0.10 || mn * 0.02;
        return { pMin: mn - pad, pMax: mx + pad };
    }, [ohlc, series]);

    const isLong = ohlc?.direction === 'LONG';
    const lineColor = isLong ? 'var(--accent-green)' : 'var(--accent-red)';
    const areaFill  = isLong ? 'rgba(104,211,145,0.10)' : 'rgba(252,129,129,0.10)';
    const verdictColor = VERDICT_COLOR[ohlc?.verdict] || 'var(--text-muted)';

    const ph = ohlc?.phases || {};
    const cooldownStart = ph.detected_ms;
    const cooldownEnd   = ph.cooldown_until_ms;
    const watchStart    = ph.cooldown_until_ms || ph.detected_ms;
    const watchEnd      = ph.resolved_ms || series.at(-1)?.t;

    return (
        <>
            <div className={styles.overlay} onClick={onClose} />
            <div className={styles.panel}>
                {/* ── HEADER ── */}
                <div className={styles.header}>
                    {ohlc ? (
                        <>
                            <span className={styles.ticker}>{ohlc.ticker}</span>
                            <span className={styles.directionBadge} style={{
                                background: isLong ? 'rgba(104,211,145,0.15)' : 'rgba(252,129,129,0.15)',
                                color: lineColor,
                            }}>
                                {isLong ? <ChevronUp size={12} className="inline" /> : <ChevronDown size={12} className="inline" />} {isLong ? 'LONG' : 'SHORT'}
                            </span>
                            <span className={styles.metaText}>{ohlc.trigger_type} · {ohlc.level_type}</span>
                            {ohlc.verdict && (
                                <span className={styles.verdictText} style={{ color: verdictColor }}>
                                    {ohlc.verdict === 'CONFIRMED' ? <CheckCircle2 size={14} /> : ohlc.verdict === 'FAILED' ? <XCircle size={14} /> : <Square size={14} />} {ohlc.verdict}
                                </span>
                            )}
                        </>
                    ) : <span className={styles.metaText}>Loading forensic data...</span>}

                    <div className={styles.headerActions}>
                        <span className={styles.granularityLabel}>Granularity:</span>
                        {[1, 5, 15, 30].map(v => (
                            <button key={v} onClick={() => handleInterval(v)} className={`${styles.pill} ${intervalMin === v ? styles.pillActive : ''}`}>
                                {v}m
                            </button>
                        ))}
                        <button onClick={onClose} className={styles.closeBtn}>
                            <X size={14} /> Close
                        </button>
                    </div>
                </div>

                {error && <div style={{ padding: 20, color: 'var(--accent-red)' }}>Error: {error}</div>}

                {/* ── BODY ── */}
                <div className={styles.body}>

                    {/* ── CHART ── */}
                    <div className={styles.chartContainer}>
                        {loadingOhlc && (
                            <div className={styles.loading}>
                                <Activity size={24} className="animate-spin" />
                                <span style={{ marginLeft: 12 }}>Loading price forensics...</span>
                            </div>
                        )}

                        {!loadingOhlc && series.length === 0 && (
                            <div className={styles.empty}>
                                <Inbox size={48} opacity={0.2} />
                                <div>No price snapshots in master store for this window.</div>
                                <div style={{ fontSize: 11 }}>Try a wider granularity, or this trial pre-dates master store ingestion.</div>
                            </div>
                        )}

                        {!loadingOhlc && series.length > 0 && (
                            <>
                                <div className={styles.legendRow}>
                                    <span className={styles.legendItem}>
                                        <svg width={16} height={4}><line x1={0} y1={2} x2={16} y2={2} stroke={lineColor} strokeWidth={2} /></svg> Price Path
                                    </span>
                                    <span className={styles.legendItem}>
                                        <svg width={16} height={4}><line x1={0} y1={2} x2={16} y2={2} stroke="rgba(255,255,255,0.4)" strokeWidth={1.5} strokeDasharray="3 2" /></svg> Trigger
                                    </span>
                                    <span className={styles.legendItem}>
                                        <svg width={16} height={4}><line x1={0} y1={2} x2={16} y2={2} stroke="#f6ad55" strokeWidth={1.5} strokeDasharray="5 2" /></svg> {ohlc?.level_type || 'Level'}
                                    </span>
                                    {EMA_DEFS.filter(e => ohlc?.levels?.[e.key] > 0).map(e => (
                                        <span key={e.key} className={styles.legendItem}>
                                            <svg width={16} height={4}><line x1={0} y1={2} x2={16} y2={2} stroke={e.color} strokeWidth={1.5} strokeDasharray={e.dash} /></svg> {e.label}
                                        </span>
                                    ))}
                                    <span className={styles.legendItem}>
                                        <span style={{ width: 12, height: 8, background: 'rgba(160,174,192,0.15)', borderRadius: 2 }} /> Cooldown
                                    </span>
                                    <span className={styles.legendItem}>
                                        <span style={{ width: 12, height: 8, background: 'rgba(99,179,237,0.15)', borderRadius: 2 }} /> Watching
                                    </span>
                                </div>

                                <div style={{ flex: 1, minHeight: 0 }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ComposedChart data={series} margin={{ top: 8, right: 100, left: 0, bottom: 20 }}>
                                            <XAxis
                                                dataKey="t" type="number" scale="time"
                                                domain={['dataMin', 'dataMax']}
                                                tickFormatter={fmtTime}
                                                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                                                tickCount={10}
                                            />
                                            <YAxis
                                                domain={[pMin, pMax]}
                                                tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                                                tickFormatter={smartFmt}
                                                width={72}
                                                tickCount={8}
                                                axisLine={false}
                                                tickLine={false}
                                            />
                                            <Tooltip
                                                contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }}
                                                labelFormatter={(v) => fmtTimeFull(v)}
                                                formatter={(v, n) => [smartFmt(v), n === 'price' ? 'Price' : n]}
                                            />

                                            {cooldownStart != null && cooldownEnd != null && (
                                                <ReferenceArea x1={cooldownStart} x2={cooldownEnd}
                                                    fill="rgba(160,174,192,0.08)" stroke="none"
                                                />
                                            )}
                                            {watchStart != null && watchEnd != null && watchEnd > watchStart && (
                                                <ReferenceArea x1={watchStart} x2={watchEnd}
                                                    fill="rgba(99,179,237,0.06)" stroke="none"
                                                />
                                            )}

                                            {EMA_DEFS.map(({ key, color, dash, label }) => {
                                                const price = ohlc?.levels?.[key];
                                                if (!price || price <= 0) return null;
                                                return (
                                                    <ReferenceLine key={key} y={price}
                                                        stroke={color} strokeDasharray={dash} strokeWidth={1.2}
                                                        label={{ value: label, fill: color, fontSize: 8, position: 'right', offset: 4 }}
                                                    />
                                                );
                                            })}

                                            {ohlc?.levels?.smart_level > 0 && ohlc.levels.smart_level !== ohlc.levels.trigger && (
                                                <ReferenceLine y={ohlc.levels.smart_level}
                                                    stroke="#f6ad55" strokeDasharray="6 4" strokeWidth={1.5}
                                                    label={{ value: ohlc.level_type || 'Level', fill: '#f6ad55', fontSize: 9, position: 'right', offset: 4 }}
                                                />
                                            )}

                                            {ohlc?.levels?.trigger > 0 && (
                                                <ReferenceLine y={ohlc.levels.trigger}
                                                    stroke="rgba(255,255,255,0.3)" strokeDasharray="4 3" strokeWidth={1}
                                                    label={{ value: `Trigger @ ${smartFmt(ohlc.levels.trigger)}`, fill: 'var(--text-muted)', fontSize: 8, position: 'right', offset: 4 }}
                                                />
                                            )}

                                            {cooldownStart != null && (
                                                <ReferenceLine x={cooldownStart} stroke="#9f7aea" strokeDasharray="4 3" strokeWidth={1.5}
                                                    label={{ value: 'Zap TRIGGER', fill: '#9f7aea', fontSize: 9, position: 'insideTopLeft' }}
                                                />
                                            )}

                                            {ph.resolved_ms != null && (
                                                <ReferenceLine x={ph.resolved_ms}
                                                    stroke={verdictColor} strokeDasharray="4 3" strokeWidth={1.5}
                                                    label={{ value: `VERDICT: ${ohlc?.verdict || ''}`, fill: verdictColor, fontSize: 9, position: 'insideTopRight' }}
                                                />
                                            )}

                                            <Area
                                                type="monotone" dataKey="price"
                                                stroke={lineColor} strokeWidth={2.5}
                                                fill={areaFill}
                                                dot={{ r: 2.5, fill: lineColor, strokeWidth: 0 }}
                                                activeDot={{ r: 4, stroke: 'var(--bg-panel)', strokeWidth: 1 }}
                                                isAnimationActive={false}
                                            />
                                        </ComposedChart>
                                    </ResponsiveContainer>
                                </div>
                            </>
                        )}
                    </div>

                    {/* ── SIDE PANEL ── */}
                    <div className={styles.sidePanel}>
                        {(ohlc || trial) && (
                            <div className={styles.metaBox}>
                                <div className={styles.boxTitle}><Info size={10} className="inline mr-1" /> Trial Analytics</div>
                                {[
                                    ['Trigger @', smartFmt(ohlc?.levels?.trigger)],
                                    ['Level @', smartFmt(ohlc?.levels?.smart_level)],
                                    ['Detected', ohlc?.phases?.detected_ms && fmtTime(ohlc.phases.detected_ms)],
                                    ['Resolved', ohlc?.phases?.resolved_ms && fmtTime(ohlc.phases.resolved_ms)],
                                    ['Snapshots', ohlc?.candle_count],
                                ].filter(([, v]) => v != null).map(([k, v]) => (
                                    <div key={k} className={styles.metaRow}>
                                        <span className={styles.metaKey}>{k}</span>
                                        <span className={styles.metaVal}>{v}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div className={styles.metaBox} style={{ flex: 1 }}>
                            <div className={styles.boxTitle}><Activity size={10} className="inline mr-1" /> Lifecycle Transitions</div>
                            {stateLog.length === 0
                                ? <div className={styles.metaText}>No transitions detected.</div>
                                : stateLog.map((s, i) => {
                                    const rules = (() => { try { return Object.entries(JSON.parse(s.rule_snapshot || '{}')).filter(([k]) => k !== 'TRIGGER_VALID'); } catch { return []; } })();
                                    return (
                                        <div key={i} className={styles.logItem}>
                                            <div className={styles.logHeader}>
                                                <span className={styles.logState} style={{ color: STATE_COLOR[s.state] }}>{s.state}</span>
                                                <span className={styles.logTime}><Clock size={10} className="inline mr-1" /> {fmtTimeFull(new Date(s.changed_at).getTime())}</span>
                                            </div>
                                            <div className={styles.logPrice}>
                                                {smartFmt(s.current_price)}
                                                {s.unrealized_move_pct != null && (
                                                    <span style={{ fontWeight: 700, color: s.unrealized_move_pct > 0 ? 'var(--accent-green)' : 'var(--accent-red)' }}>
                                                        {s.unrealized_move_pct > 0 ? '+' : ''}{Number(s.unrealized_move_pct).toFixed(2)}%
                                                    </span>
                                                )}
                                            </div>
                                            {rules.length > 0 && (
                                                <div className={styles.rulesGrid}>
                                                    {rules.map(([id, r]) => (
                                                        <span key={id} className={styles.ruleChip} style={{
                                                            background: r.passed ? 'rgba(104,211,145,0.08)' : 'rgba(252,129,129,0.08)',
                                                            color: r.passed ? 'var(--accent-green)' : 'var(--accent-red)',
                                                            borderColor: r.passed ? 'rgba(104,211,145,0.15)' : 'rgba(252,129,129,0.15)',
                                                        }}>
                                                            {r.passed ? <Check size={8} /> : <X size={8} />} {id.replace('EMA_', '').replace('_ALIGN', '').replace('_HOLD', '').replace('_SUSTAIN', '').replace('_CONFIRM', '').replace(/_/g, ' ')}
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })
                            }
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}

