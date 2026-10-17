import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { WorkspaceManager, WorkspaceStore, importWorkspaceBundle, type Collection, type CollectionNode } from '../../packages/core/src/index.js';
import { copyExample, runCli, tempDir } from '../helpers.js';
import { createRestServer, listen } from '../../examples/servers/demo-servers.mjs';

/**
 * EX-G2 round trip: the secret stripper never corrupts a collection. The example workspace (with a typed-in API key on
 * one request, as users leave them) is exported, imported as a new workspace, the values the import asks for are
 * filled in, and the collection runs against the demo server exactly as the original does.
 */
// its own demo REST server on a free port: the suite's other tests start and stop the shared one on 4010
let server: Server | undefined;
let baseUrl = '';
const tmp = tempDir('tp-roundtrip-', { alias: true });
// a typed-in key on a request (built from fragments: no file holds a string a secret scanner takes for a live key)
const TYPED_KEY = 'sk' + '_live_' + 'Ab3'.repeat(8);

beforeAll(async () => {
  server = (await listen(createRestServer(), 0)) as Server;
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => (server ? server.close(r) : r(undefined)));
  tmp.cleanup();
});

const summary = async (root: string, out: string) => {
  const r = await runCli(['run-collection', 'Veterinary API', '-w', root, '-e', 'Development', '--folder', 'Authentication', 'Patients', '-o', out, '-q'], { env: { ...process.env, TESTPION_HOME: join(tmp.dir, 'home') } });
  return { status: r.status, err: r.err, summary: JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as { total: number; passed: number; failed: number } };
};

describe('export → import round trip', () => {
  it('the imported collection runs like the original once the values it names are filled in', async () => {
    const src = copyExample('veterinary-workspace', join(tmp.dir, 'source'));
    const envFile = join(src, 'environments', 'development.json');
    const dev = JSON.parse(readFileSync(envFile, 'utf8')) as { variables: Array<{ key: string; value: string }> };
    for (const v of dev.variables) if (v.key === 'baseUrl') v.value = baseUrl;
    writeFileSync(envFile, JSON.stringify(dev, null, 2));
    const store = WorkspaceStore.open(src);
    const col = store.listCollections().find((c) => c.name === 'Veterinary API') as Collection;
    const addKey = (nodes: CollectionNode[]): CollectionNode[] =>
      nodes.map((n) => (n.kind === 'folder' ? { ...n, items: addKey(n.items) } : n.kind === 'http' ? { ...n, request: { ...n.request, headers: [...(n.request.headers ?? []), { key: 'X-Api-Key', value: TYPED_KEY, enabled: true }] } } : n));
    store.saveCollection({ ...col, items: addKey(col.items) });
    const bundle = store.exportBundle();
    const original = await summary(src, join(tmp.dir, 'run-original'));
    store.close();

    expect(JSON.stringify(bundle)).not.toContain(TYPED_KEY);
    const manager = new WorkspaceManager(join(tmp.dir, 'app'));
    const r = importWorkspaceBundle(manager, bundle);
    try {
      // fill in what the import asks for: the typed-in key, and the secrets the export blanked (from the source)
      const needed = r.valuesNeeded.map((v) => v.replace(/ \(.*$/, ''));
      expect(needed.length).toBeGreaterThan(0);
      const sourceEnv = JSON.parse(readFileSync(join(src, 'environments', 'development.json'), 'utf8')) as { variables: Array<{ key: string; value: string }> };
      const valueOf = (k: string) => sourceEnv.variables.find((v) => v.key === k)?.value ?? (bundle.replaced?.some((x) => x.variable === k && x.field.endsWith('X-Api-Key')) ? TYPED_KEY : undefined);
      const env = r.store.listEnvironments().find((e) => e.name === 'Development')!;
      const vars = env.variables.filter((v) => !needed.includes(v.key));
      for (const k of needed) {
        const value = valueOf(k);
        expect([k, value === undefined]).toEqual([k, false]);
        vars.push({ key: k, value: value!, enabled: true });
      }
      r.store.saveEnvironment({ ...env, variables: vars });
      const root = r.store.root;
      r.store.close();
      const imported = await summary(root, join(tmp.dir, 'run-imported'));
      expect(imported.err).toBe('');
      expect(imported.summary).toMatchObject({ total: original.summary.total, passed: original.summary.passed, failed: original.summary.failed });
      expect(imported.status).toBe(original.status);
      expect(original.summary.passed).toBeGreaterThan(0);
    } finally {
      try {
        r.store.close();
      } catch {
        /* closed above */
      }
    }
  }, 120_000);
});
