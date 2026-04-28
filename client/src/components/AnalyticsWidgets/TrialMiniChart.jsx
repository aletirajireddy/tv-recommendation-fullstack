import React, { useEffect, useState, useRef } from 'react';
import {
    AreaChart, Area, Line, LineChart, XAxis, YAxis, Tooltip,
    ReferenceLine, ReferenceArea, ResponsiveContainer, ComposedChart,
} from 'recharts';

/**
 * TrialMiniChart — real price-action chart embedded in each trial card.
 *
 * Uses Recharts (responsive, no SVG distortion).
 * Data: real price snapshots from master_coin_store via /api/validator/trial/:id/ohlc
 *       (uses candle close prices — each one is a real scanner read, not interpolated)
 *
 * Shows:
 *   - Price line (green=LONG, red=SHORT) with subtle area fill
 *   - COOLDOWN zone (grey) + WATCHING zone (blue tint)
 *   - Trigger price (white dashed)
 *   - Smart Level (orange dashed)
 *   - 5m EMA200 (blue dotted) if available
 *   - Verdict dot at resolved time
 */

// Dynamic decimal precision based on price magnitude
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

const VOL_SRC_COLOR = {
    STREAM_C_ALERT: '#f6ad55',
    STREAM_A_EDGE:  '#63b3ed',
    STREAM_D_RVOL:  '#d6bcfa',
};
const VOL_SRC_LABEL = {
    STREAM_C_ALERT: 'C',
    STREAM_A_EDGE:  'A',
    STREAM_D_RVOL:  'D',
};

export function TrialMiniChart({ trial }) {
    const [ohlc, setOhlc]         = useState(null);
    const [volEvents, setVolEvents] = useState([]);
    const fetchedRef = useRef(false);

    useEffect(() => {
        if (fetchedRef.current) return;
        fetchedRef.current = true;

        fetch(`/api/validator/trial/${encodeURIComponent(trial.trial_id)}/ohlc?interval=5`)
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (d && !d.error) {
                    setOhlc(d);
                    // Fetch vol events for the chart's time window using the trial ticker.
                    // since_min covers from detection up to now (+30m buffer).
                    const since_min = Math.ceil((Date.now() - new Date(trial.detected_at).getTime()) / 60000) + 30;
                    const cappedMin = Math.min(since_min, 1440); // max 24h
                    fetch(`/api/volume-events?ticker=${encodeURIComponent(trial.ticker)}&since_min=${cappedMin}&limit=30`)
                        .then(r2 => r2.ok ? r2.json() : null)
                        .then(vd => {
                            if (vd?.events?.length) setVolEvents(vd.events);
                        })
                        .catch(() => {});
                }
            })
            .catch(() => {});
    }, [trial.trial_id, trial.ticker, trial.detected_at]);

    if (!ohlc) {
        return (
            <div style={{
                height: 72, marginTop: 8,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--border)', borderRadius: 6,
                border: '1px dashed var(--border)',
                fontSize: 10, color: 'var(--text-muted)',
            }}>
                Loading chart…
            </div>
        );
    }

    if (!ohlc.candles || ohlc.candle_count === 0) {
        return (
            <div style={{
                height: 72, marginTop: 8,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--border)', borderRadius: 6,
                border: '1px dashed var(--border)',
                fontSize: 10, color: 'var(--text-muted)',
            }}>
                No price data yet
            </div>
        );
    }

    const isLong = trial.direction === 'LONG';
    const lineColor = isLong ? 'var(--accent-green)' : 'var(--accent-red)';
    const fillColor = isLong ? 'rgba(56, 161, 105, 0.08)' : 'rgba(229, 62, 62, 0.08)';

    const { candles, levels, phases } = ohlc;

    // Build series: use close price per candle, tagged with the mid-bucket timestamp
    const series = candles.map(c => ({
        t: c.ts,
        price: c.close,
    }));

    // Phase boundaries as timestamps
    const cooldownStart = phases.detected_ms;
    const cooldownEnd   = phases.cooldown_until_ms;
    const watchStart    = phases.cooldown_until_ms || phases.detected_ms;
    const watchEnd      = phases.resolved_ms || (candles.at(-1)?.ts + ohlc.interval_min * 60000);

    // Price domain with padding
    const allPrices = [
        ...series.map(s => s.price),
        levels.trigger, levels.smart_level, levels.ema200_5m,
    ].filter(p => p != null && p > 0);
    const pMin = Math.min(...allPrices);
    const pMax = Math.max(...allPrices);
    const pPad = (pMax - pMin) * 0.12 || pMin * 0.01;

    return (
        <div style={{ height: 110, marginTop: 8 }}>
            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ top: 6, right: 48, left: 0, bottom: 0 }}>
                    <XAxis
                        dataKey="t" type="number" scale="time"
                        domain={['dataMin', 'dataMax']}
                        tickFormatter={fmtTime}
                        tick={{ fontSize: 9, fill: 'var(--text-muted)' }}
                        tickCount={3}
                    />
                    <YAxis
                        domain={[pMin - pPad, pMax + pPad]}
                        tick={{ fontSize: 9, fill: 'var(--text-muted)' }}
                        tickFormatter={smartFmt}
                        width={55}
                        tickCount={4}
                    />
                    <Tooltip
                        contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 10 }}
                        labelFormatter={(v) => fmtTime(v)}
                        formatter={(v) => [smartFmt(v), 'Price']}
                    />

                    {/* Phase zones */}
                    {cooldownStart != null && cooldownEnd != null && (
                        <ReferenceArea x1={cooldownStart} x2={cooldownEnd}
                            fill="rgba(0,0,0,0.05)" stroke="none"
                            label={{ value: 'COOLDOWN', fill: 'var(--text-muted)', fontSize: 8, position: 'insideTopLeft' }}
                        />
                    )}
                    {watchStart != null && watchEnd != null && watchEnd > watchStart && (
                        <ReferenceArea x1={watchStart} x2={watchEnd}
                            fill="rgba(49, 130, 206, 0.04)" stroke="none"
                            label={{ value: 'WATCHING', fill: 'var(--accent-blue)', opacity: 0.6, fontSize: 8, position: 'insideTopLeft' }}
                        />
                    )}

                    {/* Key price levels */}
                    {levels.ema200_5m > 0 && (
                        <ReferenceLine y={levels.ema200_5m} stroke="var(--accent-blue)" strokeDasharray="2 4" strokeWidth={1}
                            label={{ value: '5m EMA', fill: 'var(--accent-blue)', fontSize: 8, position: 'right' }}
                        />
                    )}
                    {levels.smart_level > 0 && levels.smart_level !== levels.trigger && (
                        <ReferenceLine y={levels.smart_level} stroke="var(--warning)" strokeDasharray="5 3" strokeWidth={1.5}
                            label={{ value: ohlc.level_type?.replace('EMA200_', '') || 'Level', fill: 'var(--warning)', fontSize: 8, position: 'right' }}
                        />
                    )}
                    {levels.trigger > 0 && (
                        <ReferenceLine y={levels.trigger} stroke="var(--text-muted)" strokeDasharray="3 3" strokeWidth={1} opacity={0.3}
                            label={{ value: 'T', fill: 'var(--text-muted)', fontSize: 8, position: 'right' }}
                        />
                    )}

                    {/* Trigger vertical */}
                    {cooldownStart != null && (
                        <ReferenceLine x={cooldownStart} stroke="#9f7aea" strokeDasharray="3 2" strokeWidth={1.5} />
                    )}

                    {/* Volume spike pins — truth-aware source coloring */}
                    {volEvents
                        .map(e => ({ t: new Date(e.ts).getTime(), src: e.source }))
                        .filter(e => e.t >= (series[0]?.t ?? 0) && e.t <= (series.at(-1)?.t ?? Infinity))
                        .map((e, i) => {
                            const color = VOL_SRC_COLOR[e.src] || 'var(--text-muted)';
                            return (
                                <ReferenceLine key={`vol-${i}`}
                                    x={e.t}
                                    stroke={color} strokeOpacity={0.4}
                                    strokeDasharray="2 3" strokeWidth={1}
                                    label={{ value: VOL_SRC_LABEL[e.src] || '▾', position: 'top', fill: color, fontSize: 8, opacity: 0.6 }}
                                />
                            );
                        })
                    }

                    {/* Verdict vertical */}
                    {phases.resolved_ms != null && (
                        <ReferenceLine x={phases.resolved_ms}
                            stroke={ohlc.verdict === 'CONFIRMED' ? 'var(--accent-green)' : 'var(--accent-red)'}
                            strokeDasharray="3 2" strokeWidth={1.5}
                        />
                    )}

                    {/* Price area + line */}
                    <Area
                        type="monotone"
                        dataKey="price"
                        stroke={lineColor}
                        strokeWidth={2}
                        fill={fillColor}
                        dot={{ r: 1.5, fill: lineColor, stroke: 'none' }}
                        isAnimationActive={false}
                    />
                </ComposedChart>
            </ResponsiveContainer>
        </div>
    );
}
