
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the path to the vite binary strictly
// This avoids using npm.cmd or shell execution which causes popups
const viteBin = path.join(__dirname, 'node_modules', 'vite', 'bin', 'vite.js');

console.log(`Starting Client via Node: ${viteBin}`);

const child = spawn(process.execPath, [viteBin, 'preview', '--port', '5173', '--host'], {
    stdio: 'inherit',
    cwd: __dirname,
    shell: false, // CRITICAL: Prevents cmd.exe window popup
    windowsHide: true // EXTRA SAFETY: Hides window if any created
});

child.on('error', (err) => {
    console.error('Failed to start child process:', err);
});

child.on('exit', (code, signal) => {
    console.log(`Child process exited with code ${code} and signal ${signal}`);
    process.exit(code || 0);
});
