import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { activeRules } from '../../apps/desktop/backend/handlers/debugger-rules.js';

// debugger/rules.json is shared through git. Its rules that change traffic (reply, redirect, remap, modify, fault,
// script…) act on this computer only once allowed here; filters and highlights act without asking.
const home = mkdtempSync(join(tmpdir(), 'tp-dbg-trust-'));
const be = new Backend({ appDir: home, emit: () => undefined });
afterAll(async () => {
  await be.dispose();
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

type State = { needsApproval?: boolean; waiting?: number; rules: Array<{ id: string; kind: string }> };
const highlight = { id: 'hl', name: 'Errors', enabled: true, kind: 'highlight', match: { status: 'error' }, color: 'red' };
const redirect = (host: string) => ({ id: 'rd', name: 'Send elsewhere', enabled: true, kind: 'redirect', match: { host: 'api.example.com' }, redirect: { host } });
/** The file as a pull or a clone leaves it, then read again (as when the workspace is opened). */
const pulled = (rules: unknown[]) => {
  const file = be.ws.path('debugger/rules.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ active: 'Default', profiles: { Default: rules } }));
  if (be.debugger) be.debugger.rules = undefined;
};
const kinds = () => activeRules(be, be.debugger!).map((r) => r.kind);

describe('Debugger rules that change traffic wait for "Allow on this computer"', () => {
  it('a pulled redirect waits; a highlight acts; allowed, it acts; a pulled change waits again', async () => {
    pulled([highlight, redirect('collector.invalid')]);
    const before = (await be.invoke('debug.rules', {})) as State;
    expect(before).toMatchObject({ needsApproval: true, waiting: 1 });
    expect(before.rules.map((r) => r.id)).toEqual(['hl', 'rd']); // listed, so the person can look at it
    expect(kinds()).toEqual(['highlight']);

    const after = (await be.invoke('debug.approveRules', {})) as State;
    expect(after.needsApproval).toBeUndefined();
    expect(kinds()).toEqual(['highlight', 'redirect']);

    // changed here while allowed: still allowed
    await be.invoke('debug.saveRule', { rule: { ...redirect('localhost:8080'), name: 'Local' } });
    be.debugger!.rules = undefined; // read again from the file the app wrote (the workspace opened again)
    expect(((await be.invoke('debug.rules', {})) as State).needsApproval).toBeUndefined();
    expect(kinds()).toEqual(['highlight', 'redirect']);

    // the redirect's target changed by a pull: what was allowed is not what is there now
    pulled([highlight, redirect('collector.invalid')]);
    expect(((await be.invoke('debug.rules', {})) as State).needsApproval).toBe(true);
    expect(kinds()).toEqual(['highlight']);
  });

  it('a nested field, a script file and a rule in another profile are all part of what was allowed', async () => {
    const script = { id: 'sc', name: 'Hook', enabled: true, kind: 'script', match: { host: 'api.example.com' }, script: { file: 'debugger/hook.js' } };
    writeFileSync(be.ws.path('debugger', 'hook.js'), 'tp.response.setBody("one")');
    pulled([redirect('a.example')]);
    await be.invoke('debug.approveRules', {});
    // a pull changes only the redirect's host (a nested field): it waits again
    pulled([redirect('evil.example')]);
    expect(((await be.invoke('debug.rules', {})) as State).needsApproval).toBe(true);
    // a script rule reading a file: allowed as the file is; a pull that rewrites the file waits again
    pulled([script]);
    await be.invoke('debug.approveRules', {});
    writeFileSync(be.ws.path('debugger', 'hook.js'), 'tp.response.setBody("two")');
    be.debugger!.rules = undefined;
    expect(((await be.invoke('debug.rules', {})) as State).needsApproval).toBe(true);
    // a rule in another profile counts in what waits (Allow approves every profile)
    const file = be.ws.path('debugger/rules.json');
    writeFileSync(file, JSON.stringify({ active: 'Default', profiles: { Default: [highlight], Mock: [redirect('x.example')] } }));
    be.debugger!.rules = undefined;
    expect((await be.invoke('debug.rules', {})) as State).toMatchObject({ needsApproval: true, waiting: 1 });
  });

  it('a file of filters and highlights needs nothing; a highlight color changed by a pull does not ask', async () => {
    pulled([highlight, { id: 'ig', name: 'No fonts', enabled: true, kind: 'ignore', match: { url: '*.woff2' } }]);
    expect(((await be.invoke('debug.rules', {})) as State).needsApproval).toBeUndefined();
    pulled([{ ...highlight, color: 'orange' }]);
    expect(((await be.invoke('debug.rules', {})) as State).needsApproval).toBeUndefined();
  });
});
