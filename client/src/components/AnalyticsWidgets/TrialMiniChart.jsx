import React, { useEffect, useState, useRef } from 'react';

/**
 * TrialMiniChart — real price-action mini chart per trial card.
 *
 * Renders via a custom SVG canvas (no Recharts overhead at 120px height).
 * Data: fetched lazily from /api/validator/trial/:id/ohlc (real master_coin_store candles).
 *
 * Displays:
 *   - Candlestick bars (body + wick) — green=bullish, red=bearish
 *   - Smart level line (orange dashed)
 *   - Trigger price line (white dashed)
 *   - 5m EMA200 line (blue dotted) if available
 *   - COOLDOWN zone shading (grey)
 *   - WATCHING zone shading (blue tint)
 *   - Verdict icon at end of chart
 */
export function TrialMiniChart({ trial }) {
    const [ohlc, setOhlc] = useState(null);
    const fetchedRef = useRef(false);

    useEffect(() => {
        if (fetchedRef.current) return;
        fetchedRef.current = true;
        fetch(`/api/validator/trial/${encodeURIComponent(trial.trial_id)}/ohlc?interval=5`)
            .then(r => r.ok ? r.json() : null)
            .then(d => d && setOhlc(d))
            .catch(() => {});
    }, [trial.trial_id]);

    if (!ohlc || ohlc.candle_count === 0) {
        // Fallback: simple placeholder while loading or no data
        return (
            <div style={{
                height: 80, marginTop: 8,
                background: 'rgba(255,255,255,0.02)',
                border: '1px dashed rgba(255,255,255,0.08)',
                borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 10, color: '#4a5568',
            }}>
                {ohlc === null ? 'Loading chart…' : 'No price data yet'}
            </div>
        );
    }

    return <CandleCanvas ohlc={ohlc} height={120} />;
}

function CandleCanvas({ ohlc, height }) {
    const W = 420; // viewBox width (responsive via preserveAspectRatio)
    const H = height;
    const PAD = { top: 6, right: 40, bottom: 16, left: 52 };
    const chartW = W - PAD.left - PAD.right;
    const chartH = H - PAD.top - PAD.bottom;

    const { candles, levels, phases, direction } = ohlc;
    const isLong = direction === 'LONG';

    // Price range across candles + level lines
    const allPrices = [
        ...candles.flatMap(c => [c.high, c.low]),
        levels.trigger, levels.smart_level,
        levels.ema200_5m, levels.ema200_15m,
    ].filter(Boolean);
    const rawMin = Math.min(...allPrices);
    const rawMax = Math.max(...allPrices);
    const pad5 = (rawMax - rawMin) * 0.08 || rawMin * 0.002;
    const priceMin = rawMin - pad5;
    const priceMax = rawMax + pad5;
    const priceRange = priceMax - priceMin;

    const py = (price) => PAD.top + chartH - ((price - priceMin) / priceRange) * chartH;

    // Time range
    const timeMin = candles[0].ts;
    const timeMax = candles[candles.length - 1].ts + ohlc.interval_min * 60 * 1000;
    const timeRange = timeMax - timeMin || 1;
    const tx = (ms) => PAD.left + ((ms - timeMin) / timeRange) * chartW;

    const candleW = Math.max(3, (chartW / candles.length) * 0.6);

    // Phase boundaries → x coords
    const cooldownX1 = phases.detected_ms    != null ? tx(phases.detected_ms)    : null;
    const cooldownX2 = phases.cooldown_until_ms != null ? tx(phases.cooldown_until_ms) : null;
    const watchX1   = phases.cooldown_until_ms != null ? tx(phases.cooldown_until_ms) : cooldownX1;
    const watchX2   = phases.resolved_ms != null ? tx(phases.resolved_ms) : tx(timeMax);

    const fmtPrice = (p) => p == null ? '' : Number(p).toFixed(4);
    const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const verdictColor = ohlc.verdict === 'CONFIRMED' ? '#68d391'
        : ohlc.verdict === 'FAILED' ? '#fc8181'
        : '#a0aec0';

    return (
        <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%" height={H}
            style={{ display: 'block', marginTop: 8 }}
            preserveAspectRatio="none"
        >
            {/* COOLDOWN zone shading */}
            {cooldownX1 != null && cooldownX2 != null && (
                <rect
                    x={Math.min(cooldownX1, cooldownX2)} y={PAD.top}
                    width={Math.abs(cooldownX2 - cooldownX1)} height={chartH}
                    fill="rgba(160,174,192,0.08)"
                />
            )}
            {/* WATCHING zone shading */}
            {watchX1 != null && (
                <rect
                    x={watchX1} y={PAD.top}
                    width={Math.max(0, watchX2 - watchX1)} height={chartH}
                    fill="rgba(99,179,237,0.07)"
                />
            )}

            {/* EMA200 5m line (blue dotted) */}
            {levels.ema200_5m && (
                <>
                    <line x1={PAD.left} x2={W - PAD.right} y1={py(levels.ema200_5m)} y2={py(levels.ema200_5m)}
                        stroke="#4299e1" strokeWidth={1} strokeDasharray="2 4" opacity={0.7} />
                    <text x={W - PAD.right + 2} y={py(levels.ema200_5m) + 3} fontSize={8} fill="#4299e1" opacity={0.9}>5m</text>
                </>
            )}
            {/* EMA200 15m line */}
            {levels.ema200_15m && (
                <line x1={PAD.left} x2={W - PAD.right} y1={py(levels.ema200_15m)} y2={py(levels.ema200_15m)}
                    stroke="#3182ce" strokeWidth={1} strokeDasharray="1 5" opacity={0.5} />
            )}

            {/* Smart level line (orange) */}
            {levels.smart_level && levels.smart_level !== levels.trigger && (
                <>
                    <line x1={PAD.left} x2={W - PAD.right} y1={py(levels.smart_level)} y2={py(levels.smart_level)}
                        stroke="#f6ad55" strokeWidth={1.5} strokeDasharray="4 3" />
                    <text x={W - PAD.right + 2} y={py(levels.smart_level) + 3} fontSize={8} fill="#f6ad55">
                        {ohlc.level_type ? ohlc.level_type.replace('EMA200_', '').replace('_', '') : 'Lvl'}
                    </text>
                </>
            )}

            {/* Trigger price line (white dashed) */}
            <line x1={PAD.left} x2={W - PAD.right} y1={py(levels.trigger)} y2={py(levels.trigger)}
                stroke="rgba(255,255,255,0.5)" strokeWidth={1} strokeDasharray="3 3" />
            <text x={W - PAD.right + 2} y={py(levels.trigger) + 3} fontSize={8} fill="rgba(255,255,255,0.6)">T</text>

            {/* Candlesticks */}
            {candles.map((c, i) => {
                const cx = tx(c.ts + (ohlc.interval_min * 60 * 1000) / 2);
                const bodyTop    = py(Math.max(c.open, c.close));
                const bodyBottom = py(Math.min(c.open, c.close));
                const bodyH = Math.max(1.5, bodyBottom - bodyTop);
                const color = c.bullish ? '#68d391' : '#fc8181';
                return (
                    <g key={c.ts}>
                        {/* Wick */}
                        <line x1={cx} x2={cx} y1={py(c.high)} y2={py(c.low)}
                            stroke={color} strokeWidth={1} />
                        {/* Body */}
                        <rect x={cx - candleW / 2} y={bodyTop} width={candleW} height={bodyH}
                            fill={c.bullish ? 'rgba(104,211,145,0.85)' : 'rgba(252,129,129,0.85)'}
                            stroke={color} strokeWidth={0.5}
                        />
                    </g>
                );
            })}

            {/* Detection vertical line */}
            {cooldownX1 != null && (
                <line x1={cooldownX1} x2={cooldownX1} y1={PAD.top} y2={H - PAD.bottom}
                    stroke="#9f7aea" strokeWidth={1.5} strokeDasharray="3 2" opacity={0.8} />
            )}

            {/* Verdict dot at resolved_ms */}
            {phases.resolved_ms != null && ohlc.verdict && (
                <circle cx={tx(phases.resolved_ms)} cy={H - PAD.bottom - 4}
                    r={5} fill={verdictColor} opacity={0.9} />
            )}

            {/* Y-axis price labels */}
            {[priceMin + priceRange * 0.1, priceMin + priceRange * 0.5, priceMin + priceRange * 0.9].map((p, i) => (
                <text key={i} x={PAD.left - 4} y={py(p) + 3} fontSize={8} fill="#718096" textAnchor="end">
                    {fmtPrice(p)}
                </text>
            ))}

            {/* X-axis time labels */}
            {candles.length > 0 && [candles[0], candles[Math.floor(candles.length / 2)], candles[candles.length - 1]]
                .filter((c, i, a) => a.indexOf(c) === i)
                .map((c, i) => (
                    <text key={i} x={tx(c.ts)} y={H - 2} fontSize={8} fill="#718096" textAnchor="middle">
                        {fmtTime(c.ts)}
                    </text>
                ))
            }

            {/* Phase labels */}
            {cooldownX1 != null && cooldownX2 != null && (
                <text x={(cooldownX1 + Math.min(cooldownX2, W - PAD.right)) / 2} y={PAD.top + 10}
                    fontSize={8} fill="rgba(160,174,192,0.6)" textAnchor="middle">COOLDOWN</text>
            )}
            {watchX1 != null && (watchX2 - watchX1 > 30) && (
                <text x={watchX1 + (watchX2 - watchX1) / 2} y={PAD.top + 10}
                    fontSize={8} fill="rgba(99,179,237,0.6)" textAnchor="middle">WATCHING</text>
            )}
        </svg>
    );
}
