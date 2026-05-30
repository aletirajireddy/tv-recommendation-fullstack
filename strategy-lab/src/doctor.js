// Health check — run `npm run doctor` after setup to verify the lab is wired up.
// Confirms: live db reachable (read-only), key tables present + their depth,
// archive db writable, and prints the config it resolved.

const { config } = require('./util/config');
const { openLive, openArchive, tableExists } = require('./db/connections');
const { log } = require('./util/log');

function fmt(n) { return n == null ? '—' : Number(n).toLocaleString(); }

function main() {
    console.log('\n=== strategy-lab doctor ===\n');
    console.log('Resolved config:');
    console.log('  liveDbPath        :', config.liveDbPath);
    console.log('  archiveDbPath     :', config.archiveDbPath);
    console.log('  archiveEnabled    :', config.archiveEnabled);
    console.log('  incrementalTables :', config.incrementalTables.join(', '));
    console.log('  snapshotTables    :', config.snapshotTables.join(', '));
    console.log('');

    // ── Live DB ──
    let live;
    try {
        live = openLive(config.liveDbPath);
        log.ok('live db opened READ-ONLY');
    } catch (e) {
        log.err(`live db: ${e.message}`);
        process.exit(1);
    }

    const probe = [
        ['coin_metric_history', 'ts'],
        ['market_context_logs', 'timestamp'],
        ['scans', 'timestamp'],
        ['validation_trials', null],
        ['master_coin_store', null],
    ];
    console.log('\nLive tables:');
    for (const [t, tcol] of probe) {
        if (!tableExists(live, t)) { console.log(`  ${t.padEnd(22)} : (absent)`); continue; }
        const n = live.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
        let span = '';
        if (tcol) {
            try {
                const r = live.prepare(`SELECT MIN(${tcol}) lo, MAX(${tcol}) hi FROM ${t}`).get();
                span = `  span[${tcol}]: ${r.lo} → ${r.hi}`;
            } catch { /* ignore */ }
        }
        console.log(`  ${t.padEnd(22)} : ${fmt(n).padStart(9)} rows${span}`);
    }
    live.close();

    // ── Archive DB ──
    try {
        const a = openArchive(config.archiveDbPath);
        a.prepare('SELECT 1').get();
        const has = tableExists(a, '_archive_runs');
        const runs = has ? a.prepare('SELECT COUNT(*) c FROM _archive_runs').get().c : 0;
        a.close();
        log.ok(`archive db writable (${has ? runs + ' prior runs' : 'fresh, no runs yet'})`);
    } catch (e) {
        log.err(`archive db: ${e.message}`);
        process.exit(1);
    }

    console.log('\nAll good. Next: enable in .env (ARCHIVE_ENABLED=true) then `npm run archive:once`.\n');
}

main();
