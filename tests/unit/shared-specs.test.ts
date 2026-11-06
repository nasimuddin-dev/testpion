import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { apiNameOf, checkedSource, findBodySchema, removeItem, listSpecs, readSpecRef, sharedSpecSource, specFileToRead, WorkspaceSearch } from '../../packages/core/src/index.js';

// API definitions shared from another workspace (workspace.json `shared` with kind specs): listed after the workspace's
// own as ../platform-shared/specs/x.yaml, read everywhere a definition is read (outline, lint, body schema, coverage,
// tests from a spec), and never written here.
const home = mkdtempSync(join(tmpdir(), 'tp-shared-specs-'));
const be = new Backend({ appDir: home, emit: () => undefined });
afterAll(async () => {
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

const SPEC = `openapi: 3.0.3
info: { title: Platform, version: '1' }
paths:
  /users:
    post:
      requestBody:
        content:
          application/json:
            schema: { type: object, required: [name], properties: { name: { type: string } } }
      responses: { '201': { description: created } }
`;

describe('API definitions shared from another workspace', () => {
  const other = join(dirname(be.ws.root), 'platform-shared');
  mkdirSync(join(other, 'specs'), { recursive: true });
  writeFileSync(join(other, 'workspace.json'), JSON.stringify({ schemaVersion: '1.0', id: 'platform', name: 'Platform' }));
  writeFileSync(join(other, 'specs', 'platform.yaml'), SPEC);
  writeFileSync(join(other, 'secret.yaml'), 'not: shared');
  const rel = relative(be.ws.root, other).split('\\').join('/');
  const path = `${rel}/specs/platform.yaml`;

  it('is added with the kinds the folder has, listed after the own ones, and read where a definition is read', async () => {
    expect(() => checkedSource(be.ws.root, rel, ['environments'])).toThrow(/has no environments folder/);
    const added = (await be.invoke('ws.shareAdd', { path: rel })) as { shared: Array<{ kinds: string[] }>; specs: string[] };
    expect(added.shared[0]!.kinds).toEqual(['specs']);
    expect(added.specs).toEqual([path]);
    expect(listSpecs(be.ws)).not.toContain(path); // only when asked for
    expect(await be.invoke('openapi.specs', {})).toContain(path);
    expect(sharedSpecSource(be.ws, path)).toBe('platform-shared');

    const got = (await be.invoke('openapi.spec.get', { path })) as { text: string; shared?: string };
    expect(got).toMatchObject({ text: SPEC, shared: 'platform-shared' });
    expect(((await be.invoke('openapi.outline', { path })) as { operations?: unknown[]; tags?: unknown[] }) ?? {}).toBeTruthy();
    expect(await readSpecRef(be.ws, { path })).toBe(SPEC);
    // a request of this workspace finds its body schema in the shared definition
    expect(findBodySchema(be.ws, 'POST', 'https://api.example.com/users')?.spec).toBe(path);
    // found by search (Quick Open, search_workspace), marked shared
    expect(new WorkspaceSearch(be.ws).search('platform.yaml').find((h) => h.kind === 'spec')).toMatchObject({ id: path, subtitle: `API definition · shared · ${path}` });
    // opened from its row (the ref resolves), never deleted from here
    expect(await be.invoke('ref.resolve', { ref: { kind: 'spec', path } })).toMatchObject({ ok: true });
    expect(() => removeItem(be.ws, { kind: 'spec', path })).toThrow(/shared from platform-shared: delete it there/);
  });

  it('is never written here, and nothing else outside the workspace is read through it', async () => {
    await expect(be.invoke('openapi.spec.save', { path, text: 'changed' })).rejects.toThrow(/shared from platform-shared: change it there/);
    expect(readFileSync(join(other, 'specs', 'platform.yaml'), 'utf8')).toBe(SPEC);
    // a file of the other workspace outside its specs/, or a path climbing out of specs/: refused
    for (const p of [`${rel}/secret.yaml`, `${rel}/specs/../secret.yaml`, `${rel}/workspace.json`]) {
      expect(sharedSpecSource(be.ws, p)).toBeUndefined();
      expect(() => specFileToRead(be.ws, p)).toThrow(/escapes the workspace/);
      await expect(be.invoke('openapi.spec.get', { path: p })).rejects.toThrow(/Not an API definition/);
    }
    // a link in the other repository's specs/ (to a credentials file): neither listed nor read
    const outside = join(home, 'creds.json');
    writeFileSync(outside, '{"token":"secret"}');
    let linked = true;
    try {
      symlinkSync(outside, join(other, 'specs', 'creds.json'), 'file');
    } catch {
      linked = false; // no right to make links here (Windows without developer mode)
    }
    if (linked) {
      expect((await be.invoke('openapi.specs', {})) as string[]).not.toContain(`${rel}/specs/creds.json`);
      expect(sharedSpecSource(be.ws, `${rel}/specs/creds.json`)).toBeUndefined();
      await expect(be.invoke('openapi.spec.get', { path: `${rel}/specs/creds.json` })).rejects.toThrow(/Not an API definition/);
    }
    const removed = (await be.invoke('ws.shareRemove', { path: rel })) as { specs: string[] };
    expect(removed.specs).toEqual([]);
    expect(sharedSpecSource(be.ws, path)).toBeUndefined();
  });

  it('a folder inside the workspace is refused; tests from a shared definition are named with its folder', () => {
    mkdirSync(join(be.ws.root, 'inner', 'specs'), { recursive: true });
    writeFileSync(join(be.ws.root, 'inner', 'workspace.json'), '{}');
    expect(() => checkedSource(be.ws.root, 'inner', ['specs'])).toThrow(/inside this workspace/);
    expect(apiNameOf('specs/orders.yaml')).toBe('orders.yaml');
    expect(apiNameOf('../platform-shared/specs/orders.yaml')).toBe('platform-shared-orders.yaml');
    expect(apiNameOf('../../x/platform/specs/asyncapi/events.yaml')).toBe('platform-events.yaml');
  });
});
