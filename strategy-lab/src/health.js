// Archive health & gap report — `npm run health`.
//
// Answers: "Is my backup actually keeping up, and did I lose any data while the
// machine was off?" Because Stream D is pruned to ~8h in the live DB, any gap in
// the archived timeline longer than the live retention is PERMANENT data loss.
// This report makes those gaps visible so you're never silently losing history.

const { config } = require('./util/config');
const { openArchive, tableExists } = require('./db/connections');

const BUCKET_MS = 120_000; // Stream D writes on a 2-minute grid

function fmtMs(ms) {
    if (ms == null) return '—';
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60), r = m % 60;
    if (h < 24) return `${h}h ${r}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}
const iso = (ms) => (ms == null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19));

function main() {
    console.log('\n=== strategy-lab archive health ===\n');
    console.log('archive:', config.archiveDbPath, '\n');

    const a = openArchive(config.archiveDbPath);

    if (!tableExists(a, 'coin_metric_history')) {
        console.log('No coin_metric_history archived yet. Run `npm run archive:once`.');
        a.close();
        return;
    }

    // ── Coverage ──
    const cov = a.prepare(
        'SELECT COUNT(*) rows, COUNT(DISTINCT ts) buckets, MIN(ts) lo, MAX(ts) hi, COUNT(DISTINCT ticker) coins FROM coin_metric_history'
    ).get();
    const spanMs = cov.hi - cov.lo;
    const expectedBuckets = Math.floor(spanMs / BUCKET_MS) + 1;
    const coverage = expectedBuckets > 0 ? (cov.buckets / expectedBuckets) * 100 : 0;

    console.log('Stream D (coin_metric_history):');
    console.log('  rows           :', cov.rows.toLocaleString());
    console.log('  distinct coins :', cov.coins);
    console.log('  timeline       :', iso(cov.lo), '→', iso(cov.hi), `(${fmtMs(spanMs)})`);
    console.log('  buckets        :', `${cov.buckets.toLocaleString()} / ~${expectedBuckets.toLocaleString()} expected  (${coverage.toFixed(1)}% coverage)`);

    // ── Gap detection (timeline of distinct buckets) ──
    const tsRows = a.prepare('SELECT DISTINCT ts FROM coin_metric_history ORDER BY ts ASC').all();
    let biggest = 0, biggestAt = null, gapsOver = 0;
    const GAP_THRESHOLD = BUCKET_MS * 3; // >6 min = a real gap, not jitter
    for (let i = 1; i < tsRows.length; i++) {
        const d = tsRows[i].ts - tsRows[i - 1].ts;
        if (d > GAP_THRESHOLD) {
            gapsOver++;
            if (d > biggest) { biggest = d; biggestAt = tsRows[i - 1].ts; }
        }
    }
    console.log('  gaps (>6m)     :', gapsOver, gapsOver ? `· largest ${fmtMs(biggest)} starting ${iso(biggestAt)}` : '');
    if (biggest > 8 * 3600_000) {
        console.log('  ⚠️  largest gap exceeds live ~8h retention → that window is permanently lost.');
        console.log('      Fix: run the archiver on the ALWAYS-ON machine (VM1), not just the laptop.');
    }

    // ── Last run + freshness ──
    if (tableExists(a, '_archive_runs')) {
        const last = a.prepare('SELECT MAX(ran_at) r FROM _archive_runs').get().r;
        const ageMs = last ? Date.now() - new Date(last).getTime() : null;
        console.log('\nLast archive pass:', last || '—', last ? `(${fmtMs(ageMs)} ago)` : '');
        if (ageMs != null && ageMs > 15 * 60000) {
            console.log('  ⚠️  archiver hasn\'t run in >15m — is the scheduler/timer running?');
        }
    }

    // ── Other archived tables ──
    console.log('\nOther archived tables:');
    for (const t of ['market_context_logs', 'validation_trials', 'validation_state_log', 'pattern_statistics']) {
        if (tableExists(a, t)) {
            const n = a.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
            console.log(`  ${t.padEnd(22)} : ${n.toLocaleString()} rows`);
        }
    }

    a.close();
    console.log('');
}

main();
