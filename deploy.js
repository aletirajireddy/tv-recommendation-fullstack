#!/usr/bin/env node
/**
 * Trade View Dashboard — Windows deploy script (node deploy.js)
 * ─────────────────────────────────────────────────────────────
 * Does exactly the same steps as deploy.sh but runs on Windows without bash.
 *
 * Usage:
 *   node deploy.js           ← standard (pulls + installs + reloads PM2)
 *   node deploy.js --no-pull ← skip git pull (useful when you edited files locally)
 */

const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const readline     = require('readline');

const ROOT    = __dirname;
const NOPULL  = process.argv.includes('--no-pull');
const LINE    = '═'.repeat(65);

function run(cmd, cwd = ROOT) {
    console.log(`  $ ${cmd}`);
    execSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

function step(n, total, label) {
    console.log(`\n▶ ${n}/${total}  ${label}`);
}

async function prompt(msg) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(res => rl.question(msg, a => { rl.close(); res(a); }));
}

(async () => {
    console.log(LINE);
    console.log('  Trade View Dashboard — Deploy (Windows)');
    console.log(`  ${new Date().toLocaleString()}`);
    console.log(LINE);

    // 1. Git pull
    if (!NOPULL) {
        step(1, 5, 'Git pull');
        run('git pull --ff-only');
    } else {
        step(1, 5, 'Git pull  [SKIPPED via --no-pull]');
    }

    // 2–4. npm ci (deterministic, rebuilds native modules for current OS)
    step(2, 5, 'Install server deps  (better-sqlite3, express …)');
    run('npm ci', path.join(ROOT, 'server'));

    step(3, 5, 'Install client deps  (vite, react …)');
    run('npm ci', path.join(ROOT, 'client'));

    step(4, 5, 'Install mcp-server deps  (@modelcontextprotocol/sdk …)');
    run('npm ci', path.join(ROOT, 'mcp-server'));

    // .env guard
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) {
        console.log('\n  ⚠️  .env not found — copying from .env.example');
        fs.copyFileSync(path.join(ROOT, '.env.example'), envPath);
        console.log('  Fill in your secrets in .env, then press ENTER.');
        await prompt('  Press ENTER when ready …');
    }

    // Ensure logs dir
    const logsDir = path.join(ROOT, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    // 5. PM2 reload
    step(5, 5, 'PM2 reload');
    try {
        execSync('pm2 pid tv-backend', { stdio: 'pipe' });
        // Processes running → graceful reload
        run(`pm2 reload "${path.join(ROOT, 'ecosystem.config.js')}" --update-env`);
    } catch {
        // First boot
        run(`pm2 start "${path.join(ROOT, 'ecosystem.config.js')}"`);
    }
    run('pm2 save');

    console.log(`\n${LINE}`);
    console.log('  ✅  Deploy complete!');
    console.log(LINE);
    run('pm2 status');
    console.log('\n  Useful commands:');
    console.log('    pm2 logs              — tail all logs');
    console.log('    pm2 logs mcp-server   — MCP server only');
    console.log('    pm2 monit             — live CPU/RAM monitor');
})().catch(err => {
    console.error('\n❌ Deploy failed:', err.message);
    process.exit(1);
});
