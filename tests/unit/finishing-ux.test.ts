import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { COMMANDS } from '../../apps/desktop/src/lib/shortcuts.js';
import { fileInError } from '../../apps/desktop/src/lib/error-file.js';
import { SETTINGS_INDEX, SETTINGS_SCOPE, SETTINGS_TABS, searchSettings } from '../../apps/desktop/src/lib/settings-index.js';
import { PM_ALIASES } from '../../apps/desktop/src/lib/pm-aliases.js';
import { defaultSaveCollection, rememberSaveCollection } from '../../apps/desktop/src/lib/last-save-target.js';
import { WorkspaceStore, defaultSettings, exportSettings, importSettings, settingsDefaults } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers.js';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('Reveal file in an error toast', () => {
  const ws = 'D:\\work\\shop';
  it('finds the workspace file an error names: in its details, as an absolute path under the workspace, or as a relative one', () => {
    expect(fileInError({ message: 'x', why: '', details: { file: 'D:\\work\\shop\\collections\\cart.json' } }, ws)).toBe('collections/cart.json');
    expect(fileInError({ message: 'Could not parse D:\\work\\shop\\environments\\prod.json: Unexpected token', why: '' }, ws)).toBe('environments/prod.json');
    expect(fileInError({ message: 'The collection file collections/cart.json is damaged', why: '' }, undefined)).toBe('collections/cart.json');
    expect(fileInError({ message: 'x', why: '', details: { path: '../../etc/passwd' } }, ws)).toBeUndefined();
    expect(fileInError({ message: 'Nothing is listening at 127.0.0.1:3000', why: '' }, ws)).toBeUndefined();
    expect(fileInError({ message: 'Could not read C:\\Windows\\hosts', why: '' }, ws)).toBeUndefined();
  });
  it('the toast offers it, and the backend shows only a file inside the workspace', async () => {
    expect(read('apps/desktop/src/store.ts')).toMatch(/label: 'Reveal file'/);
    const tmp = tempDir('tp-reveal-');
    const be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => undefined, noMonitors: true });
    try {
      const store = WorkspaceStore.create(join(tmp.dir, 'ws'), 'W');
      store.close();
      be.openStore(join(tmp.dir, 'ws'));
      await expect(be.invoke('ws.revealFile', { path: '../outside.txt' })).rejects.toThrow();
      await expect(be.invoke('ws.revealFile', { path: 'collections/nope.json' })).rejects.toThrow(/not there/);
    } finally {
      await be.dispose();
      tmp.cleanup();
    }
  });
});

describe('Ctrl+T is a window command', () => {
  it('is registered with its key, runs in the window and is not also registered by the native menu', () => {
    expect(COMMANDS.find((c) => c.id === 'new-request-tab')?.combo).toBe('Mod+T');
    expect(read('apps/desktop/src/lib/key-commands.ts')).toMatch(/'new-request-tab': \(\) => useApp\.getState\(\)\.openIntent\('rest', \{ newTab: true \}\)/);
    expect(read('apps/desktop/electron/app-menu.ts')).toMatch(/label: 'New Request Tab'[^\n]*registerAccelerator: false/);
  });
});

describe('the Save dialog starts on the right collection', () => {
  it('the one asked for, else the last used, else the first (the only one, when there is one)', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const cols = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(defaultSaveCollection(cols)).toBe('a');
    expect(defaultSaveCollection([{ id: 'only' }])).toBe('only');
    rememberSaveCollection('c');
    expect(defaultSaveCollection(cols)).toBe('c');
    expect(defaultSaveCollection(cols, 'b')).toBe('b'); // a duplicate's original wins
    expect(defaultSaveCollection([{ id: 'x' }], undefined)).toBe('x'); // the remembered one is gone
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
  it('a duplicated tab asks to be saved beside its original', () => {
    expect(read('apps/desktop/src/views/rest/tabs-store.ts')).toMatch(/saveNear: \{ collectionId, folderId: folderIdsTo\(c\.items, requestId\)/);
    expect(read('apps/desktop/src/views/RestView.tsx')).toMatch(/defaultCollectionId=\{tab\.saveNear\?\.collectionId\} defaultFolder=\{tab\.saveNear\?\.folderId\}/);
  });
});

describe('a request that changes data with a variable that has no value asks first', () => {
  let tmp: ReturnType<typeof tempDir>;
  let be: Backend;
  beforeAll(() => {
    tmp = tempDir('tp-unresolved-');
    const s = WorkspaceStore.create(join(tmp.dir, 'ws'), 'U');
    s.saveCollection({ schemaVersion: '1.0', id: 'c1', name: 'C', version: 0, variables: [{ key: 'known', value: '1', enabled: true }], updatedAt: '', items: [] } as never);
    s.close();
    be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => undefined, noMonitors: true });
    be.openStore(join(tmp.dir, 'ws'));
  });
  afterAll(async () => {
    await be.dispose();
    tmp.cleanup();
  });
  it('names the variables with no value, and leaves out the ones a pre-request script sets', async () => {
    const request = { method: 'POST', url: 'http://x.test/users/{{userId}}/{{known}}', headers: [], body: { type: 'json', content: '{"t":"{{token}}"}' } };
    const r = (await be.invoke('http.unresolved', { request, collectionId: 'c1' })) as { unresolved: string[] };
    expect(r.unresolved.sort()).toEqual(['token', 'userId']);
    const scripted = (await be.invoke('http.unresolved', { request, collectionId: 'c1', preRequestScript: "tp.variables.set('token', 'abc')" })) as { unresolved: string[] };
    expect(scripted.unresolved).toEqual(['userId']);
  });
  it('is a setting (on by default, in the CLI and MCP settings), asked only for data-changing methods', () => {
    expect(defaultSettings().confirmUnresolvedSend).toBe(true);
    const ask = read('apps/desktop/src/lib/confirm-unresolved.ts');
    expect(ask).toMatch(/isDataChangingMethod\(p\.request\.method\)/);
    expect(ask).toMatch(/confirmUnresolvedSend === false\) return true/);
    expect(read('packages/core/src/storage/settings-access.ts')).toMatch(/confirmUnresolvedSend: \{ kind: 'boolean'/);
    expect(read('apps/desktop/src/views/SettingsView.tsx')).toMatch(/checked=\{s\.confirmUnresolvedSend !== false\}/);
  });
});

describe('pm. completions are Postman names that insert tp.*', () => {
  it('every alias is labelled pm.*, inserts tp.* and is the same path', () => {
    expect(PM_ALIASES.length).toBeGreaterThan(30);
    for (const a of PM_ALIASES) {
      expect(a.pm.startsWith('pm.')).toBe(true);
      expect(a.tp).toBe(a.pm.replace(/^pm\./, 'tp.'));
    }
    const intel = read('apps/desktop/src/editor-intel.ts');
    expect(intel).toMatch(/description: 'Postman name'/);
    expect(intel).toMatch(/insertText: a\.tp/);
  });
});

describe('Settings: scope line, search, export and reset', () => {
  it('every tab has a scope line, and the tabs of the view are the index tabs', () => {
    for (const t of SETTINGS_TABS) expect(SETTINGS_SCOPE[t.id], t.id).toMatch(/^Applies to: /);
    expect(read('apps/desktop/src/views/SettingsView.tsx')).toMatch(/\{SETTINGS_SCOPE\[tab\]\}/);
  });
  it('the search finds a setting by its label, its other words and its tab, and covers every label of the view', () => {
    expect(searchSettings('timeout')[0]?.tab).toBe('requests');
    expect(searchSettings('dark').map((h) => h.tab)).toContain('appearance');
    expect(searchSettings('corporate').map((h) => h.tab)).toEqual(expect.arrayContaining(['proxy', 'certificates']));
    expect(searchSettings('proxy')[0]).toMatchObject({ tab: 'proxy', label: 'Proxy (tab)' });
    expect(searchSettings('zzzz')).toEqual([]);
    for (const e of SETTINGS_INDEX)
      expect(
        SETTINGS_TABS.some((t) => t.id === e.tab),
        e.label,
      ).toBe(true);
    // every label the view puts on a field or a toggle is in the index (a new setting is findable)
    const labels = [...read('apps/desktop/src/views/SettingsView.tsx').matchAll(/<(?:Field|Toggle)[^>]*?\blabel="([^"]+)"/g)].map((m) => m[1]!.replace(/\s*\(.*$/, '').toLowerCase());
    const indexed = SETTINGS_INDEX.map((e) => e.label.toLowerCase());
    const missing = labels.filter((l) => !indexed.some((i) => i.startsWith(l) || l.startsWith(i.replace(/\s*\(.*$/, ''))));
    expect(missing).toEqual([]);
  });
  it('export, import and reset go through the checks of testpion settings set', () => {
    const base = defaultSettings();
    const exported = exportSettings({ ...base, theme: 'dark', defaultTimeoutMs: 5000 });
    expect(exported).toMatchObject({ format: 'testpion-settings', version: 1 });
    expect(JSON.stringify(exported)).not.toMatch(/globalVariables|pricing/); // no variables, no price table, no key: those are not settings of the file
    const back = importSettings(base, { ...exported, settings: { ...exported.settings, 'not.a.setting': 1 } });
    expect(back.next.theme).toBe('dark');
    expect(back.next.defaultTimeoutMs).toBe(5000);
    expect(back.skipped).toEqual(['not.a.setting']);
    expect(back.changed.map((c) => c.key).sort()).toEqual(['defaultTimeoutMs', 'theme']);
    expect(() => importSettings(base, { format: 'testpion-settings', version: 1, settings: { fontSize: 99 } })).toThrow(/fontSize/);
    expect(() => importSettings(base, { hello: 1 })).toThrow(/not a TestPion settings file/);
    const reset = settingsDefaults(back.next, ['theme']);
    expect(reset.reset).toEqual(['theme']);
    expect(reset.next.theme).toBe(base.theme);
    expect(reset.next.defaultTimeoutMs).toBe(5000);
    expect(settingsDefaults(back.next, 'all').next.defaultTimeoutMs).toBe(base.defaultTimeoutMs);
  });
  it('the app does the same over the backend, and refuses nothing it cannot undo', async () => {
    const tmp = tempDir('tp-settings-io-');
    const be = new Backend({ appDir: join(tmp.dir, 'app'), emit: () => undefined, noMonitors: true });
    try {
      const doc = (await be.invoke('settings.export', {})) as { format: string; settings: Record<string, unknown> };
      expect(doc.format).toBe('testpion-settings');
      const r = (await be.invoke('settings.import', { doc: { ...doc, settings: { ...doc.settings, density: 'compact', 'ai.hidden': true } } })) as { changed: Array<{ key: string }> };
      expect(r.changed.map((c) => c.key).sort()).toEqual(['ai.hidden', 'density']);
      expect(be.settings.density).toBe('compact');
      const reset = (await be.invoke('settings.reset', { keys: ['density'] })) as { reset: string[] };
      expect(reset.reset).toEqual(['density']);
      expect(be.settings.density).toBe(defaultSettings().density);
      expect(be.settings.ai?.hidden).toBe(true);
      await be.invoke('settings.reset', {});
      expect(be.settings.ai?.hidden).toBeFalsy();
    } finally {
      await be.dispose();
      tmp.cleanup();
    }
  });
  it('About has Export, Import and Reset', () => {
    const about = read('apps/desktop/src/components/SettingsTransfer.tsx');
    expect(about).toMatch(/Import settings…/);
    expect(about).toMatch(/Reset settings…/);
    expect(about).toMatch(/id: 'settings\.export'/);
    expect(read('apps/desktop/src/views/SettingsView.tsx')).toMatch(/<SettingsTransfer unsaved=\{changed > 0\} \/>/);
  });
});

describe('the folder editor asks before it drops edits', () => {
  it('Esc, the close button and Cancel go through one check', () => {
    const src = read('apps/desktop/src/components/FolderEditorBody.tsx');
    expect(src).toMatch(/const dirty = JSON\.stringify\(draft\) !== JSON\.stringify\(folder\)/);
    expect(src).toMatch(/onClose=\{\(\) => void close\(\)\}/);
    expect(src).toMatch(/onClick=\{\(\) => void close\(\)\}/);
  });
});

describe('every drag has a menu equivalent', () => {
  it('environments reorder from the menu (and with Alt+arrows); requests move with Move…; saved items with Move to', () => {
    const shared = read('packages/shared/src/node-menu.ts');
    expect(shared).toMatch(/id: 'moveUp'[^\n]*kinds: \['environment'\]/);
    expect(shared).toMatch(/id: 'moveDown'[^\n]*kinds: \['environment'\]/);
    const env = read('apps/desktop/src/views/EnvironmentsView.tsx');
    expect(env).toMatch(/moveUp: \(\) => void move\(e\.id/);
    expect(env).toMatch(/moveDown: \(\) => void move\(e\.id/);
    expect(read('apps/desktop/src/components/CollectionTree.tsx')).toMatch(/move: \(\) => setMoving\(\{ c, n \}\)/);
    expect(read('apps/desktop/src/components/FolderList.tsx')).toMatch(/move: moveToFolderItem/);
    expect(read('apps/desktop/src/components/Explorer.tsx')).toMatch(/move: collections\.filter/);
  });
});

describe('a monitor that needs attention says why', () => {
  it('the toast after a manual run and the result badge carry the reason', () => {
    const src = read('apps/desktop/src/views/MonitorsView.tsx');
    expect(src).toMatch(/r\.status !== 'passed' && \(r\.error \|\| r\.reason\)/);
    expect(src).toMatch(/<Badge tone=\{tone\(r\.status\)\} title=\{r\.error \?\? r\.reason\}>/);
  });
});

describe('the pages Logs, Script packages and Model pricing', () => {
  const pages = [
    ['getting-started/logs', "/getting-started/logs'"],
    ['test-runner/script-packages', "/test-runner/script-packages'"],
    ['ai-testing/model-pricing', "/ai-testing/model-pricing'"],
  ] as const;
  it('exist, are in the sidebar and in llms.txt', () => {
    const sidebar = read('docs/.vitepress/config.mts');
    const llms = read('docs/public/llms.txt');
    for (const [page, link] of pages) {
      expect(existsSync(join(root, 'docs', `${page}.md`)), page).toBe(true);
      expect(sidebar, page).toContain(link);
      expect(llms, page).toContain(`/${page}`);
      expect(read(`docs/${page}.md`)).toMatch(/^---\ntitle: "[^"]+"\ndescription: "[^"]+"\n---/);
    }
  });
  it('are opened by the ? of the Logs bar, the Script packages dialog and the Model pricing tab', () => {
    expect(read('apps/desktop/src/components/Shell.tsx')).toMatch(/<HelpLink page="getting-started\/logs"/);
    expect(read('apps/desktop/src/components/ScriptPackagesDialog.tsx')).toMatch(/help="test-runner\/script-packages"/);
    expect(read('apps/desktop/src/views/SettingsView.tsx')).toMatch(/<HelpLink page="ai-testing\/model-pricing"/);
  });
});

describe('the Home card for a workspace that could not be opened', () => {
  it('is on Home and offers Retry and Open another', () => {
    expect(read('apps/desktop/src/views/HomeView.tsx')).toMatch(/<StartupProblem \/>/);
    const card = read('apps/desktop/src/components/StartupProblem.tsx');
    expect(card).toMatch(/Retry/);
    expect(card).toMatch(/Open another…/);
    expect(card).toMatch(/data-startup-problem/);
  });
});

// (a file the tests above wrote nothing to: keep the helpers referenced)
void [mkdtempSync, tmpdir, writeFileSync];
