import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { adoptSaved, changedFields, clearDrafts, discardDraft, dirtyCollectionIds, editDraft, markSaved, resolveConflict, useCollectionDrafts } from '../../apps/desktop/src/lib/collection-draft';
import type { Collection } from '../../apps/desktop/src/types';

// The 2026-10-22 user-friendliness review: guards for what it fixed (one section per finding).
const SRC = join(__dirname, '../../apps/desktop/src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));
const rel = (f: string) => f.slice(SRC.length + 1).replace(/\\/g, '/');

const col = (over: Partial<Collection> = {}): Collection => ({ schemaVersion: '1.0', id: 'c1', name: 'API', version: 1, variables: [], items: [], updatedAt: '', ...over }) as Collection;
const entry = () => useCollectionDrafts.getState().entries.c1;

describe('collection settings drafts survive refreshes (P0)', () => {
  it('keeps unsaved fields when a newer saved version arrives, takes the other fields from it', () => {
    clearDrafts();
    adoptSaved(col());
    editDraft({ ...entry().draft, variables: [{ key: 'a', value: '1', enabled: true }] } as Collection);
    expect(changedFields(entry().base, entry().draft)).toEqual(['variables']);
    // a request saved in a REST tab: new version, new items, a new description
    adoptSaved(col({ version: 2, items: [{ kind: 'http', id: 'r', name: 'R', request: { method: 'GET', url: '/' } }] as never, description: 'new docs' }));
    expect(entry().draft.variables).toHaveLength(1);
    expect(entry().draft.version).toBe(2);
    expect(entry().draft.items).toHaveLength(1);
    expect(entry().draft.description).toBe('new docs');
    expect(entry().conflict).toEqual([]);
    expect(dirtyCollectionIds(useCollectionDrafts.getState().entries)).toEqual(['c1']);
  });

  it('an untouched draft follows the saved collection; saving clears the dirty mark', () => {
    clearDrafts();
    adoptSaved(col());
    adoptSaved(col({ version: 2, name: 'Renamed' }));
    expect(entry().draft.name).toBe('Renamed');
    editDraft({ ...entry().draft, testScript: 'x' });
    markSaved(entry().draft);
    expect(dirtyCollectionIds(useCollectionDrafts.getState().entries)).toEqual([]);
  });

  it('a field both sides changed is a conflict the user settles', () => {
    clearDrafts();
    adoptSaved(col({ preRequestScript: 'a' }));
    editDraft({ ...entry().draft, preRequestScript: 'mine' });
    adoptSaved(col({ version: 2, preRequestScript: 'theirs' }));
    expect(entry().conflict).toEqual(['preRequestScript']);
    expect(entry().draft.preRequestScript).toBe('mine');
    resolveConflict('c1', 'theirs');
    expect(entry().draft.preRequestScript).toBe('theirs');
    expect(entry().conflict).toEqual([]);
  });

  it('discard returns to the saved collection', () => {
    clearDrafts();
    adoptSaved(col());
    editDraft({ ...entry().draft, description: 'x' });
    discardDraft('c1');
    expect(changedFields(entry().base, entry().draft)).toEqual([]);
  });

  it('every view that edits a draft with setDraft( registers a leave guard (or saves as you type)', () => {
    // document-tab views: the draft lives in a tab that is marked dirty, kept across views and asked about on close
    const NO_GUARD_NEEDED = new Set(['views/EnvironmentsView.tsx', 'views/McpView.tsx']);
    const offenders = files(SRC)
      .filter((f) => /views\/[A-Za-z]+View\.tsx$/.test(f.replace(/\\/g, '/')))
      .filter((f) => /\bsetDraft\(/.test(readFileSync(f, 'utf8')) && !/useLeaveGuard\(/.test(readFileSync(f, 'utf8')))
      .map(rel)
      .filter((f) => !NO_GUARD_NEEDED.has(f));
    expect(offenders).toEqual([]);
  });
});

describe('errors say what to do (P1)', () => {
  it('a refused connection and a missing file are said in words; the code moves to details', async () => {
    const { normalizeError } = await import('../../packages/core/src/errors');
    const refused = normalizeError(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 3000 }) }));
    expect(refused.message).toBe('Nothing is listening at 127.0.0.1:3000');
    expect(refused.message).not.toMatch(/E[A-Z]{4,}/);
    expect(refused.details).toMatchObject({ code: 'ECONNREFUSED' });
    expect(refused.suggestions[0]).toMatch(/Start the server/);
    const bare = normalizeError({ code: 'ECONNREFUSED', message: 'fetch failed' });
    expect(bare.message).not.toMatch(/E[A-Z]{4,}/);
    const missing = normalizeError(Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\data\\rows.csv'"), { code: 'ENOENT' }));
    expect(missing.message).toBe('"C:\\data\\rows.csv" was not found');
    expect(missing.message).not.toMatch(/ENOENT/);
    expect(normalizeError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND api.nope.test' }).message).toBe('The host name "api.nope.test" could not be found');
  });

  it('a failure toast shows why and the first thing to try (errorNextStep)', async () => {
    const { ApsError } = await import('../../packages/core/src/errors');
    const { errorNextStep } = await import('../../apps/desktop/src/lib/error-text');
    const e = new ApsError('NetworkError', 'Could not reach api.test').toJSON();
    const next = errorNextStep(e);
    expect(next).toContain(e.suggestions[0]!);
    expect(errorNextStep({ message: 'x', why: 'An unexpected error occurred while executing the operation.', suggestions: [] })).toBeUndefined();
  });

  it('no handler builds an error toast from the engine message by hand: toastError adds why and the next step', () => {
    const offenders: string[] = [];
    // updates.ts writes its own second sentence for the update check
    const ALLOWED = new Set(['updates.ts']);
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/toast\(\s*`[^`]*\$\{[^}]*(?:\.message|String\(e)[^}]*\}[^`]*`\s*,\s*'error'/g)) if (!ALLOWED.has(rel(f))) offenders.push(`${rel(f)}: ${m[0].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('colour contrast of the theme tokens (P1)', () => {
  const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
  /** The declarations of the first block that starts with `selector {`. */
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return css.slice(at, css.indexOf('\n}', at));
  };
  const light = block(':root');
  const dark = block("[data-theme='dark']");
  const token = (b: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(b)?.[1]?.trim();
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const toLin = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
  /** A colour token (#rrggbb, or oklch(L C h)) as linear sRGB. */
  const rgb = (v: string): [number, number, number] => {
    if (v.startsWith('#')) return [1, 3, 5].map((i) => lin(parseInt(v.slice(i, i + 2), 16) / 255)) as [number, number, number];
    const [l, c, h] = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)/.exec(v)!.slice(1).map(Number) as [number, number, number];
    const a = c * Math.cos((h * Math.PI) / 180);
    const b = c * Math.sin((h * Math.PI) / 180);
    const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const out = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_];
    return out.map((x) => Math.min(1, Math.max(0, x))) as [number, number, number];
  };
  void toLin;
  const lum = (v: string) => {
    const [r, g, b] = rgb(v);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };

  it('white on the primary button is at least 4.5:1 at both ends of its gradient', () => {
    for (const end of ['--primary-from', '--primary-to']) expect(ratio(token(light, end)!, '#ffffff'), end).toBeGreaterThanOrEqual(4.5);
    expect(readFileSync(join(SRC, 'components/ui.tsx'), 'utf8')).toContain("variant === 'primary' && 'bg-[image:var(--primary-gradient)]");
  });

  it('the text on the accent colour (badges, filled chips) is at least 4.5:1 in light and dark', () => {
    expect(ratio(token(light, '--accent')!, token(light, '--accent-fg')!), 'light').toBeGreaterThanOrEqual(4.5);
    expect(ratio(token(dark, '--accent')!, token(dark, '--accent-fg')!), 'dark').toBeGreaterThanOrEqual(4.5);
  });

  it('the muted text on the page and panel is at least 4.5:1 in both themes', () => {
    for (const [name, b] of [['light', light], ['dark', dark]] as const) for (const bg of ['--bg', '--panel']) expect(ratio(token(b, '--muted')!, token(b, bg)!), `${name} muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});

describe('docs say what the app says (P1)', () => {
  const DOCS = join(__dirname, '../../docs');
  const mdFiles = (dir: string): string[] => readdirSync(dir).flatMap((f) => (/^(node_modules|\.vitepress|public)$/.test(f) ? [] : statSync(join(dir, f)).isDirectory() ? mdFiles(join(dir, f)) : f.endsWith('.md') ? [join(dir, f)] : []));
  const TABS = ['Appearance', 'Keyboard', 'Requests', 'Git', 'Proxy', 'Certificates', 'Privacy & security', 'Model pricing', 'Load testing', 'Storage', 'AI assistant', 'AI agents (MCP)', 'About'];

  it('every "Settings ▸ tab" names a tab Settings has', () => {
    const bad: string[] = [];
    for (const f of mdFiles(DOCS)) {
      // another tool's settings (Postman's data export, Windows' proxy) and the old release notes are not ours
      if (/[\\/](migrate|changelog\.md|getting-started[\\/]whats-new\.md|getting-started[\\/]import-fidelity\.md)/.test(f.slice(DOCS.length))) continue;
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?<!Postman ▸ |Windows: the system )Settings ▸ ([^\n]{0,40})/g)) {
        const after = m[1]!.replace(/[*]/g, '');
        if (!TABS.some((t) => after.startsWith(t))) bad.push(`${f.slice(DOCS.length + 1)}: Settings ▸ ${after}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the Settings tab names in the docs list are the tabs of SettingsView', () => {
    const view = readFileSync(join(SRC, 'views/SettingsView.tsx'), 'utf8');
    for (const t of TABS) expect(view, t).toContain(`label: '${t}'`);
  });
});

describe('the Privacy tab says what leaves the computer (P1)', () => {
  it('every program file of the desktop app that makes a network call is in NETWORK_DISCLOSURES', async () => {
    const { NETWORK_DISCLOSURES } = await import('../../apps/desktop/src/lib/network-disclosures');
    const known = new Set(NETWORK_DISCLOSURES.flatMap((d) => d.files));
    const root = join(__dirname, '../../apps/desktop');
    const calls: string[] = [];
    for (const dir of ['electron', 'backend']) {
      const walk = (d: string): string[] => readdirSync(join(root, d)).flatMap((f) => (statSync(join(root, d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f).replace(/\\/g, '/')] : []));
      for (const f of walk(dir)) if (/\bfetch\(|net\.request\(|https?\.request\(/.test(readFileSync(join(root, f), 'utf8'))) calls.push(f);
    }
    expect(calls.filter((f) => !known.has(f))).toEqual([]);
    expect(NETWORK_DISCLOSURES.find((d) => d.id === 'updates')?.off).toContain('Check for updates');
  });

  it('the tab shows the update check with its switch, not "nothing leaves"', () => {
    const view = readFileSync(join(SRC, 'views/SettingsView.tsx'), 'utf8');
    expect(view).toContain('What leaves this computer');
    expect(view).not.toMatch(/Telemetry is <b>disabled<\/b>/);
    expect(view).toContain('Check for updates when the app starts');
  });
});

describe('every AI launch asks first, and says what it cost (P1)', () => {
  it('startAi opens the "Ready to send" card unless the caller says the button already showed the estimate', () => {
    const text = readFileSync(join(SRC, 'components/ai/AiAction.tsx'), 'utf8');
    expect(text).toContain("preflight: req.preflight ?? req.task !== 'free'");
    expect(text).toContain('preflight: r.preflight ?? false');
  });

  it('an answer shows its tokens and cost', async () => {
    const src = readFileSync(join(SRC, 'components/AssistantPanel.tsx'), 'utf8');
    expect(src).toContain('data-answer-cost');
  });
});

describe('one name per thing (P1)', () => {
  it('"New AI test" is a Tests file only; the palette says prompt or test file', () => {
    const offenders = files(SRC)
      .filter((f) => /New AI test/i.test(readFileSync(f, 'utf8')) && !/views\/TestsView\.tsx$/.test(f.replace(/\\/g, '/')) && !/App\.tsx$/.test(f))
      .map(rel);
    expect(offenders).toEqual([]);
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).toContain('LABEL.newAiPrompt');
    expect(app).toContain("'New AI Test File'");
  });

  it('capturing traffic for one API has one name in every menu', () => {
    const texts = files(SRC).map((f) => [rel(f), readFileSync(f, 'utf8')] as const);
    for (const [r, t] of texts) if (r !== 'lib/vocabulary.ts') expect(t, r).not.toMatch(/'Reverse proxy for one API…'|Capture: Reverse Proxy for One API/);
  });

  it('palette labels are plain: no "Run suite", no "Area: Verb" for the terminal', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).not.toMatch(/label: 'Run Suite'/);
    expect(app).not.toMatch(/label: 'Terminal: /);
  });
});

describe("Postman's words find their place (P1)", () => {
  it('the palette finds Runner, Newman, Mock, Flows, Globals, Vault and Interceptor', async () => {
    const { POSTMAN_WORDS } = await import('../../packages/shared/src/postman-words');
    const { rankPalette } = await import('../../apps/desktop/src/lib/palette-rank');
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    const nav = readFileSync(join(SRC, 'components/nav.tsx'), 'utf8');
    for (const w of POSTMAN_WORDS) {
      const id = w.paletteId.replace(/^go-/, '');
      const exists = w.paletteId.startsWith('go-') ? nav.includes(`id: '${id}'`) : app.includes(`id: '${w.paletteId}'`);
      expect(exists, `${w.theirs} → ${w.paletteId}`).toBe(true);
      const row = { label: w.ours, aliases: w.aliases };
      expect(rankPalette([row, { label: 'Something else' }], w.aliases[0]!)).toHaveLength(1);
    }
    expect(rankPalette([{ label: 'Run a Collection…', aliases: ['runner'] }, { label: 'Open Globals' }], 'runner').map((r) => r.label)).toEqual(['Run a Collection…']);
  });

  it('the migrate page and the Import dialog carry the same words', () => {
    expect(readFileSync(join(__dirname, '../../docs/migrate/postman.md'), 'utf8')).toContain("Postman's words in TestPion");
    expect(readFileSync(join(SRC, 'components/ImportDialog.tsx'), 'utf8')).toContain('POSTMAN_WORDS');
  });
});

describe('settings are reachable from the CLI and MCP (P1)', () => {
  it('settings get lists every setting of the person\'s choice', async () => {
    const { defaultSettings } = await import('../../packages/core/src/model/types');
    const { describeSettings, HIDDEN_SETTINGS, SETTING_SPECS } = await import('../../packages/core/src/storage/settings-access');
    const shown = describeSettings(defaultSettings());
    const topLevel = new Set(Object.keys(SETTING_SPECS).map((k) => k.split('.')[0]!));
    for (const key of Object.keys(defaultSettings())) expect(topLevel.has(key) || HIDDEN_SETTINGS.includes(key) || key in shown, key).toBe(true);
    expect(Object.keys(shown)).toContain('defaultTimeoutMs');
    expect(Object.keys(shown).join(' ')).not.toMatch(/password|apiKey|secret/i);
  });

  it('a value is checked against what the setting accepts', async () => {
    const { parseSettingValue } = await import('../../packages/core/src/storage/settings-access');
    expect(parseSettingValue('theme', 'dark')).toBe('dark');
    expect(() => parseSettingValue('theme', 'pink')).toThrow(/one of/);
    expect(parseSettingValue('checkForUpdates', 'off')).toBe(false);
    expect(parseSettingValue('defaultTimeoutMs', '5000')).toBe(5000);
    expect(() => parseSettingValue('nope', '1')).toThrow(/No setting called/);
  });
});

describe('inherited auth is shown (P1)', () => {
  it('the nearest folder, else the collection, names what a request inherits', async () => {
    const { effectiveAuth } = await import('../../packages/core/src/protocols/http/auth-token');
    const c = {
      id: 'c',
      name: 'API',
      auth: { type: 'bearer', token: '{{t}}' },
      items: [{ kind: 'folder', id: 'f', name: 'Admin', auth: { type: 'basic', username: 'a', password: 'b' }, items: [{ kind: 'http', id: 'r1', name: 'Users', request: { method: 'GET', url: '/' } }] }, { kind: 'http', id: 'r2', name: 'Top', request: { method: 'GET', url: '/', auth: { type: 'inherit' } } }],
    } as never;
    expect(effectiveAuth(c, 'Users')).toMatchObject({ from: 'folder "Admin"', auth: { type: 'basic' } });
    expect(effectiveAuth(c, 'r2')).toMatchObject({ from: 'collection "API"', auth: { type: 'bearer' } });
    const ed = readFileSync(join(SRC, 'views/rest/RequestEditor.tsx'), 'utf8');
    expect(ed).toContain('useInheritedAuth');
    expect(ed).toContain('inherited={inheritedAuth}');
  });
});

describe('first launch (P1)', () => {
  it('the Examples workspace shows Get started, the walk-throughs and a way to My Workspace', () => {
    const home = readFileSync(join(SRC, 'views/HomeView.tsx'), 'utf8');
    expect(home).toContain('ws?.examples === true');
    expect(home).toContain('data-open-own-workspace');
    expect(home).not.toMatch(/EXAMPLES_ID/);
    expect(home).toMatch(/function Walkthroughs/);
  });

  it('a new request tab puts the cursor in the URL field', () => {
    const rest = readFileSync(join(SRC, 'views/RestView.tsx'), 'utf8');
    expect(rest).toContain('focusUrlOf');
    expect(rest).toContain('Request URL');
  });
});

describe('the collection runner does not start a second run (P1)', () => {
  it('the Run button is disabled while a run started here is going', () => {
    const t = readFileSync(join(SRC, 'components/CollectionRunner.tsx'), 'utf8');
    expect(t).toContain('disabled={!selected.length || !!running}');
    expect(t).toContain('data-run-in-progress');
  });
});

describe('the mock server can become {{baseUrl}} (P1)', () => {
  it('has a one-click Use as {{baseUrl}} that makes a Mock environment', () => {
    const t = readFileSync(join(SRC, 'components/MockPanel.tsx'), 'utf8');
    expect(t).toContain('data-mock-use-base-url');
    expect(t).toContain("name: 'Mock'");
  });
});

describe('leaving a view with unsaved changes asks first (P0/P1)', () => {
  it('Collections and Settings register the one leave guard, and the app\'s navigation honours it', () => {
    for (const v of ['views/CollectionsView.tsx', 'views/SettingsView.tsx']) expect(readFileSync(join(SRC, v), 'utf8'), v).toContain('useLeaveGuard(');
    const store = readFileSync(join(SRC, 'store.ts'), 'utf8');
    for (const fn of ['setView', 'openIntent']) expect(store).toMatch(new RegExp(`${fn}: \\([^)]*\\) => \\{\\s*if \\(dirtyGuard\\(get\\(\\)\\.view\\)`));
    expect(store).toContain('guardLeave(get().view, to.view');
    expect(readFileSync(join(SRC, 'views/CollectionsView.tsx'), 'utf8')).toContain("useSaveShortcut('collections'");
  });
});
