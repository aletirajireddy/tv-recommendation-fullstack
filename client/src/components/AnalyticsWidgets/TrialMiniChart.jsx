import React, { useEffect, useState, useRef } from 'react';
import {
    Area, Bar, XAxis, YAxis, Tooltip,
    ReferenceLine, ReferenceArea, ResponsiveContainer, ComposedChart,
} from 'recharts';
import socketService from '../../services/SocketService';

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
 *
 * --- TIER 2 NETWORK OPTIMIZATIONS (module scope) ---
 * The previous version fired one OHLC + one vol-events fetch per trial card on
 * EVERY mount. With 12 visible trials and a parent that re-renders 3× during
 * page load, that meant 12×2×3 = 72 requests, almost all cancelled mid-flight
 * (trace evidence: all 12 OHLC rows showed "cancelled" status).
 *
 * The four guards below — cache, in-flight dedup, stagger queue, abort-on-unmount —
 * collapse that to a single network call per trial_id per 30s, regardless of how
 * many times React mounts/unmounts the component or how many concurrent callers
 * ask for the same trial. The validator-update socket event invalidates a single
 * trial's cache entry the moment its state transitions, so resolved verdicts
 * never show stale charts.
 */

// ──────────────────────────────────────────────────────────────────────────
// Module-scoped caches & queues — shared across all TrialMiniChart instances.
// Survive React unmount/remount (the whole point of this layer).
// ──────────────────────────────────────────────────────────────────────────

const OHLC_TTL_MS    = 30_000;   // re-mount within 30s returns instant cached data
const CACHE_MAX      = 100;       // LRU cap (~3KB per entry × 100 = 300KB worst case)
const STAGGER_GAP_MS = 60;        // 60ms between cold fetches → 12 trials = ~720ms total

// Map<trial_id, { ohlc, volEvents, ts }>  — insertion-order = LRU order
const _ohlcCache = new Map();

// Map<trial_id, Promise>  — coalesces concurrent callers onto the same network call
const _ohlcInflight = new Map();

// Stagger queue — same pattern as useDataInvalidation, dedicated instance so the
// two queues don't interfere with each other.
let _staggerQueue = [];
let _staggerTimer = null;
function _staggerFlush() {
    if (_staggerQueue.length === 0) { _staggerTimer = null; return; }
    const fn = _staggerQueue.shift();
    try { fn(); } catch { /* noop */ }
    _staggerTimer = setTimeout(_staggerFlush, STAGGER_GAP_MS);
}
function _staggerEnqueue(fn) {
    _staggerQueue.push(fn);
    if (!_staggerTimer) _staggerTimer = setTimeout(_staggerFlush, 0);
}

function _cacheGet(trialId) {
    const hit = _ohlcCache.get(trialId);
    if (!hit) return null;
    if ((Date.now() - hit.ts) > OHLC_TTL_MS) {
        _ohlcCache.delete(trialId);
        return null;
    }
    // Refresh LRU position: re-insert moves to end of insertion order
    _ohlcCache.delete(trialId);
    _ohlcCache.set(trialId, hit);
    return hit;
}

function _cacheSet(trialId, data) {
    // Evict oldest if at cap (Map iteration is insertion-order = FIFO)
    if (_ohlcCache.size >= CACHE_MAX) {
        const oldest = _ohlcCache.keys().next().value;
        if (oldest !== undefined) _ohlcCache.delete(oldest);
    }
    _ohlcCache.set(trialId, { ...data, ts: Date.now() });
}

// Module-level socket subscription — ONE listener for all chart instances,
// not one per card. Drops the cache entry for whichever trial just transitioned
// state, so the next mount re-fetches fresh data. Safe to attach unconditionally;
// SocketService.connect() is idempotent (returns existing socket if present).
let _socketSubscribed = false;
function _ensureSocketSubscription() {
    if (_socketSubscribed) return;
    _socketSubscribed = true;
    socketService.on('validator-update', (payload) => {
        // Defensive: payload shape may vary by event; only invalidate if we got an ID
        const id = payload?.trial_id || payload?.id;
        if (id && _ohlcCache.has(id)) _ohlcCache.delete(id);
        // No id given → conservative full clear (rare path; e.g. bulk recompute event)
        if (!id && payload?.bulk) _ohlcCache.clear();
    });
}

/**
 * Core fetcher with in-flight dedup. Returns a Promise that resolves to
 * { ohlc, volEvents } or null on failure.
 *
 * @param {string} trialId
 * @param {string} ticker
 * @param {string} detectedAt   ISO string
 * @param {AbortSignal} signal  per-instance abort signal (only aborts THIS caller's wait,
 *                              not the underlying shared fetch — other subscribers still receive)
 */
function _fetchOhlcDeduped(trialId, ticker, detectedAt) {
    // 1. Cache hit → instant
    const cached = _cacheGet(trialId);
    if (cached) return Promise.resolve({ ohlc: cached.ohlc, volEvents: cached.volEvents });

    // 2. In-flight → reuse the same Promise (true dedup; no second network call)
    if (_ohlcInflight.has(trialId)) return _ohlcInflight.get(trialId);

    // 3. Cold → schedule via stagger queue so 12 simultaneous mounts spread out
    const promise = new Promise((resolve) => {
        _staggerEnqueue(async () => {
            // Re-check cache: another caller may have populated it while we waited
            const lateCached = _cacheGet(trialId);
            if (lateCached) {
                resolve({ ohlc: lateCached.ohlc, volEvents: lateCached.volEvents });
                return;
            }
            try {
                const ohlcRes = await fetch(
                    `/api/validator/trial/${encodeURIComponent(trialId)}/ohlc?interval=5`
                );
                if (!ohlcRes.ok) { resolve(null); return; }
                const ohlc = await ohlcRes.json();
                if (!ohlc || ohlc.error) { resolve(null); return; }

                // Chained vol-events fetch — same staggering benefit, no extra burst
                let volEvents = [];
                try {
                    const since_min = Math.ceil((Date.now() - new Date(detectedAt).getTime()) / 60000) + 30;
                    const cappedMin = Math.min(since_min, 1440); // max 24h
                    const vRes = await fetch(
                        `/api/volume-events?ticker=${encodeURIComponent(ticker)}&since_min=${cappedMin}&limit=30`
                    );
                    if (vRes.ok) {
                        const vd = await vRes.json();
                        if (vd?.events?.length) volEvents = vd.events;
                    }
                } catch { /* vol events failure is non-fatal */ }

                _cacheSet(trialId, { ohlc, volEvents });
                resolve({ ohlc, volEvents });
            } catch {
                resolve(null);
            } finally {
                _ohlcInflight.delete(trialId);
            }
        });
    });

    _ohlcInflight.set(trialId, promise);
    return promise;
}

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
    // Synchronous cache priming — if data is already cached at render time we
    // skip the "Loading chart…" placeholder entirely (no flicker on remount).
    const _primed = _cacheGet(trial.trial_id);
    const [ohlc, setOhlc]         = useState(_primed?.ohlc ?? null);
    const [volEvents, setVolEvents] = useState(_primed?.volEvents ?? []);

    // alive flag survives the closure; flips false on unmount so we never
    // call setState on an unmounted component (also avoids React warnings).
    const aliveRef = useRef(true);

    useEffect(() => {
        aliveRef.current = true;
        _ensureSocketSubscription();

        // If we primed synchronously above, no fetch needed.
        if (_primed) return () => { aliveRef.current = false; };

        _fetchOhlcDeduped(trial.trial_id, trial.ticker, trial.detected_at)
            .then(result => {
                if (!aliveRef.current || !result) return;
                setOhlc(result.ohlc);
                if (result.volEvents?.length) setVolEvents(result.volEvents);
            });

        return () => { aliveRef.current = false; };
    // _primed is intentionally not a dep: it's read once on mount and the
    // socket-driven cache invalidation handles refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

    // Map vol events onto the nearest candle bucket.
    // candle.ts is the bucket start in ms; interval is 5 min = 300 000 ms.
    const INTERVAL_MS = ohlc.interval_min ? ohlc.interval_min * 60_000 : 300_000;
    const volMap = new Map();
    for (const e of volEvents) {
        const eMs = typeof e.ts === 'number' ? e.ts : new Date(e.ts).getTime();
        let best = null, bestDiff = Infinity;
        for (const c of candles) {
            const diff = Math.abs(c.ts - eMs);
            if (diff < bestDiff && diff <= INTERVAL_MS * 1.5) { bestDiff = diff; best = c.ts; }
        }
        if (best !== null) volMap.set(best, (volMap.get(best) || 0) + (e.strength || 1));
    }

    // Build series: close price (raw, unrounded) + vol strength per bucket
    const series = candles.map(c => ({
        t:           c.ts,
        price:       c.close,   // actual candle close — no rounding, exact from DB
        volStrength: volMap.get(c.ts) || 0,
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
        <div style={{ height: 120, width: '100%' }}>
            <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={series} margin={{ top: 6, right: 48, left: 0, bottom: 0 }}>
                    <XAxis
                        dataKey="t" type="number" scale="time"
                        domain={['dataMin', 'dataMax']}
                        tickFormatter={fmtTime}
                        tick={{ fontSize: 9, fill: 'var(--text-muted)' }}
                        tickCount={3}
                    />
                    {/* Price axis — exact close values, displayed via smartFmt labels only */}
                    <YAxis
                        yAxisId="price"
                        domain={[pMin - pPad, pMax + pPad]}
                        tick={{ fontSize: 9, fill: 'var(--text-muted)' }}
                        tickFormatter={smartFmt}
                        width={55}
                        tickCount={4}
                    />
                    {/* Volume axis — hidden, 5× inflated so bars sit in bottom ~20% */}
                    <YAxis
                        yAxisId="vol"
                        orientation="right"
                        domain={[0, dataMax => dataMax * 5]}
                        hide
                    />
                    <Tooltip
                        contentStyle={{ background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 6, fontSize: 10 }}
                        labelFormatter={(v) => fmtTime(v)}
                        formatter={(v, name) => name === 'Vol' ? [v.toFixed(1), 'Vol Strength'] : [smartFmt(v), 'Price']}
                    />

                    {/* Phase zones */}
                    {cooldownStart != null && cooldownEnd != null && (
                        <ReferenceArea yAxisId="price" x1={cooldownStart} x2={cooldownEnd}
                            fill="rgba(0,0,0,0.05)" stroke="none"
                            label={{ value: 'COOLDOWN', fill: 'var(--text-muted)', fontSize: 8, position: 'insideTopLeft' }}
                        />
                    )}
                    {watchStart != null && watchEnd != null && watchEnd > watchStart && (
                        <ReferenceArea yAxisId="price" x1={watchStart} x2={watchEnd}
                            fill="rgba(49, 130, 206, 0.04)" stroke="none"
                            label={{ value: 'WATCHING', fill: 'var(--accent-blue)', opacity: 0.6, fontSize: 8, position: 'insideTopLeft' }}
                        />
                    )}

                    {/* Key price levels — raw values, no rounding */}
                    {levels.ema200_5m > 0 && (
                        <ReferenceLine yAxisId="price" y={levels.ema200_5m} stroke="var(--accent-blue)" strokeDasharray="2 4" strokeWidth={1}
                            label={{ value: '5m EMA', fill: 'var(--accent-blue)', fontSize: 8, position: 'right' }}
                        />
                    )}
                    {levels.smart_level > 0 && levels.smart_level !== levels.trigger && (
                        <ReferenceLine yAxisId="price" y={levels.smart_level} stroke="var(--warning)" strokeDasharray="5 3" strokeWidth={1.5}
                            label={{ value: ohlc.level_type?.replace('EMA200_', '') || 'Level', fill: '#FACC15', fontSize: 9, position: 'insideBottomRight' }}
                        />
                    )}
                    {levels.trigger > 0 && (
                        <ReferenceLine yAxisId="price" y={levels.trigger} stroke="var(--text-muted)" strokeDasharray="3 3" strokeWidth={1} opacity={0.3}
                            label={{ value: 'T', fill: '#94A3B8', fontSize: 9, position: 'insideBottomRight' }}
                        />
                    )}

                    {/* Trigger vertical */}
                    {cooldownStart != null && (
                        <ReferenceLine yAxisId="price" x={cooldownStart} stroke="#9f7aea" strokeDasharray="3 2" strokeWidth={1.5} />
                    )}

                    {/* Volume spike source-color pins on the price axis */}
                    {volEvents
                        .map(e => ({ t: new Date(e.ts).getTime(), src: e.source }))
                        .filter(e => e.t >= (series[0]?.t ?? 0) && e.t <= (series.at(-1)?.t ?? Infinity))
                        .map((e, i) => {
                            const color = VOL_SRC_COLOR[e.src] || 'var(--text-muted)';
                            return (
                                <ReferenceLine key={`vol-${i}`}
                                    yAxisId="price"
                                    x={e.t}
                                    stroke={color} strokeOpacity={0.35}
                                    strokeDasharray="2 3" strokeWidth={1}
                                />
                            );
                        })
                    }

                    {/* Verdict vertical */}
                    {phases.resolved_ms != null && (
                        <ReferenceLine yAxisId="price" x={phases.resolved_ms}
                            stroke={ohlc.verdict === 'CONFIRMED' ? 'var(--accent-green)' : 'var(--accent-red)'}
                            strokeDasharray="3 2" strokeWidth={1.5}
                        />
                    )}

                    {/* Volume magnitude bars — amber, bottom-anchored via secondary hidden axis */}
                    <Bar
                        yAxisId="vol"
                        dataKey="volStrength"
                        name="Vol"
                        fill="#F59E0B"
                        barSize={4}
                        radius={[2, 2, 0, 0]}
                        isAnimationActive={false}
                        opacity={0.80}
                    />

                    {/* Price area + line — exact close values, no rounding */}
                    <Area
                        yAxisId="price"
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
