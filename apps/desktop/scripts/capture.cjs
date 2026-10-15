// Captures documentation screenshots of the real app:
//   npm run screenshots -w @testpion/desktop   (TESTPION_CAPTURE_OUT=<dir> writes elsewhere; TESTPION_CAPTURE_DEBUG=<dir>
//   gets a picture of the window when a step times out)
// Starts the demo servers, copies the example workspace into a temporary profile (never the user's own profile or
// workspaces), launches Electron in capture mode and writes docs/public/images/*.jpg (steps: capture-steps.cjs).
const { spawn, spawnSync } = require('node:child_process');
const { get } = require('node:http');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const root = resolve(__dirname, '..', '..', '..');
const home = mkdtempSync(join(tmpdir(), 'aps-capture-'));
const ws = join(home, 'examples', 'veterinary-workspace');
// the committed example only (git HEAD), so local, uncommitted edits to it never end up in public screenshots
const tracked = spawnSync('git', ['ls-files', '-z', 'examples/veterinary-workspace'], { cwd: root, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
for (const rel of tracked) {
  if (/[\\/](runs|traces|payloads)([\\/]|$)|database\.sqlite/.test(rel)) continue;
  const content = spawnSync('git', ['show', `HEAD:${rel}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).stdout;
  const dest = join(ws, rel.slice('examples/veterinary-workspace/'.length));
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content);
}
// the example's MCP server is {{workspaceDir}}/../servers/mcp-server.mjs: a shim there runs the repo's
// server (which needs the repo's node_modules), so screenshots show the committed, portable command
mkdirSync(join(home, 'examples', 'servers'), { recursive: true });
writeFileSync(join(home, 'examples', 'servers', 'mcp-server.mjs'), `import ${JSON.stringify(pathToFileURL(join(root, 'examples', 'servers', 'mcp-server.mjs')).href)};
`);
writeFileSync(join(home, 'settings.json'), JSON.stringify({ lastWorkspace: ws, workspacePaths: [ws], theme: process.env.TESTPION_CAPTURE_THEME ?? 'dark' }, null, 2));

const servers = spawn(process.execPath, [join(root, 'examples', 'servers', 'demo-servers.mjs')], { stdio: 'ignore' });

/** Whether a demo server answers (any HTTP status). */
const answers = (url) =>
  new Promise((ok) => {
    const req = get(url, (res) => (res.resume(), ok(true)));
    req.on('error', () => ok(false));
    req.setTimeout(1000, () => (req.destroy(), ok(false)));
  });

(async () => {
  // the REST API, GraphQL and the mock LLM the steps use, up before the app starts
  const urls = ['http://127.0.0.1:4010/health', 'http://127.0.0.1:4011/graphql', 'http://127.0.0.1:4012/v1/models'];
  const end = Date.now() + 30_000;
  for (;;) {
    const up = await Promise.all(urls.map(answers));
    if (up.every(Boolean)) break;
    if (Date.now() > end) {
      console.error(`[capture] the demo servers did not start: ${urls.filter((_, i) => !up[i]).join(', ')}`);
      servers.kill();
      rmSync(home, { recursive: true, force: true });
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const electron = require('electron');
  const r = spawnSync(electron, ['.'], {
    cwd: resolve(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, TESTPION_HOME: home, TESTPION_CAPTURE_SCRIPT: process.env.TESTPION_CAPTURE_SCRIPT ?? join(__dirname, 'capture-steps.cjs'), TESTPION_CAPTURE_DIR: process.env.TESTPION_CAPTURE_OUT ?? join(root, 'docs', 'public', 'images') },
  });
  servers.kill();
  rmSync(home, { recursive: true, force: true });
  process.exit(r.status ?? 1);
})();
