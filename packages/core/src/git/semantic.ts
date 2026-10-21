import { readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Collection, CollectionNode, Environment } from '../model/types.js';
import { assertGitRev, gitBlobSize, gitIndexText, gitShow, realFolder, repoRoot, runGit, type GitFile } from './git.js';
import { gitBlobInfos, gitBlobTexts, isBatchable, type GitBlobInfo } from './blob-batch.js';
import { requestParts } from './merge.js';
import { flowChanges, flowItemParts, isFlowFile } from './flow-diff.js';
import { KIND_INFO, LIBRARY_LABEL, gitFolderKey, gitKindOfRef, gitRefKey, gitSectionKey, kindOfPath, kindOfRef, libraryOfPath, savedItemRef, watchKindOfPath, type ItemRef, type KindId } from '@testpion/shared';
import { sameValue } from '../storage/stable-files.js';
import { describeOtherFile, isBinaryPath } from './item-changes.js';
import { mcpServerParts, providerParts, workspaceParts } from './item-parts.js';
import { FOLDER_LIBRARY_KIND, folderLibraryChanges } from './folder-library.js';

/** The registry kind of a workspace path (lexical; git's paths are relative with `/`). */
const kindAt = (path: string) => kindOfPath(path, { raw: true });
/** Whether the path is one item file of a kind (collections/<id>.json, environments/<id>.json). */
const isItemFile = (path: string, kind: KindId) => kindAt(path)?.kind === kind && !!kindAt(path)?.id;
/** The old group of a file that is not read item by item: test files, library files, anything else. */
const fileGroup = (path: string): SemanticChange['kind'] => (kindAt(path)?.kind === 'test' ? 'test' : watchKindOfPath(path, { raw: true }) === 'library' ? 'library' : 'other');

/**
 * Changes said by what they mean (GIT-205): "Payments ▸ Create invoice: URL and 2 headers changed" rather than
 * lines of JSON. Collections are compared request by request (by id), environments variable by variable (values of
 * secret variables are never shown: they are not in the files anyway).
 */
export interface SemanticChange {
  file: string;
  /** The group of the change: the three file kinds read item by item, a library, any other registry kind (`kindId`), else a file. */
  kind: 'collection' | 'environment' | 'test' | 'library' | 'other' | KindId;
  /** The registry kind of the item the change is about (an MCP server, a prompt, a request, a dataset …). */
  kindId?: KindId;
  /** The keys of the marks the change makes on the lists it is inside (its folders, its collection, its section): see gitMarksOf. */
  containers?: string[];
  /** The change is in the index (a commit takes it): the file is staged, or just this item was (see stageItem). */
  staged?: boolean;
  change: 'added' | 'removed' | 'changed' | 'renamed' | 'conflicted';
  /** What changed, in words: "Payments ▸ Create invoice", "environment Staging". */
  title: string;
  /** Which parts: "URL", "2 headers", "body", "scripts" … */
  details: string[];
  /** The collection and item, so the explorer can mark the row. */
  collectionId?: string;
  itemId?: string;
  /** The item's kind (http, graphql, folder …). */
  itemKind?: string;
  /** What to open for it (an ItemRef): the request, folder, collection, environment, saved item, test or flow file, else the file. */
  ref?: ItemRef;
}

/** The ItemRef of a change: the most precise thing it is about. */
export function refOfChange(c: SemanticChange): ItemRef {
  if (c.ref) return c.ref;
  if (c.kind === 'collection' && c.collectionId) {
    if (!c.itemId) return { kind: 'collection', collectionId: c.collectionId };
    if (c.itemKind === 'folder') return { kind: 'folder', collectionId: c.collectionId, folderId: c.itemId };
    return { kind: 'request', collectionId: c.collectionId, requestId: c.itemId, ...(c.itemKind === 'graphql' ? { protocol: 'graphql' as const } : {}) };
  }
  const at = kindAt(c.file);
  if (at?.kind === 'test' && at.id) {
    const path = at.id;
    return isFlowFile(c.file) ? { kind: 'flow', path, ...(c.itemId ? { step: c.itemId } : {}) } : { kind: 'test', path };
  }
  return { kind: 'git-file', path: c.file };
}

/** The kind whose section lists a kind's items: a request, a folder, a gRPC call or a connection is listed in its collection. */
const sectionKindOf = (kind: KindId): KindId => (kind === 'request' || kind === 'folder' || kind === 'grpc-call' || kind === 'ws-connection' ? 'collection' : kind === 'flow' ? 'test' : kind);

/** Every change with its ref, its registry kind and the keys of the marks it makes on the lists it is inside (gitMarksOf). */
function withRefs(changes: SemanticChange[]): SemanticChange[] {
  return changes.map((c) => {
    const ref = c.ref ?? refOfChange(c);
    const kindId: KindId | undefined = c.kindId ?? (ref.kind === 'git-file' ? kindAt(c.file)?.kind : gitKindOfRef(ref)) ?? kindAt(c.file)?.kind;
    if (!kindId) return { ...c, ref };
    const containers = c.containers ?? [];
    // a test file is inside the folders of its path
    if (kindId === 'test' || kindId === 'flow') {
      const dirs = (kindAt(c.file)?.id ?? '').split('/').slice(0, -1);
      dirs.forEach((_, i) => containers.push(gitFolderKey('test', dirs.slice(0, i + 1).join('/'))));
    }
    const section = gitSectionKey(sectionKindOf(kindId));
    // a change to a whole file (nothing inside it is named) is the file's own row, not a container's count
    return { ...c, ref, kindId, containers: [...new Set([...containers, section])] };
  });
}

interface LibraryFile {
  items?: Array<{ id: string; name?: string; folder?: string; collectionId?: string; data?: unknown }>;
}

/** A library file (library/<kind>.json: saved gRPC calls, connections, prompts, monitors …) item by item. */
function libraryChanges(file: string, beforeText: string | undefined, afterText: string | undefined): SemanticChange[] | undefined {
  const kind = libraryOfPath(file, { raw: true });
  if (!kind) return undefined;
  // the folder-only libraries (MCP, API definition and dataset folders) mark the folders of those lists
  if (FOLDER_LIBRARY_KIND[kind]) return folderLibraryChanges(file, kind, beforeText, afterText);
  const before = beforeText === undefined ? { items: [] } : parse<LibraryFile>(beforeText);
  const after = afterText === undefined ? { items: [] } : parse<LibraryFile>(afterText);
  if (!before || !after || !Array.isArray(before.items ?? []) || !Array.isArray(after.items ?? [])) return undefined;
  const what = LIBRARY_LABEL[kind] ?? 'Saved item';
  const kindId = kindOfRef({ kind: 'saved', library: kind })?.id;
  const a = new Map((before.items ?? []).map((i) => [i.id, i]));
  const b = new Map((after.items ?? []).map((i) => [i.id, i]));
  const out: SemanticChange[] = [];
  const title = (i: { name?: string; id: string }) => `${what} ${i.name ?? i.id}`;
  // a folder of the list and, for a call or a connection, the collection it is shown in, show the change too
  const inside = (i: { folder?: string; collectionId?: string }): Pick<SemanticChange, 'containers'> =>
    kindId ? { containers: [...(i.folder ? [gitFolderKey(kindId, i.folder)] : []), ...(i.collectionId ? [gitRefKey({ kind: 'collection', collectionId: i.collectionId })] : [])] } : {};
  const known = kindId ? { kindId } : {};
  for (const [id, i] of b) {
    const was = a.get(id);
    if (!was) out.push({ file, kind: 'library', ...known, change: 'added', title: title(i), details: [], itemId: id, itemKind: kind, ref: savedItemRef(kind, id), ...inside(i) });
    else if (!same(was, i)) {
      const details = [was.name !== i.name ? `renamed from ${was.name}` : '', was.folder !== i.folder ? 'moved' : '', !same(was.data, i.data) ? 'settings' : '', was.collectionId !== i.collectionId ? 'collection' : ''].filter(Boolean);
      out.push({ file, kind: 'library', ...known, change: was.name !== i.name ? 'renamed' : 'changed', title: title(i), details: details.length ? details : ['order'], itemId: id, itemKind: kind, ref: savedItemRef(kind, id), ...inside(i) });
    }
  }
  for (const [id, i] of a) if (!b.has(id)) out.push({ file, kind: 'library', ...known, change: 'removed', title: title(i), details: [], itemId: id, itemKind: kind, ref: savedItemRef(kind, id), ...inside(i) });
  if (out.length) return out;
  // a library of folders only (MCP and API folders): the folders added and removed
  const folders = (f: LibraryFile) => ((f as { folders?: unknown }).folders as string[] | undefined) ?? [];
  const [fa, fb] = [new Set(folders(before)), new Set(folders(after))];
  const added = [...fb].filter((x) => !fa.has(x));
  const removed = [...fa].filter((x) => !fb.has(x));
  const details = [added.length ? `folder ${added.join(', ')} added` : '', removed.length ? `folder ${removed.join(', ')} removed` : ''].filter(Boolean);
  return [{ file, kind: 'library', ...known, change: 'changed', title: kindId ? KIND_INFO[kindId].plural : file, details: details.length ? details : ['order or formatting'] }];
}

type Node = CollectionNode & { name?: string; items?: Node[] };

const parse = <T>(text: string | undefined): T | undefined => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};

/** Every request and folder of a collection by id, with its path of names. */
function index(nodes: Node[] = [], path: string[] = [], out = new Map<string, { node: Node; path: string[]; ids: string[] }>(), ids: string[] = []) {
  for (const n of nodes) {
    out.set(n.id, { node: n, path: [...path, n.name ?? n.id], ids });
    if (n.kind === 'folder') index(n.items as Node[], [...path, n.name ?? n.id], out, [...ids, n.id]);
  }
  return out;
}

const same = sameValue;

/** Which parts of a request changed, in words. */
function requestDetails(a: Node, b: Node): string[] {
  const out: string[] = [];
  const ra = (a as { request?: Record<string, unknown> }).request ?? {};
  const rb = (b as { request?: Record<string, unknown> }).request ?? {};
  if (a.name !== b.name) out.push('name');
  if (!same(ra.method, rb.method)) out.push('method');
  if (!same(ra.url ?? ra.endpoint, rb.url ?? rb.endpoint)) out.push('URL');
  const count = (x: unknown) => (Array.isArray(x) ? x.length : 0);
  if (!same(ra.params, rb.params)) out.push(`params (${count(ra.params)} → ${count(rb.params)})`);
  if (!same(ra.headers, rb.headers)) out.push(`headers (${count(ra.headers)} → ${count(rb.headers)})`);
  if (!same(ra.body, rb.body) || !same(ra.query, rb.query) || !same(ra.variables, rb.variables)) out.push('body');
  if (!same(ra.auth, rb.auth)) out.push('auth');
  if (!same((a as { preRequestScript?: string }).preRequestScript, (b as { preRequestScript?: string }).preRequestScript) || !same((a as { testScript?: string }).testScript, (b as { testScript?: string }).testScript)) out.push('scripts');
  if (!same((a as { assertions?: unknown }).assertions, (b as { assertions?: unknown }).assertions)) out.push('checks');
  if (!same((a as { examples?: unknown }).examples, (b as { examples?: unknown }).examples)) out.push('examples');
  if (!same((a as { favorite?: unknown }).favorite, (b as { favorite?: unknown }).favorite)) out.push('favorite');
  if (!out.length) out.push('settings');
  return out;
}

function collectionChanges(file: string, before: Collection | undefined, after: Collection | undefined): SemanticChange[] {
  const name = after?.name ?? before?.name ?? file;
  const cid = after?.id ?? before?.id;
  if (!before && after) return [{ file, kind: 'collection', change: 'added', title: `collection ${name}`, details: [`${index(after.items as Node[]).size} items`], collectionId: cid }];
  if (before && !after) return [{ file, kind: 'collection', change: 'removed', title: `collection ${name}`, details: [], collectionId: cid }];
  if (!before || !after) return [];
  const out: SemanticChange[] = [];
  const top: string[] = [];
  if (before.name !== after.name) top.push(`renamed from ${before.name}`);
  if (!same(before.variables, after.variables)) top.push('variables');
  if (!same(before.auth, after.auth)) top.push('auth');
  if (!same((before as { preRequestScript?: string }).preRequestScript, (after as { preRequestScript?: string }).preRequestScript) || !same((before as { testScript?: string }).testScript, (after as { testScript?: string }).testScript)) top.push('scripts');
  if (!same(before.description, after.description)) top.push('description');
  if (top.length) out.push({ file, kind: 'collection', change: 'changed', title: `collection ${name}`, details: top, collectionId: cid });
  const a = index(before.items as Node[]);
  const b = index(after.items as Node[]);
  for (const [id, { node, path }] of b) {
    const was = a.get(id);
    const title = [name, ...path].join(' ▸ ');
    if (!was) out.push({ file, kind: 'collection', change: 'added', title, details: [node.kind === 'folder' ? 'folder' : 'request'], collectionId: cid, itemId: id, itemKind: node.kind });
    else if (node.kind !== 'folder' && !same({ ...node }, { ...was.node })) out.push({ file, kind: 'collection', change: 'changed', title, details: requestDetails(was.node, node), collectionId: cid, itemId: id, itemKind: node.kind });
    else if (node.kind === 'folder' && (was.node.name !== node.name || !same(was.path.slice(0, -1), path.slice(0, -1)))) out.push({ file, kind: 'collection', change: was.node.name !== node.name ? 'renamed' : 'changed', title, details: [was.node.name !== node.name ? `was ${was.node.name}` : 'moved'], collectionId: cid, itemId: id, itemKind: node.kind });
    else if (node.kind !== 'folder' && !same(was.path.slice(0, -1), path.slice(0, -1))) out.push({ file, kind: 'collection', change: 'changed', title, details: ['moved'], collectionId: cid, itemId: id, itemKind: node.kind });
  }
  for (const [id, { node, path }] of a) if (!b.has(id)) out.push({ file, kind: 'collection', change: 'removed', title: [name, ...path].join(' ▸ '), details: [node.kind === 'folder' ? 'folder' : 'request'], collectionId: cid, itemId: id, itemKind: node.kind });
  if (!out.length) out.push({ file, kind: 'collection', change: 'changed', title: `collection ${name}`, details: ['order or formatting'], collectionId: cid });
  // a request or folder marks the folders it is in and its collection
  const collectionKey = cid ? gitRefKey({ kind: 'collection', collectionId: cid }) : undefined;
  return out.map((c) => {
    if (!c.itemId || !cid) return c;
    const where = b.get(c.itemId) ?? a.get(c.itemId);
    const folders = (where?.ids ?? []).map((folderId) => gitRefKey({ kind: 'folder', collectionId: cid, folderId }));
    return { ...c, containers: [...folders, ...(collectionKey ? [collectionKey] : [])] };
  });
}

function environmentChanges(file: string, before: Environment | undefined, after: Environment | undefined): SemanticChange[] {
  const name = after?.name ?? before?.name ?? file;
  const envId = after?.id ?? before?.id;
  const ref: ItemRef | undefined = envId ? { kind: 'environment', environmentId: envId } : undefined;
  if (!before || !after) return [{ file, kind: 'environment', change: after ? 'added' : 'removed', title: `environment ${name}`, details: after ? [`${after.variables.length} variables`] : [], ...(ref ? { ref } : {}) }];
  const details: string[] = [];
  const av = new Map(before.variables.map((v) => [v.key, v]));
  const bv = new Map(after.variables.map((v) => [v.key, v]));
  const added = [...bv.keys()].filter((k) => !av.has(k));
  const removed = [...av.keys()].filter((k) => !bv.has(k));
  const changed = [...bv.keys()].filter((k) => av.has(k) && !same(av.get(k), bv.get(k)));
  if (before.name !== after.name) details.push(`renamed from ${before.name}`);
  if (added.length) details.push(`added ${added.join(', ')}`);
  if (removed.length) details.push(`removed ${removed.join(', ')}`);
  if (changed.length) details.push(`changed ${changed.join(', ')}`);
  return [{ file, kind: 'environment', change: 'changed', title: `environment ${name}`, details: details.length ? details : ['settings'], ...(ref ? { ref } : {}) }];
}

/** How a file changed. */
type FileState = SemanticChange['change'];

/** Files bigger than this are named by size (a changed dataset of 50 MB is not read to say what changed). */
const READ_LIMIT = 8 * 1024 * 1024;

/** The meaning of one changed file: the text on each side (undefined: not there, or too big / binary to read). */
export function describeFile(file: string, before: string | undefined, after: string | undefined, state: FileState, from?: string, sizes?: { before?: number; after?: number }): SemanticChange[] {
  if (isItemFile(file, 'collection')) return collectionChanges(file, parse<Collection>(before), parse<Collection>(after));
  if (isItemFile(file, 'environment')) return environmentChanges(file, parse<Environment>(before), parse<Environment>(after));
  if (state !== 'renamed') {
    const meaning = (isFlowFile(file) ? flowChanges(file, before, after) : undefined) ?? libraryChanges(file, before, after) ?? describeOtherFile(file, before, after, state, { sizes });
    if (meaning) return meaning;
  }
  return [{ file, kind: fileGroup(file), change: state, title: file, details: state === 'renamed' && from ? [`was ${from}`] : [] }];
}

/** The text of a file in the working folder; undefined when it is missing, binary or too big (its size is said instead). */
function readWorking(ws: string, path: string): { text?: string; size?: number } {
  try {
    const size = statSync(join(ws, path)).size;
    return isBinaryPath(path) || size > READ_LIMIT ? { size } : { text: readFileSync(join(ws, path), 'utf8'), size };
  } catch {
    return {};
  }
}

/** Whether a file can be big enough to be named by its size (a dataset, an API definition, a database or an image). */
const mayBeBig = (path: string) => isBinaryPath(path) || kindAt(path)?.kind === 'dataset' || kindAt(path)?.kind === 'spec';

/** The text of a file in a commit; undefined when it is not there, binary or too big (then its size). */
async function readRev(ws: string, path: string, rev?: string): Promise<{ text?: string; size?: number }> {
  const size = mayBeBig(path) ? await gitBlobSize(ws, path, rev) : undefined;
  if (isBinaryPath(path) || (size !== undefined && size > READ_LIMIT)) return { size };
  return { text: await gitShow(ws, path, rev), size };
}

/** Lets the event loop run once a stretch of synchronous work has gone on a while (a fresh repository has thousands of files to read). */
function yielder(sliceMs = 15): () => Promise<void> {
  let from = performance.now();
  return async () => {
    if (performance.now() - from < sliceMs) return;
    await new Promise<void>((done) => setImmediate(done));
    from = performance.now();
  };
}

/**
 * The rows of files already described, by workspace and path, valid while the file is the same: same state, same blob in the
 * last commit and in the index, same size and modified time in the working folder. A save then describes one file again, not all.
 */
const described = new Map<string, { sig: string; rows: SemanticChange[] }>();
const DESCRIBED_MAX = 4000;
/** A file modified more recently than this is not remembered: a second write in the same clock tick would look the same. */
const SETTLE_MS = 2000;

/** Rows a caller may change (the marks add containers to them) without touching the remembered ones. */
const copyRows = (rows: SemanticChange[]): SemanticChange[] =>
  rows.map((c) => ({ ...c, details: [...c.details], ...(c.containers ? { containers: [...c.containers] } : {}), ...(c.ref ? { ref: { ...c.ref } as ItemRef } : {}) }));

/**
 * Runs `fn` over the items a few at a time. File reads and stats of thousands of files go through the thread pool this way:
 * the main process is not held for each one (a synchronous read is a block of its own, and antivirus makes it longer).
 */
async function pooled<T>(items: readonly T[], fn: (item: T) => Promise<void>, width = 24): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
}

interface ChangeWork {
  f: GitFile;
  state: FileState;
  /** Size and modified time in the working folder; undefined: not there. */
  stat?: { size: number; mtimeMs: number };
  /** The path whose last-commit version is the "before", and the specs that name it and the index version. */
  wasPath?: string;
  wasSpec?: string;
  idxSpec?: string;
  /** A path git's one-line batch input cannot say (a newline in it): read the slow way. */
  slow?: boolean;
  sig?: string;
  /** The text of the working file, read when the row has to be made again. */
  text?: string;
  rows?: SemanticChange[];
}

/**
 * The meaning of each changed file (working folder against the last commit). However many files changed, git is asked
 * twice (what each "before" blob is, then the texts that are wanted); rows of files that did not change since last time
 * are remembered; and the loops give the event loop a turn now and then, so thousands of new files never freeze the app.
 */
export async function describeGitChanges(ws: string, files: GitFile[]): Promise<SemanticChange[]> {
  const repo = await repoRoot(ws);
  const base = realFolder(ws);
  const inRepo = (p: string) => relative(repo!, resolve(base, p)).split(sep).join('/');
  const tick = yielder();
  const work: ChangeWork[] = [];
  const specs: string[] = [];
  for (const f of files) {
    const state: FileState = f.state === 'untracked' || f.state === 'added' ? 'added' : f.state === 'deleted' ? 'removed' : f.state === 'renamed' ? 'renamed' : f.state === 'conflicted' ? 'conflicted' : 'changed';
    const w: ChangeWork = { f, state };
    work.push(w);
    if (f.state === 'conflicted') {
      w.rows = [{ file: f.path, kind: kindAt(f.path)?.kind === 'collection' ? 'collection' : kindAt(f.path)?.kind === 'environment' ? 'environment' : 'other', change: 'conflicted', title: f.path, details: ['changed on both sides'] }];
      continue;
    }
    if (f.state !== 'untracked' && f.state !== 'added') {
      w.wasPath = f.from ?? f.path;
      if (repo) {
        w.wasSpec = `HEAD:${inRepo(w.wasPath)}`;
        if (f.staged && f.alsoUnstaged) w.idxSpec = `:${inRepo(f.path)}`;
        if (!isBatchable(w.wasSpec) || (w.idxSpec && !isBatchable(w.idxSpec))) w.slow = true;
        else specs.push(w.wasSpec, ...(w.idxSpec ? [w.idxSpec] : []));
      }
    } else if (repo && f.staged && f.alsoUnstaged) {
      // a new file staged and changed again (one of its items staged alone): the index copy tells which items are staged
      w.idxSpec = `:${inRepo(f.path)}`;
      if (!isBatchable(w.idxSpec)) w.slow = true;
      else specs.push(w.idxSpec);
    }
    await tick();
  }
  // size and modified time of every file in the working folder, a few at a time
  await pooled(
    work.filter((w) => !w.rows && w.f.state !== 'deleted'),
    async (w) => {
      try {
        const s = await stat(join(ws, w.f.path));
        w.stat = { size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        /* not in the working folder */
      }
    },
  );
  const infos = repo ? await gitBlobInfos(ws, specs) : new Map<string, GitBlobInfo | undefined>();

  // the texts that the files to describe (again) need
  const wantedText = (path: string, info: GitBlobInfo | undefined) => !!info && info.type === 'blob' && !isBinaryPath(path) && !(mayBeBig(path) && info.size > READ_LIMIT);
  const oids: string[] = [];
  const sizes = new Map<string, number>();
  const toRead: ChangeWork[] = [];
  for (const w of work) {
    if (w.rows) continue;
    const was = w.wasSpec ? infos.get(w.wasSpec) : undefined;
    const idx = w.idxSpec ? infos.get(w.idxSpec) : undefined;
    if (!w.slow) {
      w.sig = [w.state, w.f.from ?? '', w.f.staged ? 1 : 0, w.f.alsoUnstaged ? 1 : 0, was?.oid ?? '-', idx?.oid ?? '-', w.stat ? `${w.stat.mtimeMs}:${w.stat.size}` : 'gone'].join('|');
      const known = described.get(`${base}\0${w.f.path}`);
      if (known?.sig === w.sig) {
        w.rows = copyRows(known.rows);
        continue;
      }
    }
    if (wantedText(w.wasPath ?? '', was)) (oids.push(was!.oid), sizes.set(was!.oid, was!.size));
    const nowReadable = !!w.stat && !isBinaryPath(w.f.path) && w.stat.size <= READ_LIMIT;
    if (nowReadable) toRead.push(w);
    if (nowReadable && wantedText(w.f.path, idx)) (oids.push(idx!.oid), sizes.set(idx!.oid, idx!.size));
  }
  // the blobs through git and the working files through the thread pool, at the same time
  const [texts] = await Promise.all([
    oids.length ? gitBlobTexts(ws, oids, sizes) : new Map<string, string>(),
    pooled(toRead, async (w) => {
      try {
        w.text = await readFile(join(ws, w.f.path), 'utf8');
      } catch {
        /* unreadable: no text, as when the file is not there */
      }
    }),
  ]);

  const out: SemanticChange[] = [];
  for (const w of work) {
    const f = w.f;
    if (!w.rows) {
      const now: { text?: string; size?: number } = f.state === 'deleted' || !w.stat ? {} : isBinaryPath(f.path) || w.stat.size > READ_LIMIT ? { size: w.stat.size } : w.text === undefined ? {} : { text: w.text, size: w.stat.size };
      let was: { text?: string; size?: number } = {};
      let idxText: string | undefined;
      // a new file staged and changed again has no earlier version: its index copy is what tells the staged items apart
      const splitsNew = w.state === 'added' && !w.wasPath;
      if (w.slow) {
        if (w.wasPath) was = await readRev(ws, w.wasPath);
        if (f.staged && f.alsoUnstaged && (was.text !== undefined || splitsNew) && now.text !== undefined) idxText = await gitIndexText(ws, f.path);
      } else if (w.wasSpec || splitsNew) {
        if (w.wasSpec) {
          const info = infos.get(w.wasSpec);
          was = { text: info && wantedText(w.wasPath!, info) ? texts.get(info.oid) : undefined, size: mayBeBig(w.wasPath!) ? info?.size : undefined };
        }
        const idx = w.idxSpec ? infos.get(w.idxSpec) : undefined;
        if (idx) idxText = texts.get(idx.oid);
      }
      const rows = describeFile(f.path, was.text, now.text, w.state, f.from, { before: was.size, after: now.size });
      if (f.staged && f.alsoUnstaged && (was.text !== undefined || splitsNew) && now.text !== undefined) {
        // staged and changed again: the changes the index already has are the staged ones (an item staged alone)
        const ids = (cs: SemanticChange[]) => new Set(cs.map((c) => c.itemId ?? ''));
        const inIndex = idxText === undefined ? new Set<string>() : ids(describeFile(f.path, was.text, idxText, w.state, f.from));
        // an item is staged when the index has its change and the working folder has not moved on from it
        const movedOn = idxText === undefined ? new Set<string>() : ids(describeFile(f.path, idxText, now.text, w.state, f.from));
        for (const c of rows) c.staged = inIndex.has(c.itemId ?? '') && !movedOn.has(c.itemId ?? '');
      } else if (f.staged) for (const c of rows) c.staged = true;
      w.rows = rows;
      if (w.sig && (!w.stat || Date.now() - w.stat.mtimeMs > SETTLE_MS)) {
        if (described.size >= DESCRIBED_MAX) described.delete(described.keys().next().value!);
        described.set(`${base}\0${f.path}`, { sig: w.sig, rows: copyRows(rows) });
      }
      await tick();
    }
    out.push(...w.rows);
  }
  // refs and marks row by row, in pieces (thousands of rows are a block of their own)
  const done: SemanticChange[] = [];
  for (let i = 0; i < out.length; i += 200) {
    done.push(...withRefs(out.slice(i, i + 200)));
    await tick();
  }
  return done;
}

/** Whether a file in a commit or in the working folder is too big to show as text. */
async function tooBig(ws: string, file: string, rev: string): Promise<boolean> {
  if (!(kindAt(file)?.kind === 'dataset' || kindAt(file)?.kind === 'spec')) return false;
  const size = (await gitBlobSize(ws, file, rev)) ?? 0;
  let now = 0;
  try {
    now = statSync(join(ws, file)).size;
  } catch {
    /* not in the working folder */
  }
  return Math.max(size, now) > READ_LIMIT;
}

/**
 * The items of a list file (MCP servers, AI providers, a library) in two versions, by the parts the side-by-side view
 * shows: the item with this id, or every item that differs (each part named "item ▸ part"). Undefined for any other file.
 */
function listedItems(file: string, before: string | undefined, after: string | undefined, itemId?: string): { title: string; before?: Record<string, string>; after?: Record<string, string> } | undefined {
  const at = kindAt(file);
  const library = libraryOfPath(file, { raw: true });
  const key = at?.kind === 'mcp-server' ? 'servers' : at?.kind === 'provider' ? 'providers' : library ? 'items' : undefined;
  if (!key) return undefined;
  const partsOf = at?.kind === 'mcp-server' ? mcpServerParts : at?.kind === 'provider' ? providerParts : requestParts;
  type Rec = Record<string, unknown>;
  const list = (t: string | undefined): Rec[] | undefined => {
    const arr = parse<Rec>(t)?.[key];
    return Array.isArray(arr) ? (arr as Rec[]) : t === undefined ? [] : undefined;
  };
  const [x, y] = [list(before), list(after)];
  if (!x || !y) return undefined;
  const noun = at ? KIND_INFO[at.kind].label : (LIBRARY_LABEL[library!] ?? 'Saved item');
  const nameOf = (i: Rec) => String(i.name ?? i.id);
  const find = (l: Rec[], id: string) => l.find((i) => String(i.id) === id);
  if (itemId) {
    const [b, a] = [find(x, itemId), find(y, itemId)];
    return { title: `${noun} ${nameOf((a ?? b) as Rec)}`, before: b && partsOf(b), after: a && partsOf(a) };
  }
  const ids = [...new Set([...x, ...y].map((i) => String(i.id)))];
  const flat = (l: Rec[]) => {
    const out: Record<string, string> = {};
    for (const id of ids) {
      const [b, a] = [find(x, id), find(y, id)];
      if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
      const item = find(l, id);
      for (const [part, v] of Object.entries(item ? partsOf(item) : {})) out[`${nameOf((a ?? b) as Rec)} ▸ ${part}`] = v;
    }
    return out;
  };
  return { title: file, before: before === undefined ? undefined : flat(x), after: after === undefined ? undefined : flat(y) };
}

/** One item (request or folder) of a collection by id, anywhere in its folders. */
export function findCollectionItem(c: Pick<Collection, 'items'>, id: string): CollectionNode | undefined {
  return index(c.items as Node[]).get(id)?.node;
}

/** The collection with one item replaced (GIT-209: restore a request as it was in a commit); undefined when it is not there. */
export function replaceCollectionItem<C extends Pick<Collection, 'items'>>(c: C, id: string, node: CollectionNode): C | undefined {
  let found = false;
  const walk = (nodes: Node[]): Node[] =>
    nodes.map((n) => {
      if (n.id === id) return (found = true), (node as Node);
      return n.kind === 'folder' ? ({ ...n, items: walk((n.items ?? []) as Node[]) } as Node) : n;
    });
  const items = walk(c.items as Node[]);
  return found ? { ...c, items: items as C['items'] } : undefined;
}

/**
 * The meaning of the changes between two commits (GIT-401 `testpion diff`, the CI pull-request comment): `to`
 * defaults to the working folder when omitted.
 */
export async function describeRevChanges(ws: string, from: string, to?: string): Promise<SemanticChange[]> {
  assertGitRev(from);
  if (to) assertGitRev(to);
  const out = await runGit(ws, ['diff', '--name-status', '-z', '-M', from, ...(to ? [to] : []), '--', '.']);
  const parts = out.split('\0').filter((p) => p !== '');
  const repo = (await runGit(ws, ['rev-parse', '--show-toplevel'])).trim();
  const rel = (p: string) => relative(realFolder(ws), resolve(repo, p)).split(sep).join('/');
  const files: Array<{ path: string; from?: string; status: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i]!;
    if (status.startsWith('R') || status.startsWith('C')) files.push({ status: 'R', from: rel(parts[++i]!), path: rel(parts[++i]!) });
    else files.push({ status: status[0]!, path: rel(parts[++i]!) });
  }
  // However many files changed, git is asked twice: what each blob is (`cat-file --batch-check`), then the texts that are
  // wanted (`cat-file --batch`) - the way describeGitChanges reads them. A path git's one-line input cannot say is read the slow way.
  const base = realFolder(ws);
  const inRepo = (p: string) => relative(repo, resolve(base, p)).split(sep).join('/');
  const specOf = (rev: string, path: string) => `${rev}:${inRepo(path)}`;
  const wasPathOf = (f: { path: string; from?: string }) => f.from ?? f.path;
  const specs: string[] = [];
  for (const f of files) {
    if (f.status !== 'A') specs.push(specOf(from, wasPathOf(f)));
    if (to && f.status !== 'D') specs.push(specOf(to, f.path));
  }
  const infos = await gitBlobInfos(ws, specs);
  const wanted = (path: string, info: GitBlobInfo | undefined) => !!info && info.type === 'blob' && !isBinaryPath(path) && !(mayBeBig(path) && info.size > READ_LIMIT);
  const oids: string[] = [];
  const sizes = new Map<string, number>();
  const want = (path: string, spec: string) => {
    const info = infos.get(spec);
    if (wanted(path, info)) (oids.push(info!.oid), sizes.set(info!.oid, info!.size));
  };
  for (const f of files) {
    if (f.status !== 'A' && isBatchable(specOf(from, wasPathOf(f)))) want(wasPathOf(f), specOf(from, wasPathOf(f)));
    if (to && f.status !== 'D' && isBatchable(specOf(to, f.path))) want(f.path, specOf(to, f.path));
  }
  const texts = oids.length ? await gitBlobTexts(ws, oids, sizes) : new Map<string, string>();
  /** One side of a file in a commit, from the batch (or the slow way for a path the batch cannot say). */
  const side = async (rev: string, path: string): Promise<{ text?: string; size?: number }> => {
    const spec = specOf(rev, path);
    if (!isBatchable(spec)) return readRev(ws, path, rev);
    const info = infos.get(spec);
    return { text: info && wanted(path, info) ? texts.get(info.oid) : undefined, size: mayBeBig(path) ? info?.size : undefined };
  };
  const tick = yielder();
  const result: SemanticChange[] = [];
  for (const f of files) {
    const was = f.status === 'A' ? {} : await side(from, wasPathOf(f));
    const now = f.status === 'D' ? {} : to ? await side(to, f.path) : readWorking(ws, f.path);
    const state: FileState = f.status === 'A' ? 'added' : f.status === 'D' ? 'removed' : f.status === 'R' ? 'renamed' : 'changed';
    result.push(...describeFile(f.path, was.text, now.text, state, f.from, { before: was.size, after: now.size }));
    await tick();
  }
  return withRefs(result);
}

function readOrUndefined(p: string): string | undefined {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** The changes as Markdown (a pull-request description or CI comment). */
export function changesMarkdown(changes: SemanticChange[]): string {
  if (!changes.length) return '_No changes to the TestPion workspace._';
  const mark: Record<string, string> = { added: '➕', removed: '➖', changed: '✏️', renamed: '🔀', conflicted: '⚠️' };
  return changes.map((c) => `- ${mark[c.change] ?? ''} **${c.title}**${c.details.length ? `: ${c.details.join(', ')}` : ''}`).join('\n');
}

/** One part of an item in two versions (GIT-205's side-by-side view). */
export interface PartChange {
  part: string;
  before?: string;
  after?: string;
  differs: boolean;
}

/**
 * One changed item side by side (GIT-205): a request or folder of a collection file (`itemId`), a step of a test or
 * flow file (`itemId` is the step id; without it the file's settings and steps), the collection's own
 * settings (no `itemId`), or an environment (its variables; secret values never appear, they live in the OS store).
 * `rev` is the version to compare with (the last commit by default); the other side is the file in the working folder.
 */
export async function describeItemDiff(ws: string, file: string, itemId?: string, rev = 'HEAD'): Promise<{ title: string; parts: PartChange[] }> {
  const big = isBinaryPath(file) || (await tooBig(ws, file, rev));
  const before = big ? undefined : await gitShow(ws, file, rev);
  let after: string | undefined;
  try {
    after = big ? (statSync(join(ws, file)) && '') : readFileSync(join(ws, file), 'utf8');
  } catch {
    after = undefined;
  }
  if (!big) return diffTexts(file, itemId, before, after);
  // a database, an image or a very big file: its size
  const size = async (r: string) => (await gitBlobSize(ws, file, r)) ?? 0;
  const now = (() => {
    try {
      return statSync(join(ws, file)).size;
    } catch {
      return 0;
    }
  })();
  return { title: file, parts: partRows(before === undefined ? undefined : { Size: `${await size(rev)} bytes` }, after === undefined ? undefined : { Size: `${now} bytes` }) };
}

/** Before / after of two parts lists as rows. */
export function partRows(b: Record<string, string> | undefined, a: Record<string, string> | undefined): PartChange[] {
  return [...new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})])].map((part) => {
    const x = b ? (b[part] ?? '') : undefined;
    const y = a ? (a[part] ?? '') : undefined;
    return { part, before: x, after: y, differs: x !== y };
  });
}

/**
 * Two versions of a file's text compared part by part (what describeItemDiff does with the file read from git and from
 * the working folder; the item history and the restore previews compare any two versions the same way).
 */
export function diffTexts(file: string, itemId: string | undefined, before: string | undefined, after: string | undefined): { title: string; parts: PartChange[] } {
  const at = kindAt(file);
  const rows = partRows;
  if (isItemFile(file, 'collection')) {
    const bc = parse<Collection>(before);
    const ac = parse<Collection>(after);
    if (itemId) {
      const find = (items: Node[] | undefined): Node | undefined => {
        for (const n of items ?? []) {
          if (n.id === itemId) return n;
          const inner = find(n.items as Node[] | undefined);
          if (inner) return inner;
        }
        return undefined;
      };
      const bn = find(bc?.items as Node[] | undefined);
      const an = find(ac?.items as Node[] | undefined);
      const name = String((an ?? bn)?.name ?? itemId);
      return { title: `${ac?.name ?? bc?.name ?? file} ▸ ${name}`, parts: rows(bn && requestParts(bn), an && requestParts(an)) };
    }
    const settings = (c: Collection | undefined) =>
      c && { Name: c.name, Description: c.description ?? '', Auth: c.auth ? JSON.stringify(c.auth, null, 2) : '', Variables: (c.variables ?? []).map((v) => `${v.enabled === false ? '// ' : ''}${v.key}: ${v.value}`).join('\n'), 'Pre-request script': c.preRequestScript ?? '', 'Test script': c.testScript ?? '' };
    return { title: `collection ${ac?.name ?? bc?.name ?? file}`, parts: rows(settings(bc), settings(ac)) };
  }
  if (isItemFile(file, 'environment')) {
    const be = parse<Environment>(before);
    const ae = parse<Environment>(after);
    const vars = (e: Environment | undefined) =>
      e && {
        Name: e.name,
        Production: e.isProduction ? 'yes' : 'no',
        ...Object.fromEntries(e.variables.map((v) => [`{{${v.key}}}`, `${v.enabled === false ? '(off) ' : ''}${v.secret ? '•••• (secret, in the OS store)' : v.value}`])),
      };
    return { title: `environment ${ae?.name ?? be?.name ?? file}`, parts: rows(vars(be), vars(ae)) };
  }
  // a list kept in one file (MCP servers, AI providers) or a library file: one item (itemId), else every changed item
  const listed = listedItems(file, before, after, itemId);
  if (listed) return { title: listed.title, parts: rows(listed.before, listed.after) };
  if (at?.kind === 'workspace') {
    const [bw, aw] = [parse<Record<string, unknown>>(before), parse<Record<string, unknown>>(after)];
    return { title: 'Workspace settings', parts: rows(bw && workspaceParts(bw), aw && workspaceParts(aw)) };
  }
  // a test or flow file: one step part by part (itemId is its id), or the file's own settings and steps
  if (isFlowFile(file)) {
    const b = flowItemParts(file, before, itemId);
    const a = flowItemParts(file, after, itemId);
    if ((b || before === undefined || itemId) && (a || after === undefined || itemId) && (a || b)) return { title: itemId ? `${file} ▸ ${itemId}` : file, parts: rows(b, a) };
  }
  // any other file: the text as one part
  return { title: file, parts: rows(before === undefined ? undefined : { Text: before }, after === undefined ? undefined : { Text: after }) };
}
