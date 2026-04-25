import React, { useState, useEffect, useMemo } from 'react';
import {
    LineChart, Line, ReferenceLine, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
    ScatterChart, Scatter,
} from 'recharts';
import styles from './ValidatorTimelineWidget.module.css';

/**
 * TrialExpandedModal — Full forensic chart for a single trial.
 *
 * Fetches /api/validator/trial/:trialId/timeline and renders:
 *   - Price line from master_timeline (real, not synthesized)
 *   - Reference lines: trigger price, level price, EMA200 5m/15m/1h/4h
 *   - State transition markers overlaid on the chart
 *   - Side panel: rule snapshots from each state transition
 */
export function TrialExpandedModal({ trialId, onClose }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/validator/trial/${encodeURIComponent(trialId)}/timeline`)
            .then(r => r.json())
            .then(j => { if (!cancelled) { if (j.error) setError(j.error); else setData(j); } })
            .catch(e => !cancelled && setError(e.message));
        return () => { cancelled = true; };
    }, [trialId]);

    // ESC to close
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const series = useMemo(() => {
        if (!data?.master_timeline) return [];
        return data.master_timeline.map(snap => ({
            t: snap.timestamp,
            tMs: new Date(snap.timestamp).getTime(),
            price: snap.price,
            source: snap.trigger_source,
        }));
    }, [data]);

    const stateMarkers = useMemo(() => {
        if (!data?.state_log) return [];
        return data.state_log.map(s => ({
            tMs: new Date(s.changed_at).getTime(),
            price: s.current_price || data.trial.trigger_price,
            state: s.state,
            move: s.unrealized_move_pct,
        }));
    }, [data]);

    if (error) {
        return (
            <ModalShell onClose={onClose} title="Error">
                <div style={{ color: '#fc8181' }}>{error}</div>
            </ModalShell>
        );
    }
    if (!data) {
        return (
            <ModalShell onClose={onClose} title="Loading…">
                <div style={{ color: '#718096' }}>Fetching trial timeline…</div>
            </ModalShell>
        );
    }

    const t = data.trial;
    const isLong = t.direction === 'LONG';
    const featureSnap = (() => { try { return JSON.parse(t.feature_snapshot); } catch { return {}; } })();
    const trig = Number(t.trigger_price);
    const lvl  = Number(t.level_price) || trig;
    const ema5m  = featureSnap.ema200_5m_dist  != null ? trig / (1 + featureSnap.ema200_5m_dist  / 100) : null;
    const ema15m = featureSnap.ema200_15m_dist != null ? trig / (1 + featureSnap.ema200_15m_dist / 100) : null;
    const ema1h  = featureSnap.ema200_1h_dist  != null ? trig / (1 + featureSnap.ema200_1h_dist  / 100) : null;
    const ema4h  = featureSnap.ema200_4h_dist  != null ? trig / (1 + featureSnap.ema200_4h_dist  / 100) : null;

    const STATE_COLORS = {
        COOLDOWN: '#a0aec0', WATCHING: '#63b3ed', RESOLVED: '#68d391',
    };

    return (
        <ModalShell onClose={onClose} title={`${t.ticker} ${isLong ? '▲ LONG' : '▼ SHORT'} — ${t.trigger_type}`}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
                {/* CHART */}
                <div style={{ minHeight: 420 }}>
                    {series.length === 0 ? (
                        <div style={{ color: '#718096', padding: 40, textAlign: 'center', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: 8 }}>
                            No master_coin_store data in window<br />
                            <small>(trial may pre-date master store ingestion)</small>
                        </div>
                    ) : (
                        <>
                            <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#cbd5e0' }}>Price Action vs Levels & EMA Hierarchy</h4>
                            <div style={{ height: 380 }}>
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={series} margin={{ top: 8, right: 16, left: 8, bottom: 8 }}>
                                        <XAxis
                                            dataKey="tMs" type="number" scale="time"
                                            domain={['dataMin', 'dataMax']}
                                            tickFormatter={(v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            tick={{ fontSize: 10, fill: '#718096' }}
                                        />
                                        <YAxis
                                            domain={['dataMin', 'dataMax']}
                                            tick={{ fontSize: 10, fill: '#718096' }}
                                            tickFormatter={(v) => Number(v).toFixed(4)}
                                            width={70}
                                        />
                                        <Tooltip
                                            contentStyle={{ background: '#0d1117', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: 11 }}
                                            labelFormatter={(v) => new Date(v).toLocaleString()}
                                        />
                                        <Legend wrapperStyle={{ fontSize: 10 }} />

                                        {/* Reference lines */}
                                        <ReferenceLine y={trig} stroke="#cbd5e0" strokeDasharray="3 3" label={{ value: `Trigger ${trig.toFixed(4)}`, fill: '#cbd5e0', fontSize: 10, position: 'insideTopRight' }} />
                                        {lvl !== trig && <ReferenceLine y={lvl} stroke="#f6ad55" strokeDasharray="4 4" label={{ value: `${t.level_type} ${lvl.toFixed(4)}`, fill: '#f6ad55', fontSize: 10, position: 'insideTopLeft' }} />}
                                        {ema5m  && <ReferenceLine y={ema5m}  stroke="#63b3ed" strokeDasharray="1 4" strokeOpacity={0.7} label={{ value: '5m EMA200',  fill: '#63b3ed', fontSize: 9, position: 'right' }} />}
                                        {ema15m && <ReferenceLine y={ema15m} stroke="#4299e1" strokeDasharray="1 4" strokeOpacity={0.7} label={{ value: '15m EMA200', fill: '#4299e1', fontSize: 9, position: 'right' }} />}
                                        {ema1h  && <ReferenceLine y={ema1h}  stroke="#3182ce" strokeDasharray="1 4" strokeOpacity={0.7} label={{ value: '1h EMA200',  fill: '#3182ce', fontSize: 9, position: 'right' }} />}
                                        {ema4h  && <ReferenceLine y={ema4h}  stroke="#2b6cb0" strokeDasharray="1 4" strokeOpacity={0.7} label={{ value: '4h EMA200',  fill: '#2b6cb0', fontSize: 9, position: 'right' }} />}

                                        {/* Detection vertical line */}
                                        <ReferenceLine x={new Date(t.detected_at).getTime()} stroke="#9f7aea" strokeDasharray="2 2" label={{ value: '⚡ Trigger', fill: '#9f7aea', fontSize: 9, position: 'top' }} />
                                        {t.resolved_at && <ReferenceLine x={new Date(t.resolved_at).getTime()} stroke="#ed8936" strokeDasharray="2 2" label={{ value: `🏁 ${t.verdict}`, fill: '#ed8936', fontSize: 9, position: 'top' }} />}

                                        <Line
                                            type="monotone" dataKey="price"
                                            stroke={isLong ? '#68d391' : '#fc8181'}
                                            strokeWidth={2}
                                            dot={{ r: 1.5 }}
                                            name="Price"
                                            isAnimationActive={false}
                                        />
                                    </LineChart>
                                </ResponsiveContainer>
                            </div>
                        </>
                    )}
                </div>

                {/* SIDE PANEL: state transitions */}
                <div>
                    <h4 style={{ margin: '0 0 8px', fontSize: 13, color: '#cbd5e0' }}>State Transitions</h4>
                    <div style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {stateMarkers.length === 0 ? (
                            <div style={{ color: '#718096', fontSize: 11 }}>No state transitions logged.</div>
                        ) : stateMarkers.map((s, i) => (
                            <div key={i} style={{
                                padding: 8, borderRadius: 6,
                                background: 'rgba(255,255,255,0.03)',
                                border: `1px solid ${STATE_COLORS[s.state] || 'rgba(255,255,255,0.1)'}40`,
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                                    <span style={{ color: STATE_COLORS[s.state] || '#cbd5e0', fontWeight: 600 }}>
                                        {s.state}
                                    </span>
                                    <span style={{ color: '#718096' }}>
                                        {new Date(s.tMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                    </span>
                                </div>
                                <div style={{ fontSize: 10, color: '#a0aec0', marginTop: 4 }}>
                                    Price: ${Number(s.price).toFixed(4)}
                                    {s.move != null && (
                                        <span style={{ marginLeft: 8, color: s.move > 0 ? '#68d391' : '#fc8181' }}>
                                            {s.move > 0 ? '+' : ''}{Number(s.move).toFixed(2)}%
                                        </span>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>

                    <h4 style={{ margin: '16px 0 8px', fontSize: 13, color: '#cbd5e0' }}>Trial Meta</h4>
                    <div style={{ fontSize: 11, color: '#a0aec0', lineHeight: 1.7 }}>
                        <div><strong>Trial ID:</strong> <code style={{ fontSize: 10 }}>{t.trial_id}</code></div>
                        <div><strong>Detected:</strong> {new Date(t.detected_at).toLocaleString()}</div>
                        {t.resolved_at && <div><strong>Resolved:</strong> {new Date(t.resolved_at).toLocaleString()}</div>}
                        {t.verdict && <div><strong>Verdict:</strong> <span style={{ color: t.verdict === 'CONFIRMED' ? '#68d391' : t.verdict === 'FAILED' ? '#fc8181' : '#a0aec0' }}>{t.verdict}</span></div>}
                        {t.failure_reason && <div><strong>Reason:</strong> {t.failure_reason}</div>}
                        <div><strong>Master snapshots:</strong> {data.master_timeline.length}</div>
                        <div><strong>Window:</strong> {new Date(data.window.from).toLocaleTimeString()} → {new Date(data.window.to).toLocaleTimeString()}</div>
                    </div>
                </div>
            </div>
        </ModalShell>
    );
}

function ModalShell({ title, children, onClose }) {
    return (
        <>
            <div className={styles.overlay} onClick={onClose} />
            <div style={{
                position: 'fixed', top: '5%', left: '5%', right: '5%', bottom: '5%',
                background: '#0d1117', border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 10, zIndex: 1000, padding: 20, overflow: 'auto',
                boxShadow: '0 20px 60px rgba(0,0,0,0.7)',
            }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, paddingBottom: 12, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <h3 style={{ margin: 0, color: '#e2e8f0', fontSize: 16 }}>{title}</h3>
                    <button onClick={onClose} style={{
                        background: 'rgba(252,129,129,0.15)', color: '#fc8181',
                        border: '1px solid rgba(252,129,129,0.3)', borderRadius: 6,
                        padding: '4px 12px', cursor: 'pointer', fontSize: 12,
                    }}>✕ Close (Esc)</button>
                </div>
                {children}
            </div>
        </>
    );
}
