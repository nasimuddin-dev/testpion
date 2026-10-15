import type { ItemRef } from '@testpion/shared';

/**
 * WF-01 Quick Open: one palette for items and commands, its mode chosen by the first character typed, as in VS Code
 * and Postman. Nothing typed: the items opened lately; text: items found by the workspace search; `>` commands;
 * `@` what is on screen (the focused editor's commands); `#` environments and their variables; `?` this help.
 * Ctrl+P opens it on items, Ctrl+K (and the top bar's Commands) on commands, Ctrl+Shift+E on environments: the mode it
 * opens in is the one plain text searches; a prefix typed first switches it. Pure: App.tsx gives it the lists.
 */
export type QuickMode = 'items' | 'commands' | 'here' | 'environments' | 'help';

export const MODE_OF_PREFIX: Readonly<Record<string, QuickMode>> = { '>': 'commands', '@': 'here', '#': 'environments', '?': 'help' };
export const PREFIX_OF_MODE: Readonly<Record<QuickMode, string>> = { items: '', commands: '>', here: '@', environments: '#', help: '?' };

/** The mode a query is in (a prefix typed first, else the mode it opened in), and the text after the prefix. */
export function parseQuickQuery(q: string, base: QuickMode = 'items'): { mode: QuickMode; text: string } {
  const mode = MODE_OF_PREFIX[q.charAt(0)];
  return mode ? { mode, text: q.slice(1).trim() } : { mode: base, text: q.trim() };
}

/** A row of the palette (Shell's PaletteCommand, without its icon element). */
export interface QuickRow {
  id: string;
  label: string;
  detail?: string;
  hint?: string;
  group?: string;
  /** What it names, when it is an item (App draws its icon). */
  ref?: ItemRef;
  run(): void;
}

export interface QuickSources {
  /** The items opened lately, newest first. */
  recent: Array<{ ref: ItemRef; label: string }>;
  /** The workspace search's hits for the text (items mode), when they have arrived. */
  hits?: Array<{ id: string; title: string; subtitle?: string; kind: string; ref?: ItemRef }>;
  commands: QuickRow[];
  /** The focused editor's own commands (`@`). */
  here: QuickRow[];
  environments: Array<{ id: string; name: string; production?: boolean; variables: string[] }>;
  active?: string;
  open(ref: ItemRef): void;
  switchEnvironment(name: string): void;
  /** Reopen the palette in a mode (the help rows). */
  setQuery(prefix: string): void;
  /** What a kind of item is called ("Request", "Test file"). */
  noun(ref: ItemRef): string;
}

const HELP: Array<[string, string]> = [
  ['', 'Go to an item: requests, tests, flows, monitors, environments, runs … (nothing typed: the latest)'],
  ['>', 'Run a command'],
  ['@', 'What is on screen: the focused editor'],
  ['#', 'Switch environment, or find a variable'],
];

/** The rows for a query: what the palette lists (it filters them by `text`), its placeholder and its empty line. */
export function quickOpenRows(q: string, s: QuickSources, base: QuickMode = 'items'): { rows: QuickRow[]; text: string; placeholder: string; empty: string } {
  const { mode, text } = parseQuickQuery(q, base);
  switch (mode) {
    case 'commands':
      return { rows: s.commands, text, placeholder: base === 'commands' ? 'Type a command… (no prefix: items, # environments, ? help)' : 'Type a command…', empty: 'No matching commands' };
    case 'here':
      return { rows: s.here, text, placeholder: 'What is on screen…', empty: 'Nothing here has commands of its own' };
    case 'environments': {
      const rows: QuickRow[] = [];
      for (const e of s.environments)
        rows.push({
          id: `env:${e.id}`,
          label: `${e.name}${e.production ? '  (production)' : ''}`,
          hint: e.name === s.active ? 'active' : 'Switch',
          group: 'Environments',
          run: () => s.switchEnvironment(e.name),
        });
      for (const e of s.environments)
        for (const v of e.variables.slice(0, 500)) {
          const ref: ItemRef = { kind: 'variable', key: v, environmentId: e.id };
          rows.push({ id: `var:${e.id}:${v}`, label: `{{${v}}}`, detail: e.name, group: 'Variables', ref, run: () => s.open(ref) });
        }
      return { rows, text, placeholder: 'Environment or variable…', empty: 'No matching environment or variable' };
    }
    case 'help':
      return {
        rows: HELP.map(([p, label]) => ({ id: `help:${p || 'items'}`, label, hint: p || 'type', run: () => s.setQuery(p) })),
        text: '',
        placeholder: 'What the first character does…',
        empty: '',
      };
    default: {
      if (!text)
        return {
          rows: s.recent.map((r) => ({ id: `recent:${JSON.stringify(r.ref)}`, label: r.label, detail: s.noun(r.ref), group: 'Recently opened', ref: r.ref, run: () => s.open(r.ref) })),
          text: '',
          placeholder: 'Go to an item (> commands, # environments, ? help)',
          empty: 'Nothing opened yet: type a name, or > for commands',
        };
      // the search answered for this text: its hits, already ranked (the palette's own filter keeps them)
      const rows = (s.hits ?? []).flatMap((h) => (h.ref ? [{ id: `hit:${h.kind}:${h.id}`, label: h.title, detail: h.subtitle, hint: s.noun(h.ref), ref: h.ref, run: () => s.open(h.ref!) }] : []));
      return { rows, text: '', placeholder: 'Go to an item (> commands, # environments, ? help)', empty: s.hits ? 'No matching items (> for commands)' : 'Searching…' };
    }
  }
}
