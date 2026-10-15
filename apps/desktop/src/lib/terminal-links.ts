import { refOfWorkspacePath, type ItemRef } from '@testpion/shared';

/**
 * File links in the Terminal: a path of the workspace printed by a command (`tests/smoke.yaml:12`, `specs\api.yaml`,
 * an absolute path inside the workspace folder) as the ItemRef that opens it (openRef): a test file in Tests at the
 * line, a dataset, an API definition, a collection's file as the collection, any other file as a file of the Git view.
 * Pure (no DOM), so the matching is unit tested.
 */

/** A path with at least one folder and an extension, then an optional `:line` (and `:column`). */
const PATH = /(?:^|[\s'"`(\[=<])((?:[A-Za-z]:)?(?:\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])+[\w.@+-]*[\w@+-]\.[A-Za-z][A-Za-z0-9]{0,7})(?::(\d{1,7}))?(?::\d{1,7})?/g;

export interface TerminalLink {
  /** Where in the line (0-based) and how long, the `:line` included. */
  start: number;
  length: number;
  text: string;
  ref: ItemRef;
}

/** The workspace item a path names (relative to the workspace folder, or absolute inside it); undefined when it is outside. */
export function refOfTerminalPath(path: string, root?: string, line?: number): ItemRef | undefined {
  let p = path.replace(/\\/g, '/');
  if (/^([A-Za-z]:)?\//.test(p)) {
    const r = root?.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!r) return undefined;
    // Windows paths compare without case
    const inside = (/^[A-Za-z]:/.test(r) ? p.toLowerCase().startsWith(`${r.toLowerCase()}/`) : p.startsWith(`${r}/`)) && p.length > r.length + 1;
    if (!inside) return undefined;
    p = p.slice(r.length + 1);
  }
  p = p.replace(/^(\.\/)+/, '');
  if (!p || p.startsWith('../') || p.split('/').includes('..')) return undefined;
  const at = line && line > 0 ? String(line) : undefined;
  const ref = refOfWorkspacePath(p);
  if (ref?.kind === 'test') return at ? { ...ref, line: at } : ref;
  if (ref) return ref;
  // a collection's file (collections/<id>.json) is the collection
  const col = /^collections\/([^/]+)\.json$/i.exec(p);
  if (col) return { kind: 'collection', collectionId: col[1]! };
  return at ? { kind: 'git-file', path: p, line: at } : { kind: 'git-file', path: p };
}

/** The file links in one line of terminal text. */
export function terminalLinks(line: string, root?: string): TerminalLink[] {
  const out: TerminalLink[] = [];
  for (const m of line.matchAll(PATH)) {
    const text = m[1]!;
    // a URL is the web links' (http://host/a/b.html)
    if (/:\/\/\S*$/.test(line.slice(0, m.index! + m[0].indexOf(text)))) continue;
    const ref = refOfTerminalPath(text, root, m[2] ? Number(m[2]) : undefined);
    if (!ref) continue;
    const start = m.index! + m[0].indexOf(text);
    const tail = m[0].slice(m[0].indexOf(text) + text.length);
    out.push({ start, length: text.length + tail.length, text: text + tail, ref });
  }
  return out;
}
