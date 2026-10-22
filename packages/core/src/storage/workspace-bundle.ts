/**
 * The workspace export (one JSON file, `<name>.testpion.json`) and its import
 * as a new workspace. DEPRECATED: the bundle (`testpion bundle`, File ▸ Export ▸ Bundle…) replaces it; this stays for two more releases so old files and
 * scripts keep working (transfer/legacy.ts reads these files as bundles).
 *
 * What it holds: the workspace's variables, collections, environments, providers, MCP servers, saved items (library),
 * script packages, test files, and the files under specs/, datasets/, mocks/ and protos/ (`files[]`: text as utf8,
 * anything else as base64). What it never holds: secret values (see bundle-secrets.ts; `replaced` lists what stood in
 * for them), run results, history, traces and the trash. A file over the size limits is left out and named in
 * `notes[]`, never dropped silently.
 */
import { WORKSPACE_FORMATS } from './workspace-formats.js';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Collection, Environment, Library, McpServerConfig, ProviderConfig, Workspace } from '../model/types.js';
import { SCHEMA_VERSION } from '../model/types.js';
import { ApsError } from '../errors.js';
import { isDeviceFileName } from '../util/ids.js';
import { atomicWrite } from './fsutil.js';
import { adoptLooseRequests } from './loose-requests.js';
import { SecretStripper, type ReplacedSecret } from './bundle-secrets.js';
import { SCRIPT_PACKAGE_NAME } from './script-package-name.js';
import { migrateWorkspace } from './workspace-migrate.js';
import type { TestFileNode, WorkspaceStore } from './workspace.js';
import type { WorkspaceManager } from './workspace-manager.js';
import { isRecord } from '@testpion/shared';

/** Size limits of an export, in one place: a file over `fileBytes`, or past `totalBytes` in all, is left out with a note. */
export const BUNDLE_LIMITS = { fileBytes: 10 * 1024 * 1024, totalBytes: 50 * 1024 * 1024 } as const;

/** The workspace folders whose files travel in `files[]` (tests/ has its own section). */
const BUNDLE_FILE_FOLDERS = ['specs', 'datasets', 'mocks', 'protos'] as const;

export { WORKSPACE_FORMATS };

/** One file of specs/, datasets/, mocks/ or protos/: its path from the workspace root with `/`, and its bytes. */
interface BundleFile {
  path: string;
  encoding: 'utf8' | 'base64';
  content: string;
  size: number;
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
  /** Script packages for tp.require, by name; absent in older exports. */
  packages?: Record<string, string>;
  /** specs/, datasets/, mocks/ and protos/ (0.50+). */
  files?: BundleFile[];
  /** What was left out and why (a file over the size limits …), in words (0.50+). */
  notes?: string[];
  /** Literal secrets replaced by `{{variables}}`: where, and the variable to set (never the value) (0.50+). */
  replaced?: ReplacedSecret[];
}

/** The default file name of an export: `<workspace name>.testpion.json` (a name any OS can hold). */
export function workspaceExportFileName(name: string): string {
  const safe = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120);
  return `${isDeviceFileName(safe) ? `${safe}-workspace` : safe || 'workspace'}.testpion.json`;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i;

/**
 * A path from an export checked the same way on every OS (lexically, never through `node:path`, whose answer depends on
 * the OS): `/`-separated names under one of `roots`. Refused, with the reason: absolute paths (`/x`, `C:x`, `\\server`),
 * backslashes, `..`, empty names, percent encoding, control characters, names Windows cannot hold, over-long paths.
 */
export function bundleFilePath(asked: unknown, roots: readonly string[] = BUNDLE_FILE_FOLDERS): { path: string } | { why: string } {
  if (typeof asked !== 'string' || !asked.trim()) return { why: 'no path' };
  const p = asked.trim();
  if (/[\u0000-\u001f\u007f]/.test(p)) return { why: 'it holds a control character' };
  if (/%[0-9a-f]{2}/i.test(p)) return { why: 'percent-encoded names are not decoded' };
  if (/^[a-z]:/i.test(p)) return { why: 'an absolute path (a drive)' };
  if (/^[\\/]/.test(p)) return { why: 'an absolute path' };
  if (p.includes('\\')) return { why: 'a backslash in the path' };
  const names = p.split('/').filter((n) => n !== '.');
  for (const n of names) {
    if (n === '..') return { why: '".." leaves the folder' };
    if (n === '') return { why: 'an empty folder name' };
    if (n.toLowerCase() === '.local') return { why: '".local" holds this computer\'s own state and is never imported' };
    if (/[<>:"|?*]/.test(n)) return { why: `"${n}" holds a character Windows does not allow in file names` };
    if (/[. ]$/.test(n)) return { why: `"${n}" ends with a dot or a space` };
    if (RESERVED.test(n)) return { why: `"${n}" is a device name on Windows` };
    if (n.length > 120) return { why: 'a name longer than 120 characters' };
  }
  if (names.length < 2 || !roots.includes(names[0]!)) return { why: `not under ${roots.map((r) => `${r}/`).join(', ')}` };
  const rel = names.join('/');
  if (rel.length > 240) return { why: 'longer than 240 characters' };
  return { path: rel };
}

/** Bytes as the export keeps them: text as utf8 (exactly the same bytes back), anything else as base64. */
function encode(buf: Buffer): Pick<BundleFile, 'encoding' | 'content'> {
  if (!buf.includes(0)) {
    const s = buf.toString('utf8');
    if (Buffer.from(s, 'utf8').equals(buf)) return { encoding: 'utf8', content: s };
  }
  return { encoding: 'base64', content: buf.toString('base64') };
}

/** Portable export bundle of a workspace. Secret values are never included (see bundle-secrets.ts). */
export function exportWorkspaceBundle(store: WorkspaceStore): WorkspaceBundle {
  const notes: string[] = [];
  const strip = new SecretStripper();
  let used = 0;
  /** A file's bytes when it fits the limits; otherwise a note says it was left out. */
  const take = (rel: string, abs: string): Buffer | undefined => {
    const buf = readFileSync(abs);
    if (buf.length > BUNDLE_LIMITS.fileBytes) {
      notes.push(`${rel} (${mb(buf.length)}) was left out: files over ${mb(BUNDLE_LIMITS.fileBytes)} are not exported. Copy it to the other workspace by hand.`);
      return undefined;
    }
    if (used + buf.length > BUNDLE_LIMITS.totalBytes) {
      notes.push(`${rel} (${mb(buf.length)}) was left out: the export reached its ${mb(BUNDLE_LIMITS.totalBytes)} limit. Copy it to the other workspace by hand.`);
      return undefined;
    }
    used += buf.length;
    return buf;
  };
  const tests: Record<string, string> = {};
  const walk = (nodes: TestFileNode[]) => {
    for (const n of nodes) {
      if (n.kind === 'dir') walk(n.children ?? []);
      else {
        const buf = take(`tests/${n.path}`, store.path('tests', n.path));
        if (buf) tests[n.path] = strip.text('test', `tests/${n.path}`, 'content', buf.toString('utf8'));
      }
    }
  };
  walk(store.testTree());
  const files: BundleFile[] = [];
  /** Files that went out as they are: binary ones, and datasets that could not be read field by field. */
  const unscanned: string[] = [];
  const collect = (rel: string) => {
    const abs = store.path(...rel.split('/'));
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const r = `${rel}/${e.name}`;
      const st = lstatSync(join(abs, e.name));
      if (st.isSymbolicLink()) notes.push(`${r} was left out: it is a link (the file it points to is not exported).`);
      else if (st.isDirectory()) collect(r);
      else if (st.isFile()) {
        const buf = take(r, join(abs, e.name));
        if (!buf) continue;
        const enc = encode(buf);
        if (enc.encoding === 'utf8') {
          // a dataset is read field by field (a password column, a token property); the rest is text with shapes in it
          if (r.startsWith('datasets/')) {
            const d = strip.datasetFile(r, enc.content);
            enc.content = d.text;
            if (!d.parsed) unscanned.push(r);
          } else enc.content = strip.text('file', r, 'content', enc.content);
        } else unscanned.push(r);
        files.push({ path: r, size: buf.length, ...enc });
      }
    }
  };
  for (const folder of BUNDLE_FILE_FOLDERS) if (existsSync(store.path(folder))) collect(folder);
  // said once, so "secret values are never exported" is not claimed for bytes no scan has read
  if (unscanned.length) notes.push(`Exported as is (not scanned for secrets): ${unscanned.slice(0, 20).join(', ')}${unscanned.length > 20 ? ` and ${unscanned.length - 20} more` : ''}.`);
  const ws = store.workspace;
  return {
    format: 'testpion-workspace',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    workspace: { ...ws, variables: strip.variables('workspace', 'workspace', ws.variables) ?? [] },
    collections: store
      .listCollections()
      .filter((c) => !c.problem)
      .map((c) => strip.collection(c)),
    environments: store
      .listEnvironments()
      .filter((e) => !e.problem)
      .map((e) => strip.environment(e)),
    providers: store.getProviders().map((p) => strip.provider(p)),
    mcpServers: store.getMcpServers().map((s) => strip.mcpServer(s)),
    tests,
    library: store.libraryKinds().reduce<Record<string, Library>>((all, kind) => {
      const lib = store.getLibrary(kind);
      return { ...all, [kind]: { ...lib, items: lib.items.map((i) => ({ ...i, data: strip.data('library', `${kind} ${i.name}`, i.data) })) } };
    }, {}),
    packages: Object.fromEntries(store.listScriptPackages().map((p) => [p.name, strip.text('file', `packages/${p.name}`, 'code', store.readScriptPackage(p.name) ?? '')])),
    files,
    notes,
    replaced: strip.replaced,
  };
}

/** What an export holds, in numbers and words, for the app's toast, the CLI and `--json` (one wording everywhere). */
export interface ExportSummary {
  collections: number;
  environments: number;
  tests: number;
  /** Files of specs/, datasets/, mocks/ and protos/. */
  files: number;
  /** What was left out and why. */
  notes: string[];
  /** Secrets replaced by variables (where, and the variable; never the value). */
  replaced: ReplacedSecret[];
  /** One line each: what is in it, what was replaced, what was left out. */
  lines: string[];
}

export function exportSummary(b: WorkspaceBundle): ExportSummary {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const s = {
    collections: b.collections?.length ?? 0,
    environments: b.environments?.length ?? 0,
    tests: Object.keys(b.tests ?? {}).length,
    files: b.files?.length ?? 0,
    notes: b.notes ?? [],
    replaced: b.replaced ?? [],
  };
  const lines = [`Included ${n(s.collections, 'collection')}, ${n(s.environments, 'environment')}, ${n(s.tests, 'test file')} and ${n(s.files, 'file')} from specs/, datasets/, mocks/ and protos/.`];
  if (s.replaced.length)
    lines.push(
      `Replaced ${n(s.replaced.length, 'secret')} with variables: ${s.replaced.map((r) => `${r.item} ${r.field} → ${r.variable.startsWith('{{') ? r.variable : `{{${r.variable}}}`}`).join('; ')}.`,
    );
  lines.push(...s.notes);
  return { ...s, lines };
}

/** What importing an export did: the new workspace, what was skipped (notes) and the values to fill in. */
interface BundleImportResult {
  store: WorkspaceStore;
  /** What this import skipped, in its own words (never the export's `notes`, which anyone could have written). */
  notes: string[];
  /** Variables the export replaced or left blank (secrets): `name (where)`, to set in the new workspace. */
  valuesNeeded: string[];
  /** Files written from `files[]`. */
  files: number;
}

/** The variables an import must be given values for: what the export replaced, and the blank secret variables. */
function valuesNeededOf(bundle: WorkspaceBundle): string[] {
  const seen = new Map<string, string>();
  for (const r of Array.isArray(bundle.replaced) ? bundle.replaced : []) if (r && typeof r.variable === 'string' && !seen.has(r.variable)) seen.set(r.variable, `${r.item}, ${r.field}`);
  for (const e of bundle.environments ?? []) for (const v of e.variables ?? []) if (v.secret && !v.value && !seen.has(v.key)) seen.set(v.key, `environment ${e.name}, secret`);
  for (const v of (bundle.workspace?.variables ?? []) as Array<{ key: string; value: string; secret?: boolean }>) if (v.secret && !v.value && !seen.has(v.key)) seen.set(v.key, 'workspace, secret');
  return [...seen].map(([name, where]) => `${name} (${where})`);
}

/** Write one file of the export, after the path and size checks; a refusal is a note, never an error. */
function writeBundleFile(store: WorkspaceStore, asked: unknown, content: unknown, encoding: unknown, roots: readonly string[], notes: string[]): boolean {
  const checked = bundleFilePath(asked, roots);
  if ('why' in checked) {
    notes.push(`Skipped ${JSON.stringify(String(asked)).slice(0, 200)}: ${checked.why}.`);
    return false;
  }
  if (typeof content !== 'string' || (encoding !== 'utf8' && encoding !== 'base64')) {
    notes.push(`Skipped ${checked.path}: its content is not text or base64.`);
    return false;
  }
  const data = encoding === 'base64' ? Buffer.from(content, 'base64') : content;
  if ((typeof data === 'string' ? Buffer.byteLength(data) : data.length) > BUNDLE_LIMITS.fileBytes) {
    notes.push(`Skipped ${checked.path}: over ${mb(BUNDLE_LIMITS.fileBytes)}.`);
    return false;
  }
  let file: string;
  try {
    // the real location too: a link inside the new workspace can't carry the write outside it
    file = store.safePath(checked.path);
  } catch {
    notes.push(`Skipped ${checked.path}: it would be written outside the workspace.`);
    return false;
  }
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, data);
  return true;
}


/**
 * The export's shape, checked before anything is written: each section is the type it must be (a list of objects, an
 * object of texts …), so a damaged or hand-made file is refused with what is wrong, never a TypeError half-way through.
 */
function checkBundleShape(bundle: WorkspaceBundle): void {
  const b = bundle as unknown as Record<string, unknown>;
  const bad = (what: string) => {
    throw new ApsError('ValidationError', `Not a valid TestPion workspace export: ${what}`, { suggestions: ['Export the workspace again, or import its collections one by one'] });
  };
  if (!isRecord(b.workspace)) bad('"workspace" is not an object');
  for (const k of ['collections', 'environments', 'providers', 'mcpServers'] as const) {
    if (b[k] === undefined || b[k] === null) continue;
    if (!Array.isArray(b[k])) bad(`"${k}" is not a list`);
    if (!(b[k] as unknown[]).every(isRecord)) bad(`"${k}" holds an entry that is not an object`);
  }
  for (const k of ['files', 'notes', 'replaced'] as const) if (b[k] !== undefined && b[k] !== null && !Array.isArray(b[k])) bad(`"${k}" is not a list`);
  for (const k of ['tests', 'library', 'packages'] as const) if (b[k] !== undefined && b[k] !== null && !isRecord(b[k])) bad(`"${k}" is not an object`);
}

/** Import an export as a new workspace (its name gets a number when it is taken, unless `name` is given). */
export function importWorkspaceBundle(manager: WorkspaceManager, bundle: WorkspaceBundle, name?: string): BundleImportResult {
  if (!WORKSPACE_FORMATS.has(bundle?.format)) throw new ApsError('ValidationError', 'Not a TestPion workspace export');
  checkBundleShape(bundle);
  const { ws } = migrateWorkspace({ ...(bundle.workspace as unknown as Record<string, unknown>), schemaVersion: bundle.schemaVersion });
  // the same export imported twice gets a numbered name, so the switcher can tell them apart
  const base = name ?? `${(ws as unknown as Workspace).name} (imported)`;
  const taken = new Set(manager.list().map((w) => w.name));
  let unique = base;
  for (let i = 2; !name && taken.has(unique); i++) unique = `${base} ${i}`;
  const store = manager.create(unique);
  try {
    return fillImportedWorkspace(store, bundle, ws as unknown as Workspace);
  } catch (e) {
    // an export that fails part-way leaves no half-made workspace behind
    store.close();
    try {
      manager.delete(store.root);
    } catch {
      /* the error below says what failed */
    }
    throw e instanceof ApsError ? e : new ApsError('ValidationError', `Not a valid TestPion workspace export: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function fillImportedWorkspace(store: WorkspaceStore, bundle: WorkspaceBundle, ws: Workspace): BundleImportResult {
  store.updateWorkspace({ variables: ws.variables, description: ws.description });
  for (const c of bundle.collections ?? []) store.saveCollection(c);
  // the export's environments replace the default one a new workspace starts with (unless it has one by that id)
  if (bundle.environments?.length && !bundle.environments.some((e) => e.id === 'development')) store.deleteEnvironment('development');
  for (const e of bundle.environments ?? []) store.saveEnvironment(e);
  store.saveProviders(bundle.providers ?? []);
  store.saveMcpServers(bundle.mcpServers ?? []);
  // the export's own notes are not replayed: a file from anywhere would speak in the app's voice. What this import
  // skipped is noted here, from what it did.
  const notes: string[] = [];
  for (const [kind, lib] of Object.entries(bundle.library ?? {})) {
    if (!isRecord(lib)) {
      notes.push(`Skipped the saved items of kind "${kind}": not an object.`);
      continue;
    }
    store.saveLibrary(kind, { folders: Array.isArray(lib.folders) ? lib.folders : [], items: Array.isArray(lib.items) ? lib.items : [] });
  }
  // an export from an older version may hold gRPC calls and connections outside a collection
  adoptLooseRequests(store);
  for (const [pkg, code] of Object.entries(bundle.packages ?? {})) if (SCRIPT_PACKAGE_NAME.test(pkg) && typeof code === 'string') store.saveScriptPackage(pkg, code);
  for (const [rel, content] of Object.entries(bundle.tests ?? {})) writeBundleFile(store, `tests/${rel}`, content, 'utf8', ['tests'], notes);
  let files = 0;
  for (const f of bundle.files ?? []) {
    if (!isRecord(f)) notes.push('Skipped an entry of "files" that is not an object.');
    else if (writeBundleFile(store, f.path, f.content, f.encoding, BUNDLE_FILE_FOLDERS, notes)) files++;
  }
  return { store, notes, valuesNeeded: valuesNeededOf(bundle), files };
}
