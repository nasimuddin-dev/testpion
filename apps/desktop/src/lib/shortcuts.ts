/**
 * Every keyboard shortcut of the app, in one place: the Shortcuts dialog (Help ▸ Keyboard Shortcuts, ?), Settings ▸
 * Keyboard (where the app-wide ones can be rebound), the global key handler (App.tsx), tooltips and the palette's hints
 * all read it. docs/getting-started/keyboard-shortcuts.md lists the same, with the default keys; a unit test keeps the
 * two in step.
 *
 * A key combination is written `Mod+Shift+F`: `Mod` is Ctrl (⌘ on macOS), then Alt, Shift and the key (a letter, a
 * digit, F1…F12, ← → ↑ ↓, Enter, Esc, Space, Delete, or the character itself: `,` `` ` `` `?` `/`).
 */
export type Combo = string;

export interface ShortcutGroup {
  title: string;
  /** `ids`: the commands of the row that can be rebound (one per key combination), for Settings ▸ Keyboard. */
  items: Array<{ keys: string[][]; text: string; ids?: string[] }>;
}

/** A command the global key handler runs: its name (Settings ▸ Keyboard, conflict messages) and default keys. */
export interface ShortcutCommand {
  id: string;
  label: string;
  combo: Combo;
}

/** The app-wide commands, which can be rebound (Settings ▸ Keyboard). */
export const COMMANDS: readonly ShortcutCommand[] = [
  { id: 'quick-open', label: 'Quick Open', combo: 'Mod+P' },
  { id: 'palette', label: 'Command palette', combo: 'Mod+K' },
  { id: 'switch-environment', label: 'Switch environment', combo: 'Mod+Shift+E' },
  { id: 'search', label: 'Search the workspace', combo: 'Mod+Shift+F' },
  { id: 'rerun-last', label: 'Run the last run again', combo: 'Mod+Shift+R' },
  { id: 'reopen-tab', label: 'Reopen the closed tab', combo: 'Mod+Shift+T' },
  { id: 'download-output', label: 'Download the focused output', combo: 'Mod+Shift+S' },
  { id: 'back', label: 'Back', combo: 'Alt+←' },
  { id: 'forward', label: 'Forward', combo: 'Alt+→' },
  { id: 'toggle-explorer', label: 'Show or hide the Collections explorer', combo: 'Mod+B' },
  { id: 'next-problem', label: 'Next problem', combo: 'F8' },
  { id: 'previous-problem', label: 'Previous problem', combo: 'Shift+F8' },
  { id: 'settings', label: 'Settings', combo: 'Mod+,' },
  { id: 'assistant', label: 'AI assistant', combo: 'Mod+J' },
  { id: 'toggle-console', label: 'Show or hide the console', combo: 'Mod+Alt+C' },
  { id: 'terminal', label: 'Show the terminal', combo: 'Mod+`' },
  { id: 'new-terminal', label: 'New terminal', combo: 'Mod+Shift+`' },
  { id: 'shortcuts', label: 'Keyboard shortcuts list', combo: '?' },
];
const COMMAND = new Map(COMMANDS.map((c) => [c.id, c]));

/** A row of the list: rebindable commands (`ids`, one key each) or fixed keys (`fixed`). */
interface Row {
  text: string;
  ids?: string[];
  fixed?: Combo[];
  /** Listed on macOS only (true) or everywhere else only (false). */
  mac?: boolean;
}

function rows(views: string[]): Array<{ title: string; rows: Row[] }> {
  return [
    {
      title: 'Anywhere',
      rows: [
        { ids: ['quick-open'], text: 'Quick Open: go to any item (the latest first); > commands, @ what is on screen, # environments, ? help' },
        { ids: ['palette'], text: 'Command palette (Quick Open at >)' },
        { ids: ['switch-environment'], text: 'Switch environment (Quick Open at #)' },
        { ids: ['search'], text: 'Search the workspace' },
        { ids: ['rerun-last'], text: 'Run the last run again' },
        { ids: ['reopen-tab'], text: 'Reopen the tab closed last' },
        { ids: ['download-output'], text: 'Download the output you are in (a response, a result, a log) in its default format; the command palette has Download output… for the other formats' },
        { ids: ['back', 'forward'], text: 'Back / forward to where you were (also the mouse back and forward buttons)' },
        { ids: ['toggle-explorer'], text: 'Show or hide the Collections explorer' },
        { ids: ['next-problem', 'previous-problem'], text: 'Open the next / previous item of Problems (while a flow is paused in the debugger, F8 continues it)' },
        { ids: ['settings'], text: 'Settings' },
        { ids: ['assistant'], text: 'Ask the AI assistant about what is on screen (again: close it)' },
        { ids: ['toggle-console'], text: 'Show or hide the console' },
        { ids: ['terminal'], text: 'Show the terminal (and focus it)' },
        { ids: ['new-terminal'], text: 'New terminal' },
        {
          fixed: ['Mod+Alt+1…9'],
          text: `Go to a view in the rail's order: ${views
            .slice(0, 9)
            .map((v, i) => `${i + 1} ${v}`)
            .join(', ')}`,
        },
        // the View menu has it on macOS
        { fixed: ['F12'], text: 'Developer Tools', mac: false },
        { fixed: ['Mod+Z'], text: 'Undo a delete while its message shows Undo (outside text fields and editors, which keep their own undo)' },
        { ids: ['shortcuts'], text: 'This list (outside a text field)' },
      ],
    },
    {
      title: 'Requests and tabs',
      rows: [
        { fixed: ['Mod+Enter'], text: 'Send the request (also runs AI prompts and gRPC calls)' },
        { fixed: ['Mod+S'], text: 'Save (a request, a test file, the settings …)' },
        { fixed: ['Mod+T'], text: 'New request tab' },
        { fixed: ['Mod+W'], text: 'Close the tab' },
        { fixed: ['Mod+Shift+W'], text: 'Close all tabs' },
        { fixed: ['Mod+O'], text: 'Import (Postman, Insomnia, Bruno, OpenAPI, cURL …)' },
      ],
    },
    {
      title: 'Collections sidebar',
      rows: [
        { fixed: ['↑', '↓'], text: 'Move between rows' },
        { fixed: ['→', '←'], text: 'Expand or collapse a collection, category or folder' },
        { fixed: ['F2'], text: 'Rename the focused item in place (request, folder, collection, tab, environment, monitor …); Enter saves, Esc cancels' },
        { fixed: ['Delete'], text: 'Delete the focused item: request, folder, collection, server, API definition, dataset, saved item … (Undo in the message)' },
        { fixed: ['Enter'], text: 'Open the focused item' },
        { fixed: ['Shift+F10', 'Menu key'], text: 'Open the focused row’s menu (the same as its ⋯ and its right-click)' },
        { fixed: ['*'], text: 'Expand everything inside the focused collection, folder or section' },
        { fixed: ['a … z'], text: 'Jump to the next row whose name starts with what you type' },
      ],
    },
    {
      title: 'Code editors',
      rows: [
        { fixed: ['{{'], text: 'Suggest variables' },
        { fixed: ['Mod+Space'], text: 'Suggestions (variables, tp.* snippets, JSON Schema fields)' },
        { fixed: ['Mod+F'], text: 'Find' },
        { fixed: ['Mod+H'], text: 'Replace' },
        { fixed: ['Mod+/'], text: 'Comment or uncomment lines' },
        { fixed: ['Mod+Shift+I'], text: 'Insert a snippet (request scripts): type to filter, Enter inserts at the cursor' },
        { fixed: ['Alt+↑', 'Alt+↓'], text: 'Move lines (and environment variables, in the Envs table)' },
      ],
    },
    {
      title: 'Flow designer',
      rows: [
        { fixed: ['Shift+click', 'Shift+drag'], text: 'Add a step to the selection / select with a box' },
        { fixed: ['Mod+A', 'Esc'], text: 'Select everything / nothing' },
        { fixed: ['Delete'], text: 'Remove the selected steps, notes or connection' },
        { fixed: ['Mod+D'], text: 'Duplicate the selected steps' },
        { fixed: ['Mod+C', 'Mod+V'], text: 'Copy steps, to this or another flow' },
        { fixed: ['Mod+Z', 'Mod+Y', 'Mod+Shift+Z'], text: 'Undo / redo any canvas change (redo has two keys)' },
        { fixed: ['Enter'], text: 'Open the selected step in the editor' },
        { fixed: ['Mod+F'], text: 'Find a step (Enter / Shift+Enter: next / previous match)' },
        { fixed: ['Space+drag'], text: 'Pan (as does a plain drag on the empty canvas); the wheel zooms' },
        { fixed: ['F9'], text: 'Add or remove a breakpoint on the selected step' },
        { fixed: ['F8', 'F10'], text: 'While paused: Continue / Step over' },
        { fixed: ['Mod+Enter'], text: 'Save a sticky note you are writing' },
      ],
    },
    {
      title: 'HTTP Debugger',
      rows: [
        { fixed: ['↑', '↓'], text: 'Move through the exchanges' },
        { fixed: ['Enter'], text: 'Open as request: the selected exchange in a request tab' },
        { fixed: ['Mod+click', 'Shift+click'], text: 'Select several exchanges (Save to collection…, Create flow from selection…)' },
        { fixed: ['Delete'], text: 'Delete the selected exchanges' },
        { fixed: ['Mod+F'], text: 'The filter box' },
        { fixed: ['Mod+E'], text: 'Clear the session (it asks first)' },
        { fixed: ['F5', 'F6'], text: 'The Timeline / Structure panel' },
      ],
    },
    {
      title: 'Lists, menus and dialogs',
      rows: [
        { fixed: ['↑', '↓'], text: 'Move through results' },
        { fixed: ['Enter'], text: 'Open or run the selected item; in a dialog’s text field, its main button' },
        { fixed: ['Mod+Enter'], text: 'In a dialog’s multi-line field: its main button' },
        { fixed: ['Esc'], text: 'Close' },
      ],
    },
  ];
}

/** The key combination of every command: the defaults with the person's changes (`''` = turned off). */
export function effectiveBindings(overrides?: Record<string, string>): Record<string, Combo> {
  const out: Record<string, Combo> = {};
  for (const c of COMMANDS) out[c.id] = overrides && Object.hasOwn(overrides, c.id) && typeof overrides[c.id] === 'string' ? normalizeCombo(overrides[c.id]!) : c.combo;
  return out;
}

/** A combination's keys for a platform: `Mod+Shift+F` → ['Ctrl', 'Shift', 'F'] (⌘ ⇧ F on macOS). */
export function comboKeys(combo: Combo, o: { mod: string; alt: string; shift: string }): string[] {
  if (!combo) return [];
  return splitCombo(combo).map((k) => (k === 'Mod' ? o.mod : k === 'Alt' ? o.alt : k === 'Shift' ? o.shift : k));
}

/** `Ctrl+Shift+F` (or ⌘+⇧+F): for tooltips, menus and the palette's hints; '' when turned off. */
export function comboLabel(combo: Combo, o: { mod: string; alt: string; shift: string }): string {
  return comboKeys(combo, o).join('+');
}

/** The groups for a platform: its modifier names, the views shown on the rail (Ctrl+Alt+1…9), the person's bindings. */
export function shortcutGroups(o: { mod: string; alt: string; shift: string; mac: boolean; views: string[]; bindings?: Record<string, string> }): ShortcutGroup[] {
  const b = effectiveBindings(o.bindings);
  return rows(o.views).map((g) => ({
    title: g.title,
    items: g.rows
      .filter((r) => r.mac === undefined || r.mac === o.mac)
      .map((r) => ({
        text: r.text,
        keys: (r.ids ? r.ids.map((id) => b[id] ?? '') : r.fixed!).filter(Boolean).map((c) => comboKeys(c, o)),
        ...(r.ids ? { ids: r.ids } : {}),
      })),
  }));
}

const splitCombo = (c: Combo): string[] => (c.endsWith('++') ? [...c.slice(0, -2).split('+').filter(Boolean), '+'] : c.split('+').filter(Boolean));

/** One spelling per combination: modifiers in the order Mod, Ctrl, Alt, Shift; letters upper case. */
export function normalizeCombo(c: string): Combo {
  const parts = splitCombo(c.trim());
  if (!parts.length) return '';
  const key = parts[parts.length - 1]!;
  const mods = new Set(parts.slice(0, -1).map((m) => ({ cmd: 'Mod', ctrl: 'Ctrl', control: 'Ctrl', mod: 'Mod', alt: 'Alt', option: 'Alt', shift: 'Shift' })[m.toLowerCase()] ?? m));
  return [...['Mod', 'Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), key.length === 1 ? key.toUpperCase() : key].join('+');
}

/** Key codes read by position (so Alt+C on a Mac, which types ç, is still C; a layout's `` ` `` key is the backquote key). */
const CODE_KEYS: Record<string, string> = {
  Backquote: '`',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Esc',
  Space: 'Space',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Tab: 'Tab',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
};
const KEY_NAMES: Record<string, string> = { ...CODE_KEYS, Esc: 'Esc', ' ': 'Space', '+': '+' };
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS']);

/**
 * The combination a key press makes, or undefined for a modifier alone. `mac`: ⌘ is Mod and Ctrl is Ctrl; elsewhere Ctrl
 * (or the Windows key) is Mod. A character typed with Shift (`?`) is that character, without Shift.
 */
export function comboOf(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, mac = false): Combo | undefined {
  if (!e.key || MODIFIER_KEYS.has(e.key)) return undefined;
  const code = e.code ?? '';
  let key: string;
  let shiftInKey = false;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (CODE_KEYS[code]) key = CODE_KEYS[code]!;
  else if (KEY_NAMES[e.key]) key = KEY_NAMES[e.key]!;
  else if (/^F\d{1,2}$/.test(e.key) || e.key.length > 1) key = e.key.startsWith('Arrow') ? (KEY_NAMES[e.key] ?? e.key) : e.key;
  else {
    key = /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : e.key;
    // a character Shift made (?, !, :): the character says it already
    shiftInKey = !/^[A-Z0-9]$/.test(key);
  }
  const mod = mac ? e.metaKey : e.ctrlKey || e.metaKey;
  const parts = [mod && 'Mod', mac && e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && !shiftInKey && 'Shift', key].filter(Boolean) as string[];
  return parts.join('+');
}

/** A combination of keys typed into a field as text (no Mod or Alt, a printable key): it only works outside text fields. */
export const isTextCombo = (c: Combo) => !/^(Mod|Ctrl|Alt)\+/.test(c) && !/(^|\+)(F\d{1,2}|Esc|Enter|Tab|Delete|Insert|Home|End|PageUp|PageDown|[←→↑↓])$/.test(c);

/** The command a combination runs, if any. */
export function commandFor(combo: Combo, bindings: Record<string, Combo>): string | undefined {
  for (const [id, c] of Object.entries(bindings)) if (c && c === combo) return id;
  return undefined;
}

/** Combinations the app or the system keeps for themselves: they can't be given to a command. */
export function reservedCombos(mac: boolean): Map<Combo, string> {
  const out = new Map<Combo, string>();
  for (const g of rows([])) for (const r of g.rows) if (r.fixed && (r.mac === undefined || r.mac === mac)) for (const c of r.fixed) if (!/…|click|drag/.test(c)) out.set(c, `${r.text.replace(/ \(.*$/, '')} (${g.title.toLowerCase()})`);
  for (let i = 1; i <= 9; i++) out.set(`Mod+Alt+${i}`, `Go to view ${i} of the rail`);
  for (const [k, what] of Object.entries({ C: 'Copy', V: 'Paste', X: 'Cut', Z: 'Undo', Y: 'Redo', A: 'Select all', Q: 'Quit' })) out.set(`Mod+${k}`, what);
  out.set('Mod+Shift+Z', 'Redo');
  return out;
}

/**
 * Why `combo` can't run command `id`, or undefined: it is reserved, it is a key alone that typing needs (a letter, a
 * digit, Shift+letter), or another command has it (`conflict`: that command's id, so the page can offer to swap).
 */
export function bindingProblem(id: string, combo: Combo, bindings: Record<string, Combo>, mac: boolean, label: (c: Combo) => string = (c) => c): { message: string; conflict?: string } | undefined {
  if (!combo) return undefined;
  const keys = label(combo);
  if (/^(Shift\+)?[A-Z0-9]$/.test(combo) || /^(Shift\+)?(Space|Backspace|Tab|Enter|Esc|Delete|[←→↑↓])$/.test(combo))
    return { message: `${keys} alone is needed for typing and moving around: add Ctrl, Alt or ⌘` };
  const reserved = reservedCombos(mac).get(combo);
  if (reserved) return { message: `${keys} is ${reserved}: it can't be changed` };
  const other = commandFor(combo, bindings);
  if (other && other !== id) return { message: `${keys} is already “${COMMAND.get(other)?.label ?? other}”`, conflict: other };
  return undefined;
}

/** Key bindings as a file (Settings ▸ Keyboard ▸ Export): only the ones changed from the defaults. */
export function exportBindings(overrides: Record<string, string> | undefined): string {
  const changed = Object.fromEntries(Object.entries(overrides ?? {}).filter(([id, c]) => COMMAND.has(id) && normalizeCombo(c) !== COMMAND.get(id)!.combo));
  return JSON.stringify({ testpionKeybindings: 1, bindings: changed }, null, 2);
}

/**
 * Key bindings read from a file (Import): known commands only, each checked like a binding made on the page; what was
 * refused is listed with why.
 */
export function importBindings(text: string, mac: boolean): { bindings: Record<string, string>; skipped: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The file is not JSON');
  }
  const src = (raw && typeof raw === 'object' && 'bindings' in raw ? (raw as { bindings: unknown }).bindings : raw) as Record<string, unknown> | undefined;
  if (!src || typeof src !== 'object' || Array.isArray(src)) throw new Error('No key bindings in the file: expected { "bindings": { "palette": "Mod+Shift+P" } }');
  const out: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [id, c] of Object.entries(src)) {
    if (!COMMAND.has(id)) skipped.push(`${id}: not a command`);
    else if (typeof c !== 'string') skipped.push(`${id}: not a key combination`);
    else {
      const combo = normalizeCombo(c);
      const problem = bindingProblem(id, combo, effectiveBindings(out), mac);
      if (problem && !problem.conflict) skipped.push(`${id}: ${problem.message}`);
      else if (problem?.conflict && Object.hasOwn(out, problem.conflict)) skipped.push(`${id}: ${problem.message}`);
      else out[id] = combo;
    }
  }
  // a default that an imported binding took is turned off, so no two commands share keys
  const b = effectiveBindings(out);
  for (const c of COMMANDS) if (!Object.hasOwn(out, c.id) && Object.entries(out).some(([id, k]) => id !== c.id && k && k === b[c.id])) out[c.id] = '';
  return { bindings: out, skipped };
}
