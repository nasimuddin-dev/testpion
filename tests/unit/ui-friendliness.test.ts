import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { VIEW_DOCS } from '../../apps/desktop/src/lib/docs-pages';
import { COMMANDS, shortcutGroups } from '../../apps/desktop/src/lib/shortcuts';

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
