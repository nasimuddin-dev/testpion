import type { Collection } from '../model/types.js';
import { collectionRequests } from './collection-run.js';
import type { WorkspaceStore } from '../storage/workspace.js';

/** Where a variable is set or used: a request (in run order) or the collection / a folder (runs around every request inside). */
export interface FlowPlace {
  /** Request name, or the collection / folder name for their scripts. */
  name: string;
  requestId?: string;
  /** Position of the request in a run (0-based); collection and folder scripts have -1 (they run for every request). */
  index: number;
  /** Folder names from the collection root. */
  path: string[];
}

export interface VariableFlow {
  name: string;
  setBy: FlowPlace[];
  usedBy: FlowPlace[];
  /** Defined outside scripts: an environment, the workspace, the collection or a folder. */
  defined: boolean;
  /**
   * used-before-set: a request uses it before the first request whose scripts set it (and nothing defines it);
   * never-set: used, but no script sets it and nothing defines it; unused: set by a script, used nowhere.
   */
  issue?: 'used-before-set' | 'never-set' | 'unused';
}

// tp.environment.set('x', …), tp.collectionVariables.set("x"), tp.globals.set(`x`), tp.variables.set, bru.setVar / setEnvVar (pm.* too)
const SET_RE = /\b(?:(?:tp|pm|aps)\.(?:environment|collectionVariables|globals|variables)\.set|bru\.set(?:Env)?Var)\(\s*(['"`])([^'"`]+)\1/g;
const GET_RE = /\b(?:(?:tp|pm|aps)\.(?:environment|collectionVariables|globals|variables)\.(?:get|replaceIn)|bru\.get(?:Env)?Var)\(\s*(['"`])([^'"`]+)\1/g;
// {{name}}, not dynamic variables ({{$guid}}) or secret references ({{$secret.x}})
const TOKEN_RE = /\{\{\s*([^{}$\s][^{}]*?)\s*\}\}/g;

function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}
const names = (re: RegExp, text: string, group: number) => [...text.matchAll(re)].map((m) => m[group]!.trim());

/**
 * How variables flow through a collection run: which requests' scripts set each variable and which requests
 * use it (in `{{name}}` or a script's get), in run order, with the likely mistakes flagged. Static analysis:
 * a variable built at run time (`set(prefix + id)`) is not seen.
 */
export function collectionVariableFlow(collection: Collection, definedElsewhere: Iterable<string> = []): VariableFlow[] {
  const defined = new Set(definedElsewhere);
  for (const v of collection.variables ?? []) if (v.key) defined.add(v.key);
  const flows = new Map<string, VariableFlow>();
  const flow = (name: string) => flows.get(name) ?? flows.set(name, { name, setBy: [], usedBy: [], defined: false }).get(name)!;
  const addUnique = (list: FlowPlace[], p: FlowPlace) => !list.some((x) => x.name === p.name && x.index === p.index) && list.push(p);

  // collection-level scripts run for every request
  const colScripts = `${collection.preRequestScript ?? ''}\n${collection.testScript ?? ''}`;
  const colPlace: FlowPlace = { name: collection.name, index: -1, path: [] };
  for (const n of names(SET_RE, colScripts, 2)) addUnique(flow(n).setBy, colPlace);
  for (const n of names(GET_RE, colScripts, 2)) addUnique(flow(n).usedBy, colPlace);

  const folderSeen = new Set<string>();
  collectionRequests(collection).forEach((r, index) => {
    // folder scripts and variables, once per folder
    for (const f of r.folders) {
      if (folderSeen.has(f.id)) continue;
      folderSeen.add(f.id);
      for (const v of f.variables ?? []) if (v.key) defined.add(v.key);
      const text = `${f.preRequestScript ?? ''}\n${f.testScript ?? ''}`;
      const place: FlowPlace = { name: f.name, index: -1, path: r.path.slice(0, r.path.indexOf(f.name) + 1) };
      for (const n of names(SET_RE, text, 2)) addUnique(flow(n).setBy, place);
      for (const n of names(GET_RE, text, 2)) addUnique(flow(n).usedBy, place);
    }
    const place: FlowPlace = { name: r.name, requestId: r.id, index, path: r.path };
    const { preRequestScript, testScript, ...rest } = r.node as typeof r.node & { preRequestScript?: string; testScript?: string };
    const scripts = `${preRequestScript ?? ''}\n${testScript ?? ''}`;
    for (const n of names(SET_RE, scripts, 2)) addUnique(flow(n).setBy, place);
    for (const n of names(GET_RE, scripts, 2)) addUnique(flow(n).usedBy, place);
    // {{tokens}} in the request itself (URL, headers, body, auth …) and in its scripts' strings
    for (const s of strings({ request: (rest as { request?: unknown }).request, assertions: (rest as { assertions?: unknown }).assertions }))
      for (const n of names(TOKEN_RE, s, 1)) addUnique(flow(n).usedBy, place);
  });

  for (const f of flows.values()) {
    f.defined = defined.has(f.name);
    const firstSet = Math.min(...f.setBy.map((p) => (p.index < 0 ? -1 : p.index)), Infinity);
    const firstUse = Math.min(...f.usedBy.filter((p) => p.index >= 0).map((p) => p.index), Infinity);
    if (!f.setBy.length && f.usedBy.length && !f.defined) f.issue = 'never-set';
    else if (f.setBy.length && !f.usedBy.length) f.issue = 'unused';
    // a request's own pre-request script may set what it then uses: only an earlier position counts as "before"
    else if (!f.defined && firstUse < firstSet) f.issue = 'used-before-set';
  }
  // scripted variables first (the chain), then the rest by name
  return [...flows.values()].sort((a, b) => Number(!a.setBy.length) - Number(!b.setBy.length) || a.name.localeCompare(b.name));
}

/**
 * Every variable name the workspace reads: `{{name}}` anywhere in collections, saved gRPC calls, connections,
 * prompts, monitors and other library items, MCP server settings, test files and variable values, plus
 * script reads (`tp.environment.get('name')` …). What is not in it is defined but never used.
 */
export function referencedVariableNames(store: Pick<WorkspaceStore, 'listCollections' | 'libraryKinds' | 'getLibrary' | 'getMcpServers' | 'testTree' | 'readTestFile' | 'listEnvironments' | 'workspace'>): Set<string> {
  const found = new Set<string>();
  const scan = (text: string) => {
    for (const n of names(TOKEN_RE, text, 1)) found.add(n);
    for (const n of names(GET_RE, text, 2)) found.add(n);
  };
  const scanValue = (v: unknown) => strings(v).forEach(scan);
  for (const c of store.listCollections()) if (!(c as { problem?: string }).problem) scanValue(c);
  for (const kind of store.libraryKinds()) scanValue(store.getLibrary(kind).items);
  scanValue(store.getMcpServers());
  for (const e of store.listEnvironments()) scanValue(e.variables.map((v) => v.value));
  scanValue((store.workspace.variables ?? []).map((v) => v.value));
  const walk = (nodes: ReturnType<WorkspaceStore['testTree']>) => {
    for (const n of nodes) {
      if (n.kind === 'dir') walk(n.children ?? []);
      else if (/\.(ya?ml|json)$/i.test(n.name))
        try {
          scan(store.readTestFile(n.path));
        } catch {
          /* unreadable file */
        }
    }
  };
  walk(store.testTree());
  return found;
}

/** The variables of each environment and of the workspace that nothing reads (scopes with none are left out). */
export function unusedVariables(store: Parameters<typeof referencedVariableNames>[0]): Array<{ scope: string; unused: string[] }> {
  const used = referencedVariableNames(store);
  const unusedOf = (vars: Array<{ key: string }>) => vars.map((v) => v.key).filter((k) => k && !used.has(k));
  return [...store.listEnvironments().map((e) => ({ scope: `environment ${e.name}`, unused: unusedOf(e.variables) })), { scope: 'workspace', unused: unusedOf(store.workspace.variables ?? []) }].filter((x) => x.unused.length);
}

/** Every variable name an environment, the workspace or the global settings define: what a collection need not set itself. */
export function definedVariableNames(store: Pick<WorkspaceStore, 'listEnvironments' | 'workspace'>, settings?: { globalVariables?: Array<{ key: string }> }): string[] {
  return [...store.listEnvironments().flatMap((e) => e.variables.map((v) => v.key)), ...(store.workspace.variables ?? []).map((v) => v.key), ...(settings?.globalVariables ?? []).map((v) => v.key)];
}
