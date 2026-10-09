import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Backend } from '../../apps/desktop/backend/backend.js';

/**
 * Robustness audit (2026-10-09): the backend with edge-case workspaces and misbehaving servers. Each case records
 * what happened into AUDIT_EDGE_OUT; cases that show a real bug are `it.fails` (they pass while the bug is there).
 */
const OUT = process.env.AUDIT_EDGE_OUT ?? join(tmpdir(), 'audit-edge-backend.json');
const log: Record<string, unknown> = {};
let server: Server;
let base = '';
const BIG = 50 * 1024 * 1024;

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = decodeURIComponent(req.url ?? '');
    if (u.startsWith('/reset')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100000' });
      res.write('{"partial": "');
      setTimeout(() => req.socket.resetAndDestroy(), 50);
    } else if (u.startsWith('/hang')) {
      /* never answers */
    } else if (u.startsWith('/badjson')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"a": 1, "b": ');
    } else if (u.startsWith('/badgzip')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(Buffer.from('1f8b0800000000000003this is not gzip at all', 'utf8'));
    } else if (u.startsWith('/big')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(BIG + 2) });
      const chunk = Buffer.alloc(1024 * 1024, 'a');
      res.write('"');
      // like a real server: write as the client reads (all 50 MB at once was cut short under load: "other side closed")
      let sent = 0;
      const pump = () => {
        while (sent < 50) {
          sent++;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end('"');
      };
      pump();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: req.url }));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  writeFileSync(OUT, JSON.stringify(log, null, 1));
});

function fresh() {
  const home = mkdtempSync(join(tmpdir(), 'tp-audit-edge-'));
  const be = new Backend({ appDir: home, emit: () => {}, noMonitors: true });
  const root = (be as unknown as { store: { root: string } }).store.root;
  const call = (m: string, p: unknown = {}) => Promise.resolve().then(() => be.invoke(m, p));
  return { be, root, call, home };
}
const get = (url: string, extra: object = {}) => ({ request: { method: 'GET', url, headers: [], params: [] }, ...extra });
const timed = async <T>(p: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> => Promise.race([p, new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), ms))]);

describe('audit: edge-case workspaces (backend)', () => {
  it('an empty workspace lists nothing and runs nothing cleanly', async () => {
    const { be, call } = fresh();
    log.empty = {
      cols: await call('col.list'),
      tree: await call('col.tree'),
      run: await call('col.run', { collectionId: 'nope' }).catch((e) => e),
      tests: await call('tests.tree').catch((e) => e),
    };
    await be.dispose();
  });

  // readJson renames a file it cannot parse to <file>.corrupt-<ts>: the first list shows "(corrupted)", the next
  // list does not show it at all, and the file is gone from the folder (and from git's view: deleted + untracked).
  it('a truncated collection stays listed (with its problem) on every listing, and stays where it is', async () => {
    const { be, root, call } = fresh();
    writeFileSync(join(root, 'collections', 'broken.json'), '{"schemaVersion":"1.0","id":"broken","name":"Broken","items":[{"kind":"http"');
    const first = (await call('col.list')) as Array<{ id: string; name: string; problem?: string }>;
    const second = (await call('col.list')) as Array<{ id: string; name: string; problem?: string }>;
    const files = readdirSync(join(root, 'collections'));
    log.truncatedCollection = { first: first.map((c) => [c.name, c.problem]), second: second.map((c) => [c.name, c.problem]), files };
    await be.dispose();
    expect(second.map((c) => c.id)).toContain('broken');
    expect(files).toContain('broken.json');
  });

  it('saving the "(corrupted)" placeholder does not overwrite the original with an empty collection', async () => {
    const { be, root, call } = fresh();
    const original = '{"schemaVersion":"1.0","id":"broken","name":"Broken","items":[{"kind":"http"';
    writeFileSync(join(root, 'collections', 'broken.json'), original);
    const [ph] = (await call('col.list')) as Array<Record<string, unknown>>;
    const saved = await call('col.save', { ...ph, name: 'Renamed' }).catch((e) => e);
    const files = readdirSync(join(root, 'collections'));
    const backup = files.find((f) => f.includes('.broken-'));
    log.corruptPlaceholderSave = { saved: (saved as { message?: string }).message ?? 'saved', files, backupKept: !!backup && readFileSync(join(root, 'collections', backup), 'utf8') === original };
    await be.dispose();
    expect(backup && readFileSync(join(root, 'collections', backup), 'utf8')).toBe(original);
  });

  it('an environment with invalid JSON is shown as broken (not silently dropped), and sending with it says why', async () => {
    const { be, root, call } = fresh();
    writeFileSync(join(root, 'environments', 'dev.json'), '{"id":"dev","name":"Dev","variables":[{"key":"host","value":"x"');
    const envs = (await call('env.list')) as Array<{ name: string }>;
    const send = (await call('http.send', get(`${base}/ok`, { environment: 'dev' }))) as { error?: { message: string }; response?: { status: number } };
    const files = readdirSync(join(root, 'environments'));
    log.invalidEnv = { envs: envs.map((e) => e.name), send: send.error?.message ?? send.response?.status, files };
    await be.dispose();
    expect(envs.map((e) => e.name)).toContain('Dev');
  });

  // every send with it fails "Cannot read properties of undefined (reading 'map')"; env.quickLook too
  it('an environment that is valid JSON but has no variables array still sends', async () => {
    const { be, root, call } = fresh();
    writeFileSync(join(root, 'environments', 'odd.json'), '{"id":"odd","name":"Odd"}');
    const envs = await call('env.list').catch((e) => e);
    const send = await call('http.send', get(`${base}/ok`, { environment: 'odd' })).catch((e) => e);
    const quick = await call('env.quickLook', { environment: 'odd' }).catch((e) => e);
    log.envNoVariables = { envs, send: (send as { error?: unknown; response?: { status: number }; message?: string }).response?.status ?? (send as { error?: unknown }).error ?? (send as { message?: string }).message, quick: (quick as { message?: string }).message ?? 'ok' };
    await be.dispose();
    expect((send as { response?: { status: number } }).response?.status).toBe(200);
  });

  // ws.search, vars.usages and report.workspace fail for the whole workspace: "nodes is not iterable"
  it('a collection file that is valid JSON but has no items array does not break workspace-wide search', async () => {
    const { be, root, call } = fresh();
    writeFileSync(join(root, 'collections', 'odd.json'), '{"id":"odd","name":"Odd"}');
    const r: Record<string, unknown> = {};
    for (const m of ['col.list', 'col.tree', 'stats.collectionsHealth', 'ws.search', 'vars.usages', 'report.workspace']) {
      const x = await call(m, { query: 'a', key: 'a', name: 'a' }).catch((e) => e);
      r[m] = (x as { message?: string })?.message ? `ERR ${(x as { kind?: string }).kind}: ${(x as { message: string }).message}` : 'ok';
    }
    log.collectionNoItems = r;
    await be.dispose();
    expect(Object.values(r).every((v) => v === 'ok')).toBe(true);
  });

  it('a test YAML with a syntax error: read, lint and run give a clear error', async () => {
    const { be, root, call } = fresh();
    mkdirSync(join(root, 'tests'), { recursive: true });
    writeFileSync(join(root, 'tests', 'bad.yaml'), 'name: bad\ntests:\n  - id: a\n    type: http\n   request: [unclosed\n');
    const read = await call('tests.read', { path: 'bad.yaml' }).catch((e) => e);
    const lint = await call('tests.lint', { content: readFileSync(join(root, 'tests', 'bad.yaml'), 'utf8'), path: 'bad.yaml' }).catch((e) => e);
    const tree = await call('tests.tree').catch((e) => e);
    const run = (await call('tests.run', { paths: ['bad.yaml'] }).catch((e) => e)) as { runId?: string; message?: string };
    log.badYaml = { read: typeof read === 'string' ? 'ok' : read, lint, tree: (tree as { message?: string }).message ?? 'ok', run };
    await be.dispose();
  });

  it('a 50 MB response body: answered, bounded memory, preview truncated', async () => {
    const { be, call } = fresh();
    const m0 = process.memoryUsage().rss;
    const t0 = Date.now();
    const r = (await timed(call('http.send', get(`${base}/big`)), 60_000)) as { response?: { status: number; size: number; truncated?: boolean; bodyPreview: string; json?: unknown }; error?: unknown };
    log.big = { ms: Date.now() - t0, rssGrowthMB: Math.round((process.memoryUsage().rss - m0) / 1e6), status: r === ('TIMEOUT' as never) ? 'TIMEOUT' : r.response?.status, size: r.response?.size, truncated: r.response?.truncated, previewChars: r.response?.bodyPreview.length, parsedJson: r.response?.json !== undefined, error: r.error };
    await be.dispose();
    expect(r.response?.status).toBe(200);
  });

  it('500-char unicode/RTL/emoji request names and 20 nested folders save, list and export', async () => {
    const { be, call, root } = fresh();
    const name = ('שלום ‮ RTL 🚀 üñï ').repeat(30).slice(0, 500);
    let items: unknown[] = [{ kind: 'http', id: 'deep-req', name, request: { method: 'GET', url: `${base}/ok`, headers: [], params: [] } }];
    for (let i = 20; i > 0; i--) items = [{ kind: 'folder', id: `f${i}`, name: `${name.slice(0, 40)} ${i}`, items }];
    const r: Record<string, unknown> = {};
    r.save = await call('col.save', { schemaVersion: '1.0', id: 'deep', name, version: 0, variables: [], updatedAt: '', items }).then(() => 'ok', (e) => e);
    r.empty = await call('col.save', { schemaVersion: '1.0', id: 'empty', name: 'Empty', version: 0, variables: [], updatedAt: '', items: [] }).then(() => 'ok', (e) => e);
    r.files = readdirSync(join(root, 'collections'));
    for (const [m, p] of [
      ['col.tree', {}],
      ['col.get', { id: 'deep' }],
      ['col.export', { id: 'deep', format: 'postman' }],
      ['col.docs', { id: 'deep' }],
      ['col.duplicate', { id: 'deep' }],
      ['col.securityLint', { id: 'deep' }],
      ['col.variableFlow', { collectionId: 'deep' }],
      ['col.tidy', { collectionId: 'deep' }],
      ['col.run', { collectionId: 'empty' }],
    ] as const) {
      const x = await call(m, p).catch((e) => e);
      r[m] = (x as { kind?: string; message?: string })?.kind ? `ERR ${(x as { kind: string }).kind}: ${(x as { message: string }).message.slice(0, 160)}` : 'ok';
    }
    log.namesAndDepth = r;
    await be.dispose();
  });

  // it terminates, but sends the literal %7B%7Bb%7D%7D with unresolved: [] - nothing tells the user about the cycle
  it('a variable cycle {{a}} -> {{b}} -> {{a}} is reported (unresolved or an error), not sent silently', async () => {
    const { be, call } = fresh();
    await call('env.save', { env: { id: 'cyc', name: 'Cyc', variables: [{ key: 'a', value: '{{b}}', enabled: true }, { key: 'b', value: '{{a}}', enabled: true }, { key: 'self', value: 'x{{self}}', enabled: true }] } });
    const r = (await timed(call('http.send', get(`${base}/v/{{a}}/{{self}}`, { environment: 'cyc' })), 10_000)) as { response?: { status: number }; prepared?: { url: string }; unresolved?: string[]; error?: { message: string } };
    log.cycle = r === ('TIMEOUT' as never) ? 'TIMEOUT' : { url: r.prepared?.url, unresolved: r.unresolved, error: r.error?.message };
    await be.dispose();
    expect(r).not.toBe('TIMEOUT');
    expect(!!r.error || (r.unresolved?.length ?? 0) > 0).toBe(true);
  });

  it('a URL with spaces and non-ASCII is encoded and sent', async () => {
    const { be, call } = fresh();
    const r = (await call('http.send', get(`${base}/a b/üñî/\u{1f680}?q=a b&ä=ö`))) as { response?: { bodyPreview: string }; prepared?: { url: string }; error?: { message: string } };
    log.urlSpaces = { prepared: r.prepared?.url, echoed: r.response?.bodyPreview, error: r.error?.message };
    await be.dispose();
    expect(r.response).toBeTruthy();
  });

  it('a connection reset mid-body, invalid JSON with a JSON type and corrupted gzip give clear results', async () => {
    const { be, call } = fresh();
    const out: Record<string, unknown> = {};
    for (const p of ['/reset', '/badjson', '/badgzip']) {
      const r = (await timed(call('http.send', get(`${base}${p}`, { assertions: [{ type: 'status', expected: 200 }] })), 20_000)) as { response?: { status: number; bodyPreview: string; json?: unknown }; error?: { kind: string; message: string; why?: string }; checks?: unknown };
      out[p] = r === ('TIMEOUT' as never) ? 'TIMEOUT' : r.error ? { error: r.error.kind, message: r.error.message, why: r.error.why } : { status: r.response?.status, preview: r.response?.bodyPreview.slice(0, 80), json: r.response?.json !== undefined };
    }
    log.badServers = out;
    await be.dispose();
  });

  it('a server that never answers: http.cancel stops it at once, and the default timeout applies', async () => {
    const { be, call } = fresh();
    const t0 = Date.now();
    const pending = call('http.send', get(`${base}/hang`, { id: 'req-hang' }));
    await new Promise((r) => setTimeout(r, 300));
    await call('http.cancel', { id: 'req-hang' });
    const r = (await timed(pending, 5000)) as { error?: { kind: string; message: string } };
    const settings = (await call('settings.get')) as { defaultTimeoutMs?: number };
    // the timeout: a request-level 1 s
    const t1 = Date.now();
    const r2 = (await timed(call('http.send', { request: { method: 'GET', url: `${base}/hang`, headers: [], params: [], settings: { timeoutMs: 1000 } } }), 10_000)) as { error?: { kind: string; message: string } };
    log.hang = { cancel: r === ('TIMEOUT' as never) ? 'TIMEOUT' : r.error, cancelMs: Date.now() - t0, defaultTimeoutMs: settings.defaultTimeoutMs, timeout: r2 === ('TIMEOUT' as never) ? 'TIMEOUT' : r2.error, timeoutMs: Date.now() - t1 };
    await be.dispose();
    expect(r).not.toBe('TIMEOUT');
    expect(r2).not.toBe('TIMEOUT');
  });

  // the cancelled request reads "This operation was aborted: 20" (the DOMException code leaks into the message)
  it('a cancelled request says "Cancelled", without a stray DOMException code', async () => {
    const { be, call } = fresh();
    const pending = call('http.send', get(`${base}/hang`, { id: 'req-c' }));
    await new Promise((r) => setTimeout(r, 200));
    await call('http.cancel', { id: 'req-c' });
    const r = (await pending) as { error?: { message: string } };
    await be.dispose();
    expect(r.error?.message).not.toMatch(/: 20$/);
  });

  it('a pre-request script that never ends (busy loop / never-resolving promise) does not freeze the backend', async () => {
    const { be, call } = fresh();
    const t0 = Date.now();
    const loop = (await timed(call('http.send', get(`${base}/ok`, { preRequestScript: 'while (true) {}' })), 30_000)) as { error?: { message: string } };
    const t1 = Date.now();
    const never = call('http.send', get(`${base}/ok`, { id: 'req-never', preRequestScript: 'await new Promise(() => {});' }));
    await new Promise((r) => setTimeout(r, 500));
    await call('http.cancel', { id: 'req-never' });
    const nev = (await timed(never, 30_000)) as { error?: { message: string } };
    log.scriptHang = { loop: loop === ('TIMEOUT' as never) ? 'TIMEOUT' : loop.error?.message ?? 'ok', loopMs: t1 - t0, never: nev === ('TIMEOUT' as never) ? 'TIMEOUT' : nev.error?.message ?? 'ok', neverMs: Date.now() - t1 };
    await be.dispose();
    expect(loop).not.toBe('TIMEOUT');
  });

  // a script that copies a secret into another variable: current-values/<ws>.json keeps it in plain text
  // (response payload files hold whatever the server echoed - expected; that hit is filtered out)
  it('secrets: a secret environment variable never lands in plain text in the data folder after a send and a run', async () => {
    const { be, call, root, home } = fresh();
    const SECRET = 'sk-AUDIT-9f8e7d6c5b4a';
    await call('env.save', { env: { id: 'sec', name: 'Sec', variables: [{ key: 'token', value: '', secret: true, enabled: true }] }, secrets: { token: SECRET } });
    await call('col.save', { schemaVersion: '1.0', id: 'sc', name: 'Sec', version: 0, variables: [], updatedAt: '', items: [{ kind: 'http', id: 'r1', name: 'echo', request: { method: 'GET', url: `${base}/echo?t={{token}}`, headers: [{ key: 'X-Api-Key', value: '{{token}}', enabled: true }], params: [] }, testScript: 'tp.environment.set("copied", tp.environment.get("token")); console.log(tp.environment.get("token"));' }] });
    await call('http.send', { request: { method: 'GET', url: `${base}/echo?t={{token}}`, headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }], params: [] }, environment: 'sec', collectionId: 'sc', requestId: 'r1', testScript: 'tp.environment.set("copied", tp.environment.get("token")); console.log("tok", tp.environment.get("token"));' });
    const run = (await call('col.run', { collectionId: 'sc', environment: 'sec' })) as { runId?: string; id?: string };
    await new Promise((r) => setTimeout(r, 3000));
    await be.dispose();
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else
          try {
            if (!/payloads/.test(p) && readFileSync(p).includes(SECRET)) hits.push(p.slice(home.length));
          } catch {
            /* locked */
          }
      }
    };
    walk(home);
    log.secrets = { run, hits, root };
    expect(hits).toEqual([]);
  });
  // WorkspaceStore.open migrates any workspace.json it is pointed at: an Nx / Angular monorepo's workspace.json is
  // rewritten (backup .bak-0.9) and collections/, runs/, database.sqlite … appear in that repository
  it('opening a folder whose workspace.json is not a TestPion one (an Nx monorepo) refuses and changes nothing', async () => {
    const { be, call, home } = fresh();
    const nx = join(home, 'nx-repo');
    mkdirSync(nx, { recursive: true });
    const original = JSON.stringify({ version: 2, projects: { app: 'apps/app', lib: 'libs/lib' } }, null, 2);
    writeFileSync(join(nx, 'workspace.json'), original);
    const r = await call('ws.open', { ref: nx }).then(() => 'opened', (e) => `ERR ${(e as { message: string }).message}`);
    const after = readFileSync(join(nx, 'workspace.json'), 'utf8');
    const files = readdirSync(nx);
    log.nxOpen = { r, files, rewritten: after !== original, after: after.slice(0, 300) };
    await be.dispose();
    expect(after).toBe(original);
    expect(files).toEqual(['workspace.json']);
  });
});

