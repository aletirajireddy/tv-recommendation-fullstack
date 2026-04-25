import React, { useState, useEffect, useMemo } from 'react';
import {
    ComposedChart, Line, Area, Scatter,
    XAxis, YAxis, Tooltip, Legend,
    ReferenceLine, ReferenceArea,
    ResponsiveContainer,
} from 'recharts';
import styles from './ValidatorTimelineWidget.module.css';

/**
 * TrialExpandedModal — Full forensic price chart for a single trial.
 *
 * Uses Recharts ComposedChart (responsive, correct proportions).
 * Data: /api/validator/trial/:id/ohlc (price series) +
 *       /api/validator/trial/:id/timeline (state log)
 *
 * Chart shows:
 *   - Real price line from master_coin_store snapshots (colored by direction)
 *   - Area fill (LONG=green, SHORT=red) below/above trigger to show P&L visually
 *   - Phase bands: COOLDOWN (grey) / WATCHING (blue) zones
 *   - Key price levels: Trigger, Smart Level, all 4 EMA200s
 *   - Trigger vertical marker (purple) + Verdict vertical marker (green/red)
 *   - Individual scan snapshot dots (show actual data density)
 *
 * Side panel: state transitions with rule pass/fail chips + trial meta
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

const VERDICT_COLOR = { CONFIRMED: '#68d391', FAILED: '#fc8181', NEUTRAL_TIMEOUT: '#a0aec0', EARLY_FAVORABLE: '#f6ad55' };
const STATE_COLOR   = { COOLDOWN: '#a0aec0', WATCHING: '#63b3ed', RESOLVED: '#68d391' };

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

    // Build price series from candle close prices
    const series = useMemo(() => {
        if (!ohlc?.candles) return [];
        return ohlc.candles.map(c => ({
            t: c.ts,
            price: c.close,
            samples: c.samples,
        }));
    }, [ohlc]);

    // Price domain
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
    const lineColor = isLong ? '#68d391' : '#fc8181';
    const areaFill  = isLong ? 'rgba(104,211,145,0.10)' : 'rgba(252,129,129,0.10)';
    const verdictColor = VERDICT_COLOR[ohlc?.verdict] || '#a0aec0';

    const ph = ohlc?.phases || {};
    const cooldownStart = ph.detected_ms;
    const cooldownEnd   = ph.cooldown_until_ms;
    const watchStart    = ph.cooldown_until_ms || ph.detected_ms;
    const watchEnd      = ph.resolved_ms || series.at(-1)?.t;

    return (
        <>
            <div className={styles.overlay} onClick={onClose} />
            <div style={{
                position: 'fixed', top: '3%', left: '2%', right: '2%', bottom: '3%',
                background: '#0d1117', border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 10, zIndex: 1000,
                display: 'flex', flexDirection: 'column',
                boxShadow: '0 24px 80px rgba(0,0,0,0.85)',
                overflow: 'hidden',
            }}>
                {/* ── HEADER ── */}
                <div style={{
                    padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
                }}>
                    {ohlc ? (
                        <>
                            <span style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>{ohlc.ticker}</span>
                            <span style={{
                                fontSize: 11, padding: '2px 8px', borderRadius: 4, fontWeight: 600,
                                background: isLong ? 'rgba(104,211,145,0.15)' : 'rgba(252,129,129,0.15)',
                                color: lineColor,
                            }}>{isLong ? '▲ LONG' : '▼ SHORT'}</span>
                            <span style={{ fontSize: 11, color: '#718096' }}>{ohlc.trigger_type} · {ohlc.level_type}</span>
                            {ohlc.verdict && (
                                <span style={{ fontSize: 12, fontWeight: 600, color: verdictColor, marginLeft: 2 }}>
                                    {ohlc.verdict === 'CONFIRMED' ? '✅' : ohlc.verdict === 'FAILED' ? '❌' : '⏹'} {ohlc.verdict}
                                </span>
                            )}
                        </>
                    ) : <span style={{ color: '#718096' }}>Loading…</span>}

                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 10, color: '#718096' }}>Granularity:</span>
                        {[1, 5, 15, 30].map(v => (
                            <button key={v} onClick={() => handleInterval(v)} style={{
                                padding: '3px 9px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                                background: intervalMin === v ? 'rgba(99,179,237,0.2)' : 'rgba(255,255,255,0.05)',
                                color: intervalMin === v ? '#63b3ed' : '#718096',
                                border: `1px solid ${intervalMin === v ? 'rgba(99,179,237,0.4)' : 'rgba(255,255,255,0.08)'}`,
                            }}>{v}m</button>
                        ))}
                        <button onClick={onClose} style={{
                            marginLeft: 8, padding: '4px 12px', fontSize: 12, cursor: 'pointer',
                            background: 'rgba(252,129,129,0.15)', color: '#fc8181',
                            border: '1px solid rgba(252,129,129,0.3)', borderRadius: 6,
                        }}>✕ Esc</button>
                    </div>
                </div>

                {error && <div style={{ padding: 20, color: '#fc8181' }}>Error: {error}</div>}

                {/* ── BODY ── */}
                <div style={{ flex: 1, display: 'flex', gap: 0, overflow: 'hidden', minHeight: 0 }}>

                    {/* ── CHART ── */}
                    <div style={{ flex: 1, padding: '12px 0 12px 8px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        {loadingOhlc && (
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#718096' }}>
                                Loading chart…
                            </div>
                        )}

                        {!loadingOhlc && series.length === 0 && (
                            <div style={{
                                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                flexDirection: 'column', gap: 10, color: '#718096',
                                border: '1px dashed rgba(255,255,255,0.08)', borderRadius: 8, margin: 12,
                            }}>
                                <div style={{ fontSize: 28 }}>📭</div>
                                <div>No price snapshots in master store for this window.</div>
                                <div style={{ fontSize: 11 }}>Try a wider granularity, or this trial pre-dates master store ingestion.</div>
                            </div>
                        )}

                        {!loadingOhlc && series.length > 0 && (
                            <>
                                {/* Chart legend row */}
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '0 8px 6px', fontSize: 10, color: '#718096' }}>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <svg width={20} height={8}><line x1={0} y1={4} x2={20} y2={4} stroke={lineColor} strokeWidth={2} /></svg> Price
                                    </span>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <svg width={20} height={8}><line x1={0} y1={4} x2={20} y2={4} stroke="rgba(255,255,255,0.4)" strokeWidth={1.5} strokeDasharray="3 3" /></svg> Trigger
                                    </span>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <svg width={20} height={8}><line x1={0} y1={4} x2={20} y2={4} stroke="#f6ad55" strokeWidth={1.5} strokeDasharray="5 3" /></svg> {ohlc?.level_type || 'Level'}
                                    </span>
                                    {EMA_DEFS.filter(e => ohlc?.levels?.[e.key] > 0).map(e => (
                                        <span key={e.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                            <svg width={20} height={8}><line x1={0} y1={4} x2={20} y2={4} stroke={e.color} strokeWidth={1.5} strokeDasharray={e.dash} /></svg> {e.label}
                                        </span>
                                    ))}
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <span style={{ width: 16, height: 10, background: 'rgba(160,174,192,0.15)', display: 'inline-block', borderRadius: 2 }} /> Cooldown
                                    </span>
                                    <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                        <span style={{ width: 16, height: 10, background: 'rgba(99,179,237,0.15)', display: 'inline-block', borderRadius: 2 }} /> Watching
                                    </span>
                                    <span style={{ marginLeft: 'auto', color: '#4a5568' }}>
                                        {ohlc?.candle_count} snapshots · {intervalMin}m buckets
                                    </span>
                                </div>

                                <div style={{ flex: 1, minHeight: 0 }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <ComposedChart data={series} margin={{ top: 8, right: 100, left: 8, bottom: 20 }}>
                                            <XAxis
                                                dataKey="t" type="number" scale="time"
                                                domain={['dataMin', 'dataMax']}
                                                tickFormatter={fmtTime}
                                                tick={{ fontSize: 10, fill: '#718096' }}
                                                tickCount={8}
                                            />
                                            <YAxis
                                                domain={[pMin, pMax]}
                                                tick={{ fontSize: 10, fill: '#718096' }}
                                                tickFormatter={smartFmt}
                                                width={72}
                                                tickCount={7}
                                            />
                                            <Tooltip
                                                contentStyle={{ background: '#0d1117', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, fontSize: 11 }}
                                                labelFormatter={(v) => fmtTimeFull(v)}
                                                formatter={(v, n) => [smartFmt(v), n === 'price' ? 'Price' : n]}
                                            />

                                            {/* Phase zones */}
                                            {cooldownStart != null && cooldownEnd != null && (
                                                <ReferenceArea x1={cooldownStart} x2={cooldownEnd}
                                                    fill="rgba(160,174,192,0.09)" stroke="rgba(160,174,192,0.15)" strokeWidth={0.5}
                                                />
                                            )}
                                            {watchStart != null && watchEnd != null && watchEnd > watchStart && (
                                                <ReferenceArea x1={watchStart} x2={watchEnd}
                                                    fill="rgba(99,179,237,0.08)" stroke="rgba(99,179,237,0.15)" strokeWidth={0.5}
                                                />
                                            )}

                                            {/* EMA levels */}
                                            {EMA_DEFS.map(({ key, color, dash, label }) => {
                                                const price = ohlc?.levels?.[key];
                                                if (!price || price <= 0) return null;
                                                return (
                                                    <ReferenceLine key={key} y={price}
                                                        stroke={color} strokeDasharray={dash} strokeWidth={1.5}
                                                        label={{ value: label, fill: color, fontSize: 9, position: 'right', offset: 4 }}
                                                    />
                                                );
                                            })}

                                            {/* Smart level */}
                                            {ohlc?.levels?.smart_level > 0 && ohlc.levels.smart_level !== ohlc.levels.trigger && (
                                                <ReferenceLine y={ohlc.levels.smart_level}
                                                    stroke="#f6ad55" strokeDasharray="6 4" strokeWidth={2}
                                                    label={{ value: ohlc.level_type || 'Level', fill: '#f6ad55', fontSize: 10, position: 'right', offset: 4 }}
                                                />
                                            )}

                                            {/* Trigger price */}
                                            {ohlc?.levels?.trigger > 0 && (
                                                <ReferenceLine y={ohlc.levels.trigger}
                                                    stroke="rgba(255,255,255,0.45)" strokeDasharray="4 3" strokeWidth={1.5}
                                                    label={{ value: `Trigger ${smartFmt(ohlc.levels.trigger)}`, fill: 'rgba(255,255,255,0.5)', fontSize: 9, position: 'right', offset: 4 }}
                                                />
                                            )}

                                            {/* Vertical: trigger moment */}
                                            {cooldownStart != null && (
                                                <ReferenceLine x={cooldownStart} stroke="#9f7aea" strokeDasharray="4 3" strokeWidth={2}
                                                    label={{ value: '⚡ Trigger', fill: '#9f7aea', fontSize: 10, position: 'insideTopLeft' }}
                                                />
                                            )}

                                            {/* Vertical: verdict */}
                                            {ph.resolved_ms != null && (
                                                <ReferenceLine x={ph.resolved_ms}
                                                    stroke={verdictColor} strokeDasharray="4 3" strokeWidth={2}
                                                    label={{ value: `🏁 ${ohlc?.verdict || ''}`, fill: verdictColor, fontSize: 10, position: 'insideTopRight' }}
                                                />
                                            )}

                                            {/* Price area + line */}
                                            <Area
                                                type="monotone" dataKey="price"
                                                stroke={lineColor} strokeWidth={2.5}
                                                fill={areaFill}
                                                dot={{ r: 2.5, fill: lineColor, strokeWidth: 0 }}
                                                activeDot={{ r: 4, stroke: '#fff', strokeWidth: 1 }}
                                                isAnimationActive={false}
                                            />
                                        </ComposedChart>
                                    </ResponsiveContainer>
                                </div>
                            </>
                        )}
                    </div>

                    {/* ── SIDE PANEL ── */}
                    <div style={{
                        width: 230, flexShrink: 0,
                        borderLeft: '1px solid rgba(255,255,255,0.06)',
                        padding: 12, display: 'flex', flexDirection: 'column',
                        gap: 12, overflow: 'auto',
                    }}>
                        {/* Trial meta */}
                        {(ohlc || trial) && (
                            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: 10 }}>
                                <div style={{ fontSize: 10, fontWeight: 600, color: '#718096', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Trial</div>
                                {[
                                    ['Trigger @', smartFmt(ohlc?.levels?.trigger)],
                                    ['Level @', smartFmt(ohlc?.levels?.smart_level)],
                                    ['Detected', ohlc?.phases?.detected_ms && fmtTime(ohlc.phases.detected_ms)],
                                    ['Resolved', ohlc?.phases?.resolved_ms && fmtTime(ohlc.phases.resolved_ms)],
                                    ['Snapshots', ohlc?.candle_count],
                                ].filter(([, v]) => v != null).map(([k, v]) => (
                                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                                        <span style={{ color: '#718096' }}>{k}</span>
                                        <span style={{ color: '#cbd5e0', fontWeight: 600 }}>{v}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* State transitions */}
                        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: 10, flex: 1, overflow: 'auto' }}>
                            <div style={{ fontSize: 10, fontWeight: 600, color: '#718096', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>State Log</div>
                            {stateLog.length === 0
                                ? <div style={{ fontSize: 11, color: '#4a5568' }}>No transitions yet.</div>
                                : stateLog.map((s, i) => {
                                    const rules = (() => { try { return Object.entries(JSON.parse(s.rule_snapshot || '{}')).filter(([k]) => k !== 'TRIGGER_VALID'); } catch { return []; } })();
                                    return (
                                        <div key={i} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                                                <span style={{ color: STATE_COLOR[s.state] || '#cbd5e0', fontWeight: 600 }}>{s.state}</span>
                                                <span style={{ color: '#718096' }}>{fmtTimeFull(new Date(s.changed_at).getTime())}</span>
                                            </div>
                                            <div style={{ fontSize: 10, color: '#a0aec0', margin: '3px 0' }}>
                                                {smartFmt(s.current_price)}
                                                {s.unrealized_move_pct != null && (
                                                    <span style={{ marginLeft: 8, fontWeight: 600, color: s.unrealized_move_pct > 0 ? '#68d391' : '#fc8181' }}>
                                                        {s.unrealized_move_pct > 0 ? '+' : ''}{Number(s.unrealized_move_pct).toFixed(2)}%
                                                    </span>
                                                )}
                                            </div>
                                            {rules.length > 0 && (
                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                                                    {rules.map(([id, r]) => (
                                                        <span key={id} style={{
                                                            fontSize: 9, padding: '1px 5px', borderRadius: 3,
                                                            background: r.passed ? 'rgba(104,211,145,0.1)' : 'rgba(252,129,129,0.1)',
                                                            color: r.passed ? '#68d391' : '#fc8181',
                                                            border: `1px solid ${r.passed ? 'rgba(104,211,145,0.2)' : 'rgba(252,129,129,0.2)'}`,
                                                        }}>
                                                            {r.passed ? '✓' : '✗'} {id.replace('EMA_', '').replace('_ALIGN', '').replace('_HOLD', '').replace('_SUSTAIN', '').replace('_CONFIRM', '').replace(/_/g, ' ')}
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
