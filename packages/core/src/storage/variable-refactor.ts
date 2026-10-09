import type { Collection, CollectionNode, KeyValue } from '../model/types.js';
import type { WorkspaceStore } from './workspace.js';
import { secretKeys, type SecretStore } from './secrets.js';
import { ApsError } from '../errors.js';
import { escapeRegex } from '../util/redact.js';

/**
 * Where a variable is used in a workspace, and renaming it everywhere: `{{name}}` in requests (URL,
 * params, headers, bodies, auth, assertions, examples), `tp.environment.get('name')` & co. in scripts,
 * the variable's own definitions (environments, collection, folder and workspace variables) and test
 * files. Renaming moves secret values in the secret store too, so secrets are never lost or exposed.
 */
export interface VariableUsage {
  /** "Collection › Folder › Request", "Environment Staging", "workspace", or a test file path. */
  where: string;
  kind: 'request' | 'script' | 'definition' | 'test-file';
  /** What inside it: "URL", "header Authorization", "body", "pre-request script", "variable" … */
  field: string;
  collectionId?: string;
  requestId?: string;
}

const esc = escapeRegex;
const tokenRe = (name: string) => new RegExp(`\\{\\{\\s*${esc(name)}\\s*\\}\\}`, 'g');
/** tp.environment.get('x'), tp.variables.set("x", …), tp.globals.has(`x`) … */
const scriptRe = (name: string) => new RegExp(`((?:pm|tp|aps)\\.(?:environment|globals|collectionVariables|variables|iterationData)\\.(?:get|set|has|unset)\\(\\s*)(['"\`])${esc(name)}\\2`, 'g');
const SCRIPT_KEYS = new Set(['preRequestScript', 'testScript']);

function fieldName(path: Array<string | number>, root: unknown): string {
  const key = path[path.length - 1];
  if (typeof key === 'string' && SCRIPT_KEYS.has(key)) return key === 'preRequestScript' ? 'pre-request script' : 'test script';
  const has = (k: string) => path.includes(k);
  // headers[i].value → "header <name>"
  const hi = path.indexOf('headers');
  if (hi >= 0 && typeof path[hi + 1] === 'number') {
    let cur: any = root;
    for (const p of path.slice(0, hi + 2)) cur = cur?.[p];
    return `header ${cur?.key ?? ''}`.trim();
  }
  if (has('params')) return 'query parameter';
  if (has('pathVariables')) return 'path variable';
  if (has('auth')) return 'auth';
  if (has('body')) return 'body';
  if (has('assertions')) return 'assertion';
  if (has('examples')) return 'example';
  if (key === 'url' || key === 'endpoint') return key === 'url' ? 'URL' : 'endpoint';
  if (key === 'query') return 'query';
  if (key === 'variables') return 'GraphQL variables';
  return String(key ?? 'value');
}

/** Visit every string of a value with its path; `set` replaces it. */
function eachString(v: unknown, path: Array<string | number>, visit: (s: string, path: Array<string | number>, set: (next: string) => void) => void, parent?: any, key?: string | number): void {
  if (typeof v === 'string') {
    visit(v, path, (next) => {
      if (parent && key !== undefined) parent[key] = next;
    });
  } else if (Array.isArray(v)) v.forEach((x, i) => eachString(x, [...path, i], visit, v, i));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) eachString(x, [...path, k], visit, v, k);
}

const nodesOf = (c: Collection) => {
  const out: Array<{ node: CollectionNode; path: string[] }> = [];
  const walk = (nodes: CollectionNode[], path: string[]) => {
    for (const n of nodes) {
      out.push({ node: n, path: [...path, n.name] });
      if (n.kind === 'folder') walk(n.items, [...path, n.name]);
    }
  };
  walk(c.items, []);
  return out;
};

/** Where `name` is used or defined in the workspace. */
export function variableUsages(store: WorkspaceStore, name: string): VariableUsage[] {
  const out: VariableUsage[] = [];
  const tok = tokenRe(name);
  const scr = scriptRe(name);
  const hit = (s: string, script: boolean) => (tok.lastIndex = 0, scr.lastIndex = 0, tok.test(s) || (script && scr.test(s)));
  for (const e of store.listEnvironments()) if (e.variables.some((v) => v.key === name)) out.push({ where: `Environment ${e.name}`, kind: 'definition', field: 'variable' });
  if (store.workspace.variables?.some((v) => v.key === name)) out.push({ where: 'Workspace', kind: 'definition', field: 'variable' });
  for (const c of store.listCollections().filter((x) => !x.problem)) {
    if (c.variables?.some((v) => v.key === name)) out.push({ where: c.name, kind: 'definition', field: 'collection variable', collectionId: c.id });
    for (const k of ['preRequestScript', 'testScript'] as const) if (c[k] && hit(c[k]!, true)) out.push({ where: c.name, kind: 'script', field: fieldName([k], c), collectionId: c.id });
    if (c.auth) eachString(c.auth, ['auth'], (s) => void (hit(s, false) && out.push({ where: c.name, kind: 'request', field: 'collection auth', collectionId: c.id })));
    for (const { node, path } of nodesOf(c)) {
      const where = [c.name, ...path].join(' › ');
      const seen = new Set<string>();
      const add = (u: VariableUsage) => {
        const k = `${u.kind}|${u.field}`;
        if (!seen.has(k)) (seen.add(k), out.push(u));
      };
      if (node.kind === 'folder' && node.variables?.some((v) => v.key === name)) add({ where, kind: 'definition', field: 'folder variable', collectionId: c.id });
      const { items: _items, ...own } = node as CollectionNode & { items?: unknown };
      eachString(own, [], (s, p) => {
        const script = typeof p[p.length - 1] === 'string' && SCRIPT_KEYS.has(p[p.length - 1] as string);
        if (hit(s, script)) add({ where, kind: script ? 'script' : 'request', field: fieldName(p, own), collectionId: c.id, requestId: node.kind === 'folder' ? undefined : node.id });
      });
    }
  }
  for (const f of testFiles(store)) {
    const text = store.readTestFile(f);
    tok.lastIndex = 0;
    scr.lastIndex = 0;
    if (tok.test(text) || scr.test(text)) out.push({ where: `tests/${f}`, kind: 'test-file', field: 'file' });
  }
  return out;
}

/** Test and suite files (YAML / JSON) under tests/, as paths relative to it. */
function testFiles(store: WorkspaceStore): string[] {
  const out: string[] = [];
  const walk = (nodes: ReturnType<WorkspaceStore['testTree']>) => {
    for (const n of nodes) {
      if (n.kind === 'dir') walk(n.children ?? []);
      else if (/\.(ya?ml|json)$/i.test(n.name)) out.push(n.path);
    }
  };
  walk(store.testTree());
  return out;
}

/**
 * Rename a variable everywhere in the workspace. Existing definitions of `to` are a conflict (nothing
 * is changed). Secret values move to the new key in the secret store. Returns what changed.
 */
export async function renameVariable(store: WorkspaceStore, from: string, to: string, opts: { secrets?: SecretStore } = {}): Promise<{ changed: VariableUsage[]; files: number }> {
  const next = to.trim();
  if (!/^[\w.-]+$/.test(next)) throw new ApsError('ValidationError', 'Use letters, digits, _ . or - in a variable name');
  if (next === from) return { changed: [], files: 0 };
  const clash = variableUsages(store, next).filter((u) => u.kind === 'definition');
  if (clash.length) throw new ApsError('ValidationError', `"${next}" is already defined (${clash.map((u) => u.where).join(', ')})`, { suggestions: ['Pick another name, or remove that variable first.'] });
  const changed = variableUsages(store, from);
  const tok = tokenRe(from);
  const scr = scriptRe(from);
  const swap = (s: string, script: boolean) => {
    let out = s.replace(tok, `{{${next}}}`);
    if (script) out = out.replace(scr, (_m, pre: string, q: string) => `${pre}${q}${next}${q}`);
    return out;
  };
  const renameKeys = (vars: KeyValue[] | undefined) => vars?.map((v) => (v.key === from ? { ...v, key: next } : v));
  let files = 0;

  for (const e of store.listEnvironments()) {
    if (!e.variables.some((v) => v.key === from)) continue;
    // a secret value lives under env id + key: move it before the key changes
    for (const v of e.variables)
      if (v.key === from && (v as { secret?: boolean }).secret && opts.secrets) {
        const value = opts.secrets.get(secretKeys.envVar(e.id, from));
        if (value !== undefined) {
          await opts.secrets.set(secretKeys.envVar(e.id, next), value);
          await opts.secrets.delete(secretKeys.envVar(e.id, from));
        }
      }
    store.saveEnvironment({ ...e, variables: renameKeys(e.variables)! });
    files++;
  }
  if (store.workspace.variables?.some((v) => v.key === from)) {
    for (const v of store.workspace.variables)
      if (v.key === from && (v as { secret?: boolean }).secret && opts.secrets) {
        const value = opts.secrets.get(secretKeys.workspaceVar(store.id, from));
        if (value !== undefined) {
          await opts.secrets.set(secretKeys.workspaceVar(store.id, next), value);
          await opts.secrets.delete(secretKeys.workspaceVar(store.id, from));
        }
      }
    store.updateWorkspace({ variables: renameKeys(store.workspace.variables) });
    files++;
  }
  for (const c0 of store.listCollections().filter((x) => !x.problem)) {
    const before = JSON.stringify(c0);
    const c: Collection = structuredClone(c0);
    c.variables = renameKeys(c.variables) ?? c.variables;
    for (const k of ['preRequestScript', 'testScript'] as const) if (c[k]) c[k] = swap(c[k]!, true);
    if (c.auth) eachString(c.auth, [], (s, _p, set) => set(swap(s, false)));
    for (const { node } of nodesOf(c)) {
      if (node.kind === 'folder') node.variables = renameKeys(node.variables);
      for (const [k, v] of Object.entries(node)) {
        if (k === 'items') continue;
        if (typeof v === 'string') (node as unknown as Record<string, unknown>)[k] = swap(v, SCRIPT_KEYS.has(k));
        else eachString(v, [k], (s, _p, set) => set(swap(s, false)));
      }
    }
    if (JSON.stringify(c) !== before) {
      store.saveCollection(c);
      files++;
    }
  }
  for (const f of testFiles(store)) {
    const text = store.readTestFile(f);
    const updated = swap(text, true);
    if (updated !== text) {
      store.writeTestFile(f, updated);
      files++;
    }
  }
  return { changed, files };
}
