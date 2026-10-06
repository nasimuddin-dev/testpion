import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { McpSession, mcpResultBody } from '../../packages/core/src/index.js';

// The `testpion` npm package (scripts/pack-cli.mjs): the CLI and its engine in one bundle. It is built into the
// repository's dist/ folder, so its dependencies resolve from node_modules as they would after `npm install testpion`.
const run = promisify(execFile);
const out = join(process.cwd(), 'dist', `npm-test-${process.pid}`);
const pkg = join(out, 'testpion');
const bin = join(pkg, 'bin', 'testpion.js');
const dir = mkdtempSync(join(tmpdir(), 'tp-npm-'));
let server: Server;
let base = '';

const cli = async (...args: string[]) => {
  try {
    const r = await run(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', TESTPION_HOME: join(dir, 'home') } });
    return { status: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { status: x.code ?? -1, out: x.stdout ?? '', err: x.stderr ?? '' };
  }
};

beforeAll(async () => {
  await run(process.execPath, [join(process.cwd(), 'scripts', 'pack-cli.mjs'), '--out', out]);
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, species: 'cat' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  rmSync(out, { recursive: true, force: true, maxRetries: 3 });
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('the testpion npm package', () => {
  it('is one package: a bin, a bundle, and only third-party dependencies', () => {
    const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
    const root = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(manifest).toMatchObject({ name: 'testpion', version: root.version, type: 'module', bin: { testpion: './bin/testpion.js' }, engines: root.engines });
    expect(Object.keys(manifest.dependencies).filter((d) => d.startsWith('@testpion/'))).toEqual([]);
    expect(manifest.dependencies).toHaveProperty('commander');
    for (const f of ['README.md', 'LICENSE', 'dist/testpion.js']) expect(existsSync(join(pkg, f)), f).toBe(true);
    expect(readFileSync(bin, 'utf8')).toContain("'../dist/testpion.js'");
  });

  it('prints its version', async () => {
    const r = await cli('--version');
    expect(r.out.trim()).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
  });

  it('runs a Postman collection with pm.* scripts, and fails a failing check', async () => {
    const collection = (status: number) => ({
      info: { name: 'Pets', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        {
          name: 'Get a pet',
          request: { method: 'GET', url: `${base}/pets/1` },
          event: [
            { listen: 'test', script: { exec: [`pm.test('status', () => pm.response.to.have.status(${status}));`, "pm.test('a cat', () => pm.expect(pm.response.json().species).to.eql('cat'));"] } },
          ],
        },
      ],
    });
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(collection(200)));
    writeFileSync(join(dir, 'bad.json'), JSON.stringify(collection(404)));
    const ok = await cli('run-collection', join(dir, 'ok.json'));
    expect(ok.status, ok.err + ok.out).toBe(0);
    const bad = await cli('run-collection', join(dir, 'bad.json'));
    expect(bad.status).toBe(1);
  }, 60_000);

  it('serves a workspace to agents over MCP', async () => {
    const ws = join(dir, 'ws');
    cpSync(join(process.cwd(), 'examples', 'public-workspace'), ws, { recursive: true, filter: (p) => !/database\.sqlite|[\/](runs|traces|payloads)([\/]|$)/.test(p) });
    const s = new McpSession({ id: 'tp', name: 'testpion', transport: 'stdio', command: process.execPath, args: [bin, 'mcp-server', '-w', ws], env: { TESTPION_HOME: join(dir, 'home') } });
    await s.connect(20_000);
    try {
      const cols = JSON.parse(mcpResultBody(await s.callTool('list_collections', {})).text) as Array<{ id: string }>;
      expect(cols.map((c) => c.id)).toContain('httpbin');
    } finally {
      await s.close();
    }
  }, 60_000);
});
