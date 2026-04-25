#!/usr/bin/env node
/**
 * One-shot migration: compute payload_hash + ingestion_source for legacy rows
 * that existed BEFORE the timestamp policy fix landed (2026-04-25).
 *
 * Behavior:
 *   - For each row in smart_level_events, institutional_interest_events, and
 *     master_coin_store where payload_hash IS NULL:
 *     - Parse raw_data (or merged_state for master_coin_store)
 *     - Compute hash via TimestampResolver
 *     - UPDATE the row with the hash
 *   - For ingestion_source: keep DB default ('WEBHOOK') unchanged. We can't
 *     retroactively distinguish webhook vs email rows without log inspection,
 *     so we accept this as a known limitation. New rows are tagged correctly.
 *
 * Usage:
 *   node server/scripts/backfillPayloadHash.js [--dry-run]
 *
 * Safety:
 *   - Uses unique index on payload_hash. If two legacy rows compute to the same
 *     hash (true duplicates), the later UPDATE will fail — we log and continue,
 *     leaving the row's payload_hash NULL so it's visible in audits.
 *   - Wraps each table in a transaction for atomicity.
 */

const db = require('../database');
const TimestampResolver = require('../services/TimestampResolver');

const DRY_RUN = process.argv.includes('--dry-run');

function backfillTable({ table, jsonColumn, idColumn }) {
    const rows = db.prepare(`
        SELECT ${idColumn} AS id, ${jsonColumn} AS json
        FROM ${table}
        WHERE payload_hash IS NULL
    `).all();

    console.log(`\n🔍 ${table}: ${rows.length} rows to backfill`);
    if (rows.length === 0) return { updated: 0, skipped: 0, collisions: 0 };

    const update = db.prepare(`UPDATE ${table} SET payload_hash = ? WHERE ${idColumn} = ?`);
    let updated = 0, skipped = 0, collisions = 0;

    const tx = db.transaction((batch) => {
        for (const row of batch) {
            let parsed;
            try {
                parsed = JSON.parse(row.json);
            } catch {
                skipped++;
                continue;
            }
            // For master_coin_store, the merged_state wraps the actual payload.
            // Strip the wrapper so the hash matches what the live ingest path computes.
            const payloadForHash = (table === 'master_coin_store' && parsed.stream_c)
                ? parsed.stream_c
                : parsed;
            const hash = TimestampResolver.computePayloadHash(payloadForHash);
            if (!hash) { skipped++; continue; }

            if (DRY_RUN) {
                updated++;
                continue;
            }
            try {
                update.run(hash, row.id);
                updated++;
            } catch (e) {
                if (e.message && e.message.includes('UNIQUE')) {
                    collisions++;
                } else {
                    console.error(`  ⚠️ ${table}#${row.id}:`, e.message);
                    skipped++;
                }
            }
        }
    });

    tx(rows);
    console.log(`   ✓ updated: ${updated} | collisions: ${collisions} | skipped: ${skipped}`);
    return { updated, skipped, collisions };
}

console.log(`========================================`);
console.log(`Payload Hash Backfill ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}`);
console.log(`========================================`);

const totals = { updated: 0, skipped: 0, collisions: 0 };
for (const t of [
    { table: 'smart_level_events', jsonColumn: 'raw_data', idColumn: 'id' },
    { table: 'institutional_interest_events', jsonColumn: 'raw_data', idColumn: 'id' },
    { table: 'master_coin_store', jsonColumn: 'merged_state', idColumn: 'snapshot_id' },
]) {
    const r = backfillTable(t);
    totals.updated += r.updated;
    totals.skipped += r.skipped;
    totals.collisions += r.collisions;
}

console.log(`\n========================================`);
console.log(`SUMMARY: ${totals.updated} updated | ${totals.collisions} hash collisions (legacy dups) | ${totals.skipped} skipped (bad JSON)`);
console.log(`========================================`);
process.exit(0);
