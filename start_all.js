const { spawn } = require('child_process');
const path = require('path');

console.log('\x1b[36m🚀 ULTRA SCALPER DASHBOARD - LAUNCHING SYSTEM...\x1b[0m');

// Helper to spawn processes
function spawnProcess(name, command, args, cwd, colorPrefix) {
    console.log(`${colorPrefix}[SYSTEM] Starting ${name}...\x1b[0m`);

    const proc = spawn(command, args, {
        cwd: cwd,
        shell: true,
        stdio: 'pipe',
        env: { ...process.env, FORCE_COLOR: '1' }
    });

    proc.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');
        lines.forEach(line => {
            console.log(`${colorPrefix}[${name}] ${line}\x1b[0m`);
        });
    });

    proc.stderr.on('data', (data) => {
        console.error(`${colorPrefix}[${name} ERR] ${data.toString().trim()}\x1b[0m`);
    });

    proc.on('close', (code) => {
        console.log(`${colorPrefix}[SYSTEM] ${name} exited with code ${code}\x1b[0m`);
    });

    return proc;
}

// 1. Start Backend (Server)
const serverDir = path.join(__dirname, 'server');
const backend = spawnProcess('BACKEND', 'npm', ['run', 'watch'], serverDir, '\x1b[35m'); // Magenta

// 2. Start Frontend (Client)
const clientDir = path.join(__dirname, 'client');
const frontend = spawnProcess('FRONTEND', 'npm', ['run', 'dev'], clientDir, '\x1b[36m'); // Cyan

// Handle Exit
process.on('SIGINT', () => {
    console.log('\n\x1b[31m[SYSTEM] Shutting down...\x1b[0m');
    backend.kill();
    frontend.kill();
    process.exit();
});
