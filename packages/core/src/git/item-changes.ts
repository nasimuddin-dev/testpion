import { basename } from 'node:path';
import { KIND_INFO, gitFolderKey, kindOfPath, type ItemRef, type KindId } from '@testpion/shared';
import { diffOpenApi } from '../openapi/diff.js';
import { sameValue } from '../storage/stable-files.js';
import { csvTable } from './csv-rows.js';
import type { SemanticChange } from './semantic.js';

/**
 * What a change means for the kinds that are not a collection, an environment or a library file (planning/git-everything.md
 * §4c): an MCP server or an AI provider by item (a list kept in one file), the workspace settings, the Debugger rules,
 * an API definition (operations added, removed, breaking), a dataset (rows and columns) and the plain documents (a test
 * file, a script package, an MCP mock, a .proto file: lines). Values of secrets are never named, only the keys.
 */

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const same = sameValue;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const parse = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The label of a kind in a title: "MCP server", "AI provider", "API definition". */
const labelOf = (kind: KindId) => KIND_INFO[kind].label;

type Part = Pick<SemanticChange, 'change' | 'title' | 'details' | 'itemId' | 'itemKind' | 'ref' | 'containers'>;
const make = (file: string, kindId: KindId, p: Part): SemanticChange => ({ file, kind: kindId, kindId, ...p });

/** Names of a key/value list (headers) or an object (env): "added A, changed B, removed C"; values are never named. */
function pairChange(label: string, a: unknown, b: unknown): string | undefined {
  const asMap = (x: unknown): Map<string, string> =>
    new Map(Array.isArray(x) ? x.filter(isRec).map((p) => [String(p.key ?? ''), JSON.stringify(p)]) : isRec(x) ? Object.entries(x).map(([k, v]) => [k, JSON.stringify(v)]) : []);
  const [x, y] = [asMap(a), asMap(b)];
  const added = [...y.keys()].filter((k) => !x.has(k));
  const removed = [...x.keys()].filter((k) => !y.has(k));
  const changed = [...y.keys()].filter((k) => x.has(k) && x.get(k) !== y.get(k));
  const parts = [added.length ? `added ${added.join(', ')}` : '', changed.length ? `changed ${changed.join(', ')}` : '', removed.length ? `removed ${removed.join(', ')}` : ''].filter(Boolean);
  if (parts.length) return `${label} (${parts.join('; ')})`;
  // same names, same values, another order
  return same(a, b) ? undefined : `${label} (order)`;
}

/** The fields of a list item that make up one detail, by the kind of list. */
const LIST_FIELDS: Record<'mcp-server' | 'provider', Array<[string, string[]]>> = {
  'mcp-server': [
    ['transport', ['transport']],
    ['command', ['command', 'args', 'cwd']],
    ['URL', ['url']],
    ['mock file', ['mockFile']],
  ],
  provider: [
    ['type', ['kind']],
    ['base URL', ['baseUrl']],
    ['API key reference', ['apiKey']],
    ['model', ['defaultModel']],
    ['embedding model', ['embeddingModel']],
    ['API version', ['apiVersion']],
    ['region', ['region']],
    ['rate limit', ['rateLimit']],
    ['timeout', ['timeoutMs']],
  ],
};
const PAIR_FIELDS: Record<'mcp-server' | 'provider', Array<[string, string]>> = {
  'mcp-server': [
    ['environment', 'env'],
    ['headers', 'headers'],
  ],
  provider: [['headers', 'headers']],
};

function itemDetails(kind: 'mcp-server' | 'provider', a: Rec, b: Rec): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`renamed from ${String(a.name)}`);
  if (a.folder !== b.folder) out.push('moved');
  const known = new Set(['id', 'name', 'folder']);
  for (const [label, keys] of LIST_FIELDS[kind]) {
    keys.forEach((k) => known.add(k));
    if (keys.some((k) => !same(a[k], b[k]))) out.push(label);
  }
  for (const [label, key] of PAIR_FIELDS[kind]) {
    known.add(key);
    const d = pairChange(label, a[key], b[key]);
    if (d) out.push(d);
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!known.has(k) && !same(a[k], b[k])) out.push(k);
  return out;
}

/** An MCP server or an AI provider in a list file, item by item (by id). */
function listChanges(file: string, kind: 'mcp-server' | 'provider', before: string | undefined, after: string | undefined): SemanticChange[] | undefined {
  const key = kind === 'mcp-server' ? 'servers' : 'providers';
  const [x, y] = [parse(before), parse(after)];
  if (x === null || y === null) return undefined;
  const items = (f: unknown): Rec[] | undefined =>
    f === undefined ? [] : isRec(f) && (f[key] === undefined || Array.isArray(f[key])) ? ((f[key] as unknown[] | undefined) ?? []).filter(isRec) : undefined;
  const [a, b] = [items(x), items(y)];
  if (!a || !b) return undefined;
  const ref = (id: string): ItemRef => (kind === 'mcp-server' ? { kind: 'mcp-server', serverId: id } : { kind: 'provider', providerId: id });
  const named = (i: Rec) => `${labelOf(kind)} ${String(i.name ?? i.id)}`;
  // the folder of the list an item is in (and the one it left) shows the change too
  const inside = (...items: Array<Rec | undefined>): Pick<Part, 'containers'> => ({
    containers: [...new Set(items.map((i) => (typeof i?.folder === 'string' && i.folder ? gitFolderKey(kind, i.folder) : '')).filter(Boolean))],
  });
  const was = new Map(a.map((i) => [String(i.id), i]));
  const now = new Map(b.map((i) => [String(i.id), i]));
  const out: SemanticChange[] = [];
  for (const [id, i] of now) {
    const old = was.get(id);
    if (!old) out.push(make(file, kind, { change: 'added', title: named(i), details: [], itemId: id, itemKind: kind, ref: ref(id), ...inside(i) }));
    else if (!same(old, i)) {
      const details = itemDetails(kind, old, i);
      out.push(
        make(file, kind, {
          change: old.name !== i.name ? 'renamed' : 'changed',
          title: named(i),
          details: details.length ? details : ['settings'],
          itemId: id,
          itemKind: kind,
          ref: ref(id),
          ...inside(old, i),
        }),
      );
    }
  }
  for (const [id, i] of was) if (!now.has(id)) out.push(make(file, kind, { change: 'removed', title: named(i), details: [], itemId: id, itemKind: kind, ref: ref(id), ...inside(i) }));
  if (!out.length) out.push(make(file, kind, { change: 'changed', title: `${KIND_INFO[kind].plural}`, details: ['order or formatting'], ref: { kind: 'git-file', path: file } }));
  return out;
}

/** workspace.json: the name, description and variables (names only). */
function workspaceChanges(file: string, before: string | undefined, after: string | undefined): SemanticChange[] | undefined {
  const [a, b] = [parse(before), parse(after)];
  if (a === null || b === null || (a !== undefined && !isRec(a)) || (b !== undefined && !isRec(b))) return undefined;
  const ref: ItemRef = { kind: 'environment', scope: 'workspace' };
  const title = 'Workspace settings';
  if (!a || !b) return [make(file, 'workspace', { change: b ? 'added' : 'removed', title, details: [], ref })];
  const details: string[] = [];
  if (a.name !== b.name) details.push(`renamed from ${String(a.name)}`);
  if (a.description !== b.description) details.push('description');
  const vars = pairChange('variables', a.variables, b.variables);
  if (vars) details.push(vars);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (!['schemaVersion', 'id', 'name', 'description', 'variables', 'createdAt', 'updatedAt'].includes(k) && !same(a[k], b[k])) details.push(k);
  if (!details.length) details.push(a.updatedAt !== b.updatedAt || a.createdAt !== b.createdAt ? 'dates' : 'formatting');
  return [make(file, 'workspace', { change: 'changed', title, details, ref })];
}

/** debugger/rules.json: profiles added, removed or with other rules. */
function rulesChanges(file: string, before: string | undefined, after: string | undefined): SemanticChange[] | undefined {
  const [a, b] = [parse(before), parse(after)];
  if (a === null || b === null || (a !== undefined && !isRec(a)) || (b !== undefined && !isRec(b))) return undefined;
  const title = 'Debugger rules';
  const ref: ItemRef = { kind: 'git-file', path: file };
  if (!a || !b) return [make(file, 'debugger-rules', { change: b ? 'added' : 'removed', title, details: [], ref })];
  const [pa, pb] = [isRec(a.profiles) ? a.profiles : {}, isRec(b.profiles) ? b.profiles : {}];
  const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const details: string[] = [];
  for (const k of Object.keys(pb)) if (!(k in pa)) details.push(`profile ${k} added`);
  for (const k of Object.keys(pa)) if (!(k in pb)) details.push(`profile ${k} removed`);
  for (const k of Object.keys(pb))
    if (k in pa && !same(pa[k], pb[k])) details.push(count(pa[k]) === count(pb[k]) ? `profile ${k}: rules changed` : `profile ${k}: ${plural(count(pa[k]), 'rule')} → ${count(pb[k])}`);
  if (a.active !== b.active) details.push('active profile');
  if (!same(a.filterPresets, b.filterPresets)) details.push('filter presets');
  return [make(file, 'debugger-rules', { change: 'changed', title, details: details.length ? details : ['formatting'], ref })];
}

/** Lines of a text added and removed (as multisets: moving a line is no change). */
export function lineStats(before: string | undefined, after: string | undefined): { added: number; removed: number } {
  const lines = (t: string | undefined) => (t === undefined || t === '' ? [] : t.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n'));
  return multisetDiff(lines(before), lines(after));
}

/** Entries of `after` that `before` lacks, and the other way round (as multisets: moving one is no change). */
export function multisetDiff(before: readonly string[], after: readonly string[]): { added: number; removed: number } {
  const count = new Map<string, number>();
  for (const l of before) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of after) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

const linesDetail = (before: string | undefined, after: string | undefined): string[] => {
  const { added, removed } = lineStats(before, after);
  return [added ? `${plural(added, 'line')} added` : '', removed ? `${plural(removed, 'line')} removed` : ''].filter(Boolean);
};

/** An API definition: operations and breaking changes when it is an OpenAPI / Swagger document, else lines. */
function specChanges(file: string, before: string | undefined, after: string | undefined, state: SemanticChange['change']): SemanticChange[] {
  const title = `${labelOf('spec')} ${basename(file)}`;
  const ref: ItemRef = { kind: 'spec', path: file };
  let details: string[] = [];
  if (before !== undefined && after !== undefined) {
    try {
      const d = diffOpenApi(before, after);
      if (d.operations.added) details.push(plural(d.operations.added, 'operation') + ' added');
      if (d.operations.removed) details.push(plural(d.operations.removed, 'operation') + ' removed');
      if (d.breaking.length) details.push(`${plural(d.breaking.length, 'breaking change')}: ${d.breaking[0]!.message}${d.breaking.length > 1 ? ' …' : ''}`);
      else if (d.nonBreaking.length) details.push(plural(d.nonBreaking.length, 'non-breaking change'));
    } catch {
      /* not an OpenAPI document (AsyncAPI, a fragment): lines say it */
    }
    if (!details.length) details = linesDetail(before, after);
  } else if (after !== undefined) details = [plural(lineStats(undefined, after).added, 'line')];
  return [make(file, 'spec', { change: state, title, details, ref })];
}

/** A dataset: rows and columns of a table, items of a JSON list, or lines; a database or other binary file by its size. */
function datasetChanges(file: string, before: string | undefined, after: string | undefined, state: SemanticChange['change'], sizes?: { before?: number; after?: number }): SemanticChange[] {
  const name = file.replace(/^datasets\//, '');
  const title = `${labelOf('dataset')} ${name}`;
  const ref: ItemRef = { kind: 'dataset', name };
  const done = (details: string[]) => [make(file, 'dataset', { change: state, title, details, ref })];
  if (before === undefined && after === undefined) return done(sizes ? [`${bytes(sizes.before)} → ${bytes(sizes.after)}`] : ['binary file']);
  const table = /\.(csv|tsv)$/i.test(file);
  if (table) {
    const [x, y] = [before === undefined ? undefined : csvTable(before, file), after === undefined ? undefined : csvTable(after, file)];
    if (x === null || y === null) return done(linesDetail(before, after));
    if (!x) return done([plural(y!.rows.length, 'row'), plural(y!.header.length, 'column')]);
    if (!y) return done([plural(x.rows.length, 'row')]);
    const details: string[] = [];
    const addedCols = y.header.filter((c) => !x.header.includes(c));
    const removedCols = x.header.filter((c) => !y.header.includes(c));
    if (addedCols.length) details.push(`column ${addedCols.join(', ')} added`);
    if (removedCols.length) details.push(`column ${removedCols.join(', ')} removed`);
    const { added, removed } = multisetDiff(x.rows, y.rows);
    if (added) details.push(`${plural(added, 'row')} added`);
    if (removed) details.push(`${plural(removed, 'row')} removed`);
    return done(details.length ? details : ['values or order']);
  }
  if (before !== undefined && after !== undefined) return done(linesDetail(before, after));
  return done([plural(lineStats(undefined, before ?? after).added, 'line')]);
}

const bytes = (n: number | undefined) => (n === undefined ? '?' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The documents that are the user's own text: lines added and removed. */
function documentChanges(file: string, kindId: KindId, name: string, before: string | undefined, after: string | undefined, state: SemanticChange['change']): SemanticChange[] {
  const details = before !== undefined && after !== undefined ? linesDetail(before, after) : [];
  const ref: ItemRef | undefined = kindId === 'test' ? { kind: 'test', path: file.replace(/^tests\//, '') } : { kind: 'git-file', path: file };
  return [make(file, kindId, { change: state, title: `${labelOf(kindId)} ${name}`, details, ref })];
}

/** Whether a path is a file whose contents are not read to describe it (a database, an image): named by size only. */
export const isBinaryPath = (file: string): boolean => /\.(sqlite3?|db3?|png|jpe?g|gif|webp|ico|pdf|zip|gz)$/i.test(file);

/**
 * The meaning of a change to one of these files, or undefined when the file is not of these kinds (or cannot be read as
 * its kind: then the caller says "changed"). `before` / `after` are the text on each side (undefined: not there, or a
 * file too big or binary to read).
 */
export function describeOtherFile(
  file: string,
  before: string | undefined,
  after: string | undefined,
  state: SemanticChange['change'],
  opts: { sizes?: { before?: number; after?: number } } = {},
): SemanticChange[] | undefined {
  const at = kindOfPath(file, { raw: true });
  return at ? DESCRIBE[at.kind]?.(file, before, after, state, opts.sizes, at.id) : undefined;
}

/** What describes a change to a file of each kind (a table, not a switch: a kind is added here and in the registry). */
type Describe = (
  file: string,
  before: string | undefined,
  after: string | undefined,
  state: SemanticChange['change'],
  sizes?: { before?: number; after?: number },
  id?: string,
) => SemanticChange[] | undefined;
const doc =
  (kindId: KindId, name: (file: string, id?: string) => string): Describe =>
  (file, before, after, state, _sizes, id) =>
    documentChanges(file, kindId, name(file, id), before, after, state);
const DESCRIBE: Partial<Record<KindId, Describe>> = {
  'mcp-server': (file, before, after) => listChanges(file, 'mcp-server', before, after),
  provider: (file, before, after) => listChanges(file, 'provider', before, after),
  workspace: (file, before, after) => workspaceChanges(file, before, after),
  'debugger-rules': (file, before, after) => rulesChanges(file, before, after),
  spec: (file, before, after, state) => specChanges(file, before, after, state),
  dataset: (file, before, after, state, sizes) => datasetChanges(file, before, after, state, sizes),
  test: doc('test', (file) => file.replace(/^tests\//, '')),
  flow: doc('test', (file) => file.replace(/^tests\//, '')),
  'script-package': doc('script-package', (file, id) => id ?? basename(file)),
  'mcp-mock': doc('mcp-mock', (file) => basename(file).replace(/\.mcp-mock\.yaml$/, '')),
  proto: doc('proto', (file, id) => id ?? basename(file)),
};
