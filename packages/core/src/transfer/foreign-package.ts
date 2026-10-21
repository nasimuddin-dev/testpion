/**
 * A collection for another tool, with what it uses: a Postman package (the v2.1 collection, the environments, the
 * workspace variables as Postman globals, the API definitions, the data files and an `.mcp.json`) or a Bruno collection
 * folder with the same extras. Both are file lists the caller writes to a folder or packs into a zip. Secret values are
 * never in them (the same stripper as a bundle); what the other tool cannot hold (test and flow files, monitors,
 * evaluations, load tests, saved calls) is listed in the notes and in the README, never dropped silently.
 */
import { exportPostmanCollection, exportPostmanEnvironment } from '../import/postman-export.js';
import { collectionToBru } from '../import/bru-export.js';
import { safeFileName } from '../import/export-common.js';
import { ApsError } from '../errors.js';
import type { Collection, Environment, McpServerConfig } from '../model/types.js';
import { SecretStripper, type ReplacedSecret } from '../storage/bundle-secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { itemKey } from './format.js';
import { adapter } from './registry.js';
import { collectUses } from './uses.js';

export interface PackageFile {
  /** Relative, `/` separated, never starting with `/` or holding `..`. */
  path: string;
  data: Buffer;
}

export interface ForeignPackage {
  files: PackageFile[];
  /** What the target cannot hold or was left out, in words. */
  notes: string[];
  replaced: ReplacedSecret[];
  /** The collection as the file name base. */
  name: string;
}

export type PackageTarget = 'postman' | 'bruno';

const text = (s: string): Buffer => Buffer.from(s, 'utf8');
const json = (v: unknown): Buffer => text(JSON.stringify(v, null, 2) + '\n');

/** The `.mcp.json` Claude, VS Code and Cursor read: one entry per MCP server, with variables where secrets were. */
function mcpJson(servers: McpServerConfig[]): Buffer {
  const out: Record<string, unknown> = {};
  for (const s of servers) {
    const x = s as unknown as Record<string, unknown>;
    if (s.transport === 'stdio') out[s.name] = { command: x.command, ...(Array.isArray(x.args) && x.args.length ? { args: x.args } : {}), ...(x.env && Object.keys(x.env as object).length ? { env: x.env } : {}) };
    else if (s.transport === 'streamable-http' || s.transport === 'sse') {
      const headers = Array.isArray(x.headers) ? Object.fromEntries((x.headers as Array<{ key: string; value: string }>).filter((h) => h.key).map((h) => [h.key, h.value])) : undefined;
      out[s.name] = { type: s.transport === 'sse' ? 'sse' : 'http', url: x.url, ...(headers && Object.keys(headers).length ? { headers } : {}) };
    }
  }
  return json({ mcpServers: out });
}

/**
 * The files of a collection package for `target`. Throws when the collection is not in the workspace. Names inside the
 * package come from item names through the one file-name rule (`safeFileName`) and paths of the workspace's own files;
 * nothing is read from outside the workspace.
 */
export function exportCollectionPackage(store: WorkspaceStore, collectionId: string, target: PackageTarget): ForeignPackage {
  let collection: Collection;
  try {
    collection = store.getCollection(collectionId);
  } catch {
    throw new ApsError('ValidationError', `No collection "${collectionId.slice(0, 80)}" in this workspace`);
  }
  const strip = new SecretStripper();
  const c = strip.collection(collection) as Collection;
  const notes: string[] = [];
  const files: PackageFile[] = [];
  const base = safeFileName(c.name, 'collection');

  // what the collection uses, found the way a bundle finds it
  const texts = new Map<string, string | undefined>();
  const read = (r: { kind: Parameters<typeof adapter>[0]; id: string }) => {
    const k = itemKey(r.kind, r.id);
    if (!texts.has(k)) {
      const s = adapter(r.kind).snapshot(store, r.id, new SecretStripper());
      texts.set(k, s && !s.data.includes(0) ? s.data.toString('utf8') : undefined);
    }
    return texts.get(k);
  };
  const uses = collectUses(store, [{ kind: 'collection', id: collection.id }], read);
  const of = (kind: string) => uses.refs.filter((r) => r.kind === kind);

  const envs: Environment[] = [];
  for (const r of of('environment')) {
    const e = store.listEnvironments().find((x) => x.id === r.id && !x.problem);
    if (e) envs.push(strip.environment(e));
  }
  const servers: McpServerConfig[] = [];
  for (const r of of('mcp-server')) {
    const s = store.getMcpServers().find((x) => x.id === r.id);
    if (s) servers.push(strip.mcpServer(s));
  }
  const copy = (refs: Array<{ kind: Parameters<typeof adapter>[0]; id: string }>, dir: string, keep: (path: string) => boolean) => {
    for (const r of refs) {
      const snap = adapter(r.kind).snapshot(store, r.id, strip);
      if (!snap) continue;
      if (!keep(r.id)) {
        notes.push(`${r.id} is not a file this tool reads; it was left out.`);
        continue;
      }
      files.push({ path: `${dir}/${r.id.replace(/^[^/]+\//, '')}`, data: snap.data });
    }
  };

  if (target === 'postman') {
    const r = exportPostmanCollection(c);
    notes.push(...r.notes);
    files.push({ path: `${base}.postman_collection.json`, data: json(r.collection) });
    for (const e of envs) files.push({ path: `environments/${safeFileName(e.name, 'environment')}.postman_environment.json`, data: json(exportPostmanEnvironment(e)) });
    // the workspace's own variables are Postman's globals
    const globals = strip.variables('workspace', 'the workspace variables', (store.workspace.variables ?? []).map((v) => ({ ...v })));
    if (globals?.length)
      files.push({
        path: 'globals.postman_globals.json',
        data: json({ ...exportPostmanEnvironment({ id: 'globals', name: 'Workspace Globals', variables: globals.map((v) => ({ key: v.key, value: v.value, enabled: v.enabled !== false, ...((v as { secret?: boolean }).secret ? { secret: true } : {}) })) }), _postman_variable_scope: 'globals' }),
      });
    copy(of('spec'), 'specs', () => true);
    // data files for the Collection Runner: tables Postman reads
    copy(of('dataset'), 'data', (p) => /\.(csv|json)$/i.test(p));
  } else {
    const wsEnvs = envs;
    for (const f of collectionToBru(c, wsEnvs)) files.push({ path: f.path, data: text(f.text) });
    copy(of('spec'), 'specs', () => true);
    copy(of('dataset'), 'datasets', (p) => /\.(csv|json|jsonl)$/i.test(p));
    const globals = store.workspace.variables ?? [];
    if (globals.length) notes.push(`The ${globals.length} workspace variable${globals.length === 1 ? '' : 's'} (the Globals) have no place in a Bruno collection: add ${globals.length === 1 ? 'it' : 'them'} to an environment there.`);
  }
  if (servers.length) files.push({ path: '.mcp.json', data: mcpJson(servers) });

  // what the other tool does not hold
  const lost = (kind: string, what: string) => {
    const n = of(kind).length;
    if (n) notes.push(`${n} ${what} ${n === 1 ? 'is' : 'are'} not in the ${target === 'postman' ? 'Postman' : 'Bruno'} package: only a TestPion bundle holds ${n === 1 ? 'it' : 'them'}.`);
  };
  lost('test', 'test or flow file');
  lost('monitor', 'monitor');
  lost('evaluation', 'evaluation');
  lost('load-test', 'load test');
  lost('grpc-call', 'saved gRPC call');
  lost('ws-connection', 'saved connection');
  lost('prompt', 'prompt');
  for (const r of of('proto').concat(of('mcp-mock'), of('script-package'))) notes.push(`${r.id} is not in the package (the other tool has no place for it).`);
  if (strip.replaced.length) notes.push(`Replaced ${strip.replaced.length} secret${strip.replaced.length === 1 ? '' : 's'} with variables: ${[...new Set(strip.replaced.map((s) => `{{${s.variable}}}`))].join(', ')}. Set ${strip.replaced.length === 1 ? 'it' : 'them'} in the other tool.`);

  const readme = [
    `# ${c.name}`,
    '',
    `A ${target === 'postman' ? 'Postman' : 'Bruno'} package made by TestPion: the collection with what it uses. Secret values are not in it.`,
    '',
    '## Files',
    '',
    ...files.map((f) => `- ${f.path}`),
    ...(notes.length ? ['', '## Not included', '', ...notes.map((n) => `- ${n}`)] : []),
    '',
  ].join('\n');
  files.push({ path: 'README.md', data: text(readme) });
  return { files, notes, replaced: strip.replaced, name: base };
}
