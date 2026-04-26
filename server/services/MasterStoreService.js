const db = require('../database');
const crypto = require('crypto');
const TimestampResolver = require('./TimestampResolver');

/**
 * MasterStoreService — Unified V4 event timeline.
 *
 * IMPORTANT (Timestamp Policy, locked 2026-04-25):
 *   - The canonical timestamp is ALWAYS supplied by the caller (resolved upstream
 *     via TimestampResolver). This service NEVER invents `new Date()` for the row.
 *   - Callers must also pass `ingestion_source` ('WEBHOOK' | 'EMAIL' | 'SCAN_A' | 'SCOUT_B').
 *   - When ingesting a backfilled record (source='EMAIL'), the merge uses the
 *     point-in-time stream states AS OF that historical timestamp — NOT current
 *     latest state — to avoid corrupting the timeline with future data.
 */
class MasterStoreService {
    constructor() {
        this.lastPruneTime = 0;
        this.PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
    }

    /**
     * Get the most recent stream states AS OF a given timestamp.
     * For live (WEBHOOK / SCAN_A / SCOUT_B) ingestion this is "latest known".
     * For backfilled (EMAIL) ingestion this is "latest known up to and including asOfISO".
     */
    _getStateAsOf(ticker, asOfISO) {
        const stmt = db.prepare(`
            SELECT stream_a_state, stream_b_state, stream_c_state, stream_d_state
            FROM master_coin_store
            WHERE ticker = ? AND timestamp <= ?
            ORDER BY timestamp DESC
            LIMIT 1
        `);
        return stmt.get(ticker, asOfISO) || {
            stream_a_state: null,
            stream_b_state: null,
            stream_c_state: null,
            stream_d_state: null
        };
    }

    _mergeAndSave({ ticker, source, sliceKey, sliceData, price, resolvedTimestampISO, ingestionSource, payloadHash }) {
        try {
            // 1. Hash dedup — skip if this exact payload was already stored.
            if (payloadHash) {
                const existing = db.prepare(
                    'SELECT snapshot_id FROM master_coin_store WHERE payload_hash = ? LIMIT 1'
                ).get(payloadHash);
                if (existing) {
                    return { skipped: true, reason: 'duplicate_payload_hash' };
                }
            }

            // 2. Point-in-time merge — snapshot states AS OF resolvedTimestamp.
            const lastState = this._getStateAsOf(ticker, resolvedTimestampISO);
            const stateA = lastState.stream_a_state ? JSON.parse(lastState.stream_a_state) : {};
            const stateB = lastState.stream_b_state ? JSON.parse(lastState.stream_b_state) : {};
            const stateC = lastState.stream_c_state ? JSON.parse(lastState.stream_c_state) : {};
            const stateD = lastState.stream_d_state ? JSON.parse(lastState.stream_d_state) : {};

            const finalStateA = sliceKey === 'A' ? sliceData : stateA;
            const finalStateB = sliceKey === 'B' ? sliceData : stateB;
            const finalStateC = sliceKey === 'C' ? sliceData : stateC;
            const finalStateD = sliceKey === 'D' ? sliceData : stateD;

            const mergedState = {
                ticker,
                price,
                last_updated: resolvedTimestampISO,
                trigger_source: source,
                ingestion_source: ingestionSource,
                stream_a: finalStateA,
                stream_b: finalStateB,
                stream_c: finalStateC,
                stream_d: finalStateD
            };

            const stmt = db.prepare(`
                INSERT INTO master_coin_store (
                    snapshot_id, ticker, timestamp, trigger_source, price,
                    stream_a_state, stream_b_state, stream_c_state, stream_d_state, merged_state,
                    payload_hash, ingestion_source
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            stmt.run(
                crypto.randomUUID(),
                ticker,
                resolvedTimestampISO,
                source,
                price || 0,
                JSON.stringify(finalStateA),
                JSON.stringify(finalStateB),
                JSON.stringify(finalStateC),
                JSON.stringify(finalStateD),
                JSON.stringify(mergedState),
                payloadHash || null,
                ingestionSource || 'WEBHOOK'
            );

            this._runPruneEngine();
            return { skipped: false };
        } catch (error) {
            console.error(`[MasterStore] Error merging state for ${ticker}:`, error.message);
            return { skipped: true, reason: 'error', error: error.message };
        }
    }

    /**
     * Stream A: Macro & Micro Indicators (Tampermonkey scanner).
     * @param {string} ticker
     * @param {object} data - Per-coin slice from scan payload
     * @param {number} price
     * @param {object} [opts]
     * @param {string} [opts.timestampISO] - Pre-resolved timestamp. If omitted, resolver is called here.
     * @param {string} [opts.ingestionSource='SCAN_A']
     */
    async ingestStreamA(ticker, data, price, opts = {}) {
        const resolved = opts.timestampISO
            ? { timestampISO: opts.timestampISO }
            : TimestampResolver.resolve({ stream: 'STREAM_A', source: 'SCAN_A', payload: data });
        const payloadHash = TimestampResolver.computePayloadHash({ ticker, price, ...data });
        this._mergeAndSave({
            ticker,
            source: 'STREAM_A',
            sliceKey: 'A',
            sliceData: data,
            price,
            resolvedTimestampISO: resolved.timestampISO,
            ingestionSource: opts.ingestionSource || 'SCAN_A',
            payloadHash,
        });
    }

    /**
     * Stream B: Watchlist Context (Coin Scout).
     */
    async ingestStreamB(ticker, data, price, opts = {}) {
        const resolved = opts.timestampISO
            ? { timestampISO: opts.timestampISO }
            : TimestampResolver.resolve({ stream: 'STREAM_B', source: 'SCOUT_B', payload: data });
        const payloadHash = TimestampResolver.computePayloadHash({ ticker, price, ...data });
        this._mergeAndSave({
            ticker,
            source: 'STREAM_B',
            sliceKey: 'B',
            sliceData: data,
            price,
            resolvedTimestampISO: resolved.timestampISO,
            ingestionSource: opts.ingestionSource || 'SCOUT_B',
            payloadHash,
        });
    }

    /**
     * Stream C: Smart Levels / Alerts (TradingView).
     * @param {string} ticker
     * @param {object} data - Raw alert payload
     * @param {number} price
     * @param {object} [opts]
     * @param {string} [opts.timestampISO] - REQUIRED: pre-resolved timestamp from caller.
     * @param {'WEBHOOK'|'EMAIL'} [opts.ingestionSource='WEBHOOK']
     * @param {string} [opts.payloadHash] - Optional pre-computed hash for cross-table dedup.
     */
    async ingestStreamC(ticker, data, price, opts = {}) {
        const resolved = opts.timestampISO
            ? { timestampISO: opts.timestampISO }
            : TimestampResolver.resolve({
                stream: 'STREAM_C',
                source: opts.ingestionSource || 'WEBHOOK',
                payload: data,
                emailReceivedMs: opts.emailReceivedMs,
            });
        const payloadHash = opts.payloadHash || TimestampResolver.computePayloadHash(data);
        this._mergeAndSave({
            ticker,
            source: 'STREAM_C',
            sliceKey: 'C',
            sliceData: data,
            price,
            resolvedTimestampISO: resolved.timestampISO,
            ingestionSource: opts.ingestionSource || 'WEBHOOK',
            payloadHash,
        });
    }

    /**
     * Stream D: Technical Watchlist Scanner (Tampermonkey → TradingView CEX Screener).
     *
     * DEDUP POLICY: Stream D is a regular time-series feed (every 2 min).
     * Technical indicator values change slowly — a content hash would deduplicate
     * consecutive scans with identical RSI/EMA values, creating gaps.
     * Instead we use a (ticker, 2-min-bucket) dedup key so we store exactly one
     * snapshot per coin per scan cycle regardless of value changes.
     */
    async ingestStreamD(ticker, data, price, opts = {}) {
        const resolved = opts.timestampISO
            ? { timestampISO: opts.timestampISO }
            : TimestampResolver.resolve({ stream: 'STREAM_D', source: 'WATCHLIST_TECHNICALS', payload: data });

        // Bucket-based dedup: one row per (ticker, 2-min window).
        // This replaces content-hash dedup which would skip unchanged indicator snapshots.
        const tsBucketMs = Math.floor(new Date(resolved.timestampISO).getTime() / (2 * 60 * 1000)) * (2 * 60 * 1000);
        const bucketISO  = new Date(tsBucketMs).toISOString();
        const existing   = db.prepare(
            `SELECT snapshot_id FROM master_coin_store
             WHERE ticker = ? AND trigger_source = 'STREAM_D'
             AND timestamp >= ? AND timestamp < datetime(?, '+2 minutes')
             LIMIT 1`
        ).get(ticker, bucketISO, bucketISO);
        if (existing) return; // already have a D-snapshot for this 2-min window

        this._mergeAndSave({
            ticker,
            source: 'STREAM_D',
            sliceKey: 'D',
            sliceData: data,
            price,
            resolvedTimestampISO: resolved.timestampISO,
            ingestionSource: opts.ingestionSource || 'WATCHLIST_TECHNICALS',
            payloadHash: null, // no content dedup — bucket dedup above handles it
        });
    }

    /**
     * Return the latest stream_d_state for a given ticker.
     * Used by API endpoints to attach technical context to coin data.
     */
    getLatestStreamD(ticker) {
        const row = db.prepare(
            `SELECT stream_d_state, timestamp FROM master_coin_store
             WHERE ticker = ? AND stream_d_state IS NOT NULL AND trigger_source = 'STREAM_D'
             ORDER BY timestamp DESC LIMIT 1`
        ).get(ticker);
        if (!row) return null;
        try {
            return { data: JSON.parse(row.stream_d_state), ts: row.timestamp };
        } catch { return null; }
    }

    /**
     * Discover all field names present in stream_d_state across all tickers.
     * Returns a sorted, deduplicated list — used by frontend for dynamic rendering.
     */
    getStreamDSchema() {
        const rows = db.prepare(
            `SELECT stream_d_state FROM master_coin_store
             WHERE stream_d_state IS NOT NULL AND trigger_source = 'STREAM_D'
             ORDER BY timestamp DESC LIMIT 50`
        ).all();
        const fieldSet = new Set();
        for (const row of rows) {
            try {
                const d = JSON.parse(row.stream_d_state);
                Object.keys(d).forEach(k => fieldSet.add(k));
            } catch {}
        }
        return Array.from(fieldSet).sort();
    }

    // ════════════════════════════════════════════════════════════════════════
    // EMA200 STACK + SOURCE HEALTH (foundation for EMA Cascade Monitor)
    // ════════════════════════════════════════════════════════════════════════

    /**
     * Per-source TTLs (ms). Past these, the value is flagged `stale: true` but
     * still returned via Last-Observation-Carried-Forward. Widgets decide how
     * to render staleness (typically: grey out + dashed line).
     */
    static SOURCE_TTL_MS = {
        STREAM_A: 5  * 60 * 1000,   // scans every ~1 min, allow 5x slack
        STREAM_B: 5  * 60 * 1000,
        STREAM_C: 60 * 60 * 1000,   // alert levels valid until next alert
        STREAM_D: 6  * 60 * 1000,   // 2-min cadence, allow 3x slack
    };

    /**
     * Build the EMA200 ladder for a ticker by merging across sources with
     * explicit provenance + staleness.
     *
     *   m1   ← Stream D.ema_200                                  (2-min cadence)
     *   m5   ← smart_level_events.raw_data.smart_levels.emas_200.m5.p   (Stream C alert)
     *   m15  ← smart_level_events.raw_data.smart_levels.emas_200.m15.p
     *   h1   ← smart_level_events.raw_data.smart_levels.emas_200.h1.p
     *   h4   ← smart_level_events.raw_data.smart_levels.emas_200.h4.p
     *
     * NOTE: smart_levels does NOT live in master_coin_store.stream_*_state —
     * those store flat per-coin slices. The full alert with smart_levels lives
     * in `smart_level_events.raw_data` (one row per fired Stream C alert).
     *
     * Each TF entry: { price, source, ts, ageMs, stale } or null.
     *
     * @param {string} ticker - any of: BTC, BTCUSDT, BTCUSDT.P (auto-normalized)
     * @param {string} [asOfISO] - if supplied, point-in-time stack
     */
    getEMA200Stack(ticker, asOfISO = null) {
        const nowMs = asOfISO ? new Date(asOfISO).getTime() : Date.now();
        const TTL = MasterStoreService.SOURCE_TTL_MS;

        const buildEntry = (price, source, tsISO) => {
            const num = parseFloat(price);
            if (price == null || isNaN(num)) return null;
            const ts    = new Date(tsISO).getTime();
            const ageMs = nowMs - ts;
            return {
                price:  num,
                source,
                ts:     tsISO,
                ageMs,
                stale:  ageMs > (TTL[source] || 5 * 60 * 1000),
            };
        };

        // Ticker variants — DB stores BTCUSDT.P, callers may pass BTC.
        const t = (ticker || '').trim().toUpperCase();
        const variants = Array.from(new Set([
            t,
            `${t}USDT.P`,
            `${t}USDT`,
            t.replace(/USDT\.P$|USDT$/, ''),  // also try plain
        ].filter(Boolean)));

        // ── Stream D (m1, m5, m15 — and possibly h1/h4 if screener provides) ──
        //   Field convention: ema_200Timeresolution<N>  where N is minutes.
        //     1   → m1     5   → m5     15  → m15
        //     60  → h1     240 → h4
        //   Fallback: bare `ema_200` (single-TF screener) treated as m1.
        const TF_BY_RES = { 1: 'm1', 5: 'm5', 15: 'm15', 60: 'h1', 240: 'h4' };
        const tfPicks = { m1: null, m5: null, m15: null, h1: null, h4: null };
        let dTicker = null;

        for (const v of variants) {
            const dRow = db.prepare(
                asOfISO
                    ? `SELECT stream_d_state, timestamp FROM master_coin_store
                        WHERE ticker = ? AND trigger_source = 'STREAM_D'
                          AND stream_d_state IS NOT NULL AND timestamp <= ?
                        ORDER BY timestamp DESC LIMIT 1`
                    : `SELECT stream_d_state, timestamp FROM master_coin_store
                        WHERE ticker = ? AND trigger_source = 'STREAM_D'
                          AND stream_d_state IS NOT NULL
                        ORDER BY timestamp DESC LIMIT 1`
            ).get(...(asOfISO ? [v, asOfISO] : [v]));

            if (!dRow) continue;
            let d;
            try { d = JSON.parse(dRow.stream_d_state); } catch { continue; }
            dTicker = v;

            // Match every ema_200Timeresolution<N> key
            for (const key of Object.keys(d)) {
                const m = key.match(/^ema_200Timeresolution(\d+)$/i);
                if (!m) continue;
                const tfSlot = TF_BY_RES[parseInt(m[1], 10)];
                if (!tfSlot) continue;
                const entry = buildEntry(d[key], 'STREAM_D', dRow.timestamp);
                if (entry) tfPicks[tfSlot] = entry;
            }
            // Bare ema_200 as fallback for m1
            if (!tfPicks.m1 && d.ema_200 != null) {
                const entry = buildEntry(d.ema_200, 'STREAM_D', dRow.timestamp);
                if (entry) tfPicks.m1 = entry;
            }
            break;
        }

        // ── Stream C smart_level_events (fills any TF not provided by D) ───
        let resolvedTicker = dTicker;

        for (const v of variants) {
            const slRows = db.prepare(
                asOfISO
                    ? `SELECT raw_data, timestamp FROM smart_level_events
                        WHERE ticker = ? AND timestamp <= ?
                        ORDER BY id DESC LIMIT 30`
                    : `SELECT raw_data, timestamp FROM smart_level_events
                        WHERE ticker = ?
                        ORDER BY id DESC LIMIT 30`
            ).all(...(asOfISO ? [v, asOfISO] : [v]));

            if (!slRows.length) continue;
            if (!resolvedTicker) resolvedTicker = v;

            for (const row of slRows) {
                let parsed;
                try { parsed = JSON.parse(row.raw_data); } catch { continue; }
                const e200 = parsed?.smart_levels?.emas_200 || null;
                if (!e200) continue;

                // Fill ANY TF still missing — Stream C is the fallback source
                for (const tf of ['m1', 'm5', 'm15', 'h1', 'h4']) {
                    if (tfPicks[tf]) continue;          // D already won
                    const slot = e200[tf];
                    if (!slot) continue;
                    const p = slot.p ?? slot;            // {p,s} object OR raw
                    if (p == null) continue;
                    tfPicks[tf] = buildEntry(p, 'STREAM_C', row.timestamp);
                }
                if (tfPicks.m1 && tfPicks.m5 && tfPicks.m15 && tfPicks.h1 && tfPicks.h4) break;
            }
            // Stop searching variants once we got any data from this ticker
            if (Object.values(tfPicks).some(Boolean)) break;
        }

        return {
            ticker: resolvedTicker || t,
            asOf:   asOfISO || new Date(nowMs).toISOString(),
            m1:     tfPicks.m1,
            m5:     tfPicks.m5,
            m15:    tfPicks.m15,
            h1:     tfPicks.h1,
            h4:     tfPicks.h4,
        };
    }

    /**
     * Last-seen timestamp per ingestion source. Used by widgets to render
     * data-source health rows ("A: 0:42 ago · C: 12m ago · D: 1:58 ago").
     *
     * @param {string|null} ticker - null = global, otherwise per-ticker
     */
    getSourceHeartbeats(ticker = null) {
        const sources = ['STREAM_A', 'STREAM_B', 'STREAM_C', 'STREAM_D'];
        const result = {};
        const nowMs = Date.now();

        for (const src of sources) {
            const stmt = ticker
                ? db.prepare(`SELECT MAX(timestamp) AS ts FROM master_coin_store
                              WHERE ticker = ? AND trigger_source = ?`)
                : db.prepare(`SELECT MAX(timestamp) AS ts FROM master_coin_store
                              WHERE trigger_source = ?`);
            const row = ticker ? stmt.get(ticker, src) : stmt.get(src);
            const ts  = row?.ts || null;
            const ageMs = ts ? nowMs - new Date(ts).getTime() : null;
            const ttl   = MasterStoreService.SOURCE_TTL_MS[src] || 5 * 60 * 1000;
            result[src] = {
                lastSeen: ts,
                ageMs,
                stale: ageMs == null || ageMs > ttl,
                ttlMs: ttl,
            };
        }
        return result;
    }

    /**
     * Detect time gaps in a chronologically sorted series. Used by the
     * frontend to render dashed-line "absence" segments where the browser
     * scanner failed to push for a while.
     *
     * @param {Array<{timestamp:string}|{ts:number|string}>} rows - sorted ASC
     * @param {number} expectedCadenceMs - normal interval between rows
     * @param {number} [multiplier=2]    - flag gap when actual > expected*mult
     * @returns {Array<{startTs:number, endTs:number, durationMs:number}>}
     */
    detectGaps(rows, expectedCadenceMs, multiplier = 2) {
        if (!Array.isArray(rows) || rows.length < 2) return [];
        const threshold = expectedCadenceMs * multiplier;
        const gaps = [];
        const tsOf = r => {
            const t = r.timestamp ?? r.ts;
            return typeof t === 'number' ? t : new Date(t).getTime();
        };
        for (let i = 1; i < rows.length; i++) {
            const prev = tsOf(rows[i - 1]);
            const cur  = tsOf(rows[i]);
            const dur  = cur - prev;
            if (dur > threshold) {
                gaps.push({ startTs: prev, endTs: cur, durationMs: dur });
            }
        }
        return gaps;
    }

    _runPruneEngine() {
        const now = Date.now();
        if (now - this.lastPruneTime > this.PRUNE_INTERVAL_MS) {
            this.lastPruneTime = now;
            try {
                const stmt = db.prepare(`
                    DELETE FROM master_coin_store
                    WHERE timestamp < datetime('now', '-30 days')
                `);
                const result = stmt.run();
                if (result.changes > 0) {
                    console.log(`[MasterStore] 🧹 Pruned ${result.changes} snapshots older than 30 days.`);
                }
            } catch (err) {
                console.error(`[MasterStore] Error during pruning:`, err.message);
            }
        }
    }
}

module.exports = new MasterStoreService();
