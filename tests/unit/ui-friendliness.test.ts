import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { VIEW_DOCS } from '../../apps/desktop/src/lib/docs-pages';
import { COMMANDS, shortcutGroups } from '../../apps/desktop/src/lib/shortcuts';
import { adoptSaved, changedFields, clearDrafts, discardDraft, dirtyCollectionIds, editDraft, markSaved, resolveConflict, useCollectionDrafts } from '../../apps/desktop/src/lib/collection-draft';
import type { Collection } from '../../apps/desktop/src/types';

/**
 * The user-friendliness rules of the renderer (UI audit 2026-10-21), kept by reading the source:
 *
 * - a dialog (Modal) focuses its first field as it opens, and Enter runs its main button (`onSubmit`);
 * - a disabled Button, IconButton or menu item says why (`reason`, or a `title` that is the reason);
 * - an icon-only button is an IconButton (it has a name) and never a self-closing `<Button icon=… />`;
 * - every view has a docs page (the top bar's ?), every PageHeader passes `help`, and the pages exist;
 * - every Ctrl/Cmd key handled in a view or component is in the shortcuts registry (lib/shortcuts.ts).
 */
const SRC = join(__dirname, '../../apps/desktop/src');
const DOCS = join(__dirname, '../../docs');
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.tsx$/.test(f) ? [join(dir, f)] : []));
const rel = (f: string) => f.slice(SRC.length + 1).replace(/\\/g, '/');
const sources = files(SRC).map((f) => ({ file: rel(f), text: readFileSync(f, 'utf8') }));

/** Every `<Name …>` opening tag of a source, JSX braces balanced, with its line. */
function tags(text: string, name: string): Array<{ tag: string; line: number }> {
  const out: Array<{ tag: string; line: number }> = [];
  for (let i = text.indexOf(`<${name}`); i >= 0; i = text.indexOf(`<${name}`, i + 1)) {
    if (/\w/.test(text[i + 1 + name.length] ?? '')) continue; // <ButtonGroup, <ModalOrPanel …
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    out.push({ tag: text.slice(i, j + 1), line: text.slice(0, i).split('\n').length });
  }
  return out;
}

/** The `{…}` expression of an attribute of a tag, braces balanced. */
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}=\\{`).exec(tag);
  if (!m) return undefined;
  let depth = 0;
  for (let k = m.index + m[0].length - 1; k < tag.length; k++) {
    if (tag[k] === '{') depth++;
    else if (tag[k] === '}' && --depth === 0) return tag.slice(m.index + m[0].length, k);
  }
  return undefined;
}

const DISABLED = /\sdisabled=\{(?!false\})/;

describe('dialogs (Modal)', () => {
  it('open with the focus in the first field of their body, never on Close: one mechanism in Modal', () => {
    const ui = readFileSync(join(SRC, 'components/ui.tsx'), 'utf8');
    expect(ui).toMatch(/onOpenAutoFocus=\{focusFirst\}/);
    expect(ui).toMatch(/\[data-autofocus\], input:not\(\[type=hidden\]\)/);
    // the number of dialogs that still focus a field by hand only goes down (the Modal does it for them)
    const byHand = sources.filter((s) => s.file !== 'components/ui.tsx' && s.text.includes('<Modal') && /\bautoFocus\b/.test(s.text)).map((s) => s.file);
    expect(byHand.length, byHand.join(', ')).toBeLessThanOrEqual(10);
  });

  it('with a main button (variant="primary" in the footer) pass onSubmit, so Enter in a field runs it', () => {
    const missing: string[] = [];
    for (const s of sources)
      for (const t of tags(s.text, 'Modal')) {
        const footer = attr(t.tag, 'footer');
        if (footer?.includes('variant="primary"') && !/\sonSubmit=/.test(t.tag)) missing.push(`${s.file}:${t.line}`);
      }
    expect(missing).toEqual([]);
  });

  it('(and page headers) link to their docs page, and the page exists', () => {
    const missing: string[] = [];
    const pages: string[] = Object.values(VIEW_DOCS);
    for (const s of sources) {
      for (const t of tags(s.text, 'PageHeader')) {
        const m = /\shelp="([^"]+)"/.exec(t.tag);
        if (!m) missing.push(`${s.file}:${t.line}: PageHeader without help=`);
        else pages.push(m[1]!);
      }
      for (const t of tags(s.text, 'Modal')) {
        const m = /\shelp="([^"]+)"/.exec(t.tag);
        if (m) pages.push(m[1]!);
      }
    }
    expect(missing).toEqual([]);
    const gone = pages.filter((p) => {
      const [path, anchor] = p.split('#');
      const file = join(DOCS, `${path}.md`);
      if (!existsSync(file)) return true;
      if (!anchor) return false;
      const doc = readFileSync(file, 'utf8');
      // a VitePress anchor: an explicit {#id} or the heading's text slugified
      const headings = [...doc.matchAll(/^#{1,6}\s+(.+?)(?:\s*\{#([^}]+)\})?\s*$/gm)].map(
        (m) =>
          m[2] ??
          m[1]!
            .toLowerCase()
            .replace(/[`*_]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, ''),
      );
      return !headings.includes(anchor);
    });
    expect(gone).toEqual([]);
  });

  it('every view of the app has a docs page for the top bar’s ?', () => {
    const store = readFileSync(join(SRC, 'store.ts'), 'utf8');
    const ids = [...store.slice(store.indexOf('export type ViewId'), store.indexOf(';', store.indexOf('export type ViewId'))).matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(15);
    expect(ids.filter((id) => !(id in VIEW_DOCS))).toEqual([]);
  });
});

describe('disabled controls say why', () => {
  // the group around the output download control carries the reason for all three of its buttons (OutputDownload.tsx)
  const GROUP_TOOLTIP = new Set(['components/output/OutputDownload.tsx']);

  it('a disabled Button or IconButton has a reason (or a title that is the reason)', () => {
    const missing: string[] = [];
    for (const s of sources) {
      if (GROUP_TOOLTIP.has(s.file)) continue;
      for (const name of ['Button', 'IconButton']) for (const t of tags(s.text, name)) if (DISABLED.test(t.tag) && !/\s(reason|title)=/.test(t.tag)) missing.push(`${s.file}:${t.line}`);
    }
    expect(missing).toEqual([]);
  });

  it('a disabled menu item or empty-state action has a reason', () => {
    const missing: string[] = [];
    for (const s of sources)
      for (const m of s.text.matchAll(/\bdisabled:(?!\s*true\b)/g)) {
        // buildNodeMenu's `disabled: { action: reason }` map (perhaps behind a condition): its values are the reasons
        if (/^\s*(?:[^,\n{]*\?\s*)?\{\s*\w+:/.test(s.text.slice(m.index + 'disabled:'.length, m.index + 200))) continue;
        // the object literal around it (balanced braces); only the rows of a menu or an empty state (onSelect / onClick)
        let a = m.index;
        for (let depth = 0; a > 0; a--) {
          if (s.text[a] === '}') depth++;
          else if (s.text[a] === '{' && depth-- === 0) break;
        }
        let b = a;
        for (let depth = 0; b < s.text.length; b++) {
          if (s.text[b] === '{') depth++;
          else if (s.text[b] === '}' && --depth === 0) break;
        }
        const obj = s.text.slice(a, b + 1);
        if (!/\b(onSelect|onClick)\s*[:(]/.test(obj) || !/\blabel:/.test(obj)) continue;
        if (!/\b(reason|title):/.test(obj)) missing.push(`${s.file}:${s.text.slice(0, m.index).split('\n').length}`);
      }
    expect(missing).toEqual([]);
  });

  it('IconButton can show its reason while disabled (the box around it carries the tooltip)', () => {
    const ui = readFileSync(join(SRC, 'components/ui.tsx'), 'utf8');
    expect(ui).toMatch(/data-disabled-reason/);
    expect(ui).toMatch(/title=\{disabled && reason \? reason : title\}/);
  });
});

describe('icon-only buttons', () => {
  it('are IconButtons (named): no self-closing <Button icon=… />', () => {
    const found: string[] = [];
    for (const s of sources) for (const t of tags(s.text, 'Button')) if (t.tag.endsWith('/>')) found.push(`${s.file}:${t.line}`);
    expect(found).toEqual([]);
  });
});

describe('keyboard shortcuts handled in views and components are in the registry', () => {
  // files that read keys for another purpose: recording a binding, a terminal, the menu's own open keys
  const NOT_SHORTCUTS = new Set(['components/KeyboardSettings.tsx', 'components/TerminalPanel.tsx', 'components/Menu.tsx']);
  const groups = shortcutGroups({ mod: 'Mod', alt: 'Alt', shift: 'Shift', mac: false, views: [] });
  const known = new Set<string>([...groups.flatMap((g) => g.items.flatMap((i) => i.keys.map((k) => k.join('+')))), ...COMMANDS.map((c) => c.combo)]);

  it('every Ctrl/Cmd+key a view or component handles is listed (so the Shortcuts dialog and the docs know it)', () => {
    const missing: string[] = [];
    for (const s of sources) {
      if (NOT_SHORTCUTS.has(s.file) || !/ctrlKey\s*\|\|\s*e\w*\.metaKey/.test(s.text)) continue;
      const lines = s.text.split('\n');
      const modAlias = /const mod = e\.ctrlKey \|\| e\.metaKey/.test(s.text);
      lines.forEach((l, i) => {
        const onLine = /ctrlKey\s*\|\|\s*\w+\.metaKey/.test(l) || (modAlias && /\bk === '/.test(l));
        if (!onLine) return;
        for (const m of l.matchAll(/(?:key(?:\.toLowerCase\(\))?|\bk)\s*===\s*'(\w+)'/g)) {
          const key = m[1]!.length === 1 ? m[1]!.toUpperCase() : m[1]!;
          // Shift belongs to this key when the condition right after it says so ('z' && e.shiftKey)
          const after = l.slice(m.index! + m[0].length).split(/\|\||\)/)[0]!;
          const shift = /&&\s*e\w*\.shiftKey/.test(after);
          const combo = `Mod+${shift ? 'Shift+' : ''}${key}`;
          if (!known.has(combo)) missing.push(`${s.file}:${i + 1}: ${combo}`);
        }
      });
    }
    expect(missing).toEqual([]);
  });

  it('the Debugger and the flow designer have their own groups', () => {
    expect(groups.map((g) => g.title)).toEqual(expect.arrayContaining(['HTTP Debugger', 'Flow designer']));
    expect(known.has('Mod+E')).toBe(true);
  });
});

const allFiles = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? allFiles(join(dir, f)) : /\.tsx?$/.test(f) ? [join(dir, f)] : []));

// The 2026-10-22 user-friendliness review (agents and people): guards for what it fixed, one section per finding.
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
    const offenders = allFiles(SRC)
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
    // updates.ts writes its own second sentence for the update check; App.tsx says an event's message (the backend's own text and hint,
    // not a thrown error); GraphQLView says what to do with variables that are not JSON (a JSON.parse message, nothing to add)
    const ALLOWED = new Set(['updates.ts', 'App.tsx', 'views/GraphQLView.tsx']);
    for (const f of allFiles(SRC)) {
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
      if (/[\\/](migrate|changelog\.md|getting-started[\\/]whats-new\.md|getting-started[\\/]import-fidelity\.md|security[\\/]code-signing\.md)/.test(f.slice(DOCS.length))) continue;
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
    const offenders = allFiles(SRC)
      .filter((f) => /New AI test/i.test(readFileSync(f, 'utf8')) && !/views\/TestsView\.tsx$/.test(f.replace(/\\/g, '/')) && !/App\.tsx$/.test(f))
      .map(rel);
    expect(offenders).toEqual([]);
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).toContain('LABEL.newAiPrompt');
    expect(app).toContain("'New AI test file'");
  });

  it('capturing traffic for one API has one name in every menu', () => {
    const texts = allFiles(SRC).map((f) => [rel(f), readFileSync(f, 'utf8')] as const);
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
  it("Collections and Settings register the one leave guard (hooks.ts), and the app's navigation honours it", () => {
    for (const v of ['views/CollectionsView.tsx', 'views/SettingsView.tsx']) expect(readFileSync(join(SRC, v), 'utf8'), v).toContain('useLeaveGuard(');
    const store = readFileSync(join(SRC, 'store.ts'), 'utf8');
    for (const fn of ['setView', 'openIntent']) expect(store).toMatch(new RegExp(`${fn}: \\([^)]*\\) =>\\s*whenLeaving\\(`));
    expect(store).toContain('mayLeave(get().view)');
    // Collections offers Save / Don't save / Cancel: it passes its save to the guard
    expect(readFileSync(join(SRC, 'views/CollectionsView.tsx'), 'utf8')).toMatch(/useLeaveGuard\('collections', dirty, [^\n]*saveDraft\)/);
    expect(readFileSync(join(SRC, 'views/CollectionsView.tsx'), 'utf8')).toContain("useSaveShortcut('collections'");
  });
});
