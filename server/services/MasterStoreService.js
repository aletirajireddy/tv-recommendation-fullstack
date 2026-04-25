const db = require('../database');
const crypto = require('crypto');

class MasterStoreService {
    constructor() {
        this.lastPruneTime = 0;
        this.PRUNE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
    }

    _getLastState(ticker) {
        const stmt = db.prepare(`
            SELECT stream_a_state, stream_b_state, stream_c_state 
            FROM master_coin_store 
            WHERE ticker = ? 
            ORDER BY timestamp DESC 
            LIMIT 1
        `);
        return stmt.get(ticker) || {
            stream_a_state: null,
            stream_b_state: null,
            stream_c_state: null
        };
    }

    _mergeAndSave(ticker, source, price, newSliceKey, newSliceData) {
        try {
            const lastState = this._getLastState(ticker);
            
            // Parse existing JSONs
            const stateA = lastState.stream_a_state ? JSON.parse(lastState.stream_a_state) : {};
            const stateB = lastState.stream_b_state ? JSON.parse(lastState.stream_b_state) : {};
            const stateC = lastState.stream_c_state ? JSON.parse(lastState.stream_c_state) : {};

            // We completely replace the specific slice to reflect current reality
            const finalStateA = newSliceKey === 'A' ? newSliceData : stateA;
            const finalStateB = newSliceKey === 'B' ? newSliceData : stateB;
            const finalStateC = newSliceKey === 'C' ? newSliceData : stateC;

            const nowISO = new Date().toISOString();

            const mergedState = {
                ticker,
                price,
                last_updated: nowISO,
                trigger_source: source,
                stream_a: finalStateA,
                stream_b: finalStateB,
                stream_c: finalStateC
            };

            const stmt = db.prepare(`
                INSERT INTO master_coin_store (
                    snapshot_id, ticker, timestamp, trigger_source, price,
                    stream_a_state, stream_b_state, stream_c_state, merged_state
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            stmt.run(
                crypto.randomUUID(),
                ticker,
                nowISO,
                source,
                price || 0,
                JSON.stringify(finalStateA),
                JSON.stringify(finalStateB),
                JSON.stringify(finalStateC),
                JSON.stringify(mergedState)
            );

            // Run prune engine occasionally
            this._runPruneEngine();

        } catch (error) {
            console.error(`[MasterStore] Error merging state for ${ticker}:`, error.message);
        }
    }

    async ingestStreamA(ticker, data, price) {
        // Stream A: Macro & Micro Indicators (From Scanner)
        this._mergeAndSave(ticker, 'STREAM_A', price, 'A', data);
    }

    async ingestStreamB(ticker, data, price) {
        // Stream B: Watchlist Context (From Scout)
        this._mergeAndSave(ticker, 'STREAM_B', price, 'B', data);
    }

    async ingestStreamC(ticker, data, price) {
        // Stream C: Alerts / Smart Levels
        this._mergeAndSave(ticker, 'STREAM_C', price, 'C', data);
    }

    _runPruneEngine() {
        const now = Date.now();
        if (now - this.lastPruneTime > this.PRUNE_INTERVAL_MS) {
            this.lastPruneTime = now;
            try {
                // Delete rows older than 30 days
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
