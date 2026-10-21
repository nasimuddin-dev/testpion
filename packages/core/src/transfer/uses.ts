/**
 * "Export with everything it uses": from the items picked, the closure of what they use — a collection's saved gRPC
 * calls and connections, monitors and load tests that name it, the API definitions, datasets, protos and mocks its text
 * points at, the environments that define the variables it needs, the test and flow files that refer to it, the MCP
 * servers its requests or tests name, the script packages its scripts require. A use is found by reading the item's
 * (already secret-stripped) text for workspace paths and names, never by running anything; what is named but not in the
 * workspace is listed as missing, so a bundle never claims to hold more than it does.
 */
import { escapeRegex, isRecord, templateVariables } from '@testpion/shared';
import type { WorkspaceStore } from '../storage/workspace.js';
import { LIBRARY_OF, RAW_ROOT, itemKey, type BundleEdge, type BundleKindId, type BundleManifest } from './format.js';
import { adapter, ALL_BUNDLE_KINDS } from './registry.js';
import type { Listed } from './items.js';
import { collectionIdOfRef } from './parts.js';
import type { BundleRef } from './types.js';

export interface UsesResult {
  refs: BundleRef[];
  edges: BundleEdge[];
  missing: BundleManifest['missing'];
}

const PATH_RE = /(?:^|[^A-Za-z0-9_./@-])((?:specs|datasets|protos|mocks|packages|tests)\/[^\s"'`,;)\]}<>|*?]+?\.[A-Za-z0-9]{1,12})(?=$|[\s"'`,;)\]}<>|])/g;
const REQUIRE_RE = /\b(?:tp|pm)\.require\(\s*['"]([^'"]+)['"]\s*\)/g;


/** The values of keys that name an MCP server (`server`, `serverId`, `mcpServer`) anywhere in a JSON value. */
function serverNames(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) for (const x of v) serverNames(x, out);
  else if (isRecord(v))
    for (const [k, x] of Object.entries(v)) {
      if (/^(server|serverId|serverName|mcpServer)$/i.test(k) && typeof x === 'string') out.add(x);
      else if (k.toLowerCase() === 'server' && isRecord(x) && typeof x.name === 'string') out.add(x.name);
      else serverNames(x, out);
    }
  return out;
}

export function collectUses(store: WorkspaceStore, roots: readonly BundleRef[], read: (r: BundleRef) => string | undefined, exclude?: ReadonlySet<string>): UsesResult {
  const lists = new Map<BundleKindId, Listed[]>(ALL_BUNDLE_KINDS.map((k) => [k, adapter(k).list(store)]));
  const listOf = (k: BundleKindId) => lists.get(k) ?? [];
  const byPath = new Map<string, BundleRef>();
  for (const k of Object.keys(RAW_ROOT) as BundleKindId[]) for (const i of listOf(k)) byPath.set(i.id, { kind: k, id: i.id });
  const wsVars = new Set((store.workspace.variables ?? []).map((v) => v.key));
  const envs = store.listEnvironments().filter((e) => !e.problem);
  const libs = (Object.entries(LIBRARY_OF) as Array<[BundleKindId, string]>).map(([kind, lib]) => ({ kind, items: store.getLibrary(lib).items }));

  const seen = new Map<string, BundleRef>(roots.map((r) => [itemKey(r.kind, r.id), r]));
  const edges: BundleEdge[] = [];
  const missing: BundleManifest['missing'] = [];
  const queue = [...roots];
  let tests: Array<{ ref: BundleRef; text: string }> | undefined;

  // an edge once per pair (a set, not a scan of the edges: a collection that 2,500 saved items belong to makes 2,500 of them)
  const edgeKeys = new Set<string>();
  const use = (from: BundleRef, to: BundleRef, via: string) => {
    const key = itemKey(to.kind, to.id);
    // an item the person unticked stays out, and so does what only it would have brought; the bundle says it is not there
    if (exclude?.has(key) && !seen.has(key)) {
      if (!missing.some((x) => x.to === to.id)) missing.push({ from: itemKey(from.kind, from.id), to: to.id, reason: 'left out: you unticked it' });
      return;
    }
    const edge =`${itemKey(from.kind, from.id)}\0${key}`;
    if (!edgeKeys.has(edge)) (edgeKeys.add(edge), edges.push({ from: itemKey(from.kind, from.id), to: key, via }));
    if (!seen.has(key)) {
      seen.set(key, to);
      queue.push(to);
    }
  };

  while (queue.length) {
    const from = queue.shift()!;
    const text = read(from);
    if (text === undefined) continue;

    // workspace paths: API definitions, datasets, protos, mocks, packages and sub-flows named in the text
    for (const m of text.matchAll(PATH_RE)) {
      const p = m[1]!;
      const hit = byPath.get(p);
      if (hit && itemKey(hit.kind, hit.id) !== itemKey(from.kind, from.id)) use(from, hit, p);
      else if (!hit && missing.length < 50 && !missing.some((x) => x.to === p)) missing.push({ from: itemKey(from.kind, from.id), to: p, reason: 'named in the text but not in the workspace' });
    }
    // sub-flows and files named relative to the test file or to tests/
    if (from.kind === 'test') {
      const dir = from.id.slice(0, from.id.lastIndexOf('/'));
      for (const m of text.matchAll(/["']?([A-Za-z0-9_./ -]+\.ya?ml)["']?/g)) {
        const rel = m[1]!.trim();
        const hit = byPath.get(`${dir}/${rel}`) ?? byPath.get(`tests/${rel}`);
        if (hit && hit.kind === 'test' && hit.id !== from.id) use(from, hit, rel);
      }
    }
    // script packages
    for (const m of text.matchAll(REQUIRE_RE)) {
      const hit = byPath.get(`packages/${m[1]}.js`);
      if (hit) use(from, hit, `require('${m[1]}')`);
    }
    // MCP servers by name or id: a test's `server: { name: X }`, a request's `server`
    const names = new Set<string>();
    if (from.kind === 'test') for (const m of text.matchAll(/server:\s*(?:\{[^}\n]*?name:\s*)?["']?([^"'\n,}]+?)["']?\s*(?:[},]|\r?\n|$)/g)) names.add(m[1]!.trim());
    else
      try {
        serverNames(JSON.parse(text), names);
      } catch {
        /* not JSON: nothing to read by key */
      }
    for (const n of names) {
      const s = listOf('mcp-server').find((x) => x.id === n || x.name.toLowerCase() === n.toLowerCase());
      if (s) use(from, { kind: 'mcp-server', id: s.id }, `server ${n}`);
    }
    // the environment a monitor or an item names
    if (from.kind === 'monitor' || from.kind === 'load-test' || from.kind === 'evaluation') {
      const m = /"environment"\s*:\s*"([^"]+)"/.exec(text);
      const e = m && envs.find((x) => x.id === m[1] || x.name === m[1]);
      if (e) use(from, { kind: 'environment', id: e.id }, `environment ${e.name}`);
    }
    if (from.kind === 'mcp-server') {
      const m = /"mockFile"\s*:\s*"([^"]+)"/.exec(text);
      const hit = m && byPath.get(m[1]!);
      if (hit) use(from, hit, 'mock file');
    }

    if (from.kind === 'collection') {
      // a part of a collection (a folder, a request) brings what its own text uses; the saved calls, monitors and tests
      // that belong to the whole collection stay with the whole collection
      const whole = collectionIdOfRef(from.id);
      const isPart = whole !== from.id;
      const c = listOf('collection').find((x) => x.id === whole);
      // saved calls, connections, monitors and load tests that belong to the collection
      if (!isPart)
        for (const { kind, items } of libs)
          for (const i of items) {
            const d = isRecord(i.data) ? i.data : {};
            if (i.collectionId === from.id || d.collectionId === from.id) use(from, { kind, id: i.id }, `belongs to the collection`);
          }
      // test and flow files that refer to the collection by id or name
      tests ??= listOf('test').flatMap((t) => {
        const ref: BundleRef = { kind: 'test', id: t.id };
        const body = read(ref);
        return body === undefined ? [] : [{ ref, text: body }];
      });
      const needles = [from.id, c?.name].filter((x): x is string => !!x);
      for (const t of isPart ? [] : tests) if (needles.some((n) => new RegExp(`collection(?:Id)?\\s*:\\s*["']?${escapeRegex(n)}["']?\\s*$`, 'mi').test(t.text))) use(from, t.ref, 'refers to the collection');
      // the environments that define the variables the collection needs and nothing else here defines
      const own = new Set<string>();
      try {
        const col = JSON.parse(text) as { variables?: Array<{ key?: string }> };
        for (const v of col.variables ?? []) if (v.key) own.add(v.key);
      } catch {
        /* the names below still come from the text */
      }
      const needed = templateVariables(text).filter((v) => !own.has(v) && !wsVars.has(v));
      for (const e of envs) {
        const defined = needed.filter((n) => e.variables.some((v) => v.key === n));
        if (defined.length)
          use(
            from,
            { kind: 'environment', id: e.id },
            `defines ${defined
              .slice(0, 3)
              .map((d) => `{{${d}}}`)
              .join(', ')}${defined.length > 3 ? ' …' : ''}`,
          );
      }
    }
  }
  return { refs: [...seen.values()], edges, missing };
}
