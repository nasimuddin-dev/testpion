import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { AppSettings, Collection, Environment, Library, McpServerConfig, ProviderConfig, Trace, Workspace } from '../model/types.js';
import { SCHEMA_VERSION, defaultSettings } from '../model/types.js';
import { ApsError } from '../errors.js';
import { shortId, slugify } from '../util/ids.js';
import { atomicWrite, readJson, writeJson } from './fsutil.js';
import { openMetaStore, type MetaStore } from './metastore.js';
import type { Baseline } from '../report/regression.js';
import { moveToTrash } from './trash.js';
import { markTemplateInstalled } from './template-update.js';
import { writeGitFiles } from './git-files.js';

/* ------------------------------------------------------------------ migrations */

export interface Migration {
  from: string;
  to: string;
  description: string;
  migrate(ws: Record<string, unknown>, root: string): Record<string, unknown>;
}

/**
 * Ordered workspace-format migrations. Each step upgrades exactly one version; `migrateWorkspace`
 * chains them. Never silently break existing workspaces: unknown future versions are rejected.
 */
export const MIGRATIONS: Migration[] = [
  {
    from: '0.9',
    to: '1.0',
    description: 'Pre-release format: `variables` was an object map; convert to a key/value list.',
    migrate(ws) {
      const vars = ws.variables;
      if (vars && !Array.isArray(vars) && typeof vars === 'object')
        ws.variables = Object.entries(vars as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value), enabled: true }));
      ws.schemaVersion = '1.0';
      return ws;
    },
  },
];

function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function migrateWorkspace(ws: Record<string, unknown>, root = '', migrations = MIGRATIONS, target = SCHEMA_VERSION): { ws: Record<string, unknown>; applied: string[] } {
  let version = String(ws.schemaVersion ?? '0.9');
  const applied: string[] = [];
  if (cmpVersion(version, target) > 0)
    throw new ApsError('ConfigurationError', `Workspace format ${version} is newer than this version of TestPion supports (${target})`, {
      suggestions: ['Upgrade TestPion to open this workspace.'],
    });
  while (cmpVersion(version, target) < 0) {
    const m = migrations.find((x) => x.from === version);
    if (!m) throw new ApsError('ConfigurationError', `No migration path from workspace format ${version} to ${target}`);
    ws = m.migrate(ws, root);
    applied.push(`${m.from} → ${m.to}`);
    version = m.to;
  }
  return { ws, applied };
}

/* ------------------------------------------------------------------ workspace store */

export interface TestFileNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: TestFileNode[];
}

/**
 * On-disk layout (spec §25):
 *   workspace.json  database.sqlite  collections/  environments/  tests/  datasets/
 *   traces/  payloads/  reports/  runs/  baselines/  providers.json  mcp-servers.json
 */
/** Script package names for pm.require: utils, or @team/utils. */
export const SCRIPT_PACKAGE_NAME = /^(@[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/;

export class WorkspaceStore {
  readonly meta: MetaStore;
  private ws: Workspace;
  readonly migrationsApplied: string[] = [];

  private constructor(
    readonly root: string,
    ws: Workspace,
  ) {
    this.ws = ws;
    for (const d of ['collections', 'environments', 'tests', 'datasets', 'traces', 'payloads', 'reports', 'runs', 'baselines']) mkdirSync(join(root, d), { recursive: true });
    this.meta = openMetaStore(root);
  }

  static create(root: string, name: string): WorkspaceStore {
    if (existsSync(join(root, 'workspace.json'))) throw new ApsError('ConfigurationError', `A workspace already exists at ${root}`);
    mkdirSync(root, { recursive: true });
    const now = new Date().toISOString();
    const ws: Workspace = { schemaVersion: SCHEMA_VERSION, id: shortId('ws-'), name, variables: [], createdAt: now, updatedAt: now };
    writeJson(join(root, 'workspace.json'), ws);
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
    const original = structuredClone(raw);
    const { ws, applied } = migrateWorkspace(raw, root);
    if (applied.length) {
      // keep a backup of the pre-migration file
      atomicWrite(`${file}.bak-${original.schemaVersion ?? '0.9'}`, JSON.stringify(original, null, 2));
      writeJson(file, ws);
    }
    const store = new WorkspaceStore(root, ws as unknown as Workspace);
    store.migrationsApplied.push(...applied);
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
    } catch {
      /* a broken file mid-write: keep what we had */
    }
    return this.ws;
  }

  updateWorkspace(patch: Partial<Omit<Workspace, 'schemaVersion' | 'id' | 'createdAt'>>): Workspace {
    const before = this.ws.updatedAt;
    this.ws = { ...this.ws, ...patch, updatedAt: new Date().toISOString() };
    // the file keeps its time stamp: a change of the workspace variables is not also a change of a date line
    writeJson(join(this.root, 'workspace.json'), { ...this.ws, updatedAt: before });
    return this.ws;
  }

  path(...p: string[]): string {
    return join(this.root, ...p);
  }

  /** Guard against path traversal for user-supplied relative paths. */
  safePath(rel: string, base = this.root): string {
    const root = resolve(base);
    const p = resolve(root, rel);
    if (p !== root && !p.startsWith(root + sep)) throw new ApsError('ValidationError', `Path escapes the workspace: ${rel}`);
    return p;
  }

  /** Whether an absolute path is inside one of the workspace's folders (e.g. `payloads`). */
  isInside(file: string, ...folder: string[]): boolean {
    const base = resolve(this.root, ...folder);
    return typeof file === 'string' && resolve(file).startsWith(base + sep);
  }

  /* collections */
  listCollections(): Array<Collection & { problem?: string }> {
    const dir = this.path('collections');
    const out: Array<Collection & { problem?: string }> = [];
    const seen = new Set<string>();
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      try {
        const c = readJson<Collection>(join(dir, f));
        // two files with the same id (a copied file, an older import): the second gets its file name as id,
        // so each one opens, saves and expands on its own (see collectionFile)
        const base = f.slice(0, -'.json'.length);
        if (!c.id || seen.has(c.id)) c.id = base;
        seen.add(c.id);
        out.push(this.withLocalMeta(c));
      } catch (e) {
        out.push({ schemaVersion: SCHEMA_VERSION, id: f.replace(/\.json$/, ''), name: `${f} (corrupted)`, version: 0, variables: [], items: [], updatedAt: '', problem: (e as Error).message });
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
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      try {
        if (readJson<Collection>(join(dir, f)).id === id) return join(dir, f);
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

  getCollection(id: string): Collection {
    const c = readJson<Collection>(this.collectionFile(id));
    // a de-duplicated id (see listCollections) is the file name: the copy says so too
    return this.withLocalMeta(c.id === id ? c : { ...c, id });
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
    } catch {
      return { collections: {} };
    }
  }
  private withLocalMeta(c: Collection): Collection {
    const m = this.readLocalMeta().collections[c.id];
    return { ...c, version: m?.version ?? c.version ?? 0, updatedAt: m?.updatedAt ?? c.updatedAt ?? '' };
  }

  /* Script packages (pm.require): packages/<name>.js, e.g. packages/@clinic/auth.js for "@clinic/auth". */
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
  readScriptPackage(name: string): string | undefined {
    if (!SCRIPT_PACKAGE_NAME.test(name)) return undefined;
    const p = this.packagePath(name);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  }
  saveScriptPackage(name: string, code: string): void {
    const p = this.packagePath(name);
    mkdirSync(dirname(p), { recursive: true });
    atomicWrite(p, code);
  }
  deleteScriptPackage(name: string): void {
    rmSync(this.packagePath(name), { force: true });
  }

  saveCollection(c: Collection): Collection {
    const meta = this.readLocalMeta();
    const before = meta.collections[c.id];
    const next: Collection = { ...c, schemaVersion: SCHEMA_VERSION, version: Math.max(before?.version ?? 0, c.version ?? 0) + 1, updatedAt: new Date().toISOString() };
    writeJson(this.collectionFile(c.id), collectionFileContent(next));
    meta.collections[c.id] = { version: next.version, updatedAt: next.updatedAt };
    mkdirSync(join(this.root, '.local'), { recursive: true });
    writeJson(this.localMetaFile(), meta);
    return next;
  }

  /** Moves the collection to the trash (restorable for 30 days; see trash.ts). */
  deleteCollection(id: string): void {
    moveToTrash(this, 'collection', this.collectionFile(id));
  }

  /* environments */
  /** The environment's file, relative to the workspace (forward slashes): what git knows it by. */
  environmentFileOf(idOrName: string): string {
    const dir = this.path('environments');
    const slug = `${slugify(idOrName)}.json`;
    if (existsSync(join(dir, slug))) return `environments/${slug}`;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const e = readJson<Environment>(join(dir, f));
        if (e.id === idOrName || e.name === idOrName) return `environments/${f}`;
      } catch {
        /* not an environment */
      }
    }
    throw new ApsError('ValidationError', `No environment "${idOrName}"`);
  }

  listEnvironments(): Environment[] {
    const dir = this.path('environments');
    const envs = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .flatMap((f) => {
        try {
          return [readJson<Environment>(join(dir, f))];
        } catch {
          return [];
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
      if (e.order !== order) writeJson(this.path('environments', `${slugify(e.id)}.json`), { ...e, order });
    });
    return this.listEnvironments();
  }

  getEnvironment(idOrName: string): Environment | undefined {
    return this.listEnvironments().find((e) => e.id === idOrName || e.name.toLowerCase() === idOrName.toLowerCase());
  }

  /** Secret variable values must already have been moved to the secret store — they are stripped here. */
  saveEnvironment(env: Environment): Environment {
    const clean: Environment = { ...env, variables: env.variables.map((v) => (v.secret ? { ...v, value: '' } : v)) };
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
    writeJson(this.path('environments', `${slugify(env.id)}.json`), clean);
    return clean;
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
    writeJson(this.path('providers.json'), { schemaVersion: SCHEMA_VERSION, providers });
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
    writeJson(this.path('mcp-servers.json'), { schemaVersion: SCHEMA_VERSION, servers });
  }

  /* saved items with folders (WebSocket connections, AI prompts, MCP server folders …), one file per kind */
  getLibrary<T = unknown>(kind: string): Library<T> {
    const lib = readJson<Partial<Library<T>>>(this.libraryPath(kind), {});
    return { schemaVersion: SCHEMA_VERSION, folders: lib.folders ?? [], items: lib.items ?? [] };
  }

  saveLibrary<T = unknown>(kind: string, lib: Pick<Library<T>, 'folders' | 'items'>): Library<T> {
    const folders = [...new Set([...(lib.folders ?? []), ...lib.items.map((i) => i.folder).filter((f): f is string => !!f)])].sort((a, b) => a.localeCompare(b));
    const next: Library<T> = { schemaVersion: SCHEMA_VERSION, folders, items: lib.items.map((i) => ({ ...i, id: i.id || shortId('lib-'), name: i.name || 'Untitled' })) };
    mkdirSync(this.path('library'), { recursive: true });
    writeJson(this.libraryPath(kind), next);
    return next;
  }

  private libraryPath(kind: string): string {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(kind)) throw new ApsError('ValidationError', `Invalid library kind "${kind}"`);
    return this.path('library', `${kind}.json`);
  }

  /* tests */
  testTree(dir = this.path('tests')): TestFileNode[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => {
        const p = join(dir, e.name);
        const rel = relative(this.path('tests'), p).split(sep).join('/');
        return e.isDirectory() ? { name: e.name, path: rel, kind: 'dir' as const, children: this.testTree(p) } : { name: e.name, path: rel, kind: 'file' as const };
      })
      .filter((n) => n.kind === 'dir' || /\.(ya?ml|json|jsonl|csv|md)$/i.test(n.name));
  }

  readTestFile(rel: string): string {
    return readFileSync(this.safePath(rel, this.path('tests')), 'utf8');
  }

  writeTestFile(rel: string, content: string): void {
    atomicWrite(this.safePath(rel, this.path('tests')), content);
  }

  deleteTestFile(rel: string): void {
    rmSync(this.safePath(rel, this.path('tests')), { force: true, recursive: true });
  }

  /* traces */
  saveTrace(trace: Trace, kind: string, runId?: string): string {
    const day = new Date(trace.startTime).toISOString().slice(0, 10);
    const rel = join('traces', day, `${trace.traceId}.json`);
    atomicWrite(this.path(rel), JSON.stringify(trace));
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

  loadTrace(id: string): Trace | undefined {
    const m = this.meta.getTrace(id);
    if (!m) return undefined;
    return readJson<Trace>(this.path(m.path));
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

  /** Portable export bundle. Secret values are never included. */
  exportBundle(): WorkspaceBundle {
    const tests: Record<string, string> = {};
    const walk = (nodes: TestFileNode[]) => {
      for (const n of nodes) {
        if (n.kind === 'dir') walk(n.children ?? []);
        else {
          const p = this.path('tests', n.path);
          if (statSync(p).size < 5 * 1024 * 1024) tests[n.path] = readFileSync(p, 'utf8');
        }
      }
    };
    walk(this.testTree());
    return {
      format: 'testpion-workspace',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      workspace: { ...this.ws, variables: this.ws.variables.map((v) => ((v as { secret?: boolean }).secret ? { ...v, value: '' } : v)) },
      collections: this.listCollections().filter((c) => !c.problem),
      environments: this.listEnvironments().map((e) => ({ ...e, variables: e.variables.map((v) => (v.secret ? { ...v, value: '' } : v)) })),
      providers: this.getProviders(),
      mcpServers: this.getMcpServers(),
      tests,
      library: this.libraryKinds().reduce<Record<string, Library>>((all, kind) => ({ ...all, [kind]: this.getLibrary(kind) }), {}),
      packages: Object.fromEntries(this.listScriptPackages().map((p) => [p.name, this.readScriptPackage(p.name) ?? ''])),
    };
  }

  /** Kinds of saved items this workspace has (library/*.json). */
  libraryKinds(): string[] {
    const dir = this.path('library');
    return existsSync(dir) ? readdirSync(dir).filter((f) => /^[a-z][a-z0-9-]{0,40}\.json$/.test(f)).map((f) => f.slice(0, -5)) : [];
  }

  close(): void {
    this.meta.close();
  }
}

export interface WorkspaceBundle {
  /** "fluxpion-workspace" / "protopion-workspace" / "protolens-workspace" in exports from before the TestPion name (still imported). */
  format: 'testpion-workspace' | 'fluxpion-workspace' | 'protopion-workspace' | 'protolens-workspace';
  schemaVersion: string;
  exportedAt: string;
  workspace: Workspace;
  collections: Collection[];
  environments: Environment[];
  providers: ProviderConfig[];
  mcpServers: McpServerConfig[];
  tests: Record<string, string>;
  /** Saved items with folders by kind (WebSocket connections, AI prompts …); absent in older exports. */
  library?: Record<string, Pick<Library, 'folders' | 'items'>>;
  /** Script packages for pm.require, by name; absent in older exports. */
  packages?: Record<string, string>;
}

/* ------------------------------------------------------------------ app-level manager */

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  updatedAt: string;
}

/** Workspace export formats this version imports (the project's earlier names included). */
export const WORKSPACE_FORMATS = new Set(['testpion-workspace', 'fluxpion-workspace', 'protopion-workspace', 'protolens-workspace']);

export function defaultAppDir(): string {
  // earlier names of the variable: FLUXPION_HOME (0.5), PROTOPION_HOME (0.4), PROTOLENS_HOME (0.2–0.3), APS_HOME (0.1)
  const explicit = process.env.TESTPION_HOME || process.env.FLUXPION_HOME || process.env.PROTOPION_HOME || process.env.PROTOLENS_HOME || process.env.APS_HOME;
  if (explicit) return explicit;
  const dir = join(homedir(), '.testpion');
  // one-time move of the data folder of earlier versions: ".fluxpion" (0.5), ".protopion" (0.4), ".protolens" (0.2–0.3), ".aipstudio" (0.1)
  for (const legacy of [join(homedir(), '.fluxpion'), join(homedir(), '.protopion'), join(homedir(), '.protolens'), join(homedir(), '.aipstudio')]) {
    if (existsSync(dir) || !existsSync(legacy)) continue;
    try {
      renameSync(legacy, dir);
    } catch {
      return legacy; // in use or not permitted: keep using it rather than losing data
    }
  }
  return dir;
}

/** Manages the list of workspaces and global settings under the app directory. */
export class WorkspaceManager {
  constructor(readonly appDir = defaultAppDir()) {
    mkdirSync(join(appDir, 'workspaces'), { recursive: true });
  }

  get settingsPath(): string {
    return join(this.appDir, 'settings.json');
  }

  /** Problem found while loading settings (e.g. a corrupted file that was backed up and reset). */
  settingsProblem?: string;

  loadSettings(): AppSettings {
    let s: Partial<AppSettings> = {};
    try {
      s = readJson<Partial<AppSettings>>(this.settingsPath, {});
    } catch (e) {
      // readJson preserved the corrupted file as settings.json.corrupt-<ts>; start from defaults
      this.settingsProblem = (e as Error).message;
    }
    // revision 2 (redesigned UI): the default font size went from 13 to 14px — move people still on the old default
    if ((s.settingsRevision ?? 1) < 2 && s.fontSize === 13) s.fontSize = 14;
    // forget workspaces that lived in the system temp folder and are gone (test runs used to add them);
    // other missing paths stay listed, e.g. a workspace on a drive that isn't connected right now
    if (Array.isArray(s.workspacePaths)) {
      const tmp = tmpdir().toLowerCase();
      s.workspacePaths = s.workspacePaths.filter((p) => !(typeof p === 'string' && p.toLowerCase().startsWith(tmp) && !existsSync(p)));
    }
    return { ...defaultSettings(), ...s, settingsRevision: 2 };
  }

  saveSettings(s: AppSettings): AppSettings {
    writeJson(this.settingsPath, s);
    return s;
  }

  list(): WorkspaceInfo[] {
    const dirs = readdirSync(join(this.appDir, 'workspaces'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(this.appDir, 'workspaces', d.name));
    const extra = this.loadSettings().workspacePaths ?? [];
    const out: WorkspaceInfo[] = [];
    for (const p of [...dirs, ...extra]) {
      try {
        const w = readJson<Workspace>(join(p, 'workspace.json'));
        out.push({ id: w.id, name: w.name, path: p, updatedAt: w.updatedAt });
      } catch {
        /* skip invalid */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Resolve a workspace by id, name, slug or filesystem path. */
  resolve(ref: string): string | undefined {
    if (existsSync(join(ref, 'workspace.json'))) return resolve(ref);
    const r = ref.toLowerCase();
    return this.list().find((w) => w.id === ref || w.name.toLowerCase() === r || basename(w.path) === slugify(ref))?.path;
  }

  create(name: string, path?: string): WorkspaceStore {
    let root = path ?? join(this.appDir, 'workspaces', slugify(name));
    if (!path) {
      let i = 2;
      while (existsSync(root)) root = join(this.appDir, 'workspaces', `${slugify(name)}-${i++}`);
    }
    const s = WorkspaceStore.create(root, name);
    if (path) {
      const settings = this.loadSettings();
      if (!settings.workspacePaths.includes(root)) this.saveSettings({ ...settings, workspacePaths: [...settings.workspacePaths, root] });
    }
    return s;
  }

  open(ref: string): WorkspaceStore {
    const p = this.resolve(ref);
    if (!p) throw new ApsError('ConfigurationError', `Workspace "${ref}" not found`, { suggestions: [`Known workspaces: ${this.list().map((w) => w.name).join(', ') || 'none'}`] });
    return WorkspaceStore.open(p);
  }

  duplicate(ref: string, newName: string): WorkspaceInfo {
    const src = this.resolve(ref);
    if (!src) throw new ApsError('ConfigurationError', `Workspace "${ref}" not found`);
    let dest = join(this.appDir, 'workspaces', slugify(newName));
    let i = 2;
    while (existsSync(dest)) dest = join(this.appDir, 'workspaces', `${slugify(newName)}-${i++}`);
    cpSync(src, dest, {
      recursive: true,
      // copy definitions, not execution artefacts
      filter: (s) => {
        const top = relative(src, s).split(/[\\/]/)[0] ?? '';
        return !['runs', 'traces', 'payloads', 'reports', 'trash'].includes(top) && !/^(database\.sqlite.*|metadata\.jsonl)$/.test(basename(s));
      },
    });
    const w = readJson<Workspace>(join(dest, 'workspace.json'));
    const next = { ...w, id: shortId('ws-'), name: newName, updatedAt: new Date().toISOString() };
    writeJson(join(dest, 'workspace.json'), next);
    return { id: next.id, name: newName, path: dest, updatedAt: next.updatedAt };
  }

  /**
   * Copy a bundled workspace (such as the examples that ship with the app) into the data folder, once:
   * if a workspace with the same id is already there, that one is returned untouched, so the user's
   * edits survive app updates. Execution artefacts are never copied.
   */
  installTemplate(templateDir: string): WorkspaceInfo {
    const w = readJson<Workspace>(join(templateDir, 'workspace.json'));
    const existing = this.list().find((x) => x.id === w.id);
    if (existing) return existing;
    let dest = join(this.appDir, 'workspaces', slugify(w.name));
    let i = 2;
    while (existsSync(dest)) dest = join(this.appDir, 'workspaces', `${slugify(w.name)}-${i++}`);
    cpSync(templateDir, dest, {
      recursive: true,
      filter: (s) => {
        const top = relative(templateDir, s).split(/[\\/]/)[0] ?? '';
        return !['runs', 'traces', 'payloads', 'reports', 'baselines', 'trash', '.local'].includes(top) && !/^(database\.sqlite.*|metadata\.jsonl)$/.test(basename(s));
      },
    });
    // everything in the template was offered: later versions add only what is new (addTemplateAdditions)
    markTemplateInstalled(templateDir, dest);
    return { id: w.id, name: w.name, path: dest, updatedAt: w.updatedAt };
  }

  /** Whether the app created this workspace (inside its data folder) rather than a folder the user opened. */
  isManaged(path: string): boolean {
    return resolve(path).startsWith(resolve(this.appDir, 'workspaces'));
  }

  /** A workspace with counts of what it holds, e.g. for a delete confirmation. */
  details(ref: string): WorkspaceInfo & { managed: boolean; collections: number; environments: number; tests: number } {
    const p = this.resolve(ref);
    if (!p) throw new ApsError('ConfigurationError', `Workspace "${ref}" not found`);
    const w = readJson<Workspace>(join(p, 'workspace.json'));
    const count = (dir: string, re: RegExp): number => {
      const d = join(p, dir);
      if (!existsSync(d)) return 0;
      let n = 0;
      for (const e of readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? count(join(dir, e.name), re) : re.test(e.name) ? 1 : 0;
      return n;
    };
    return { id: w.id, name: w.name, path: p, updatedAt: w.updatedAt, managed: this.isManaged(p), collections: count('collections', /\.json$/), environments: count('environments', /\.json$/), tests: count('tests', /\.ya?ml$/) };
  }

  /** Rename a workspace that isn't open (the open one is renamed through its store). */
  rename(ref: string, name: string): WorkspaceInfo {
    const p = this.resolve(ref);
    if (!p) throw new ApsError('ConfigurationError', `Workspace "${ref}" not found`);
    if (!name.trim()) throw new ApsError('ValidationError', 'The workspace name is empty');
    const file = join(p, 'workspace.json');
    const w = { ...readJson<Workspace>(file), name: name.trim(), updatedAt: new Date().toISOString() };
    writeJson(file, w);
    return { id: w.id, name: w.name, path: p, updatedAt: w.updatedAt };
  }

  /**
   * Remove a workspace. Folders the app created are deleted; folders the user opened are only removed
   * from the list (their files stay). Close the workspace first if it is open.
   */
  delete(ref: string): { deletedFiles: boolean } {
    const p = this.resolve(ref);
    if (!p) throw new ApsError('ConfigurationError', `Workspace "${ref}" not found`);
    const managed = this.isManaged(p);
    // only delete files for workspaces the app created; external folders are just unregistered
    if (managed) {
      try {
        // Windows: files can be briefly locked (SQLite, antivirus, an indexer); retry before giving up
        rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (e) {
        throw new ApsError('ConfigurationError', `Could not delete the workspace folder ${p}: ${e instanceof Error ? e.message : String(e)}. Close programs using it and try again.`);
      }
    }
    const settings = this.loadSettings();
    this.saveSettings({ ...settings, workspacePaths: settings.workspacePaths.filter((x) => resolve(x) !== resolve(p)), ...(settings.lastWorkspace && resolve(settings.lastWorkspace) === resolve(p) ? { lastWorkspace: undefined } : {}) });
    return { deletedFiles: managed };
  }

  importBundle(bundle: WorkspaceBundle, name?: string): WorkspaceStore {
    if (!WORKSPACE_FORMATS.has(bundle?.format)) throw new ApsError('ValidationError', 'Not a TestPion workspace export');
    const { ws } = migrateWorkspace({ ...(bundle.workspace as unknown as Record<string, unknown>), schemaVersion: bundle.schemaVersion });
    // the same export imported twice gets a numbered name, so the switcher can tell them apart
    const base = name ?? `${(ws as unknown as Workspace).name} (imported)`;
    const taken = new Set(this.list().map((w) => w.name));
    let unique = base;
    for (let i = 2; !name && taken.has(unique); i++) unique = `${base} ${i}`;
    const store = this.create(unique);
    store.updateWorkspace({ variables: (ws as unknown as Workspace).variables, description: (ws as unknown as Workspace).description });
    for (const c of bundle.collections ?? []) store.saveCollection(c);
    // the export's environments replace the default one a new workspace starts with (unless it has one by that id)
    if (bundle.environments?.length && !bundle.environments.some((e) => e.id === 'development')) store.deleteEnvironment('development');
    for (const e of bundle.environments ?? []) store.saveEnvironment(e);
    store.saveProviders(bundle.providers ?? []);
    store.saveMcpServers(bundle.mcpServers ?? []);
    for (const [kind, lib] of Object.entries(bundle.library ?? {})) store.saveLibrary(kind, { folders: lib.folders ?? [], items: lib.items ?? [] });
    for (const [name, code] of Object.entries(bundle.packages ?? {})) if (SCRIPT_PACKAGE_NAME.test(name) && typeof code === 'string') store.saveScriptPackage(name, code);
    for (const [rel, content] of Object.entries(bundle.tests ?? {})) {
      const p = store.safePath(rel, store.path('tests'));
      mkdirSync(dirname(p), { recursive: true });
      atomicWrite(p, content);
    }
    return store;
  }
}

/** Save counters and times of this computer's saves (`.local/meta.json`, not shared). */
interface LocalMeta {
  collections: Record<string, { version: number; updatedAt: string }>;
}

/** The first keys of a collection file, in this order; any others follow, sorted (stable files for git). */
const COLLECTION_KEY_ORDER = ['schemaVersion', 'id', 'name', 'description', 'variables', 'auth', 'preRequestScript', 'testScript', 'items'];

/** What a collection file holds: no `version` / `updatedAt` (they are this computer's, see LocalMeta), keys in a fixed order. */
export function collectionFileContent(c: Collection): Record<string, unknown> {
  const { version: _v, updatedAt: _u, ...rest } = c as Collection & Record<string, unknown>;
  void _v;
  void _u;
  const known = COLLECTION_KEY_ORDER.filter((k) => k in rest);
  const others = Object.keys(rest)
    .filter((k) => !COLLECTION_KEY_ORDER.includes(k))
    .sort();
  return Object.fromEntries([...known, ...others].map((k) => [k, (rest as Record<string, unknown>)[k]]));
}
