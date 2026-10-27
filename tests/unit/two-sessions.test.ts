import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { appServices } from '../../apps/desktop/backend/app-services.js';
import { tempDir } from '../helpers.js';

// Cloud stage 1: two sessions (users) in one process share nothing they should not. Everything that is still process-wide is
// listed in planning/cloud-globals.md with a reason, and this test fails when new module-level state is added without a row.
const root = join(__dirname, '..', '..');
const tmp = tempDir('tp-two-');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('two sessions in one process', () => {
  const servers: Server[] = [];
  const bes: Backend[] = [];
  let a: Backend;
  let b: Backend;
  const ports: number[] = [];
  const seenCookie: string[][] = [[], []];

  beforeAll(async () => {
    for (const i of [0, 1])
      servers.push(
        await new Promise<Server>((res) => {
          const s = createServer((req, rsp) => {
            seenCookie[i]!.push(String(req.headers.cookie ?? ''));
            rsp.setHeader('set-cookie', `sid=user-${i}; Path=/`);
            rsp.setHeader('content-type', 'text/plain');
            rsp.end(`server ${i}`);
          }).listen(0, '127.0.0.1', () => res(s));
        }),
      );
    ports.push(...servers.map((s) => (s.address() as { port: number }).port));
    a = new Backend({ appDir: join(tmp.dir, 'a'), emit: () => {}, noMonitors: true });
    b = new Backend({ appDir: join(tmp.dir, 'b'), emit: () => {}, noMonitors: true });
    bes.push(a, b);
  });
  afterAll(async () => {
    for (const be of bes) await be.dispose();
    for (const s of servers) s.close();
    tmp.cleanup();
  });

  it('both sessions are registered in the process services, with different workspaces and data folders', () => {
    expect(appServices().sessions.has(a)).toBe(true);
    expect(appServices().sessions.has(b)).toBe(true);
    expect(a.ws.root).not.toBe(b.ws.root);
    expect(a.host.appDir).not.toBe(b.host.appDir);
    expect(a.manager).not.toBe(b.manager);
  });

  it('settings: a change in one session is not seen in the other', async () => {
    await a.invoke('settings.save', { ...a.settings, defaultTimeoutMs: 1234 });
    expect(a.settings.defaultTimeoutMs).toBe(1234);
    expect(b.settings.defaultTimeoutMs).not.toBe(1234);
    expect((await b.invoke('settings.get', {})) as { defaultTimeoutMs: number }).toMatchObject({ defaultTimeoutMs: b.settings.defaultTimeoutMs });
  });

  it('network configuration: a proxy and a CA saved in one session are not the other one (NetConfig)', async () => {
    await a.invoke('settings.save', { ...a.settings, proxy: { mode: 'custom', url: 'http://127.0.0.1:9' } });
    expect(a.net.settings).toMatchObject({ mode: 'custom', url: 'http://127.0.0.1:9' });
    expect(b.net.settings.mode).not.toBe('custom');
    expect(a.net.id).not.toBe(b.net.id);
    await a.invoke('settings.save', { ...a.settings, proxy: { mode: 'env' } });
  });

  it('secrets: a secret of one user is not readable by the other', async () => {
    await a.secrets.set('two.sessions', 'only-a');
    expect(a.secrets.get('two.sessions')).toBe('only-a');
    expect(b.secrets.get('two.sessions')).toBeUndefined();
  });

  it('collections and their caches: the same id holds each user own content', async () => {
    const col = (name: string) => ({ schemaVersion: '1.0', id: 'shop', name, version: 0, updatedAt: '', variables: [], items: [] });
    await Promise.all([a.invoke('col.save', col('Shop of A')), b.invoke('col.save', col('Shop of B'))]);
    expect(((await a.invoke('col.get', { id: 'shop' })) as { name: string }).name).toBe('Shop of A');
    expect(((await b.invoke('col.get', { id: 'shop' })) as { name: string }).name).toBe('Shop of B');
  });

  it('concurrent sends: each response is its own, cookies stay in the jar of the session that got them', async () => {
    const send = (be: Backend, i: number) => be.invoke('http.send', { id: `s${i}`, request: { method: 'GET', url: `http://127.0.0.1:${ports[i]}/x`, headers: [] } });
    const [ra, rb] = await Promise.all([send(a, 0), send(b, 1)]);
    expect(JSON.stringify(ra)).toContain('server 0');
    expect(JSON.stringify(rb)).toContain('server 1');
    expect(a.cookieStore!.jar.list().map((c) => c.value)).toEqual(['user-0']);
    expect(b.cookieStore!.jar.list().map((c) => c.value)).toEqual(['user-1']);
    // a second send from B to A's server carries B's cookie only (never user-0's)
    await b.invoke('http.send', { id: 's3', request: { method: 'GET', url: `http://127.0.0.1:${ports[0]}/x`, headers: [] } });
    expect(seenCookie[0]!.at(-1)).toBe('sid=user-1');
  });

  it('current values (script variables) and run registries are per session', async () => {
    await a.currentValues!.set('globals', '', 'token', 'a-token', false, { defer: false });
    expect(a.currentValues!.get('globals', '')).toMatchObject({ token: 'a-token' });
    expect(b.currentValues!.get('globals', '')).not.toHaveProperty('token');
    const { runId } = a.startRun('empty', (async function* () {})(), {});
    expect(b.runs.has(runId)).toBe(false);
    await a.runs.get(runId)?.finished;
  });

  it('a call cancelled in one session does not touch the other', async () => {
    for (const be of [a, b])
      be.handlers['t.hold'] = async () => {
        await sleep(200);
        return 'ok';
      };
    const pa = a.invoke('t.hold', {}, { requestId: 'same-id' });
    const pb = b.invoke('t.hold', {}, { requestId: 'same-id' });
    await sleep(10);
    expect(a.calls.cancel('same-id')).toBe(true);
    await expect(pa).rejects.toMatchObject({ kind: 'CancelledError' });
    await expect(pb).resolves.toBe('ok');
  });

  it('fuzz runs and the "already told" sets are per session (no module state)', () => {
    expect(readFileSync(join(root, 'apps/desktop/backend/handlers/fuzz.ts'), 'utf8')).not.toMatch(/^let running/m);
    expect(readFileSync(join(root, 'apps/desktop/backend/handlers/external-secrets.ts'), 'utf8')).not.toMatch(/^const told = new Set/m);
  });
});

/** The module-level mutable state scan: see the header of planning/cloud-globals.md. */
function moduleState(): string[] {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f).replaceAll('\\', '/');
      return statSync(p).isDirectory() ? (f === 'node_modules' || f === 'dist' ? [] : walk(p)) : /\.ts$/.test(p) ? [p] : [];
    });
  const found: string[] = [];
  for (const dir of ['packages/core/src', 'packages/shared/src', 'apps/desktop/backend'])
    for (const abs of walk(join(root, dir))) {
      const file = abs.slice(root.length + 1).replaceAll('\\', '/');
      if (/prelude\.ts$|\.generated\.ts$|mcp-server\/sdk\.ts$/.test(file)) continue;
      for (const line of readFileSync(abs, 'utf8').split(/\r?\n/)) {
        const m = /^(?:export )?(let|const) (\w+)(?:: [^=]+)? = (new (Map|Set|WeakMap)\b|\[\]|\{\}|undefined|0|false|null)/.exec(line);
        const lm = /^(?:export )?let (\w+)/.exec(line);
        if (!m && !lm) continue;
        const name = (m ? m[2] : lm![1])!;
        if (/^[A-Z][A-Z0-9_]*$/.test(name) && !lm) continue;
        if (/WeakMap/.test(line) && !lm) continue;
        if (/bounded:|registry:/.test(line)) continue;
        if (/^__|^codeNames$|^sqliteModule$|^modulePromise$/.test(name)) continue;
        if (/typeof import\(|Promise<typeof import|Mod\??: /.test(line) && lm) continue;
        found.push(`${file}#${name}`);
      }
    }
  return found;
}

describe('known process-wide state', () => {
  const doc = readFileSync(join(root, 'planning', 'cloud-globals.md'), 'utf8');
  it('every module-level mutable state is bounded:/registry:-noted, a constant, a lazy loader, or a row in planning/cloud-globals.md', () => {
    const state = moduleState();
    expect(state.length).toBeGreaterThan(20);
    expect(state.filter((s) => !doc.includes(`\`${s}\``))).toEqual([]);
  });
  it('the document has no row for state that is gone (rows only shrink)', () => {
    const state = new Set(moduleState());
    const rows = [...doc.matchAll(/^\| `([^`#]+#\w+)` \|/gm)].map((m) => m[1]!);
    expect(rows.filter((r) => !state.has(r))).toEqual([]);
  });
});
