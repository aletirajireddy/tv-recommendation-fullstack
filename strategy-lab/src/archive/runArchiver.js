// CLI entrypoint for the archiver.
//   node src/archive/runArchiver.js --once   → single pass, then exit
//   node src/archive/runArchiver.js          → loop every ARCHIVE_INTERVAL_SEC
//
// Refuses to run unless ARCHIVE_ENABLED=true (kill-switch). This makes an
// accidental invocation a safe no-op.

const { config } = require('../util/config');
const { runOnce } = require('./ArchiveService');
const { log } = require('../util/log');

const ONCE = process.argv.includes('--once');

function pass() {
    const started = Date.now();
    const summary = runOnce(config);
    const total = Object.values(summary).reduce((a, s) => a + s.rows, 0);
    const detail = Object.entries(summary)
        .map(([t, s]) => `${t}:${s.rows}`)
        .join('  ');
    log.ok(`archive pass: +${total} rows  (${detail})  [${Date.now() - started}ms]`);
}

function main() {
    log.info(`strategy-lab archiver`);
    log.info(`live    : ${config.liveDbPath} (read-only)`);
    log.info(`archive : ${config.archiveDbPath}`);

    if (!config.archiveEnabled) {
        log.warn('ARCHIVE_ENABLED is not true — refusing to run. Set it in .env to enable.');
        process.exit(0);
    }

    if (ONCE) {
        pass();
        return;
    }

    log.info(`loop mode: every ${config.archiveIntervalSec}s (Ctrl+C to stop)`);
    pass();
    const timer = setInterval(pass, config.archiveIntervalSec * 1000);
    process.on('SIGINT', () => { clearInterval(timer); log.info('stopped.'); process.exit(0); });
}

try {
    main();
} catch (e) {
    log.err(e.message);
    process.exit(1);
}
