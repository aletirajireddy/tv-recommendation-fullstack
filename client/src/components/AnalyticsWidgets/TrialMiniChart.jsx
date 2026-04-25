import React, { useMemo } from 'react';
import {
    LineChart, Line, ReferenceLine, ReferenceDot, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';

/**
 * TrialMiniChart — 120px inline OHLC-style mini chart per trial card.
 *
 * Sources data from `trial.master_state` (snapshot at trigger) for level lines,
 * and from `trial.latest_move` / `trial.final_move` for current vs trigger price.
 *
 * For full historical price action use the TrialExpandedModal (click-through).
 */
export function TrialMiniChart({ trial }) {
    const a = trial.master_state?.stream_a || {};

    // Synthesize a minimal price series from what we know:
    //   - trigger_price at detected_at
    //   - current price = trigger_price * (1 + latest_move%)  if available
    // This gives a rough trajectory until the modal does the real chart.
    const data = useMemo(() => {
        const trig = Number(trial.trigger_price) || 0;
        const movePct = (trial.final_move ?? trial.latest_move) || 0;
        const cur = trig * (1 + movePct / 100);
        const lvl = Number(trial.level_price) || trig;
        const t0 = new Date(trial.detected_at).getTime();
        const t1 = trial.resolved_at ? new Date(trial.resolved_at).getTime() : Date.now();
        // 5 evenly-spaced points so the line has shape
        return [0, 0.25, 0.5, 0.75, 1].map((p, i) => ({
            t: new Date(t0 + (t1 - t0) * p).toISOString(),
            price: trig + (cur - trig) * p,
            level: lvl,
        }));
    }, [trial]);

    const isLong = trial.direction === 'LONG';
    const trig = Number(trial.trigger_price) || 0;
    const lvl = Number(trial.level_price) || trig;
    const ema200_5m_dist = a.ema200_5m_dist;
    // Compute approximate 5m EMA200 absolute price from distance %
    const ema5m = ema200_5m_dist != null ? trig / (1 + ema200_5m_dist / 100) : null;

    const lineColor = isLong ? '#68d391' : '#fc8181';
    const lvlColor = '#f6ad55';
    const emaColor = '#63b3ed';

    return (
        <div style={{ height: 120, marginTop: 8, marginBottom: 4 }}>
            <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                    <XAxis dataKey="t" hide />
                    <YAxis
                        domain={['dataMin', 'dataMax']}
                        tick={{ fontSize: 9, fill: '#4a5568' }}
                        width={45}
                        tickFormatter={(v) => Number(v).toFixed(4)}
                    />
                    <Tooltip
                        contentStyle={{ background: '#0d1117', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: 11 }}
                        labelFormatter={(v) => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        formatter={(v, n) => [Number(v).toFixed(4), n === 'price' ? 'Price' : n]}
                    />
                    {/* Trigger price baseline */}
                    <ReferenceLine y={trig} stroke="#718096" strokeDasharray="2 4" label={{ value: 'Trig', fill: '#718096', fontSize: 9, position: 'insideTopLeft' }} />
                    {/* Level (smart level the trial is testing) */}
                    {lvl !== trig && (
                        <ReferenceLine y={lvl} stroke={lvlColor} strokeDasharray="3 3" label={{ value: trial.level_type || 'Lvl', fill: lvlColor, fontSize: 9, position: 'insideBottomRight' }} />
                    )}
                    {/* 5m EMA200 (most relevant gate for the trial) */}
                    {ema5m && (
                        <ReferenceLine y={ema5m} stroke={emaColor} strokeDasharray="1 3" label={{ value: '5m EMA', fill: emaColor, fontSize: 9, position: 'insideTopRight' }} />
                    )}
                    <Line
                        type="monotone"
                        dataKey="price"
                        stroke={lineColor}
                        strokeWidth={2}
                        dot={false}
                        isAnimationActive={false}
                    />
                    {/* Trigger marker */}
                    <ReferenceDot x={data[0].t} y={trig} r={3} fill={lineColor} stroke="#fff" strokeWidth={1} />
                </LineChart>
            </ResponsiveContainer>
        </div>
    );
}
