import { securityLint } from '../eval/security.js';
import { Redactor } from '../util/redact.js';
import type { Collection, CollectionNode, Environment, KeyValue } from '../model/types.js';
import type { WorkspaceStore } from './workspace.js';
import { secretKeys, type SecretStore } from './secrets.js';

/**
 * Secrets that would be published by committing the workspace (GIT-104): values typed in where a secret variable
 * belongs. Secret variables themselves are safe: their values live in the OS secret store, not in the files.
 * Used before a commit: `testpion git check`, the pre-commit hook (`testpion git hook install`), and the app, which
 * also fixes them in one click (fixCommittableSecrets).
 */
export interface SecretFinding {
  /** Workspace file the value is in. */
  file: string;
  /** Where in it, in words: "Payments ▸ Create invoice", "environment Staging, variable token". */
  where: string;
  message: string;
  /** What holds the value, so the app can open it and fix it. */
  kind: 'request' | 'collection-auth' | 'collection-variable' | 'environment-variable' | 'workspace-variable' | 'mcp-server' | 'provider';
  collectionId?: string;
  /** The request (kind 'request'). */
  itemId?: string;
  /** For a request or a collection's auth: the part and the field (header name, body key, auth field) that holds the value. */
  part?: 'auth' | 'headers' | 'params' | 'body';
  field?: string;
  environmentId?: string;
  serverId?: string;
  providerId?: string;
  /** The secret variable name a fix would use ({{name}}). */
  variable?: string;
}

const hasVariable = (v: string) => /\{\{\s*[^{}]+\s*\}\}/.test(v);

/** A variable name for a field: "X-Api-Key" → apiKey, "continuationToken" stays, "client_secret" → clientSecret. */
export function variableNameFor(field: string): string {
  const words = field
    .replace(/^x-/i, '')
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (!words.length) return 'secret';
  return words[0]! + words.slice(1).map((w) => w[0]!.toUpperCase() + w.slice(1)).join('');
}

export function findCommittableSecrets(store: WorkspaceStore): SecretFinding[] {
  const out: SecretFinding[] = [];
  const red = new Redactor();
  const sensitive = (key: string) => red.isSensitiveKey(key);
  // collections: the security lint's "typed in" findings (headers, auth, body fields)
  for (const c of store.listCollections()) {
    if ((c as { problem?: string }).problem) continue;
    const file = `collections/${c.id}.json`;
    for (const f of securityLint(c)) {
      if (f.severity !== 'high' || !/typed in/.test(f.message)) continue;
      const variable = f.field ? variableNameFor(f.field) : undefined;
      if (f.requestId) out.push({ file, where: f.where, message: f.message, kind: 'request', collectionId: c.id, itemId: f.requestId, part: f.part, field: f.field, variable });
      else out.push({ file, where: f.where, message: f.message, kind: 'collection-auth', collectionId: c.id, part: f.part, field: f.field, variable });
    }
    for (const v of c.variables ?? [])
      if (sensitive(v.key) && v.value && !hasVariable(v.value) && !(v as { secret?: boolean }).secret)
        out.push({ file, where: `collection ${c.name}, variable ${v.key}`, message: `The collection variable "${v.key}" holds a value typed in: move it to a secret environment variable`, kind: 'collection-variable', collectionId: c.id, field: v.key, variable: v.key });
  }
  // environments and the workspace: a sensitive-looking variable with a plain value (not marked secret)
  for (const e of store.listEnvironments()) {
    for (const v of e.variables)
      if (sensitive(v.key) && v.value && !v.secret && !hasVariable(v.value))
        out.push({ file: `environments/${e.id}.json`, where: `environment ${e.name}, variable ${v.key}`, message: `"${v.key}" holds a value in plain text: mark it secret (lock icon) so its value stays in the OS secret store`, kind: 'environment-variable', environmentId: e.id, field: v.key, variable: v.key });
  }
  for (const v of store.workspace.variables ?? [])
    if (sensitive(v.key) && v.value && !(v as { secret?: boolean }).secret && !hasVariable(v.value))
      out.push({ file: 'workspace.json', where: `workspace variable ${v.key}`, message: `"${v.key}" holds a value in plain text: mark it secret`, kind: 'workspace-variable', field: v.key, variable: v.key });
  // MCP servers (headers, environment of a local command) and providers (API keys)
  for (const s of store.getMcpServers()) {
    const kv: Array<[string, string]> = 'env' in s && s.env ? Object.entries(s.env) : 'headers' in s && s.headers ? s.headers.map((h) => [h.key, h.value]) : [];
    for (const [k, v] of kv) if (sensitive(k) && v && !hasVariable(v)) out.push({ file: 'mcp-servers.json', where: `MCP server ${s.name}, ${k}`, message: `"${k}" holds a value typed in: use a {{secret variable}}`, kind: 'mcp-server', serverId: s.id, field: k, variable: variableNameFor(k) });
  }
  for (const p of store.getProviders()) if (p.apiKey && !hasVariable(p.apiKey)) out.push({ file: 'providers.json', where: `provider ${p.name}`, message: 'The API key is typed in: save it in Settings ▸ Providers (kept in the OS secret store)', kind: 'provider', providerId: p.id });
  return out;
}

export interface SecretFixResult {
  fixed: SecretFinding[];
  /** Findings this cannot fix by itself (MCP servers, providers): the app opens them instead. */
  skipped: Array<{ finding: SecretFinding; reason: string }>;
  /** Secret variables created or set in the environment, by name. */
  variables: string[];
}

/** Read the typed value a finding points at, from the collection as it is now. */
function typedValue(c: Collection, f: SecretFinding): string | undefined {
  const auth = (a: unknown) => (a && typeof a === 'object' && f.field ? (a as Record<string, unknown>)[f.field] : undefined);
  if (f.kind === 'collection-auth') return auth(c.auth) as string | undefined;
  const node = findNode(c.items, f.itemId!);
  if (!node || node.kind !== 'http') return undefined;
  if (f.part === 'auth') return auth(node.request.auth) as string | undefined;
  if (f.part === 'headers') return node.request.headers?.find((h) => h.key === f.field && h.enabled !== false)?.value;
  if (f.part === 'body' && node.request.body && 'content' in node.request.body) {
    try {
      let found: string | undefined;
      const walk = (v: unknown, key = '') => {
        if (found !== undefined) return;
        if (typeof v === 'string' && key === f.field && !hasVariable(v)) found = v;
        else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, Array.isArray(v) ? key : k);
      };
      walk(JSON.parse(node.request.body.content));
      return found;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function findNode(nodes: CollectionNode[], id: string): CollectionNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.kind === 'folder') {
      const r = findNode(n.items, id);
      if (r) return r;
    }
  }
  return undefined;
}

/** The collection with the typed value replaced by {{variable}} where the finding points. */
function replaceInCollection(c: Collection, f: SecretFinding, ref: string): Collection {
  const setAuth = (a: unknown) => (a && typeof a === 'object' && f.field ? { ...(a as Record<string, unknown>), [f.field]: ref } : a);
  if (f.kind === 'collection-auth') return { ...c, auth: setAuth(c.auth) as Collection['auth'] };
  const map = (nodes: CollectionNode[]): CollectionNode[] =>
    nodes.map((n) => {
      if (n.kind === 'folder') return { ...n, items: map(n.items) };
      if (n.id !== f.itemId || n.kind !== 'http') return n;
      const r = { ...n.request };
      if (f.part === 'auth') r.auth = setAuth(r.auth) as typeof r.auth;
      else if (f.part === 'headers') r.headers = (r.headers ?? []).map((h) => (h.key === f.field && h.enabled !== false && !hasVariable(h.value) ? { ...h, value: ref } : h));
      else if (f.part === 'body' && r.body && 'content' in r.body) {
        try {
          let done = false;
          const walk = (v: unknown, key = ''): unknown => {
            if (!done && typeof v === 'string' && key === f.field && !hasVariable(v)) return (done = true), ref;
            if (Array.isArray(v)) return v.map((x) => walk(x, key));
            if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
            return v;
          };
          const json = walk(JSON.parse(r.body.content));
          r.body = { ...r.body, content: JSON.stringify(json, null, 2) };
        } catch {
          /* not JSON any more: left as is */
        }
      }
      return { ...n, request: r };
    });
  return { ...c, items: map(c.items) };
}

/**
 * Fix findings in one go: a typed value in a request becomes `{{variable}}` and the value a secret variable of the
 * given environment (its value goes to the secret store, never to a file); a plain environment, workspace or
 * collection variable becomes secret the same way. MCP servers and providers are reported as skipped.
 */
export async function fixCommittableSecrets(store: WorkspaceStore, secrets: SecretStore, findings: SecretFinding[], opts: { environmentId: string }): Promise<SecretFixResult> {
  const result: SecretFixResult = { fixed: [], skipped: [], variables: [] };
  const env = store.listEnvironments().find((e) => e.id === opts.environmentId);
  if (!env) throw new Error(`No environment ${opts.environmentId} to keep the secret variables in`);
  const envVars = new Map<string, string>(); // variable → value to store
  // names the environment uses already keep their own value: a request's value gets a fresh name (password2 …)
  const taken = new Set(env.variables.map((v) => v.key));
  const collections = new Map<string, Collection>();
  const col = (id: string) => collections.get(id) ?? (collections.set(id, store.getCollection(id)), collections.get(id)!);
  let workspaceVars: KeyValue[] | undefined;
  for (const f of findings) {
    if (f.kind === 'request' || f.kind === 'collection-auth') {
      const c = col(f.collectionId!);
      const value = typedValue(c, f);
      const name = f.variable ?? variableNameFor(f.field ?? 'secret');
      if (!value) {
        result.skipped.push({ finding: f, reason: 'the value is not there any more' });
        continue;
      }
      // the same name holds one value: a second, different value gets its own name
      let variable = name;
      for (let i = 2; (taken.has(variable) && envVars.get(variable) !== value) || (envVars.has(variable) && envVars.get(variable) !== value); i++) variable = `${name}${i}`;
      envVars.set(variable, value);
      collections.set(c.id, replaceInCollection(c, { ...f, variable }, `{{${variable}}}`));
      result.fixed.push({ ...f, variable });
    } else if (f.kind === 'collection-variable') {
      const c = col(f.collectionId!);
      const v = (c.variables ?? []).find((x) => x.key === f.field);
      if (!v?.value) {
        result.skipped.push({ finding: f, reason: 'the value is not there any more' });
        continue;
      }
      // the value moves to the environment as a secret; the collection keeps the name as a reference
      envVars.set(v.key, v.value);
      collections.set(c.id, { ...c, variables: (c.variables ?? []).map((x) => (x.key === v.key ? { ...x, value: `{{${v.key}}}` } : x)) });
      result.fixed.push({ ...f, variable: v.key });
    } else if (f.kind === 'environment-variable') {
      // read again each time: an earlier finding of the same environment has just saved it
      const e = store.listEnvironments().find((x) => x.id === f.environmentId);
      const v = e?.variables.find((x) => x.key === f.field);
      if (!e || !v?.value) {
        result.skipped.push({ finding: f, reason: 'the value is not there any more' });
        continue;
      }
      await secrets.set(secretKeys.envVar(e.id, v.key), v.value);
      store.saveEnvironment({ ...e, variables: e.variables.map((x) => (x.key === v.key ? { ...x, value: '', secret: true } : x)) });
      result.fixed.push({ ...f, variable: v.key });
    } else if (f.kind === 'workspace-variable') {
      workspaceVars ??= [...(store.workspace.variables ?? [])];
      const v = workspaceVars.find((x) => x.key === f.field);
      if (!v?.value) {
        result.skipped.push({ finding: f, reason: 'the value is not there any more' });
        continue;
      }
      await secrets.set(secretKeys.workspaceVar(store.id, v.key), v.value);
      workspaceVars = workspaceVars.map((x) => (x.key === v.key ? { ...x, value: '', secret: true } : x));
      result.fixed.push({ ...f, variable: v.key });
    } else result.skipped.push({ finding: f, reason: f.kind === 'provider' ? 'save the key in Settings ▸ Providers' : 'use a {{secret variable}} in the server settings' });
  }
  for (const c of collections.values()) store.saveCollection(c);
  if (workspaceVars) store.updateWorkspace({ ...store.workspace, variables: workspaceVars });
  if (envVars.size) {
    const latest = store.listEnvironments().find((e) => e.id === env.id) ?? env;
    const vars: Environment['variables'] = [...latest.variables];
    for (const [key, value] of envVars) {
      await secrets.set(secretKeys.envVar(env.id, key), value);
      const i = vars.findIndex((x) => x.key === key);
      const row = { key, value: '', enabled: true, secret: true };
      if (i >= 0) vars[i] = { ...vars[i]!, ...row };
      else vars.push(row);
      result.variables.push(key);
    }
    store.saveEnvironment({ ...latest, variables: vars });
  }
  return result;
}
