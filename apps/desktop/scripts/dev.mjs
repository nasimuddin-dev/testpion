// Development launcher.
//   npm run dev       → Vite + Electron
//   npm run dev:web   → Vite + HTTP backend bridge (open the printed URL in any browser)
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = process.argv.includes('--web');
const require = createRequire(import.meta.url);

execFileSync(process.execPath, [join(root, 'scripts/build-main.mjs')], { stdio: 'inherit' });

const token = randomBytes(16).toString('hex');
const env = { ...process.env, TESTPION_BRIDGE_TOKEN: token, VITE_TESTPION_BRIDGE: web ? 'http://127.0.0.1:5174' : '' };
const viteBin = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--port', '5173', '--strictPort'], { cwd: root, env, stdio: 'inherit' });

let child;
if (web) {
  child = spawn(process.execPath, [join(root, 'dist-electron/web-server.cjs')], { cwd: root, env, stdio: 'inherit' });
  console.log('\n  Open http://localhost:5173 in your browser (backend bridge on 127.0.0.1:5174)\n');
} else {
  const electron = require('electron');
  child = spawn(electron, ['.'], { cwd: root, env: { ...env, VITE_DEV_SERVER_URL: 'http://localhost:5173' }, stdio: 'inherit' });
  child.on('exit', () => {
    vite.kill();
    process.exit(0);
  });
}
const stop = () => {
  child?.kill();
  vite.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
