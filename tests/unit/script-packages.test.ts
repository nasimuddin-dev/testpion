import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore, runScript, scriptCompatibility, type Collection } from '../../packages/core/src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'pkgs-'));
const store = WorkspaceStore.create(dir, 'pkgs');
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('script packages (pm.require)', () => {
  it('stores packages by name, scoped ones in a folder, and refuses paths', () => {
    store.saveScriptPackage('@clinic/auth', "const h = pm.require('helpers');\nmodule.exports = { header: (t) => h.bearer(t), calls: 0 };");
    store.saveScriptPackage('helpers', "exports.bearer = (t) => 'Bearer ' + t;\nexports.id = require('uuid').v4().length;");
    expect(store.listScriptPackages().map((p) => p.name)).toEqual(['@clinic/auth', 'helpers']);
    expect(store.readScriptPackage('nope')).toBeUndefined();
    expect(() => store.saveScriptPackage('../evil', 'x')).toThrow(/not a package name/);
    expect(store.readScriptPackage('../../workspace')).toBeUndefined();
    // workspace exports carry them
    expect(Object.keys(store.exportBundle().packages ?? {})).toEqual(['@clinic/auth', 'helpers']);
  });

  it('pm.require loads a package (and the packages it requires) once per script', async () => {
    const out = await runScript(
      `const auth = pm.require('@clinic/auth');
       auth.calls++;
       pm.request.headers.upsert({ key: 'Authorization', value: auth.header('t0k') });
       pm.test('same module object', () => pm.expect(pm.require('@clinic/auth').calls).to.equal(1));
       pm.test('built-in modules inside packages', () => pm.expect(pm.require('helpers').id).to.equal(36));`,
      { request: { method: 'GET', url: 'http://x', headers: [] }, vars: {} } as never,
      { requirePackage: (n) => store.readScriptPackage(n) },
    );
    expect(out.error).toBeUndefined();
    expect(out.request?.headers).toEqual([{ key: 'Authorization', value: 'Bearer t0k' }]);
    expect(out.tests.every((t) => t.passed)).toBe(true);
  });

  it('a package can use tp (the TestPion name) as well as pm', async () => {
    const out = await runScript(
      "const p = tp.require('tp-pkg'); tp.test('both names', () => tp.expect(p.same).to.equal(true));",
      { request: { method: 'GET', url: 'http://x', headers: [] }, vars: {} } as never,
      { requirePackage: (n) => (n === 'tp-pkg' ? 'module.exports = { same: tp === pm && typeof tp.test === "function" };' : undefined) },
    );
    expect(out.error).toBeUndefined();
    expect(out.tests).toEqual([{ name: 'both names', passed: true }]);
  });

  it('says which package is missing', async () => {
    const out = await runScript("pm.require('@team/missing');", { request: { method: 'GET', url: 'http://x', headers: [] }, vars: {} } as never, { requirePackage: () => undefined });
    expect(out.error).toMatch(/tp\.require\("@team\/missing"\): there is no package with that name in this workspace \(packages\/@team\/missing\.js\)/);
  });

  it('an import warns only about packages the workspace does not have', () => {
    const c = { name: 'c', items: [{ kind: 'http', id: 'r', name: 'R', request: { method: 'GET', url: 'x' }, preRequestScript: "pm.require('@clinic/auth'); pm.require('@team/missing');" }] } as unknown as Collection;
    const w = scriptCompatibility(c, (n) => store.readScriptPackage(n) !== undefined);
    expect(w.map((x) => x.api)).toEqual(["pm.require('@team/missing')"]);
    expect(w[0]!.hint).toContain('packages/@team/missing.js');
  });
});
