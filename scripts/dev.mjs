import { spawn } from 'node:child_process';
// Keep normal development sessions stable while MongoDB writes local files.
// API watching is opt-in; Vite always provides frontend hot reload.
const watchArguments = !process.argv.includes('--watch-api') ? [] : process.platform === 'win32'
  ? ['--watch', '--watch-path=server', '--watch-path=src/domain.ts', '--watch-path=src/site-template.json']
  : ['--watch'];
const processes = [
  spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', ...watchArguments, 'server/index.ts'], { stdio: 'inherit', windowsHide: true }),
  ...(process.argv.includes('--api-only') ? [] : [spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '0.0.0.0', '--strictPort'], { stdio: 'inherit', windowsHide: true })]),
];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of processes) child.kill(); process.exitCode = code; }
for (const child of processes) child.on('exit', code => { if (!stopping && code) stop(code); });
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
