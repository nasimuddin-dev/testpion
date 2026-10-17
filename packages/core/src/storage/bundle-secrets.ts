/**
 * EX-G2: an export never holds a secret value. Every literal secret the one detector (security/secrets.ts) finds in a
 * workspace bundle is replaced by a `{{variable}}` (or, for a provider key, its secret-store reference), and the
 * replacement is listed (`replaced`: kind, item, field, variable; never the value) so the export can say what it
 * replaced and the import what to fill in.
 *
 * - MCP servers: deny by default. Every `headers` and stdio `env` value is replaced unless it is empty, already a
 *   reference, or under a name known not to hold a secret (`Content-Type`, `NODE_ENV` …); args and URLs lose
 *   high-confidence shapes (provider keys, passwords in URLs).
 * - Collections: auth fields, headers, params and variables with a secret name or a secret-shaped value; scripts, URLs and
 *   descriptions lose high-confidence shapes. Request bodies are not scanned.
 * - Environments and workspace variables: a secret-named or secret-shaped value that is not marked secret is blanked and
 *   marked secret (its value then goes to the secret store, never a file). Secret variables are blank already.
 * - Providers: a literal API key becomes `{{$secret.provider.<id>.apiKey}}`.
 * - Saved items (library), tests and files (specs/, datasets/, mocks/, protos/): `{key, value}` rows and secret-named
 *   properties; high-confidence shapes in text (a connection string's password, a provider key).
 */
import type { AuthConfig, Collection, CollectionNode, Environment, KeyValue, McpServerConfig, ProviderConfig } from '../model/types.js';
import { literalAuthSecrets } from '../eval/security.js';
import { classifySecret, confidenceAtLeast, isNonSecretKey, isSecretKey, isSecretReference, replaceSecretValues } from '../security/secrets.js';
import { variableNameFor } from './git-guard.js';

export type ReplacedSecretKind = 'mcp-server' | 'collection' | 'environment' | 'workspace' | 'provider' | 'library' | 'test' | 'file';

/** One value an export replaced: where it was and the variable that now stands for it (never the value). */
export interface ReplacedSecret {
  kind: ReplacedSecretKind;
  /** The item, in words: `MCP server Petstore`, `API › Pets › Create pet`, `environment Staging`, `specs/x.yaml`. */
  item: string;
  /** The field: `headers.Authorization`, `env.GITHUB_TOKEN`, `auth.token`, `variables.password`, `url`. */
  field: string;
  /** What to set on import: a `{{variable}}` name, or a secret-store reference for provider keys. */
  variable: string;
}

const SCHEME = /^(Bearer|Basic|Token|Digest|ApiKey)\s+/i;
/** Variable names for a value found by its shape alone. */
const SHAPE_NAME: Record<string, string> = { 'connection-string': 'dbPassword', 'private-key': 'privateKey', jwt: 'jwt', 'auth-scheme': 'token', 'query-credential': 'token' };

/** One pass over one bundle: the replacements so far, and one variable name per distinct value. */
export class SecretStripper {
  readonly replaced: ReplacedSecret[] = [];
  private byValue = new Map<string, string>();
  private taken = new Set<string>();

  /** The variable for a value: the same value always gets the same name; a different value under a taken name gets name2 … */
  private nameFor(base: string, value: string): string {
    const known = this.byValue.get(value);
    if (known) return known;
    const b = base || 'secret';
    let n = b;
    for (let i = 2; this.taken.has(n); i++) n = `${b}${i}`;
    this.taken.add(n);
    this.byValue.set(value, n);
    return n;
  }

  /** `value` replaced by `{{name}}` (an auth scheme in front stays: `Bearer {{token}}`), and noted. */
  swap(kind: ReplacedSecretKind, item: string, field: string, base: string, value: string): string {
    const scheme = SCHEME.exec(value)?.[0] ?? '';
    const name = this.nameFor(base, value.slice(scheme.length));
    this.replaced.push({ kind, item, field, variable: name });
    return `${scheme}{{${name}}}`;
  }

  /** High-confidence shapes inside free text (a script, a URL, a test file) replaced by `{{variables}}`. */
  text(kind: ReplacedSecretKind, item: string, field: string, s: string): string {
    if (typeof s !== 'string' || s.length < 8) return s;
    return replaceSecretValues(
      s,
      (p, secret) => {
        const name = this.nameFor(SHAPE_NAME[p.id] ?? 'apiKey', secret);
        this.replaced.push({ kind, item, field: `${field} (${p.id})`, variable: name });
        return `{{${name}}}`;
      },
      'high',
    );
  }

  /**
   * Name/value pairs in whichever shape a file holds them, each value passed through `fn`, given back in the same shape:
   * `[{ key, value }]` rows (TestPion), or a `{ name: value }` object (stdio `env`, and headers as other tools and
   * hand-edited files write them). A lone string is scanned as text; anything else that is not a pair is kept as it is.
   */
  private pairs(kind: ReplacedSecretKind, item: string, part: string, v: unknown, fn: (key: string, value: string) => string): unknown {
    if (typeof v === 'string') return this.text(kind, item, part, v);
    // copy on write: a list or object with nothing to replace is given back as it is (a big workspace has thousands)
    if (Array.isArray(v)) {
      let out: unknown[] | undefined;
      v.forEach((r, i) => {
        const row = r as { key?: unknown; value?: unknown } | null;
        if (!row || typeof row !== 'object' || typeof row.key !== 'string' || typeof row.value !== 'string') return;
        const value = fn(row.key, row.value);
        if (value !== row.value) (out ??= [...v])[i] = { ...row, value };
      });
      return out ?? v;
    }
    if (v && typeof v === 'object') {
      let out: Record<string, unknown> | undefined;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const y = typeof x === 'string' ? fn(k, x) : this.data(kind, item, x, `${part}.${k}`);
        if (y !== x) (out ??= { ...(v as Record<string, unknown>) })[k] = y;
      }
      return out ?? v;
    }
    return v;
  }

  /** `{ key, value }` rows (or a `{ name: value }` object): a secret name or a secret-shaped value (medium or more) becomes `{{variable}}`. */
  rows<T>(kind: ReplacedSecretKind, item: string, part: string, rows: T): T {
    return this.pairs(kind, item, part, rows, (key, value) => {
      const v = classifySecret(key, value);
      return v && confidenceAtLeast(v.confidence, 'medium') ? this.swap(kind, item, `${part}.${key}`, variableNameFor(key), value) : value;
    }) as T;
  }

  /** Deny by default (MCP `headers` / `env`, rows or an object): every value but empty ones, references and allow-listed names. */
  denyRows<T>(item: string, part: string, server: string, rows: T): T {
    return this.pairs('mcp-server', item, part, rows, (key, value) =>
      !value || isSecretReference(value) || isNonSecretKey(key) ? value : this.swap('mcp-server', item, `${part}.${key}`, envName(String(server), key), value),
    ) as T;
  }

  /** Variables: a secret value not marked secret is blanked and marked secret (its value never travels). */
  variables<T extends KeyValue & { secret?: boolean }>(kind: ReplacedSecretKind, item: string, vars: T[] | undefined): T[] | undefined {
    if (!Array.isArray(vars)) return vars;
    let changed = false;
    const out = vars.map((v) => {
      if (!v || typeof v !== 'object') return v;
      if (v.secret) return v.value ? ((changed = true), { ...v, value: '' }) : v;
      const c = classifySecret(v.key, v.value);
      if (!c || !confidenceAtLeast(c.confidence, 'medium')) return v;
      this.replaced.push({ kind, item, field: `variables.${v.key}`, variable: v.key });
      changed = true;
      return { ...v, value: '', secret: true };
    });
    return changed ? out : vars;
  }

  /** An auth config with its typed secrets as `{{variables}}`. */
  auth(kind: ReplacedSecretKind, item: string, auth: AuthConfig | undefined): AuthConfig | undefined {
    const found = literalAuthSecrets(auth);
    if (!auth || !found.length) return auth;
    const out = { ...(auth as unknown as Record<string, unknown>) };
    for (const f of found)
      if (typeof out[f.field] === 'string' && !isSecretReference(out[f.field])) out[f.field] = this.swap(kind, item, `auth.${f.field}`, variableNameFor(f.field), out[f.field] as string);
    return out as unknown as AuthConfig;
  }

  /** Any JSON-like data (saved items): rows, secret-named string properties, high-confidence shapes in other strings; `body` is left alone. */
  data(kind: ReplacedSecretKind, item: string, v: unknown, path = '', depth = 0): unknown {
    if (depth > 32 || v == null) return v;
    if (typeof v === 'string') return this.text(kind, item, path || 'value', v);
    if (typeof v !== 'object') return v;
    if (Array.isArray(v)) {
      const isRows = v.length > 0 && v.every((r) => r && typeof r === 'object' && typeof (r as { key?: unknown }).key === 'string' && typeof (r as { value?: unknown }).value === 'string');
      if (isRows) return this.rows(kind, item, path || 'rows', v as Array<{ key: string; value: string }>);
      return v.map((x, i) => this.data(kind, item, x, `${path}[${i}]`, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (k === 'body') out[k] = x;
      else if (typeof x === 'string' && x && isSecretKey(k) && !isSecretReference(x)) out[k] = this.swap(kind, item, p, variableNameFor(k), x);
      else out[k] = this.data(kind, item, x, p, depth + 1);
    }
    return out;
  }

  /**
   * A collection with its literal secrets replaced. Copy on write: a node (and its request, rows, scripts) with nothing
   * to replace is the same object, so a 9,000-request collection without secrets costs a scan, not a copy.
   */
  collection(c: Collection): Collection {
    const item = `collection ${c.name}`;
    /** `fields` of `obj` passed through `f`; `obj` itself when none changed, else a copy with the changed ones. */
    const patch = <T extends object>(obj: T, fields: readonly string[], f: (key: string, value: unknown) => unknown): T => {
      let out: Record<string, unknown> | undefined;
      for (const k of fields) {
        const was = (obj as Record<string, unknown>)[k];
        if (was === undefined || was === null) continue;
        const now = f(k, was);
        if (now !== was) (out ??= { ...(obj as Record<string, unknown>) })[k] = now;
      }
      return (out ?? obj) as T;
    };
    const scripts = (where: string) => (k: string, v: unknown) => (typeof v === 'string' ? this.text('collection', where, k, v) : v);
    const nodes = (list: CollectionNode[], trail: string): CollectionNode[] => {
      if (!Array.isArray(list)) return list;
      let out: CollectionNode[] | undefined;
      list.forEach((n, i) => {
        if (!n || typeof n !== 'object') return;
        const where = `${trail} › ${n.name}`;
        let next: CollectionNode;
        if (n.kind === 'folder')
          next = patch(n, ['auth', 'variables', 'preRequestScript', 'testScript', 'items'], (k, v) =>
            k === 'auth' ? this.auth('collection', where, v as AuthConfig) : k === 'variables' ? this.variables('collection', where, v as KeyValue[]) : k === 'items' ? nodes(v as CollectionNode[], where) : scripts(where)(k, v),
          );
        else
          next = patch(n, ['request', 'preRequestScript', 'testScript'], (k, v) =>
            k !== 'request'
              ? scripts(where)(k, v)
              : v && typeof v === 'object'
                ? patch(v as Record<string, unknown>, ['auth', 'headers', 'params', 'metadata', 'url', 'endpoint'], (part, x) =>
                    part === 'auth' ? this.auth('collection', where, x as AuthConfig) : part === 'url' || part === 'endpoint' ? scripts(where)(part, x) : this.rows('collection', where, part, x),
                  )
                : v,
          );
        if (next !== n) (out ??= [...list])[i] = next;
      });
      return out ?? list;
    };
    return {
      ...c,
      auth: this.auth('collection', `${c.name} (collection auth)`, c.auth),
      variables: this.variables('collection', item, c.variables) ?? [],
      ...(c.preRequestScript ? { preRequestScript: this.text('collection', item, 'preRequestScript', c.preRequestScript) } : {}),
      ...(c.testScript ? { testScript: this.text('collection', item, 'testScript', c.testScript) } : {}),
      items: nodes(c.items, c.name),
    };
  }

  environment(e: Environment): Environment {
    return { ...e, variables: this.variables('environment', `environment ${e.name}`, e.variables) ?? [] };
  }

  /** Every field that can hold a credential, whatever the transport says (a hand-edited file may mix them): env and headers deny by default. */
  mcpServer(s: McpServerConfig): McpServerConfig {
    const item = `MCP server ${s.name}`;
    const x = s as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = { ...x };
    if (x.env !== undefined && x.env !== null) out.env = this.denyRows(item, 'env', s.name, x.env);
    if (x.headers !== undefined && x.headers !== null) out.headers = this.denyRows(item, 'headers', s.name, x.headers);
    if (Array.isArray(x.args)) out.args = x.args.map((a, i) => (typeof a === 'string' ? this.text('mcp-server', item, `args[${i}]`, a) : this.data('mcp-server', item, a, `args[${i}]`)));
    else if (x.args !== undefined) out.args = this.data('mcp-server', item, x.args, 'args');
    if (typeof x.url === 'string') out.url = this.text('mcp-server', item, 'url', x.url);
    return out as unknown as McpServerConfig;
  }

  provider(p: ProviderConfig): ProviderConfig {
    const item = `provider ${p.name}`;
    let apiKey = p.apiKey;
    if (apiKey && !isSecretReference(apiKey)) {
      apiKey = `{{$secret.provider.${p.id}.apiKey}}`;
      this.replaced.push({ kind: 'provider', item, field: 'apiKey', variable: apiKey });
    }
    return { ...p, ...(p.apiKey !== undefined ? { apiKey } : {}), ...(p.headers !== undefined && p.headers !== null ? { headers: this.rows('provider', item, 'headers', p.headers) } : {}) };
  }
}

/** An environment-variable style name for a server's field: `Petstore MCP` + `Authorization` → PETSTORE_MCP_AUTHORIZATION. */
export function envName(server: string, key: string): string {
  return (
    `${server}_${key}`
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase() || 'SECRET'
  );
}
