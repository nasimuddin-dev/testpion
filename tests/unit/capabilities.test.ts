import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { BRIDGE_USER, RPC_GROUPS, SERVER_DEFAULT_DENIED, SERVER_DEFAULT_GROUPS, methodGroup, serverUser } from '../../apps/desktop/backend/capabilities.js';
import { LOCAL_USER } from '../../apps/desktop/backend/request-context.js';
import { tempDir } from '../helpers.js';

// Security review 2026-10-27 (P2, cloud): RequestContext.can() was never consulted. Every RPC method belongs to a group (the part before
// the first dot); Backend.invoke asks ctx.can(group) before the handler runs. The desktop owner may do everything; a server host
// grants what its policy says.
const tmp = tempDir('tp-caps-');
const bes: Backend[] = [];
const make = (name: string, serverMode = false) => {
  const be = new Backend({ appDir: join(tmp.dir, name), emit: () => {}, noMonitors: true, ...(serverMode ? { serverMode: true } : {}) });
  bes.push(be);
  return be;
};
afterAll(async () => {
  for (const be of bes) await be.dispose();
  tmp.cleanup();
});

describe('method groups', () => {
  it('every handler belongs to a declared group, and every declared group has a handler', () => {
    const be = make('cover');
    const groups = new Set(Object.keys(be.handlers).map(methodGroup));
    expect([...groups].filter((g) => !RPC_GROUPS[g]).sort()).toEqual([]);
    expect(Object.keys(RPC_GROUPS).filter((g) => !groups.has(g)).sort()).toEqual([]);
  });

  it('the groups that act on the server\'s own computer are not in the default server policy', () => {
    for (const g of ['terminal', 'debug', 'app', 'record', 'mock', 'flows']) {
      expect(SERVER_DEFAULT_DENIED.has(g), g).toBe(true);
      expect(SERVER_DEFAULT_GROUPS.has(g), g).toBe(false);
    }
    for (const g of ['col', 'http', 'git', 'settings', 'ws']) expect(SERVER_DEFAULT_GROUPS.has(g), g).toBe(true);
  });
});

describe('Backend.invoke checks the caller\'s group before the handler', () => {
  it('two sessions with different permission sets: one is refused, the other is not', async () => {
    const a = make('a');
    const b = make('b');
    let ran = 0;
    for (const be of [a, b]) be.handlers['settings.get'] = (() => (ran++, { ok: true })) as never;
    const readOnly = serverUser('reader', ['ws', 'col']);
    await expect(a.invoke('settings.get', {}, { user: readOnly })).rejects.toMatchObject({ kind: 'Forbidden' });
    expect(ran).toBe(0); // the handler never ran
    await expect(b.invoke('settings.get', {}, { user: serverUser('admin', '*') })).resolves.toEqual({ ok: true });
    expect(ran).toBe(1);
    // a group the user holds works
    await expect(a.invoke('col.list', {}, { user: readOnly })).resolves.toBeDefined();
  });

  it('the refusal is a typed error in plain words that names the group', async () => {
    const be = make('words');
    const err = await be.invoke('git.status', {}, { user: serverUser('u', ['ws']) }).then(
      () => undefined,
      (e) => e as { kind: string; message: string; suggestions: string[] },
    );
    expect(err?.kind).toBe('Forbidden');
    expect(err?.message).toMatch(/not allowed to use "git"/);
    expect(err?.suggestions.join(' ')).toMatch(/Ask the person who runs this server/);
  });

  it('the desktop owner (no user, or LOCAL_USER, or the bridge user) may call every group', async () => {
    const be = make('desktop');
    await expect(be.invoke('settings.get', {})).resolves.toBeDefined();
    await expect(be.invoke('settings.get', {}, { user: LOCAL_USER })).resolves.toBeDefined();
    await expect(be.invoke('settings.get', {}, { user: BRIDGE_USER })).resolves.toBeDefined();
    await expect(be.invoke('terminal.list', {})).resolves.toBeDefined();
  });

  it('a server host without a user of its own gives the default policy, not everything', async () => {
    const be = make('server', true);
    await expect(be.invoke('settings.get', {})).resolves.toBeDefined();
    await expect(be.invoke('terminal.list', {})).rejects.toMatchObject({ kind: 'Forbidden' });
    await expect(be.invoke('debug.status', {})).rejects.toMatchObject({ kind: 'Forbidden' });
    // the handshake and cancelling one's own call need no permission
    await expect(be.invoke('app.info', {}, { user: serverUser('nobody', []) })).resolves.toBeDefined();
    await expect(be.invoke('rpc.cancel', { id: 'none' }, { user: serverUser('nobody', []) })).resolves.toBe(false);
  });

  it('a server host can grant a denied group to a user it trusts', async () => {
    const be = make('server2', true);
    await expect(be.invoke('terminal.list', {}, { user: serverUser('ops', '*') })).resolves.toBeDefined();
    await expect(be.invoke('terminal.list', {}, { user: serverUser('ops2', ['terminal']) })).resolves.toBeDefined();
  });

  it('the hosts name their user: the bridge and the window', () => {
    const root = join(__dirname, '..', '..', 'apps', 'desktop');
    expect(readFileSync(join(root, 'backend', 'web-server.ts'), 'utf8')).toMatch(/user: BRIDGE_USER/);
    expect(readFileSync(join(root, 'electron', 'main.ts'), 'utf8')).toMatch(/user: LOCAL_USER/);
  });
});
