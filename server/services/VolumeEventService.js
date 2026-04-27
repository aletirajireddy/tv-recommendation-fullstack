/**
 * VolumeEventService — Truth-source for "did volume spike at moment X?"
 *
 * Problem: Stream A's `volSpike` flag stays sticky for ~15 min after a spike
 * fires, so consumers can't tell "spiking right now" from "spiked 14 min ago".
 * The 24h-volume counter is monotonic. Both are useless as event signals.
 *
 * Solution: Discrete events keyed by (ticker, ts, source):
 *   - STREAM_C_ALERT  → emitted on every Stream C webhook (TV alert moment = truth)
 *   - STREAM_A_EDGE   → emitted on the LEADING edge of a Stream A volSpike run
 *                       (per-ticker rising-edge detector; further spikes inside
 *                        the same ~15-min sticky window are suppressed)
 *   - STREAM_D_RVOL   → emitted when Stream D relativevolume crosses ≥ 2.0
 *
 * Widgets call getEvents(ticker, sinceISO) and render pins on the timeline.
 */

const db = require('../database');

// Module-scope prepared statements — better-sqlite3 caches prepares but inline
// calls still re-walk the cache + re-allocate the SQL string. Hoisting saves
// ~5-15% on hot ingest paths and avoids waste during the backfill loop.
const _stmtInsertEvent = db.prepare(`
    INSERT OR IGNORE INTO volume_events
    (ticker, ts, source, strength, payload_hash, meta)
    VALUES (?, ?, ?, ?, ?, ?)
`);

class VolumeEventService {
    constructor() {
        // In-memory rising-edge tracker for Stream A.
        // ticker → { lastFlagState: bool, lastEdgeMs: number }
        this._streamAEdgeState = new Map();
        // RelVol gate so we don't re-fire the same Stream D crossing.
        this._streamDRvolState = new Map();   // ticker → lastFiredMs
        this.STREAM_A_REARM_MS = 15 * 60 * 1000;  // sticky window
        this.STREAM_D_REARM_MS = 10 * 60 * 1000;
        this.STREAM_D_RVOL_THRESHOLD = 2.0;
    }

    /**
     * Insert one event. Idempotent on (ticker, ts, source) — duplicates dropped.
     * @returns {boolean} true if inserted, false if dedup-skipped or invalid.
     */
    record({ ticker, ts, source, strength = 1.0, payloadHash = null, meta = null }) {
        if (!ticker || !ts || !source) return false;
        try {
            const result = _stmtInsertEvent.run(
                ticker, ts, source, strength, payloadHash,
                meta ? JSON.stringify(meta) : null
            );
            return result.changes > 0;
        } catch (err) {
            // Throttle log spam (audit fix L2 — backfill produced thousands per restart)
            if (!this._lastErrLog || Date.now() - this._lastErrLog > 5000) {
                console.error('[VolumeEvent] insert error:', err.message);
                this._lastErrLog = Date.now();
            }
            return false;
        }
    }

    /**
     * Hook for Stream C webhook ingest. Called from the webhook handler.
     * Trust the alert moment — TradingView fired it because conditions were met
     * RIGHT NOW. This is our authoritative "spike happened" signal.
     */
    onStreamC({ ticker, ts, payload, payloadHash }) {
        // Optional strength heuristic: alert payload sometimes carries
        // bar_move_pct or roc — bigger move ≈ bigger spike.
        const strength = payload?.bar_move_pct
            ? Math.min(5, Math.max(1, Math.abs(parseFloat(payload.bar_move_pct)) / 2 + 1))
            : 1.0;
        this.record({
            ticker,
            ts,
            source: 'STREAM_C_ALERT',
            strength,
            payloadHash,
            meta: {
                direction:  payload?.direction ?? payload?.momentum?.direction ?? null,
                price:      payload?.price ?? null,
                bar_move:   payload?.bar_move_pct ?? null,
                today_vol:  payload?.today_volume ?? null,
            },
        });
    }

    /**
     * Hook for Stream A scan ingest. Called per-coin from the scan handler.
     * Detects rising edge: previous flag = false → current = true => emit event.
     * Suppresses re-fires within STREAM_A_REARM_MS of last edge to avoid
     * double-counting against the sticky 15-min window.
     */
    onStreamA({ ticker, ts, volSpike, price, direction }) {
        const isSpike = volSpike === true || volSpike === 1 || volSpike === '1';
        const prev    = this._streamAEdgeState.get(ticker) || { lastFlagState: false, lastEdgeMs: 0 };
        const tsMs    = new Date(ts).getTime();

        // Rising edge AND outside re-arm window
        if (isSpike && !prev.lastFlagState && (tsMs - prev.lastEdgeMs) > this.STREAM_A_REARM_MS) {
            this.record({
                ticker,
                ts,
                source: 'STREAM_A_EDGE',
                strength: 1.0,
                meta: { price, direction },
            });
            this._streamAEdgeState.set(ticker, { lastFlagState: true, lastEdgeMs: tsMs });
        } else {
            // Just track flag state for next call
            this._streamAEdgeState.set(ticker, { lastFlagState: isSpike, lastEdgeMs: prev.lastEdgeMs });
        }
    }

    /**
     * Hook for Stream D scan ingest. Called per-coin from the technicals handler.
     * Looks for relative-volume crossings (any field whose lower-cased name
     * contains "relvol" or "rel_vol" or "relativevolume").
     */
    onStreamD({ ticker, ts, data }) {
        if (!data || typeof data !== 'object') return;
        let rvol = null;
        for (const [k, v] of Object.entries(data)) {
            const lk = k.toLowerCase();
            if (lk.includes('relvol') || lk.includes('rel_vol') || lk.includes('relativevolume')) {
                const n = parseFloat(v);
                if (!isNaN(n) && n > (rvol || 0)) rvol = n;
            }
        }
        if (rvol == null || rvol < this.STREAM_D_RVOL_THRESHOLD) return;

        const tsMs = new Date(ts).getTime();
        const last = this._streamDRvolState.get(ticker) || 0;
        if (tsMs - last < this.STREAM_D_REARM_MS) return;

        this.record({
            ticker,
            ts,
            source: 'STREAM_D_RVOL',
            strength: Math.min(5, rvol),
            meta: { relVol: rvol },
        });
        this._streamDRvolState.set(ticker, tsMs);
    }

    /**
     * Read events for a ticker (or all tickers) since a given time.
     * @param {string|null} ticker - null = all tickers
     * @param {string} sinceISO    - ISO timestamp lower bound
     * @param {number} [limit=200]
     */
    getEvents(ticker, sinceISO, limit = 200) {
        const sql = ticker
            ? `SELECT id, ticker, ts, source, strength, meta
               FROM volume_events
               WHERE ticker = ? AND ts >= ?
               ORDER BY ts DESC LIMIT ?`
            : `SELECT id, ticker, ts, source, strength, meta
               FROM volume_events
               WHERE ts >= ?
               ORDER BY ts DESC LIMIT ?`;
        const rows = ticker
            ? db.prepare(sql).all(ticker, sinceISO, limit)
            : db.prepare(sql).all(sinceISO, limit);
        return rows.map(r => ({
            ...r,
            meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return null; } })() : null,
        }));
    }

    /**
     * Batch-fetch events for multiple tickers + their variants in ONE query.
     * Used by /api/volume-events?tickers=BTC,ETH,... to avoid N+1 (audit M1).
     *
     * Returns { events: [...], by_canonical: { BTC: [...], ETH: [...] } } where
     * `by_canonical` is keyed by the input ticker (variants collapsed back).
     *
     * @param {string[]} tickers     - input ticker labels (e.g. ['BTC','ETH'])
     * @param {string}   sinceISO    - ISO timestamp lower bound
     * @param {number}   [perTicker=200]
     */
    getEventsBatch(tickers, sinceISO, perTicker = 200) {
        if (!Array.isArray(tickers) || tickers.length === 0) {
            return { events: [], by_canonical: {} };
        }
        // Build variant set + reverse map (variant → canonical input label)
        const variantToCanonical = new Map();
        const allVariants = new Set();
        for (const t of tickers) {
            const variants = [
                t, `${t}USDT.P`, `${t}USDT`,
                t.replace(/USDT\.P$|USDT$/, ''),
            ].filter(Boolean);
            for (const v of variants) {
                allVariants.add(v);
                if (!variantToCanonical.has(v)) variantToCanonical.set(v, t);
            }
        }
        const variantList = Array.from(allVariants);
        if (variantList.length === 0) return { events: [], by_canonical: {} };

        // Single IN-clause query — one round-trip regardless of ticker count.
        const placeholders = variantList.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT id, ticker, ts, source, strength, meta
            FROM volume_events
            WHERE ts >= ? AND ticker IN (${placeholders})
            ORDER BY ts DESC
        `).all(sinceISO, ...variantList);

        const by_canonical = {};
        for (const t of tickers) by_canonical[t] = [];
        const counts_by_canonical = {};
        for (const t of tickers) counts_by_canonical[t] = { STREAM_C_ALERT: 0, STREAM_A_EDGE: 0, STREAM_D_RVOL: 0, total: 0 };

        const events = [];
        for (const r of rows) {
            const canonical = variantToCanonical.get(r.ticker);
            if (!canonical) continue;
            if (by_canonical[canonical].length >= perTicker) continue;
            const meta = r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return null; } })() : null;
            const evt = { ...r, meta };
            by_canonical[canonical].push(evt);
            const c = counts_by_canonical[canonical];
            c[r.source] = (c[r.source] || 0) + 1;
            c.total += 1;
            events.push(evt);
        }
        return { events, by_canonical, counts_by_canonical };
    }

    /**
     * Quick aggregate — counts per source for a ticker in a window.
     * Useful for "spike density in last hour" badges.
     */
    countBySource(ticker, sinceISO) {
        const rows = db.prepare(`
            SELECT source, COUNT(*) AS n FROM volume_events
            WHERE ticker = ? AND ts >= ? GROUP BY source
        `).all(ticker, sinceISO);
        const out = { STREAM_C_ALERT: 0, STREAM_A_EDGE: 0, STREAM_D_RVOL: 0, total: 0 };
        rows.forEach(r => { out[r.source] = r.n; out.total += r.n; });
        return out;
    }

    /**
     * Backfill from existing data. Called once at server start to populate the
     * table from history that predates the live hooks.
     *   - Stream C alerts → smart_level_events + institutional_interest_events
     *   - Stream A edges  → walk master_coin_store STREAM_A rows in chronological order
     */
    backfill({ verbose = true } = {}) {
        const t0 = Date.now();
        let cAlerts = 0, instAlerts = 0, aEdges = 0, dRvols = 0;

        // PERF AUDIT FIX (C2/C3): each section wrapped in a single transaction.
        // - Eliminates per-row implicit-commit fsyncs (3+ per row → 1 per section)
        // - On a 50k-row table this drops backfill from minutes to seconds
        // - Event loop is still blocked (better-sqlite3 is sync) but the duration
        //   shrinks ~50-100×, so in practice the boot pause is unnoticeable.

        // 1. Stream C alerts from smart_level_events
        try {
            const rows = db.prepare(
                `SELECT ticker, timestamp, payload_hash, raw_data
                 FROM smart_level_events ORDER BY id ASC`
            ).all();
            cAlerts = db.transaction(() => {
                let n = 0;
                for (const r of rows) {
                    let payload = null;
                    try { payload = JSON.parse(r.raw_data); } catch {}
                    if (this.record({
                        ticker: r.ticker, ts: r.timestamp, source: 'STREAM_C_ALERT',
                        strength: 1.0, payloadHash: r.payload_hash,
                        meta: payload ? { direction: payload.direction, price: payload.price } : null,
                    })) n++;
                }
                return n;
            })();
        } catch (e) { console.error('[VolumeEvent] backfill C/SL error:', e.message); }

        // 2. Institutional interest events
        try {
            const rows = db.prepare(
                `SELECT ticker, timestamp, payload_hash, raw_data
                 FROM institutional_interest_events ORDER BY id ASC`
            ).all();
            instAlerts = db.transaction(() => {
                let n = 0;
                for (const r of rows) {
                    let payload = null;
                    try { payload = JSON.parse(r.raw_data); } catch {}
                    const strength = payload?.bar_move_pct
                        ? Math.min(5, Math.abs(parseFloat(payload.bar_move_pct)) / 2 + 1)
                        : 1.5;
                    if (this.record({
                        ticker: r.ticker, ts: r.timestamp, source: 'STREAM_C_ALERT',
                        strength, payloadHash: r.payload_hash,
                        meta: payload ? { direction: payload.direction, type: 'INSTITUTIONAL', price: payload.price } : null,
                    })) n++;
                }
                return n;
            })();
        } catch (e) { console.error('[VolumeEvent] backfill C/INST error:', e.message); }

        // 3. Stream A edges from master_coin_store. Walk per-ticker chronologically.
        try {
            const tickers = db.prepare(
                `SELECT DISTINCT ticker FROM master_coin_store WHERE trigger_source = 'STREAM_A'`
            ).all();
            // Hoist the per-ticker statement once
            const aStmt = db.prepare(
                `SELECT timestamp, stream_a_state FROM master_coin_store
                 WHERE ticker = ? AND trigger_source = 'STREAM_A'
                 ORDER BY timestamp ASC`
            );
            aEdges = db.transaction(() => {
                let n = 0;
                for (const { ticker } of tickers) {
                    const rows = aStmt.all(ticker);
                    let prevSpike = false, lastEdgeMs = 0;
                    for (const r of rows) {
                        let s; try { s = JSON.parse(r.stream_a_state); } catch { continue; }
                        const isSpike = s?.volSpike === true || s?.volSpike === 1 || s?.volSpike === '1';
                        const tsMs = new Date(r.timestamp).getTime();
                        if (isSpike && !prevSpike && (tsMs - lastEdgeMs) > this.STREAM_A_REARM_MS) {
                            if (this.record({
                                ticker, ts: r.timestamp, source: 'STREAM_A_EDGE',
                                strength: 1.0, meta: { price: s.close, direction: s.direction },
                            })) n++;
                            lastEdgeMs = tsMs;
                        }
                        prevSpike = isSpike;
                    }
                    this._streamAEdgeState.set(ticker, { lastFlagState: prevSpike, lastEdgeMs });
                }
                return n;
            })();
        } catch (e) { console.error('[VolumeEvent] backfill A error:', e.message); }

        // 4. Stream D RelVol crossings
        try {
            const tickers = db.prepare(
                `SELECT DISTINCT ticker FROM master_coin_store WHERE trigger_source = 'STREAM_D'`
            ).all();
            const dStmt = db.prepare(
                `SELECT timestamp, stream_d_state FROM master_coin_store
                 WHERE ticker = ? AND trigger_source = 'STREAM_D'
                 ORDER BY timestamp ASC`
            );
            dRvols = db.transaction(() => {
                let n = 0;
                for (const { ticker } of tickers) {
                    const rows = dStmt.all(ticker);
                    let lastFireMs = 0;
                    for (const r of rows) {
                        let d; try { d = JSON.parse(r.stream_d_state); } catch { continue; }
                        let rvol = null;
                        for (const [k, v] of Object.entries(d)) {
                            const lk = k.toLowerCase();
                            if (lk.includes('relvol') || lk.includes('rel_vol') || lk.includes('relativevolume')) {
                                const num = parseFloat(v);
                                if (!isNaN(num) && num > (rvol || 0)) rvol = num;
                            }
                        }
                        if (rvol == null || rvol < this.STREAM_D_RVOL_THRESHOLD) continue;
                        const tsMs = new Date(r.timestamp).getTime();
                        if (tsMs - lastFireMs < this.STREAM_D_REARM_MS) continue;
                        if (this.record({
                            ticker, ts: r.timestamp, source: 'STREAM_D_RVOL',
                            strength: Math.min(5, rvol), meta: { relVol: rvol },
                        })) n++;
                        lastFireMs = tsMs;
                    }
                    this._streamDRvolState.set(ticker, lastFireMs);
                }
                return n;
            })();
        } catch (e) { console.error('[VolumeEvent] backfill D error:', e.message); }

        // PERF AUDIT FIX (L1): cap in-memory state Maps to prevent unbounded growth
        // across the lifetime of long-running processes.
        this._evictIfOversize(this._streamAEdgeState, 2000);
        this._evictIfOversize(this._streamDRvolState, 2000);

        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        if (verbose) {
            console.log(`[VolumeEvent] ✅ Backfill complete in ${dt}s — `
                + `Stream C/SL: ${cAlerts}, C/Inst: ${instAlerts}, A edges: ${aEdges}, D RelVol: ${dRvols}`);
        }
        return { cAlerts, instAlerts, aEdges, dRvols };
    }

    /**
     * LRU-style trim: drops oldest insertion-order entries until size <= cap.
     * Map iteration order is insertion-order so this is effectively a FIFO cap.
     * Cheap (one shot per backfill / hourly tick).
     */
    _evictIfOversize(map, cap) {
        if (!map || map.size <= cap) return;
        const drop = map.size - cap;
        let i = 0;
        for (const k of map.keys()) {
            if (i++ >= drop) break;
            map.delete(k);
        }
    }
}

module.exports = new VolumeEventService();
