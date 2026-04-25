import React, { useState, useEffect, useMemo } from 'react';
import styles from './ValidatorTimelineWidget.module.css';

/**
 * TrialExpandedModal — Full forensic candlestick chart for a single trial.
 *
 * Fetches /api/validator/trial/:id/ohlc and renders:
 *   - Real OHLC candles (grouped from master_coin_store at 5m intervals)
 *   - Smart level line (breakout/bounce target — orange)
 *   - Trigger price line (white)
 *   - EMA200: 5m (blue), 15m, 1h, 4h (progressively darker)
 *   - COOLDOWN + WATCHING zone shading
 *   - Vertical markers at trigger and verdict
 *   - Wick rejection and body size visible for pattern reading
 *   - Side panel: state transitions + trial meta
 */
export function TrialExpandedModal({ trialId, onClose }) {
    const [ohlc, setOhlc] = useState(null);
    const [stateLog, setStateLog] = useState([]);
    const [error, setError] = useState(null);
    const [interval, setIntervalMin] = useState(5);

    const loadOhlc = (intervalMin) => {
        fetch(`/api/validator/trial/${encodeURIComponent(trialId)}/ohlc?interval=${intervalMin}`)
            .then(r => r.json())
            .then(d => { if (d.error) setError(d.error); else setOhlc(d); })
            .catch(e => setError(e.message));
    };

    useEffect(() => {
        loadOhlc(interval);
        // Also fetch state log
        fetch(`/api/validator/trial/${encodeURIComponent(trialId)}/timeline`)
            .then(r => r.json())
            .then(d => { if (d.state_log) setStateLog(d.state_log); })
            .catch(() => {});
    }, [trialId, interval]);

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const changeInterval = (v) => { setIntervalMin(v); setOhlc(null); loadOhlc(v); };

    const verdictColor = !ohlc?.verdict ? '#a0aec0'
        : ohlc.verdict === 'CONFIRMED' ? '#68d391'
        : ohlc.verdict === 'FAILED' ? '#fc8181'
        : '#a0aec0';

    const STATE_COLORS = { COOLDOWN: '#a0aec0', WATCHING: '#63b3ed', RESOLVED: '#68d391' };

    return (
        <>
            <div className={styles.overlay} onClick={onClose} />
            <div style={{
                position: 'fixed', top: '4%', left: '3%', right: '3%', bottom: '4%',
                background: '#0d1117', border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 10, zIndex: 1000, padding: 16, overflow: 'hidden',
                display: 'flex', flexDirection: 'column',
                boxShadow: '0 24px 64px rgba(0,0,0,0.8)',
            }}>
                {/* HEADER */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
                    {ohlc && (
                        <>
                            <span style={{ fontSize: 16, fontWeight: 700, color: '#e2e8f0' }}>{ohlc.ticker}</span>
                            <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, background: ohlc.direction === 'LONG' ? 'rgba(104,211,145,0.15)' : 'rgba(252,129,129,0.15)', color: ohlc.direction === 'LONG' ? '#68d391' : '#fc8181', fontWeight: 600 }}>
                                {ohlc.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'}
                            </span>
                            <span style={{ fontSize: 11, color: '#718096' }}>{ohlc.trigger_type} · {ohlc.level_type}</span>
                            {ohlc.verdict && (
                                <span style={{ fontSize: 12, fontWeight: 600, color: verdictColor, marginLeft: 4 }}>
                                    {ohlc.verdict === 'CONFIRMED' ? '✅' : ohlc.verdict === 'FAILED' ? '❌' : '⏹'} {ohlc.verdict}
                                </span>
                            )}
                        </>
                    )}
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: 10, color: '#718096' }}>Interval:</span>
                        {[1, 5, 15, 30].map(v => (
                            <button key={v} onClick={() => changeInterval(v)} style={{
                                padding: '3px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
                                background: interval === v ? 'rgba(99,179,237,0.2)' : 'rgba(255,255,255,0.05)',
                                color: interval === v ? '#63b3ed' : '#718096',
                                border: `1px solid ${interval === v ? 'rgba(99,179,237,0.4)' : 'rgba(255,255,255,0.08)'}`,
                            }}>{v}m</button>
                        ))}
                        <button onClick={onClose} style={{ marginLeft: 8, background: 'rgba(252,129,129,0.15)', color: '#fc8181', border: '1px solid rgba(252,129,129,0.3)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}>✕ Esc</button>
                    </div>
                </div>

                {error && <div style={{ color: '#fc8181', padding: 20 }}>Error: {error}</div>}

                {/* BODY */}
                <div style={{ display: 'flex', flex: 1, gap: 12, overflow: 'hidden', minHeight: 0 }}>
                    {/* CHART */}
                    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                        {!ohlc && !error && (
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#718096' }}>Loading candles…</div>
                        )}
                        {ohlc && ohlc.candle_count === 0 && (
                            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#718096', border: '1px dashed rgba(255,255,255,0.08)', borderRadius: 8 }}>
                                <div style={{ fontSize: 24 }}>📭</div>
                                <div>No master_coin_store price data in this window.</div>
                                <div style={{ fontSize: 11 }}>Trial may pre-date master store ingestion or no scanner snapshots in window.</div>
                            </div>
                        )}
                        {ohlc && ohlc.candle_count > 0 && (
                            <FullCandleChart ohlc={ohlc} />
                        )}
                    </div>

                    {/* SIDE PANEL */}
                    <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
                        {/* Levels legend */}
                        {ohlc && (
                            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: 10 }}>
                                <div style={{ fontSize: 11, fontWeight: 600, color: '#a0aec0', marginBottom: 8 }}>LEVELS</div>
                                <LevelRow color="rgba(255,255,255,0.5)" dash label="Trigger" value={ohlc.levels.trigger} />
                                <LevelRow color="#f6ad55" dash label={ohlc.level_type || 'Smart Level'} value={ohlc.levels.smart_level} />
                                <LevelRow color="#63b3ed" dot label="5m EMA200" value={ohlc.levels.ema200_5m} />
                                <LevelRow color="#4299e1" dot label="15m EMA200" value={ohlc.levels.ema200_15m} />
                                <LevelRow color="#3182ce" dot label="1h EMA200" value={ohlc.levels.ema200_1h} />
                                <LevelRow color="#2b6cb0" dot label="4h EMA200" value={ohlc.levels.ema200_4h} />
                            </div>
                        )}

                        {/* State transitions */}
                        <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 8, padding: 10, flex: 1, overflow: 'auto' }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#a0aec0', marginBottom: 8 }}>STATE LOG</div>
                            {stateLog.length === 0 ? (
                                <div style={{ fontSize: 11, color: '#718096' }}>No transitions logged.</div>
                            ) : stateLog.map((s, i) => {
                                const ruleSnap = (() => { try { return JSON.parse(s.rule_snapshot); } catch { return {}; } })();
                                const rules = Object.entries(ruleSnap).filter(([k]) => k !== 'TRIGGER_VALID');
                                return (
                                    <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                                            <span style={{ color: STATE_COLORS[s.state] || '#cbd5e0', fontWeight: 600 }}>{s.state}</span>
                                            <span style={{ color: '#718096' }}>{new Date(s.changed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                                        </div>
                                        <div style={{ fontSize: 10, color: '#a0aec0', margin: '2px 0' }}>
                                            ${Number(s.current_price).toFixed(4)}
                                            {s.unrealized_move_pct != null && (
                                                <span style={{ marginLeft: 8, color: s.unrealized_move_pct > 0 ? '#68d391' : '#fc8181', fontWeight: 600 }}>
                                                    {s.unrealized_move_pct > 0 ? '+' : ''}{Number(s.unrealized_move_pct).toFixed(2)}%
                                                </span>
                                            )}
                                        </div>
                                        {rules.length > 0 && (
                                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 3 }}>
                                                {rules.map(([id, r]) => (
                                                    <span key={id} style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: r.passed ? 'rgba(104,211,145,0.1)' : 'rgba(252,129,129,0.1)', color: r.passed ? '#68d391' : '#fc8181' }}>
                                                        {r.passed ? '✓' : '✗'} {id.replace('EMA_', '').replace('_', ' ')}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}

function LevelRow({ color, dash, dot, label, value }) {
    if (!value) return null;
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, fontSize: 10 }}>
            <svg width={24} height={10}>
                {dash
                    ? <line x1={0} x2={24} y1={5} y2={5} stroke={color} strokeWidth={1.5} strokeDasharray="4 3" />
                    : <line x1={0} x2={24} y1={5} y2={5} stroke={color} strokeWidth={1.5} strokeDasharray="1 4" />
                }
            </svg>
            <span style={{ color: '#a0aec0', flex: 1 }}>{label}</span>
            <span style={{ color, fontWeight: 600, fontFamily: 'monospace' }}>{Number(value).toFixed(4)}</span>
        </div>
    );
}

function FullCandleChart({ ohlc }) {
    const { candles, levels, phases, direction } = ohlc;
    const isLong = direction === 'LONG';

    // Dimensions
    const W = 900;
    const H = 440;
    const PAD = { top: 20, right: 90, bottom: 30, left: 70 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    const allPrices = [
        ...candles.flatMap(c => [c.high, c.low]),
        levels.trigger, levels.smart_level,
        levels.ema200_5m, levels.ema200_15m, levels.ema200_1h, levels.ema200_4h,
    ].filter(Boolean);
    const rawMin = Math.min(...allPrices);
    const rawMax = Math.max(...allPrices);
    const padPct = (rawMax - rawMin) * 0.10 || rawMin * 0.003;
    const priceMin = rawMin - padPct;
    const priceMax = rawMax + padPct;
    const priceRange = priceMax - priceMin;

    const py = (price) => PAD.top + chartH - ((price - priceMin) / priceRange) * chartH;

    const timeMin = candles[0].ts;
    const timeMax = candles[candles.length - 1].ts + ohlc.interval_min * 60 * 1000;
    const timeRange = timeMax - timeMin || 1;
    const tx = (ms) => PAD.left + ((ms - timeMin) / timeRange) * chartW;

    const slotW = chartW / candles.length;
    const bodyW = Math.max(4, slotW * 0.6);

    // Phase coords
    const detX     = phases.detected_ms ? tx(phases.detected_ms) : null;
    const coolX2   = phases.cooldown_until_ms ? tx(phases.cooldown_until_ms) : null;
    const resolveX = phases.resolved_ms ? tx(phases.resolved_ms) : null;
    const watchX2  = phases.resolved_ms ? tx(phases.resolved_ms) : tx(timeMax);

    // Y-axis ticks (6 levels)
    const yTicks = Array.from({ length: 6 }, (_, i) => priceMin + (priceRange / 5) * i);

    // X-axis ticks (at candle boundaries, max ~8)
    const tickEvery = Math.ceil(candles.length / 8);
    const xTicks = candles.filter((_, i) => i % tickEvery === 0);

    const EMAs = [
        { key: 'ema200_4h', color: '#2b6cb0', label: '4h EMA', dash: '2 6' },
        { key: 'ema200_1h', color: '#3182ce', label: '1h EMA', dash: '2 5' },
        { key: 'ema200_15m', color: '#4299e1', label: '15m EMA', dash: '2 4' },
        { key: 'ema200_5m', color: '#63b3ed', label: '5m EMA', dash: '3 3' },
    ];

    return (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" style={{ display: 'block' }}>
            {/* Background */}
            <rect width={W} height={H} fill="#0a0f16" rx={6} />

            {/* Grid lines */}
            {yTicks.map((p, i) => (
                <line key={i} x1={PAD.left} x2={W - PAD.right} y1={py(p)} y2={py(p)}
                    stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
            ))}

            {/* COOLDOWN zone */}
            {detX != null && coolX2 != null && (
                <rect x={Math.min(detX, coolX2)} y={PAD.top} width={Math.abs(coolX2 - detX)} height={chartH}
                    fill="rgba(160,174,192,0.06)" />
            )}
            {/* WATCHING zone */}
            {(coolX2 ?? detX) != null && (
                <rect x={coolX2 ?? detX} y={PAD.top} width={Math.max(0, watchX2 - (coolX2 ?? detX))} height={chartH}
                    fill="rgba(99,179,237,0.06)" />
            )}

            {/* EMA lines */}
            {EMAs.map(({ key, color, dash }) => {
                const price = levels[key];
                if (!price) return null;
                return (
                    <line key={key} x1={PAD.left} x2={W - PAD.right} y1={py(price)} y2={py(price)}
                        stroke={color} strokeWidth={1.5} strokeDasharray={dash} opacity={0.8} />
                );
            })}

            {/* Smart level line (orange) */}
            {levels.smart_level && levels.smart_level !== levels.trigger && (
                <line x1={PAD.left} x2={W - PAD.right} y1={py(levels.smart_level)} y2={py(levels.smart_level)}
                    stroke="#f6ad55" strokeWidth={2} strokeDasharray="6 4" />
            )}

            {/* Trigger line (white) */}
            <line x1={PAD.left} x2={W - PAD.right} y1={py(levels.trigger)} y2={py(levels.trigger)}
                stroke="rgba(255,255,255,0.55)" strokeWidth={1.5} strokeDasharray="4 4" />

            {/* Candlesticks */}
            {candles.map((c, i) => {
                const cx = tx(c.ts + (ohlc.interval_min * 60 * 1000) / 2);
                const bTop    = py(Math.max(c.open, c.close));
                const bBottom = py(Math.min(c.open, c.close));
                const bH = Math.max(1.5, bBottom - bTop);
                const color = c.bullish ? '#68d391' : '#fc8181';
                const fillColor = c.bullish ? 'rgba(104,211,145,0.8)' : 'rgba(252,129,129,0.8)';
                return (
                    <g key={c.ts}>
                        {/* Full wick */}
                        <line x1={cx} x2={cx} y1={py(c.high)} y2={py(c.low)} stroke={color} strokeWidth={1.5} />
                        {/* Body */}
                        <rect x={cx - bodyW / 2} y={bTop} width={bodyW} height={bH}
                            fill={fillColor} stroke={color} strokeWidth={1} />
                    </g>
                );
            })}

            {/* Trigger vertical line + label */}
            {detX != null && (
                <>
                    <line x1={detX} x2={detX} y1={PAD.top} y2={H - PAD.bottom}
                        stroke="#9f7aea" strokeWidth={2} strokeDasharray="4 3" opacity={0.9} />
                    <text x={detX + 4} y={PAD.top + 14} fontSize={10} fill="#9f7aea" fontWeight={600}>⚡ Trigger</text>
                </>
            )}

            {/* Verdict vertical line + label */}
            {resolveX != null && (
                <>
                    <line x1={resolveX} x2={resolveX} y1={PAD.top} y2={H - PAD.bottom}
                        stroke={ohlc.verdict === 'CONFIRMED' ? '#68d391' : '#fc8181'} strokeWidth={2} strokeDasharray="4 3" opacity={0.9} />
                    <text x={resolveX + 4} y={PAD.top + 14} fontSize={10} fill={ohlc.verdict === 'CONFIRMED' ? '#68d391' : '#fc8181'} fontWeight={600}>
                        {ohlc.verdict === 'CONFIRMED' ? '✅' : '❌'} {ohlc.verdict}
                    </text>
                </>
            )}

            {/* Phase zone labels */}
            {detX != null && coolX2 != null && (
                <text x={(detX + coolX2) / 2} y={PAD.top + 10} fontSize={9} fill="rgba(160,174,192,0.5)" textAnchor="middle">COOLDOWN</text>
            )}
            {(coolX2 ?? detX) != null && watchX2 > (coolX2 ?? detX) && (
                <text x={((coolX2 ?? detX) + watchX2) / 2} y={PAD.top + 10} fontSize={9} fill="rgba(99,179,237,0.5)" textAnchor="middle">WATCHING</text>
            )}

            {/* Y-axis */}
            {yTicks.map((p, i) => (
                <g key={i}>
                    <text x={PAD.left - 6} y={py(p) + 3} fontSize={10} fill="#718096" textAnchor="end">
                        {Number(p).toFixed(4)}
                    </text>
                </g>
            ))}

            {/* Right axis — level labels */}
            {levels.trigger && (
                <text x={W - PAD.right + 6} y={py(levels.trigger) + 3} fontSize={9} fill="rgba(255,255,255,0.55)">Trigger</text>
            )}
            {levels.smart_level && levels.smart_level !== levels.trigger && (
                <text x={W - PAD.right + 6} y={py(levels.smart_level) + 3} fontSize={9} fill="#f6ad55">{ohlc.level_type}</text>
            )}
            {EMAs.map(({ key, color, label }) => {
                const price = levels[key];
                if (!price) return null;
                return <text key={key} x={W - PAD.right + 6} y={py(price) + 3} fontSize={9} fill={color}>{label}</text>;
            })}

            {/* X-axis ticks */}
            {xTicks.map((c, i) => (
                <text key={i} x={tx(c.ts + (ohlc.interval_min * 60 * 1000) / 2)} y={H - 6} fontSize={9} fill="#718096" textAnchor="middle">
                    {new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </text>
            ))}

            {/* Chart border */}
            <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH}
                fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={1} />
        </svg>
    );
}
