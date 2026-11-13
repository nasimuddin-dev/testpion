import { readFileSync } from 'node:fs';
import type { Collection } from '../model/types.js';
import { collectionOwners } from '../git/owners.js';
import { loadOpenApi } from '../openapi/contract.js';
import { listSpecs } from '../openapi/spec-files.js';
import { collectionRequests } from '../runner/collection-run.js';
import { lastMonitorResult, listMonitors } from '../runner/monitors.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { workspaceUses } from '../transfer/item-uses.js';
import { ENGINE_VERSION } from '../version.js';
import { collectionHtml } from './collection-html.js';
import type { CollectionDocsOptions } from './collection-docs.js';

/**
 * The API catalog: every API of a workspace on one page (`testpion docs --catalog`, `docs --site <dir>`, MCP
 * `api_catalog`, RPC `col.catalog`). An API is a collection; the catalog says what belongs to it: how many requests,
 * which hosts they call, the API definition it implements and how many of that definition's operations have a request,
 * the environments that define its variables, its monitors with their latest result, the test files and flows that run
 * it, its saved gRPC calls and connections, and who owns it (CODEOWNERS). Read only; names, counts and statuses, never a
 * value of a variable, a header or a body.
 */
export interface CatalogApi {
  id: string;
  name: string;
  /** The first paragraph of the collection's description. */
  summary?: string;
  requests: number;
  folders: number;
  /** Requests per HTTP method. */
  methods: Record<string, number>;
  /** Where the requests go: a host, or the variable the URL starts with (`{{baseUrl}}`). */
  hosts: string[];
  /** API definitions whose operations these requests call. */
  specs: Array<{ path: string; title?: string; version?: string; operations: number; withRequest: number }>;
  environments: string[];
  monitors: Array<{ id: string; name: string; enabled: boolean; status?: 'passed' | 'failed' | 'error'; at?: string }>;
  /** Test files and flows that run the collection. */
  tests: string[];
  calls: { grpc: number; websocket: number; loadTests: number };
  owners: string[];
  updatedAt?: string;
  /** Its documentation page in the site (`apis/<slug>.html`). */
  page: string;
}

export interface Catalog {
  workspace: { id: string; name: string };
  generatedAt: string;
  version: string;
  apis: CatalogApi[];
  /** API definitions no collection calls yet. */
  specsWithoutRequests: Array<{ path: string; title?: string; version?: string; operations: number }>;
  mcpServers: Array<{ id: string; name: string; transport: string }>;
}

interface SpecInfo {
  path: string;
  title?: string;
  version?: string;
  /** `GET /pets/*` for every operation. */
  operations: string[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

/** A URL's path as segments, a parameter (`{id}`, `:id`, `{{id}}`) as `*`; the scheme, host and a leading `{{baseUrl}}` are not part of it. */
function pathKey(url: string): string {
  let p = url.trim().split(/[?#]/)[0]!;
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^\{\{[^{}]+\}\}(?=\/|$)/, '');
  return p
    .split('/')
    .filter(Boolean)
    .map((s) => (/^\{[^{}]+\}$|^:[\w-]+$|\{\{[^{}]+\}\}/.test(s) ? '*' : s.toLowerCase()))
    .join('/');
}

function readSpecs(store: WorkspaceStore): SpecInfo[] {
  const out: SpecInfo[] = [];
  for (const path of listSpecs(store)) {
    try {
      const doc = loadOpenApi(readFileSync(store.safePath(path), 'utf8')) as unknown as { info?: { title?: string; version?: string }; paths?: Record<string, Record<string, unknown>> };
      const operations: string[] = [];
      for (const [p, item] of Object.entries(doc.paths ?? {})) for (const m of METHODS) if (item && typeof item === 'object' && m in item) operations.push(`${m.toUpperCase()} ${pathKey(p)}`);
      out.push({ path, title: doc.info?.title, version: doc.info?.version !== undefined ? String(doc.info.version) : undefined, operations });
    } catch {
      // a definition that cannot be read is listed with no operations (Problems says why it cannot be read)
      out.push({ path, operations: [] });
    }
  }
  return out;
}

const slugOf = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'api';

/** A request's operation as a definition names it; the request may sit under a base path the definition's server has (`/v1/pets` for `/pets`). */
function matches(operation: string, request: string): boolean {
  if (operation === request) return true;
  const [method, path] = operation.split(' ') as [string, string];
  return request.startsWith(`${method} `) && path !== '' && request.endsWith(`/${path}`);
}

export async function workspaceCatalog(store: WorkspaceStore): Promise<Catalog> {
  const collections = store.listCollections().filter((c) => !(c as { problem?: string }).problem);
  const specs = readSpecs(store);
  const { edges, names } = workspaceUses(store);
  const monitors = listMonitors(store);
  const owners = await collectionOwners(store, collections.map((c) => c.id)).catch(() => ({}) as Record<string, string[]>);
  const taken = new Set<string>();
  const called = new Set<string>();
  const apis: CatalogApi[] = [];
  for (const listed of collections) {
    let c: Collection;
    try {
      c = store.collectionView(listed.id);
    } catch {
      continue;
    }
    const requests = collectionRequests(c);
    const methods: Record<string, number> = {};
    const hosts = new Set<string>();
    const ops: string[] = [];
    let folders = 0;
    const count = (nodes: Collection['items']) => {
      for (const n of nodes)
        if (n.kind === 'folder') {
          folders++;
          count(n.items);
        }
    };
    count(c.items);
    for (const r of requests) {
      const req = r.node.request as { method?: string; url?: string };
      const method = String(req.method ?? 'GET').toUpperCase();
      const url = String(req.url ?? '');
      methods[method] = (methods[method] ?? 0) + 1;
      const host = /^\{\{[^{}]+\}\}/.exec(url)?.[0] ?? /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url)?.[1];
      if (host) hosts.add(host);
      ops.push(`${method} ${pathKey(url)}`);
    }
    const mine = (via: RegExp, kind?: string) => edges.filter((e) => e.from === `collection:${c.id}` && via.test(e.via) && (!kind || e.to.startsWith(`${kind}:`))).map((e) => e.to);
    const linked = specs
      .map((s) => ({ s, withRequest: s.operations.filter((o) => ops.some((r) => matches(o, r))).length }))
      // the definition this collection implements: at least two of its operations (or its only one) have a request here
      .filter((x) => x.withRequest >= Math.min(2, x.s.operations.length) && x.withRequest > 0);
    for (const x of linked) called.add(x.s.path);
    let slug = slugOf(c.id);
    for (let n = 2; taken.has(slug); n++) slug = `${slugOf(c.id)}-${n}`;
    taken.add(slug);
    const key = (k: string) => k.slice(k.indexOf(':') + 1);
    apis.push({
      id: c.id,
      name: c.name,
      ...(c.description?.trim() ? { summary: c.description.trim().split(/\r?\n\s*\r?\n/)[0]!.replace(/\s+/g, ' ').slice(0, 300) } : {}),
      requests: requests.length,
      folders,
      methods,
      hosts: [...hosts].sort(),
      specs: linked.map(({ s, withRequest }) => ({ path: s.path, ...(s.title ? { title: s.title } : {}), ...(s.version ? { version: s.version } : {}), operations: s.operations.length, withRequest })),
      environments: mine(/^defines /, 'environment').map((k) => names.get(k) ?? key(k)),
      monitors: monitors
        .filter((m) => (m as { collectionId?: string }).collectionId === c.id)
        .map((m) => {
          const last = lastMonitorResult(store, m.id);
          return { id: m.id, name: m.name, enabled: !!m.enabled, ...(last ? { status: last.status, at: last.startedAt } : {}) };
        }),
      tests: mine(/^refers to the collection$/, 'test').map(key).sort(),
      calls: { grpc: mine(/^belongs to/, 'grpc-call').length, websocket: mine(/^belongs to/, 'ws-connection').length, loadTests: mine(/^belongs to/, 'load-test').length },
      owners: owners[c.id] ?? [],
      ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}),
      page: `apis/${slug}.html`,
    });
  }
  return {
    workspace: { id: store.workspace.id, name: store.workspace.name },
    generatedAt: new Date().toISOString(),
    version: ENGINE_VERSION,
    apis: apis.sort((a, b) => a.name.localeCompare(b.name)),
    specsWithoutRequests: specs.filter((s) => !called.has(s.path)).map((s) => ({ path: s.path, ...(s.title ? { title: s.title } : {}), ...(s.version ? { version: s.version } : {}), operations: s.operations.length })),
    mcpServers: store.getMcpServers().map((s) => ({ id: s.id, name: s.name, transport: (s as { transport?: string }).transport ?? 'stdio' })),
  };
}

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The catalog as one static page: a card per API with a link to its documentation, a filter box, light and dark by the viewer's system. No external resources. */
export function catalogHtml(catalog: Catalog, opts: { links?: boolean } = {}): string {
  const status = (s?: string) => (s === 'passed' ? '<span class="ok">passing</span>' : s ? '<span class="bad">failing</span>' : '<span class="muted">no run yet</span>');
  const card = (a: CatalogApi) => {
    const methods = Object.entries(a.methods)
      .sort((x, y) => y[1] - x[1])
      .map(([m, n]) => `<span class="m">${esc(m)} ${n}</span>`)
      .join(' ');
    const rows: string[] = [];
    if (a.hosts.length) rows.push(`<dt>Calls</dt><dd>${a.hosts.map((h) => `<code>${esc(h)}</code>`).join(' ')}</dd>`);
    for (const s of a.specs) rows.push(`<dt>API definition</dt><dd><code>${esc(s.path)}</code>${s.title ? ` ${esc(s.title)}` : ''}${s.version ? ` <span class="muted">${esc(s.version)}</span>` : ''} <span class="muted">· ${s.withRequest} of ${plural(s.operations, 'operation')} ${s.withRequest === 1 ? 'has' : 'have'} a request</span></dd>`);
    if (a.environments.length) rows.push(`<dt>Environments</dt><dd>${a.environments.map(esc).join(', ')}</dd>`);
    if (a.monitors.length) rows.push(`<dt>Monitors</dt><dd>${a.monitors.map((m) => `${esc(m.name)} ${m.enabled ? status(m.status) : '<span class="muted">off</span>'}`).join(' · ')}</dd>`);
    if (a.tests.length) rows.push(`<dt>Tests</dt><dd>${a.tests.map((t) => `<code>${esc(t)}</code>`).join(' ')}</dd>`);
    const extra = [a.calls.grpc && plural(a.calls.grpc, 'gRPC call'), a.calls.websocket && plural(a.calls.websocket, 'connection'), a.calls.loadTests && plural(a.calls.loadTests, 'load test')].filter(Boolean);
    if (extra.length) rows.push(`<dt>Also</dt><dd>${extra.join(' · ')}</dd>`);
    if (a.owners.length) rows.push(`<dt>Owners</dt><dd>${a.owners.map(esc).join(', ')}</dd>`);
    const title = opts.links === false ? esc(a.name) : `<a href="${esc(a.page)}">${esc(a.name)}</a>`;
    return `<article class="api" data-text="${esc([a.name, a.summary, ...a.hosts, ...a.specs.map((s) => `${s.path} ${s.title ?? ''}`), ...a.owners].join(' ').toLowerCase())}">
<h2>${title}</h2>
<p class="meta">${plural(a.requests, 'request')}${a.folders ? ` in ${plural(a.folders, 'folder')}` : ''} ${methods}</p>
${a.summary ? `<p>${esc(a.summary)}</p>` : ''}
${rows.length ? `<dl>${rows.join('')}</dl>` : ''}
</article>`;
  };
  const loose = catalog.specsWithoutRequests.length
    ? `<section><h2 class="h">API definitions without requests</h2><ul>${catalog.specsWithoutRequests.map((s) => `<li><code>${esc(s.path)}</code>${s.title ? ` ${esc(s.title)}` : ''} <span class="muted">· ${plural(s.operations, 'operation')}</span></li>`).join('')}</ul></section>`
    : '';
  const servers = catalog.mcpServers.length ? `<section><h2 class="h">MCP servers</h2><ul>${catalog.mcpServers.map((s) => `<li>${esc(s.name)} <span class="muted">· ${esc(s.transport)}</span></li>`).join('')}</ul></section>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(catalog.workspace.name)}: API catalog</title>
<style>
:root{--bg:#fff;--fg:#1c2024;--muted:#60646c;--line:#e0e1e6;--card:#f9f9fb;--accent:#0b68cb;--ok:#18794e;--bad:#c62a2f}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#edeef0;--muted:#b0b4ba;--line:#2e3035;--card:#18191b;--accent:#70b8ff;--ok:#3dd68c;--bad:#ff9592}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px 64px}h1{font-size:24px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
input{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit;margin-bottom:16px}
.api{border:1px solid var(--line);border-radius:8px;background:var(--card);padding:14px 16px;margin-bottom:12px}
.api h2{font-size:17px;margin:0}.api p{margin:6px 0}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.meta,.muted{color:var(--muted)}.m{font:12px ui-monospace,Consolas,monospace;border:1px solid var(--line);border-radius:4px;padding:0 5px;margin-left:4px}
dl{display:grid;grid-template-columns:130px 1fr;gap:4px 12px;margin:10px 0 0;font-size:14px}dt{color:var(--muted)}dd{margin:0;min-width:0;overflow-wrap:anywhere}
code{font:13px ui-monospace,Consolas,monospace}.ok{color:var(--ok)}.bad{color:var(--bad)}.h{font-size:16px;margin:28px 0 8px}ul{padding-left:20px;margin:0}
footer{color:var(--muted);font-size:13px;margin-top:32px}[hidden]{display:none}
@media (max-width:560px){dl{grid-template-columns:1fr}dt{margin-top:6px}}
</style></head><body><main>
<h1>${esc(catalog.workspace.name)}</h1>
<p class="sub">API catalog · ${plural(catalog.apis.length, 'API')} · ${plural(catalog.apis.reduce((n, a) => n + a.requests, 0), 'request')}</p>
${catalog.apis.length > 3 ? '<input id="q" type="search" placeholder="Filter by name, host, API definition or owner" aria-label="Filter the APIs">' : ''}
${catalog.apis.length ? catalog.apis.map(card).join('\n') : '<p class="muted">This workspace has no collections yet.</p>'}
${loose}${servers}
<footer>Generated by TestPion ${esc(catalog.version)} on ${esc(catalog.generatedAt.slice(0, 10))}. Names, counts and statuses only: no values of variables, headers or bodies.</footer>
</main>
<script>
var q=document.getElementById('q');if(q)q.addEventListener('input',function(){var t=q.value.trim().toLowerCase();document.querySelectorAll('.api').forEach(function(a){a.hidden=!!t&&a.getAttribute('data-text').indexOf(t)<0})});
</script>
</body></html>
`;
}

/**
 * The catalog as a site to host or share: `index.html` (the catalog), `catalog.json` (the same as data) and one
 * documentation page per API under `apis/` (the collection's own documentation, secrets masked).
 */
export async function catalogSite(store: WorkspaceStore, opts: CollectionDocsOptions = {}): Promise<{ catalog: Catalog; files: Array<{ path: string; content: string }> }> {
  const catalog = await workspaceCatalog(store);
  const files = [
    { path: 'index.html', content: catalogHtml(catalog) },
    { path: 'catalog.json', content: `${JSON.stringify(catalog, null, 2)}\n` },
  ];
  for (const a of catalog.apis) files.push({ path: a.page, content: collectionHtml(store.collectionView(a.id), opts) });
  return { catalog, files };
}
