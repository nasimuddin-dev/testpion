/**
 * The workspace export of earlier versions (`testpion-workspace`, and the project's older names: one JSON file with
 * collections, environments, tests, saved items and files) read as a bundle, so it gets the preview, the conflict
 * choices and Undo of every import, and merges into the open workspace (importing it as a new workspace stays
 * `importWorkspaceBundle`). Every section is shape-checked here; what does not fit is skipped with a warning.
 */
import { LIBRARY_OF, RAW_ROOT, isPlainId, plainName, type BundleKindId, type ParsedBundle } from './format.js';
import { canonicalJson } from './items.js';
import { assemble, type BundlePart } from './container.js';
import { ENGINE_VERSION } from '../version.js';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const objects = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObject) : []);

const KIND_OF_LIBRARY = new Map<string, BundleKindId>(Object.entries(LIBRARY_OF).map(([k, lib]) => [lib!, k as BundleKindId]));
const KIND_OF_ROOT = new Map<string, BundleKindId>(Object.entries(RAW_ROOT).map(([k, root]) => [root!, k as BundleKindId]));

export function legacyToBundle(raw: Record<string, unknown>): ParsedBundle {
  const warnings: string[] = [];
  const parts: BundlePart[] = [];
  const seen = new Set<string>();
  const add = (kind: BundleKindId, id: unknown, name: unknown, data: Buffer) => {
    if (!isPlainId(id)) {
      warnings.push(`Skipped a ${kind} with no usable id.`);
      return;
    }
    const key = `${kind}:${id}`;
    if (seen.has(key)) {
      warnings.push(`Skipped a second ${kind} "${id.slice(0, 60)}".`);
      return;
    }
    seen.add(key);
    parts.push({ item: { kind, id, name: plainName(name, id) }, data });
  };
  const noMeta = (o: Record<string, unknown>) => {
    const { version: _v, updatedAt: _u, problem: _p, ...rest } = o;
    void _v;
    void _u;
    void _p;
    return rest;
  };
  for (const c of objects(raw.collections)) add('collection', c.id, c.name, canonicalJson(noMeta(c)));
  for (const e of objects(raw.environments)) add('environment', e.id, e.name, canonicalJson(noMeta(e)));
  for (const s of objects(raw.mcpServers)) add('mcp-server', s.id, s.name, canonicalJson(s));
  for (const p of objects(raw.providers)) add('provider', p.id, p.name, canonicalJson(p));
  if (isObject(raw.tests)) for (const [rel, text] of Object.entries(raw.tests)) if (typeof text === 'string') add('test', `tests/${rel}`, `tests/${rel}`, Buffer.from(text, 'utf8'));
  if (isObject(raw.library))
    for (const [lib, v] of Object.entries(raw.library)) {
      const kind = KIND_OF_LIBRARY.get(lib);
      if (!kind) {
        warnings.push(`Skipped the saved items of "${lib}": this version does not import them.`);
        continue;
      }
      if (isObject(v)) for (const i of objects(v.items)) add(kind, i.id, i.name, canonicalJson(noMeta(i)));
    }
  if (isObject(raw.packages)) for (const [name, code] of Object.entries(raw.packages)) if (typeof code === 'string') add('script-package', `packages/${name}.js`, name, Buffer.from(code, 'utf8'));
  for (const f of objects(raw.files)) {
    const path = typeof f.path === 'string' ? f.path : '';
    const kind = KIND_OF_ROOT.get(path.split('/')[0] ?? '');
    if (!kind || kind === 'test' || kind === 'script-package' || typeof f.content !== 'string' || (f.encoding !== 'utf8' && f.encoding !== 'base64')) {
      warnings.push(`Skipped the file ${JSON.stringify(path.slice(0, 120))}: not under specs/, datasets/, mocks/ or protos/, or not text or base64.`);
      continue;
    }
    add(kind, path, path, f.encoding === 'base64' ? Buffer.from(f.content, 'base64') : Buffer.from(f.content, 'utf8'));
  }
  const ws = isObject(raw.workspace) ? raw.workspace : {};
  const b = assemble(
    {
      title: plainName(ws.name, 'Workspace export'),
      createdBy: { app: 'testpion', version: ENGINE_VERSION },
      createdAt: typeof raw.exportedAt === 'string' ? raw.exportedAt.slice(0, 40) : new Date().toISOString(),
      root: [],
      edges: [],
      missing: [],
      requires: { secrets: objects(raw.replaced).filter((r) => typeof r.variable === 'string').map((r) => ({ name: String(r.variable).slice(0, 120), where: `${String(r.item ?? '').slice(0, 150)} ${String(r.field ?? '').slice(0, 100)}`.trim() })), osEnv: [] },
      flags: { scripts: 0, production: [], strippedSecrets: 0, stdioServers: [] },
      notes: ['Read from a workspace export made by an earlier version of TestPion.'],
    },
    parts,
    'legacy-workspace',
    warnings,
  );
  return b;
}
