import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Collection, Environment, Library, McpServerConfig, ProviderConfig, Trace, Workspace } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { ApsError } from '../errors.js';
import { shortId, slugify } from '../util/ids.js';
import { onOwnWrite, writeJsonAsync, atomicWrite, deepFreeze, readJson, readJsonShared, relativeInside, readTextCached, samePath, writeDerived, writeDerivedAsync, writeJson, removeOwned } from './fsutil.js';
import { assertNotNewerOnDisk, looksLikeWorkspace, normalizeCollection, normalizeEnvironment, scanString } from './normalize.js';

export { isWorkspaceDir, looksLikeWorkspace, normalizeCollection, normalizeEnvironment } from './normalize.js';
import { openMetaStore, type MetaStore } from './metastore.js';
import type { Baseline } from '../report/regression.js';
import { moveToTrash } from './trash.js';
import { writeGitFiles } from './git-files.js';
import { collectionFileValue, environmentFileValue, libraryFileValue, mcpServersFileValue, normalizeText, providersFileValue, workspaceFileValue } from './stable-files.js';
import { adoptLooseRequests, describeAdoption, type AdoptedRequests } from './loose-requests.js';
import { exportWorkspaceBundle, type WorkspaceBundle } from './workspace-bundle.js';

export { WORKSPACE_FORMATS } from './workspace-formats.js';
export type { WorkspaceBundle } from './workspace-bundle.js';
export { migrateWorkspace, type Migration } from './workspace-migrate.js';
export { SCRIPT_PACKAGE_NAME } from './script-package-name.js';
import { migrateWorkspace } from './workspace-migrate.js';
import { SCRIPT_PACKAGE_NAME } from './script-package-name.js';

/* ------------------------------------------------------------------ workspace store */

export interface TestFileNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: TestFileNode[];
}

/** The longest path a save can write on Windows (the 260-character limit less the temp-file suffix). */
const MAX_WINDOWS_PATH = 236;
const WINDOWS_PATHS = process.platform === 'win32';

/** At most this many read-only views are kept per workspace (one per collection, the least recently used go first). */
const VIEWS_MAX = 64;
const TEST_FILE_EXT = /\.(ya?ml|json|jsonl|csv|md)$/i;
// folders first, then by name in the user's locale (a Collator gives what localeCompare gives, without building one per comparison)
const nameOrder = new Intl.Collator().compare;
const byDirsThenName = (a: { name: string; isDirectory(): boolean }, b: { name: string; isDirectory(): boolean }) => Number(b.isDirectory()) - Number(a.isDirectory()) || nameOrder(a.name, b.name);

/**
 * On-disk layout (spec §25):
 *   workspace.json  database.sqlite  collections/  environments/  tests/  datasets/
 *   traces/  payloads/  reports/  runs/  baselines/  providers.json  mcp-servers.json
 */
export class WorkspaceStore {
  readonly meta: MetaStore;
  private ws: Workspace;
  /** The time stamp workspace.json holds: it changes when the file is replaced or renamed, not with each edit of its variables. */
  private fileUpdatedAt: string;
  readonly migrationsApplied: string[] = [];
  /** gRPC calls and connections that were in no collection, moved into one when the workspace was opened. */
  adoptedRequests?: AdoptedRequests;

  private constructor(
    readonly root: string,
    ws: Workspace,
  ) {
    this.ws = ws;
    this.fileUpdatedAt = ws.updatedAt;
    for (const d of ['collections', 'environments', 'tests', 'datasets', 'traces', 'payloads', 'reports', 'runs', 'baselines']) mkdirSync(join(root, d), { recursive: true });
    this.meta = openMetaStore(root);
    this.offOwnWrites = onOwnWrite((abs) => this.ownWrote(abs));
  }

  /*
   * Versions of files handed out (etags), so a save over a file that someone else changed since it was read is refused with a ConflictError.
   * A version is the file's size and time. Per file a chain of the versions this app produced after the one it handed out: a stale copy
   * that was only overtaken by this app's own writes (another call of the same window) may still save, one overtaken by anyone else may not.
   */
  private etags = new Map<string, string[]>(); // bounded: 8 versions per file, 500 files
  private offOwnWrites: () => void;
  private static stamp(file: string): string | undefined {
    try {
      const st = statSync(file);
      return `${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {
      return undefined;
    }
  }
  private handOut(file: string): string | undefined {
    const s = WorkspaceStore.stamp(file);
    if (!s) return undefined;
    const k = resolve(file);
    const chain = this.etags.get(k);
    if (!chain || chain[chain.length - 1] !== s) {
      this.etags.delete(k);
      this.etags.set(k, [s]);
      if (this.etags.size > 500) this.etags.delete(this.etags.keys().next().value as string);
    }
    return s;
  }
  private ownWrote(abs: string): void {
    const k = resolve(abs);
    const chain = this.etags.get(k);
    if (!chain) return;
    const s = WorkspaceStore.stamp(k);
    if (s && chain[chain.length - 1] !== s) {
      chain.push(s);
      if (chain.length > 8) chain.shift();
    }
  }
  /** Throws a ConflictError when `expected` (the etag the caller read) is not the file's version and not one only this app has overtaken. */
  private checkEtag(file: string, expected: string | undefined, what: string): void {
    if (!expected) return;
    const cur = WorkspaceStore.stamp(file);
    if (!cur || cur === expected) return;
    const chain = this.etags.get(resolve(file));
    if (chain && chain[chain.length - 1] === cur && chain.includes(expected)) return;
    throw new ApsError('ConflictError', `${what} was changed outside this window since you opened it`, {
      suggestions: ['Keep your version, take the one on disk, or keep both.'],
      details: { code: 'Conflict', file: relative(this.root, file).split(sep).join('/'), what },
    });
  }

  /**
   * Things that went wrong without stopping anything (an unreadable file that is skipped): kept (the last 20) and passed to `onWarn` once
   * someone listens (the backend logs them), so a skipped file is never silent.
   */
  readonly warnings: string[] = [];
  onWarn?: (message: string) => void;
  warn(message: string): void {
    if (this.warnings.includes(message)) return;
    this.warnings.push(message);
    if (this.warnings.length > 20) this.warnings.shift();
    this.onWarn?.(message);
  }

  static create(root: string, name: string): WorkspaceStore {
    if (existsSync(join(root, 'workspace.json'))) throw new ApsError('ConfigurationError', `A workspace already exists at ${root}`);
    mkdirSync(root, { recursive: true });
    const now = new Date().toISOString();
    const ws: Workspace = { schemaVersion: SCHEMA_VERSION, id: shortId('ws-'), name, variables: [], createdAt: now, updatedAt: now };
    writeJson(join(root, 'workspace.json'), workspaceFileValue(ws));
    // ready for git from the start: results and local state ignored, the same line endings everywhere
    writeGitFiles(root);
    const store = new WorkspaceStore(root, ws);
    store.saveEnvironment({ id: 'development', name: 'Development', variables: [{ key: 'baseUrl', value: 'http://localhost:3000', enabled: true }] });
    return store;
  }

  static open(root: string): WorkspaceStore {
    const file = join(root, 'workspace.json');
    if (!existsSync(file)) throw new ApsError('ConfigurationError', `No workspace found at ${root}`, { suggestions: ['Create a workspace first, or pass the correct --workspace path.'] });
    const raw = readJson<Record<string, unknown>>(file);
    // another tool's workspace.json (Nx, Angular, a VS Code workspace …): refuse before migrating or creating anything
    if (!looksLikeWorkspace(raw))
      throw new ApsError('ConfigurationError', `${root} is not a TestPion workspace`, {
        why: 'Its workspace.json belongs to another tool (it has no TestPion id, name or schemaVersion).',
        suggestions: ['Open the folder that holds your TestPion workspace, or create a new workspace in another folder.'],
      });
    const original = structuredClone(raw);
    const { ws, applied } = migrateWorkspace(raw, root);
    if (applied.length) {
      // keep a backup of the pre-migration file
      atomicWrite(`${file}.bak-${original.schemaVersion ?? '0.9'}`, JSON.stringify(original, null, 2));
      writeJson(file, workspaceFileValue(ws));
    }
    const store = new WorkspaceStore(root, ws as unknown as Workspace);
    store.migrationsApplied.push(...applied);
    // every saved request belongs to a collection: older versions saved gRPC calls and connections outside one
    try {
      const adopted = adoptLooseRequests(store);
      if (adopted.moved) {
        store.adoptedRequests = adopted;
        store.migrationsApplied.push(describeAdoption(adopted));
      }
    } catch (e) {
      // an unreadable library file: the workspace still opens; the next open tries again
      store.warn(`Saved requests outside a collection could not be moved into one: ${(e as Error).message}`);
    }
    return store;
  }

  get workspace(): Workspace {
    return this.ws;
  }

  get id(): string {
    return this.ws.id;
  }

  /** workspace.json changed outside the app (git pull, another editor): read it again. */
  reloadWorkspaceFile(): Workspace {
    try {
      this.ws = { ...readJson<Workspace>(join(this.root, 'workspace.json')), id: this.ws.id };
      this.fileUpdatedAt = this.ws.updatedAt;
    } catch {
      /* a broken file mid-write: keep what we had */
    }
    return this.ws;
  }

  updateWorkspace(patch: Partial<Omit<Workspace, 'schemaVersion' | 'id' | 'createdAt'>>): Workspace {
    this.ws = { ...this.ws, ...patch, updatedAt: new Date().toISOString() };
    // the file keeps its time stamp: a change of the workspace variables is not also a change of a date line
    writeJson(join(this.root, 'workspace.json'), workspaceFileValue({ ...this.ws, updatedAt: this.fileUpdatedAt }));
    return this.ws;
  }

  path(...p: string[]): string {
    return join(this.root, ...p);
  }

  /**
   * Guard against path traversal for user-supplied relative paths. An absolute path is fine when it is really inside
   * `base` (a workspace opened through a link, named by the other path: see `relativeInside`); a path that only names
   * the workspace but leads elsewhere through a link inside it is refused, so no name is taken on its spelling alone.
   * The answer is named under `base` as the workspace names it, so paths made relative to the workspace stay right.
   */
  safePath(rel: string, base = this.root): string {
    const root = resolve(base);
    const inside = relativeInside(root, resolve(root, rel), { orSame: true });
    if (inside === undefined) throw new ApsError('ValidationError', `Path escapes the workspace: ${rel}`);
    const full = join(root, inside);
    // Windows stops at 260 characters, and a write adds a temp-file suffix (about 24): refuse early, saying why, instead of an ENAMETOOLONG from the middle of a save
    if (WINDOWS_PATHS && full.length > MAX_WINDOWS_PATH) throw new ApsError('ValidationError', `The path is too long for Windows (${full.length} characters, the limit is ${MAX_WINDOWS_PATH} here): ${rel}`, { suggestions: ['Use shorter folder or file names, or move the workspace closer to the drive root.'] });
    return full;
  }

  /** Whether an absolute path is inside one of the workspace's folders (e.g. `payloads`), named as given or really (`relativeInside`). */
  isInside(file: string, ...folder: string[]): boolean {
    return typeof file === 'string' && relativeInside(resolve(this.root, ...folder), file) !== undefined;
  }

  /* collections */
  listCollections(o: { etag?: boolean } = {}): Array<Collection & { problem?: string }> {
    const dir = this.path('collections');
    const out: Array<Collection & { problem?: string }> = [];
    const seen = new Set<string>();
    const meta = this.readLocalMeta(); // once for the whole list, not once per collection
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      try {
        const c = normalizeCollection(readJson<Collection>(join(dir, f)));
        // two files with the same id (a copied file, an older import): the second gets its file name as id,
        // so each one opens, saves and expands on its own (see collectionFile)
        const base = f.slice(0, -'.json'.length);
        if (!c.id || seen.has(c.id)) c.id = base;
        seen.add(c.id);
        const etag = o.etag ? this.handOut(join(dir, f)) : undefined;
        out.push(etag ? { ...this.withLocalMeta(c, meta), etag } : this.withLocalMeta(c, meta));
      } catch (e) {
        // listed every time, with why, and left where it is: the user fixes it (or saves over it, which keeps a copy)
        const named = scanString(readTextCached(join(dir, f)), 'name');
        out.push({ schemaVersion: SCHEMA_VERSION, id: f.replace(/\.json$/, ''), name: named ?? f, version: 0, variables: [], items: [], updatedAt: '', problem: (e as Error).message });
      }
    }
    return out;
  }

  /**
   * The file of a collection: collections/<id>.json, or else the file that holds this id (a file named
   * otherwise, e.g. by hand or by an older version). Saving then updates that file instead of adding a
   * second one with the same id.
   */
  private collectionFile(id: string): string {
    const named = this.path('collections', `${slugify(id)}.json`);
    if (existsSync(named)) return named;
    const dir = this.path('collections');
    // a cheap scan: only files whose text holds the id are parsed; a broken file is skipped and left untouched
    const quoted = JSON.stringify(id);
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      if (!readTextCached(join(dir, f))?.includes(quoted)) continue;
      try {
        if (readJsonShared<Collection>(join(dir, f)).id === id) return join(dir, f);
      } catch {
        /* unreadable: not this one */
      }
    }
    return named;
  }

  /** The collection's file, relative to the workspace (forward slashes): what git knows it by. */
  collectionFileOf(id: string): string {
    return relative(this.root, this.collectionFile(id)).split(sep).join('/');
  }

  /** The collection as the file holds it; with `etag` it carries the version read, so a later save of it can be refused when someone else changed the file (the app's window uses this). */
  getCollection(id: string, o: { etag?: boolean } = {}): Collection {
    if (typeof id !== 'string' || !id) throw new ApsError('ValidationError', 'A collection id is required');
    const file = this.collectionFile(id);
    const c = normalizeCollection(readJson<Collection>(file));
    const etag = o.etag ? this.handOut(file) : undefined;
    // a de-duplicated id (see listCollections) is the file name: the copy says so too
    const out = this.withLocalMeta(c.id === id ? c : { ...c, id });
    return etag ? { ...out, etag } : out;
  }

  /*
   * Read-only views for readers that only look (the engine context of every send, code snippet and variable hover):
   * parsed once per change of the file and shared, deeply frozen, so a megabyte collection is not parsed again for each.
   * A caller that changes what it reads uses getCollection / getEnvironment, which answer objects of its own.
   */
  // bounded: one entry per collection id (a new version replaces the old one, a save or delete drops it), at most VIEWS_MAX entries, oldest used first
  private views = new Map<string, { from: unknown; sig: string; value: unknown }>();
  private view<T>(key: string, from: unknown, make: () => T, sig = ''): T {
    const hit = this.views.get(key);
    if (hit && hit.from === from && hit.sig === sig) {
      this.views.delete(key); // most recently used last
      this.views.set(key, hit);
      return hit.value as T;
    }
    const value = deepFreeze(make());
    this.views.delete(key);
    this.views.set(key, { from, sig, value });
    while (this.views.size > VIEWS_MAX) this.views.delete(this.views.keys().next().value as string);
    return value;
  }

  /** Number of cached read-only views (for tests and diagnostics). */
  get viewCount(): number {
    return this.views.size;
  }

  /** The collection as getCollection answers it, shared and frozen (see the views above). */
  collectionView(id: string): Collection {
    if (typeof id !== 'string' || !id) throw new ApsError('ValidationError', 'A collection id is required');
    const doc = readJsonShared<Collection>(this.collectionFile(id));
    const meta = this.readLocalMeta().collections[id];
    return this.view(
      `c:${id}`,
      doc,
      () => {
        const c = normalizeCollection(doc);
        return this.withLocalMeta(c.id === id ? c : { ...c, id });
      },
      `${meta?.version ?? ''}:${meta?.updatedAt ?? ''}`,
    );
  }

  /** Every environment as listEnvironments answers it, shared and frozen: the files are read again only when one of them changed. */
  environmentList(): readonly Environment[] {
    const dir = this.path('environments');
    // the files' names, sizes and times: a list of environments read again only when one of them changed
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const sig = files.map((f) => ((s) => `${f}:${s?.size}:${s?.mtimeMs}`)(statSync(join(dir, f), { throwIfNoEntry: false }))).join('|');
    const hit = this.views.get('environments');
    return hit && hit.from === sig ? (hit.value as Environment[]) : (this.views.set('environments', { from: sig, sig: '', value: deepFreeze(this.listEnvironments()) }), this.views.get('environments')!.value as Environment[]);
  }

  /** The environment as getEnvironment answers it, shared and frozen (see the views above). */
  environmentView(idOrName: string): Environment | undefined {
    if (typeof idOrName !== 'string') return undefined;
    return this.environmentList().find((e) => e.id === idOrName || e.name.toLowerCase() === idOrName.toLowerCase());
  }

  /*
   * Git-friendly files: a collection file holds only what people write. How often and when it was saved on this
   * computer (`version`, `updatedAt`) lives in `.local/meta.json`, which git ignores; otherwise every save would
   * change the file and two people editing different requests would always conflict on those lines.
   */
  private localMetaFile(): string {
    return join(this.root, '.local', 'meta.json');
  }
  private readLocalMeta(): LocalMeta {
    try {
      const m = readJson<LocalMeta>(this.localMetaFile());
      return { collections: m.collections ?? {} };
    } catch (e) {
      // a damaged .local/meta.json: counters start from 0 until the next save repairs it (the damaged copy is kept by writeJson)
      if (existsSync(this.localMetaFile())) this.warn(`.local/meta.json could not be read (${(e as Error).message}): save counters start again`);
      return { collections: {} };
    }
  }
  private withLocalMeta(c: Collection, meta = this.readLocalMeta()): Collection {
    const m = meta.collections[c.id];
    return { ...c, version: m?.version ?? c.version ?? 0, updatedAt: m?.updatedAt ?? c.updatedAt ?? '' };
  }

  /* Script packages (tp.require): packages/<name>.js, e.g. packages/@clinic/auth.js for "@clinic/auth". */
  private packagePath(name: string): string {
    if (!SCRIPT_PACKAGE_NAME.test(name)) throw new ApsError('ValidationError', `"${name}" is not a package name`, { suggestions: ['Use a name like utils, or @team/utils (letters, digits, . _ -).'] });
    return this.safePath(`${name}.js`, this.path('packages'));
  }
  listScriptPackages(): Array<{ name: string; size: number }> {
    const dir = this.path('packages');
    if (!existsSync(dir)) return [];
    const out: Array<{ name: string; size: number }> = [];
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isFile() && f.name.endsWith('.js')) out.push({ name: f.name.slice(0, -3), size: statSync(join(dir, f.name)).size });
      else if (f.isDirectory() && f.name.startsWith('@'))
        for (const g of readdirSync(join(dir, f.name))) if (g.endsWith('.js')) out.push({ name: `${f.name}/${g.slice(0, -3)}`, size: statSync(join(dir, f.name, g)).size });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
  private packageText = new Map<string, { mtimeMs: number; size: number; text: string }>();
  readScriptPackage(name: string): string | undefined {
    if (!SCRIPT_PACKAGE_NAME.test(name)) return undefined;
    const p = this.packagePath(name);
    // by size and time: tp.require reads the package on every script run
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st?.isFile()) return undefined;
    const hit = this.packageText.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = readFileSync(p, 'utf8');
    this.packageText.set(p, { mtimeMs: st.mtimeMs, size: st.size, text });
    return text;
  }
  saveScriptPackage(name: string, code: string): void {
    const p = this.packagePath(name);
    mkdirSync(dirname(p), { recursive: true });
    atomicWrite(p, code);
  }
  deleteScriptPackage(name: string): void {
    removeOwned(this.packagePath(name));
  }

  /**
   * Saves the whole collection. With `expectedVersion` (the `version` the caller read) a save over a newer one is refused: the caller held a
   * stale copy (another window, the CLI or an agent saved meanwhile) and would overwrite their work. The error says so (details.code
   * 'Conflict', with the version on disk); without it the save is last-writer-wins as before.
   */
  saveCollection(c: Collection, o: { expectedVersion?: number } = {}): Collection {
    const p = this.planCollectionSave(c, o);
    writeJson(p.file, p.content);
    this.views.delete(`c:${c.id}`);
    mkdirSync(join(this.root, '.local'), { recursive: true });
    writeJson(this.localMetaFile(), p.meta);
    return p.next;
  }

  /** `saveCollection` for the app: the files are written without blocking the thread on a busy file (fsutil atomicWriteAsync). */
  saveCollectionAsync(c: Collection, o: { expectedVersion?: number } = {}): Promise<Collection> {
    return this.serial(async () => {
      const p = this.planCollectionSave(c, o);
      await writeJsonAsync(p.file, p.content);
      this.views.delete(`c:${c.id}`);
      mkdirSync(join(this.root, '.local'), { recursive: true });
      await writeJsonAsync(this.localMetaFile(), p.meta);
      return this.collectionSaved(p);
    });
  }

  /** Asynchronous saves run one after another: each plans its write from what the one before left on disk. */
  private saves: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.saves.then(fn, fn);
    this.saves = run.catch(() => undefined);
    return run;
  }

  private collectionSaved(p: { file: string; next: Collection }): Collection {
    const fresh = WorkspaceStore.stamp(p.file);
    return fresh ? { ...p.next, etag: fresh } : p.next;
  }

  /** The checks of a save and what to write (shared by the synchronous and the asynchronous save). */
  private planCollectionSave(c: Collection, o: { expectedVersion?: number }): { file: string; content: Record<string, unknown>; meta: LocalMeta; next: Collection } {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id) throw new ApsError('ValidationError', 'A collection to save needs an id');
    const meta = this.readLocalMeta();
    const before = meta.collections[c.id];
    if (typeof o.expectedVersion === 'number' && (before?.version ?? 0) > o.expectedVersion)
      throw new ApsError('ConflictError', `"${c.name}" was changed since you opened it (version ${before!.version}, you have ${o.expectedVersion})`, {
        suggestions: ['Read the collection again, apply your change to the new version, and save.'],
        details: { code: 'Conflict', theirs: before!.version, mine: o.expectedVersion },
      });
    const { problem: _problem, etag, ...rest } = c as Collection & { problem?: string };
    void _problem;
    const file = this.collectionFile(c.id);
    this.checkEtag(file, etag, `"${c.name}"`);
    const next: Collection = { ...rest, schemaVersion: SCHEMA_VERSION, version: Math.max(before?.version ?? 0, c.version ?? 0) + 1, updatedAt: new Date().toISOString() };
    assertNotNewerOnDisk(file, `The collection "${c.name}"`);
    meta.collections[c.id] = { version: next.version, updatedAt: next.updatedAt };
    return { file, content: collectionFileContent(next), meta, next };
  }

  /** Moves the collection to the trash (restorable for 30 days; see trash.ts). */
  deleteCollection(id: string): void {
    moveToTrash(this, 'collection', this.collectionFile(id));
    this.views.delete(`c:${id}`);
  }

  /* environments */
  /** The environment's file, relative to the workspace (forward slashes): what git knows it by. */
  environmentFileOf(idOrName: string): string {
    const dir = this.path('environments');
    const slug = `${slugify(idOrName)}.json`;
    if (existsSync(join(dir, slug))) return `environments/${slug}`;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const e = readJsonShared<Environment>(join(dir, f));
        if (e.id === idOrName || e.name === idOrName) return `environments/${f}`;
      } catch {
        /* not an environment */
      }
    }
    throw new ApsError('ValidationError', `No environment "${idOrName}"`);
  }

  /** Every environment; one whose file cannot be read is listed too, with `problem` saying why (and no variables). */
  listEnvironments(o: { etag?: boolean } = {}): Environment[] {
    const dir = this.path('environments');
    const envs = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f): Environment => {
        const base = f.slice(0, -'.json'.length);
        try {
          const e = normalizeEnvironment(readJson<Environment>(join(dir, f)), base);
          const etag = o.etag ? this.handOut(join(dir, f)) : undefined;
          return etag ? { ...e, etag } : e;
        } catch (e) {
          const text = readTextCached(join(dir, f));
          return { id: scanString(text, 'id') ?? base, name: scanString(text, 'name') ?? base, variables: [], problem: (e as Error).message };
        }
      });
    // stable sort: explicit order first, the rest keep file-name order
    return envs.sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
  }

  /** Set the display order of environments. Ids not listed keep their relative order after the listed ones. */
  reorderEnvironments(ids: string[]): Environment[] {
    const envs = this.listEnvironments();
    const rank = (e: Environment) => {
      const i = ids.indexOf(e.id);
      return i >= 0 ? i : ids.length + envs.indexOf(e);
    };
    const sorted = [...envs].sort((a, b) => rank(a) - rank(b));
    sorted.forEach((e, order) => {
      if (e.order !== order && !e.problem) writeJson(this.path('environments', `${slugify(e.id)}.json`), environmentFileValue({ ...e, order }));
    });
    return this.listEnvironments();
  }

  getEnvironment(idOrName: string): Environment | undefined {
    if (typeof idOrName !== 'string') return undefined;
    return this.listEnvironments().find((e) => e.id === idOrName || e.name.toLowerCase() === idOrName.toLowerCase());
  }

  /** Secret variable values must already have been moved to the secret store — they are stripped here. */
  saveEnvironment(env: Environment): Environment {
    const p = this.planEnvironmentSave(env);
    writeJson(p.file, p.content);
    return p.clean;
  }

  /** `saveEnvironment` for the app (see saveCollectionAsync). */
  saveEnvironmentAsync(env: Environment): Promise<Environment> {
    return this.serial(async () => {
      const p = this.planEnvironmentSave(env);
      await writeJsonAsync(p.file, p.content);
      return this.environmentSaved(p);
    });
  }

  private environmentSaved(p: { file: string; clean: Environment }): Environment {
    const fresh = WorkspaceStore.stamp(p.file);
    return fresh ? { ...p.clean, etag: fresh } : p.clean;
  }

  private planEnvironmentSave(env: Environment): { file: string; content: Record<string, unknown>; clean: Environment } {
    if (!env || typeof env !== 'object' || typeof env.id !== 'string' || !env.id) throw new ApsError('ValidationError', 'An environment to save needs an id');
    const { problem: _problem, etag, ...rest } = env;
    void _problem;
    const clean: Environment = { ...rest, name: typeof env.name === 'string' ? env.name : env.id, variables: (Array.isArray(env.variables) ? env.variables : []).map((v) => (v.secret ? { ...v, value: '' } : v)) };
    // the position is owned by reorderEnvironments; a save from a stale editor copy must not move it
    const file = this.path('environments', `${slugify(env.id)}.json`);
    if (existsSync(file)) {
      let order: number | undefined;
      try {
        order = readJson<Environment>(file).order;
      } catch {
        order = env.order; // unreadable file: it is being replaced anyway
      }
      if (order === undefined) delete clean.order;
      else clean.order = order;
    }
    this.checkEtag(file, etag, `The environment "${clean.name}"`);
    assertNotNewerOnDisk(file, `The environment "${clean.name}"`);
    return { file, content: environmentFileValue(clean) as Record<string, unknown>, clean };
  }

  /** Moves the environment to the trash (restorable for 30 days; its secret values stay in the secret store). */
  deleteEnvironment(id: string): void {
    moveToTrash(this, 'environment', this.path('environments', `${slugify(id)}.json`));
  }

  /* providers & MCP servers */
  getProviders(): ProviderConfig[] {
    return readJson<{ providers: ProviderConfig[] }>(this.path('providers.json'), { providers: [] }).providers;
  }

  saveProviders(providers: ProviderConfig[]): void {
    for (const p of providers)
      if (p.apiKey && !/\{\{.+\}\}/.test(p.apiKey))
        throw new ApsError('ValidationError', `Provider "${p.name}" has a literal API key; store it as a secret instead`, {
          suggestions: ['Use {{$secret.provider.<id>.apiKey}} or {{$env.NAME}}.'],
        });
    assertNotNewerOnDisk(this.path('providers.json'), 'providers.json');
    writeJson(this.path('providers.json'), providersFileValue({ schemaVersion: SCHEMA_VERSION, providers }));
  }

  getMcpServers(): McpServerConfig[] {
    return readJson<{ servers: McpServerConfig[] }>(this.path('mcp-servers.json'), { servers: [] }).servers;
  }

  /** A server config ready to connect: a mock's definition file becomes an absolute path in this workspace. */
  resolveMcpServer(cfg: McpServerConfig): McpServerConfig {
    if (cfg.transport !== 'mock') return cfg;
    let file: string;
    try {
      file = this.safePath(cfg.mockFile);
    } catch {
      throw new ApsError('ConfigurationError', `The MCP mock file must be inside the workspace: ${cfg.mockFile}`);
    }
    return { ...cfg, mockFile: file };
  }

  saveMcpServers(servers: McpServerConfig[]): void {
    assertNotNewerOnDisk(this.path('mcp-servers.json'), 'mcp-servers.json');
    writeJson(this.path('mcp-servers.json'), mcpServersFileValue({ schemaVersion: SCHEMA_VERSION, servers }));
  }

  /* saved items with folders (WebSocket connections, AI prompts, MCP server folders …), one file per kind */
  getLibrary<T = unknown>(kind: string, o: { etag?: boolean } = {}): Library<T> {
    const lib = readJson<Partial<Library<T>>>(this.libraryPath(kind), {});
    const etag = o.etag ? this.handOut(this.libraryPath(kind)) : undefined;
    return { schemaVersion: SCHEMA_VERSION, folders: lib.folders ?? [], items: lib.items ?? [], ...(etag ? { etag } : {}) };
  }

  saveLibrary<T = unknown>(kind: string, lib: Pick<Library<T>, 'folders' | 'items'> & { etag?: string }): Library<T> {
    const p = this.planLibrarySave(kind, lib);
    writeJson(p.file, p.content);
    return p.next;
  }

  /** `saveLibrary` for the app (see saveCollectionAsync). */
  saveLibraryAsync<T = unknown>(kind: string, lib: Pick<Library<T>, 'folders' | 'items'> & { etag?: string }): Promise<Library<T>> {
    return this.serial(async () => {
      const p = this.planLibrarySave(kind, lib);
      await writeJsonAsync(p.file, p.content);
      return this.librarySaved(p);
    });
  }

  private librarySaved<T>(p: { file: string; next: Library<T> }): Library<T> {
    const fresh = WorkspaceStore.stamp(p.file);
    return fresh ? { ...p.next, etag: fresh } : p.next;
  }

  private planLibrarySave<T>(kind: string, lib: Pick<Library<T>, 'folders' | 'items'> & { etag?: string }): { file: string; content: Record<string, unknown>; next: Library<T> } {
    const folders = [...new Set([...(lib.folders ?? []), ...lib.items.map((i) => i.folder).filter((f): f is string => !!f)])].sort((a, b) => a.localeCompare(b));
    const next: Library<T> = { schemaVersion: SCHEMA_VERSION, folders, items: lib.items.map((i) => ({ ...i, id: i.id || shortId('lib-'), name: i.name || 'Untitled' })) };
    mkdirSync(this.path('library'), { recursive: true });
    assertNotNewerOnDisk(this.libraryPath(kind), `library/${kind}.json`);
    this.checkEtag(this.libraryPath(kind), lib.etag, `The ${kind} list`);
    return { file: this.libraryPath(kind), content: libraryFileValue(next) as Record<string, unknown>, next };
  }

  private libraryPath(kind: string): string {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(kind)) throw new ApsError('ValidationError', `Invalid library kind "${kind}"`);
    return this.path('library', `${kind}.json`);
  }

  /* tests */
  testTree(dir = this.path('tests')): TestFileNode[] {
    return this.testTreeUnder(dir, relative(this.path('tests'), dir).split(sep).join('/'));
  }

  /** (the path of a node is its parent's plus its name: no `relative()` per file, which cost more than reading a 50,000-file folder) */
  private testTreeUnder(dir: string, relDir: string): TestFileNode[] {
    if (!existsSync(dir)) return [];
    const out: TestFileNode[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true }).sort(byDirsThenName)) {
      if (e.name.startsWith('.')) continue;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) out.push({ name: e.name, path: rel, kind: 'dir', children: this.testTreeUnder(join(dir, e.name), rel) });
      else if (TEST_FILE_EXT.test(e.name)) out.push({ name: e.name, path: rel, kind: 'file' });
    }
    return out;
  }

  readTestFile(rel: string): string {
    return readFileSync(this.safePath(rel, this.path('tests')), 'utf8');
  }

  writeTestFile(rel: string, content: string): void {
    atomicWrite(this.safePath(rel, this.path('tests')), /\.ya?ml$/i.test(rel) ? normalizeText(content) : content);
  }

  deleteTestFile(rel: string): void {
    const base = this.path('tests');
    const target = this.safePath(rel, base);
    // "." or "" names the tests folder itself: a recursive delete of every test and flow, not of a file
    if (relativeInside(base, target) === undefined) throw new ApsError('ValidationError', 'Name a test file or a folder inside tests/, not tests/ itself', { suggestions: ['Delete the files one by one, or a subfolder of tests/.'] });
    removeOwned(target, { recursive: true });
  }

  /**
   * Move a test file, or a folder with everything in it, to another path inside tests/ in one call (the window made two
   * calls per file): written at the new path first, then the old one removed, so a failure in between leaves a copy,
   * never a loss. A folder never goes onto another folder. Returns the old and new path of each file.
   */
  moveTestPath(from: string, to: string): Array<{ from: string; to: string }> {
    const base = this.path('tests');
    const src = this.safePath(from, base);
    const dst = this.safePath(to, base);
    if (samePath(src, dst)) return [];
    const files: string[] = [];
    if (statSync(src).isDirectory()) {
      if (existsSync(dst)) throw new ApsError('ValidationError', `tests/${to} exists already`);
      const walk = (dir: string, rel: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? walk(join(dir, e.name), `${rel}/${e.name}`) : files.push(`${rel}/${e.name}`));
      };
      walk(src, '');
    } else files.push('');
    const moved = files.map((f) => ({ from: `${from}${f}`, to: `${to}${f}` }));
    // a test file through the writer (YAML text normalised); anything else in a folder byte for byte
    for (const m of moved) {
      if (TEST_FILE_EXT.test(m.from)) this.writeTestFile(m.to, this.readTestFile(m.from));
      else atomicWrite(this.safePath(m.to, base), readFileSync(this.safePath(m.from, base)));
    }
    this.deleteTestFile(from);
    return moved;
  }

  /* traces */
  saveTrace(trace: Trace, kind: string, runId?: string): string {
    const day = new Date(trace.startTime).toISOString().slice(0, 10);
    const rel = join('traces', day, `${trace.traceId}.json`);
    // derived data: no fsync / rename (collections, environments and the workspace stay atomic)
    writeDerived(this.path(rel), JSON.stringify(trace));
    this.meta.addTrace({
      id: trace.traceId,
      name: trace.name,
      kind,
      status: trace.status,
      startTime: trace.startTime,
      durationMs: (trace.endTime ?? trace.startTime) - trace.startTime,
      spanCount: trace.spans.length,
      runId,
      path: rel,
    });
    return rel;
  }

  /**
   * Persist many traces without holding the process: the files are written through the thread pool (32 at a time),
   * then the rows go into the database in transactions of 50 with the event loop free in between. A 500-trace batch
   * used to be 500 synchronous writes inside one transaction (about 750 ms in one block).
   */
  async saveTraces(items: ReadonlyArray<{ trace: Trace; kind: string; runId?: string }>): Promise<void> {
    const rows = items.map(({ trace, kind, runId }) => {
      const day = new Date(trace.startTime).toISOString().slice(0, 10);
      const rel = join('traces', day, `${trace.traceId}.json`);
      return { trace, rel, meta: { id: trace.traceId, name: trace.name, kind, status: trace.status, startTime: trace.startTime, durationMs: (trace.endTime ?? trace.startTime) - trace.startTime, spanCount: trace.spans.length, runId, path: rel } };
    });
    const FILES_AT_ONCE = 32;
    const ROWS_PER_TRANSACTION = 50;
    for (let i = 0; i < rows.length; i += FILES_AT_ONCE) {
      const chunk = rows.slice(i, i + FILES_AT_ONCE);
      await Promise.all(chunk.map((r) => writeDerivedAsync(this.path(r.rel), JSON.stringify(r.trace))));
      this.meta.batch(() => {
        for (const r of chunk) this.meta.addTrace(r.meta);
      });
      if ((i + FILES_AT_ONCE) % ROWS_PER_TRANSACTION === 0) await new Promise<void>((r) => setImmediate(r));
    }
  }

  loadTrace(id: string): Trace | undefined {
    const m = this.meta.getTrace(id);
    if (!m) return undefined;
    return readJson<Trace>(this.path(m.path));
  }

  /** `loadTrace` without blocking the process (a search that reads up to 300 trace files). */
  async loadTraceAsync(id: string): Promise<Trace | undefined> {
    const m = this.meta.getTrace(id);
    if (!m) return undefined;
    return JSON.parse(await readFile(this.path(m.path), 'utf8')) as Trace;
  }

  /* baselines */
  listBaselines(): Array<{ name: string; createdAt: string; runId: string; tests: number }> {
    const dir = this.path('baselines');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          const b = readJson<Baseline>(join(dir, f));
          return [{ name: b.name, createdAt: b.createdAt, runId: b.runId, tests: Object.keys(b.tests).length }];
        } catch {
          return [];
        }
      });
  }

  getBaseline(name: string): Baseline {
    return readJson<Baseline>(this.path('baselines', `${slugify(name)}.json`));
  }

  saveBaseline(b: Baseline): void {
    writeJson(this.path('baselines', `${slugify(b.name)}.json`), b);
  }

  /** Ids of the tests that failed or errored in a run ("last": the newest run), for re-running them. */
  failedTestIds(runId: string): { runId: string; ids: string[] } {
    const id = runId === 'last' ? this.meta.listRuns({ limit: 1 }).items[0]?.id : runId;
    if (!id) throw new ApsError('ValidationError', 'There are no runs yet');
    const file = join(this.runDir(id), 'results.jsonl');
    if (!existsSync(file)) throw new ApsError('ValidationError', `No results for run ${id}`);
    const ids = new Set<string>();
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { id?: string; status?: string };
        // collection runs number results per iteration: request@2 (and request@2#3 when it ran again)
        if (r.id && (r.status === 'failed' || r.status === 'error')) ids.add(r.id.replace(/@\d+(#\d+)?$/, ''));
      } catch {
        /* a partial line from an interrupted run */
      }
    }
    return { runId: id, ids: [...ids] };
  }

  runDir(runId: string): string {
    // one folder under runs/: an id from a caller (RPC, MCP tool) can't point anywhere else
    const base = this.path('runs');
    const dir = this.safePath(String(runId), base);
    if (dir === base || dirname(dir) !== base) throw new ApsError('ValidationError', `Not a run id: ${runId}`);
    return dir;
  }

  /** Portable export bundle (workspace-bundle.ts). Secret values are never included. */
  exportBundle(): WorkspaceBundle {
    return exportWorkspaceBundle(this);
  }

  /** Kinds of saved items this workspace has (library/*.json). */
  libraryKinds(): string[] {
    const dir = this.path('library');
    return existsSync(dir) ? readdirSync(dir).filter((f) => /^[a-z][a-z0-9-]{0,40}\.json$/.test(f)).map((f) => f.slice(0, -5)) : [];
  }

  private closed = false;
  /** Close the history database; closing again does nothing. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.offOwnWrites();
    this.meta.close();
  }
}

export { defaultAppDir } from './app-dir.js';

/** Save counters and times of this computer's saves (`.local/meta.json`, not shared). */
interface LocalMeta {
  collections: Record<string, { version: number; updatedAt: string }>;
}

/** What a collection file holds: no `version` / `updatedAt` (they are this computer's, see LocalMeta), keys in the stable order (stable-files.ts). */
export const collectionFileContent = (c: Collection): Record<string, unknown> => collectionFileValue(c) as Record<string, unknown>;
