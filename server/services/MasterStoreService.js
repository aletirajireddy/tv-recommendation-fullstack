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
