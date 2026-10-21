import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { kindOfPath, libraryOfPath, type ItemRef, type KindId } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { canonicalText, normalizeText, stableText } from '../storage/stable-files.js';

/**
 * Where an item lives in git (planning/git-everything.md §4c, release B): a file, and for the kinds that keep several
 * items in one file the item's id. Every per-item operation (history, restore, discard, stage, blame) works on an
 * address, so one code path serves collections' requests, library items, MCP servers, AI providers, and whole-file
 * kinds (environments, tests, flows, API definitions, datasets …).
 */
export type ItemMode = 'nested' | 'list' | 'whole';

export interface ItemAddress {
  /** Workspace-relative path with `/`. */
  file: string;
  /** The item inside the file (modes `nested` and `list`); undefined: the whole file. */
  itemId?: string;
  mode: ItemMode;
  /** For `list` files: the array that holds the items. */
  listKey?: 'items' | 'servers' | 'providers';
  /** The registry kind of the file. */
  kind?: KindId;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

/** A workspace path as git names it: `/`, no leading `./`. */
export const gitPathOf = (p: string): string => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

/** The address of an item in a file; the item id is dropped for a file that is one item (an environment, a test file …). */
export function addressOf(file: string, itemId?: string): ItemAddress {
  const f = gitPathOf(file);
  const k = kindOfPath(f, { raw: true });
  if (k?.kind === 'collection' && k.id) return itemId ? { file: f, itemId, mode: 'nested', kind: 'collection' } : { file: f, mode: 'whole', kind: 'collection' };
  const listKey = k?.kind === 'mcp-server' ? 'servers' : k?.kind === 'provider' ? 'providers' : libraryOfPath(f, { raw: true }) ? 'items' : undefined;
  if (listKey && itemId) return { file: f, itemId, mode: 'list', listKey, kind: k?.kind };
  return { file: f, mode: 'whole', ...(k ? { kind: k.kind } : {}) };
}

type FileOf = { collectionFile?(id: string): string; environmentFile?(id: string): string };
type R = Record<string, string | undefined>;
const col = (r: R, o: FileOf) => o.collectionFile?.(r.collectionId!) ?? `collections/${r.collectionId}.json`;

/** How each ref kind names its file and item (a table: the registry is the one place that branches on a kind). */
const ADDRESS_OF_REF: Record<string, (r: R, o: FileOf) => ItemAddress | undefined> = {
  request: (r, o) => addressOf(col(r, o), r.requestId),
  folder: (r, o) => addressOf(col(r, o), r.folderId),
  collection: (r, o) => addressOf(col(r, o)),
  environment: (r, o) => (r.environmentId && !r.scope ? addressOf(o.environmentFile?.(r.environmentId) ?? `environments/${r.environmentId}.json`) : r.scope === 'workspace' ? addressOf('workspace.json') : undefined),
  'mcp-server': (r) => addressOf('mcp-servers.json', r.serverId),
  provider: (r) => addressOf('providers.json', r.providerId),
  saved: (r) => addressOf(`library/${r.library}.json`, r.itemId),
  monitor: (r) => addressOf('library/monitors.json', r.monitorId),
  test: (r) => addressOf(`tests/${r.path}`),
  flow: (r) => addressOf(`tests/${r.path}`),
  spec: (r) => addressOf(r.path!.startsWith('specs/') ? r.path! : `specs/${r.path}`),
  dataset: (r) => addressOf(`datasets/${r.name}`),
  'git-file': (r) => addressOf(r.path!),
};

/** The address an ItemRef points at; `collectionFile` finds a collection's file (its id is not always its file name). */
export function addressOfRef(ref: ItemRef, o: FileOf = {}): ItemAddress | undefined {
  return ADDRESS_OF_REF[ref.kind]?.(ref as unknown as R, o);
}

/** Find an item by id in a collection's tree. */
function findNode(nodes: unknown, id: string): Rec | undefined {
  if (!Array.isArray(nodes)) return undefined;
  for (const n of nodes) {
    if (!isRec(n)) continue;
    if (n.id === id) return n;
    const inner = findNode(n.items, id);
    if (inner) return inner;
  }
  return undefined;
}

function replaceNode(nodes: unknown, id: string, value: Rec | undefined): { nodes: unknown[]; found: boolean } {
  let found = false;
  const walk = (list: unknown[]): unknown[] => {
    const out: unknown[] = [];
    for (const n of list) {
      if (isRec(n) && n.id === id) {
        found = true;
        if (value) out.push(value);
        continue;
      }
      out.push(isRec(n) && Array.isArray(n.items) ? { ...n, items: walk(n.items) } : n);
    }
    return out;
  };
  return { nodes: walk(Array.isArray(nodes) ? nodes : []), found };
}

const parseJson = (text: string | undefined): Rec | undefined => {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text.replace(/^﻿/, '')) as unknown;
    return isRec(v) ? v : undefined;
  } catch {
    return undefined;
  }
};

/** The item in a file's text (its JSON value, or for a whole file its text); undefined when it is not there. */
export function readItem(a: ItemAddress, text: string | undefined): unknown {
  if (text === undefined) return undefined;
  if (a.mode === 'whole') return text;
  const doc = parseJson(text);
  if (!doc) return undefined;
  if (a.mode === 'nested') return findNode(doc.items, a.itemId!);
  const list = doc[a.listKey!];
  return Array.isArray(list) ? list.find((i) => isRec(i) && i.id === a.itemId) : undefined;
}

/**
 * The file's text with the item replaced by `value` (or removed when `value` is undefined), in the stable form. An
 * item that is not in the file yet is added at the end of its list (a restored deletion). For a whole file the value is
 * its text (undefined: the file goes). Undefined when the current text cannot be read as the kind needs.
 */
export function writeItem(a: ItemAddress, current: string | undefined, value: unknown): string | undefined {
  if (a.mode === 'whole') return value === undefined ? undefined : String(value);
  const doc = parseJson(current) ?? (current === undefined || current.trim() === '' ? emptyDoc(a) : undefined);
  if (!doc) return undefined;
  if (a.mode === 'nested') {
    const r = replaceNode(doc.items, a.itemId!, value as Rec | undefined);
    if (!r.found && value) r.nodes.push(value);
    doc.items = r.nodes;
  } else {
    const list = Array.isArray(doc[a.listKey!]) ? (doc[a.listKey!] as unknown[]) : [];
    const at = list.findIndex((i) => isRec(i) && i.id === a.itemId);
    if (at >= 0) {
      if (value) list[at] = value;
      else list.splice(at, 1);
    } else if (value) list.push(value);
    doc[a.listKey!] = list;
    // a library keeps the folders its items are in
    if (a.listKey === 'items' && isRec(value) && typeof value.folder === 'string' && value.folder) {
      const folders = Array.isArray(doc.folders) ? (doc.folders as string[]) : [];
      if (!folders.includes(value.folder)) doc.folders = [...folders, value.folder];
    }
  }
  return canonicalText(a.file, JSON.stringify(doc)) ?? stableText(doc);
}

function emptyDoc(a: ItemAddress): Rec {
  if (a.mode === 'nested') return { items: [] };
  return a.listKey === 'items' ? { schemaVersion: '1.0', folders: [], items: [] } : { schemaVersion: '1.0', [a.listKey!]: [] };
}

/** The same content, whatever the line endings (a CRLF working file against an LF blob) or the key order of a JSON file. */
export function sameText(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a === b) return true;
  const [x, y] = [a.replace(/\r\n?/g, '\n'), b.replace(/\r\n?/g, '\n')];
  if (x === y) return true;
  return false;
}

/** The text in the line-ending style of the file it replaces (a CRLF working file stays CRLF, so git sees no whole-file change). */
export function matchEol(current: string | undefined, next: string): string {
  const crlf = current !== undefined && /\r\n/.test(current) && !/(^|[^\r])\n/.test(current);
  const lf = next.replace(/\r\n?/g, '\n');
  return crlf ? lf.replace(/\n/g, '\r\n') : lf;
}

/** Text for a raw document going to a file: LF-normalised only for test files (the stable form), else as given. */
export const rawText = (file: string, text: string): string => (/^tests\//.test(file) && /\.ya?ml$/i.test(file) ? normalizeText(text) : text);

/**
 * The absolute path of a workspace file, refusing anything outside the workspace: `..`, an absolute path, or a folder
 * that is a link to somewhere else. Every write of the git operations goes through it.
 */
export function workspaceFile(ws: string, rel: string): string {
  const p = gitPathOf(rel);
  if (!p || isAbsolute(p) || /^[a-z]:/i.test(p) || p.split('/').some((s) => s === '..')) throw new ApsError('ValidationError', `Not a path inside the workspace: ${rel}`);
  const root = realpathSync.native(ws);
  const abs = resolve(root, p);
  // the nearest folder that exists must be inside the workspace (a linked folder pointing out is refused)
  let d = dirname(abs);
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  const r = relative(root, realpathSync.native(d));
  if (r.startsWith('..') || isAbsolute(r)) throw new ApsError('ValidationError', `${rel} is outside the workspace`);
  if (relative(root, abs).split(sep).some(isGitFolderName)) throw new ApsError('ValidationError', `${rel} is inside .git`);
  return abs;
}

/**
 * Whether a path segment names a git folder on any file system git runs on: `.git` in any case (Windows and macOS
 * ignore it), with trailing dots or spaces (Windows drops them), as the 8.3 short name `GIT~1`, with a stream suffix
 * (`.git::$INDEX_ALLOCATION`) or with invisible characters macOS ignores. Any segment of the path, not just the first
 * (a nested repository's hooks run as well).
 */
export function isGitFolderName(segment: string): boolean {
  const s = segment.replace(/[​-‏‪-‮⁠-⁯﻿]/g, '');
  return /^(\.git|git~\d+)[. ]*(:.*)?$/i.test(s);
}
