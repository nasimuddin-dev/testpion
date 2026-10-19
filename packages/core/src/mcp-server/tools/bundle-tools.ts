import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { ApsError } from '../../errors.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import {
  TRANSFER_LIMITS,
  applyImport,
  buildBundle,
  describeBundle,
  listImports,
  parseSelector,
  previewImport,
  readBundle,
  recallBundle,
  rememberBundle,
  sectionRefs,
  undoImport,
  type BundleRef,
  type ImportChoice,
  type ParsedBundle,
} from '../../transfer/index.js';
import { str, type Tool } from '../tool.js';

/**
 * MCP tools for TestPion bundles (.testpion.zip / .testpion.json): export items (a collection with everything it uses, a
 * section, the whole workspace), read one without importing (`describe_bundle`), preview an import (read-only: the
 * answer's `plan_id` is what the one write needs), apply it with the person's conflict choices, and undo it. The apply
 * is the only write and asks for confirmation; nothing in a bundle runs, and secret values are never in one.
 * Files are inside the workspace (the default for an export is `.local/exports/`, which git ignores).
 */
export function bundleTools({ store }: { store: WorkspaceStore }): Tool[] {
  const choices = ['keep-both', 'replace', 'skip'];
  const readFrom = (a: Record<string, unknown>): ParsedBundle => {
    let bytes: Buffer;
    if (typeof a.base64 === 'string' && a.base64) bytes = Buffer.from(a.base64, 'base64');
    else if (typeof a.file === 'string' && a.file) {
      const p = store.safePath(a.file);
      if (!existsSync(p)) throw new ApsError('ValidationError', `No file ${a.file} in the workspace`, { suggestions: ['Give a path relative to the workspace, or the bundle as base64'] });
      if (statSync(p).size > TRANSFER_LIMITS.fileBytes) throw new ApsError('ValidationError', `${a.file} is too large to be a bundle`);
      bytes = readFileSync(p);
    } else throw new ApsError('ValidationError', 'Give the bundle as `file` (a path in the workspace) or `base64`');
    return readBundle(bytes);
  };
  return [
    {
      name: 'export_bundle',
      write: true,
      description:
        'Export items of the workspace into one TestPion bundle file (.testpion.zip, or .testpion.json when small and text only). Pick `items` (kind:id such as collection:<id>, spec:specs/<path>, dataset:<name>, mcp-server:<id>, environment:<id>, test:<path>, or an ItemRef from search_workspace), or a whole `section` (collection, environment, spec, dataset, test, mcp-server, mcp-mock, proto, script-package, prompt, load-test, evaluation, monitor, grpc-call, ws-connection, provider), or `all`. `uses: true` adds what the items use (a collection: its environments, API definitions, datasets, MCP servers and mocks, protos, packages, test and flow files, saved calls, monitors); what is named but not in the workspace comes back in `missing`. Secret values are never written: each is replaced by a {{variable}} (listed in `replaced` and `requires.secrets`, with the variable to set after an import). Datasets over 10 MB go by reference (`datasets: "embed"` forces them in). The file is written inside the workspace (default .local/exports/<title>.testpion.zip); returns its path, the items, what was replaced and what was left out.',
      inputSchema: {
        type: 'object',
        properties: {
          items: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] }, description: 'What to export: kind:id strings or ItemRef objects; a bare word is a collection name' },
          section: str('Or every item of one kind, e.g. mcp-server or dataset'),
          all: { type: 'boolean', description: 'Or the whole workspace (AI providers only with `providers: true`)' },
          uses: { type: 'boolean', description: 'Add everything the items use' },
          datasets: { type: 'string', enum: ['auto', 'embed', 'reference'], description: 'auto (default): embed up to 10 MB, bigger by reference' },
          providers: { type: 'boolean', description: 'Include AI providers in a whole-workspace or section export' },
          title: str('The bundle’s title (its file name)'),
          out: str('Where to write it, relative to the workspace (.zip or .json; default .local/exports/<title>.testpion.zip)'),
        },
      },
      run: (a) => {
        let refs: BundleRef[] | 'all';
        if (a.all === true) refs = 'all';
        else if (typeof a.section === 'string' && a.section) refs = sectionRefs(store, a.section);
        else if (Array.isArray(a.items) && a.items.length) refs = a.items.map((x) => parseSelector(store, x));
        else throw new ApsError('ValidationError', 'Name what to export: `items`, a `section`, or `all`');
        const out = typeof a.out === 'string' && a.out ? a.out : undefined;
        const ext = out ? /\.(zip|json)$/i.exec(out)?.[1]?.toLowerCase() : undefined;
        const b = buildBundle(store, refs, {
          uses: a.uses === true,
          datasets: a.datasets === 'embed' || a.datasets === 'reference' ? a.datasets : 'auto',
          providers: a.providers === true,
          title: typeof a.title === 'string' && a.title ? a.title : undefined,
          format: ext === 'zip' || ext === 'json' ? ext : 'auto',
        });
        const file = store.safePath(out ?? `.local/exports/${b.fileName}`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, b.bytes);
        return {
          path: relative(store.root, file).split('\\').join('/'),
          absolutePath: file,
          format: b.format,
          size: b.bytes.length,
          title: b.manifest.title,
          counts: b.counts,
          items: b.manifest.items.map((i) => ({ kind: i.kind, id: i.id, name: i.name, ...(i.mode === 'reference' ? { mode: 'reference' } : {}) })),
          replaced: b.replaced,
          requires: b.manifest.requires,
          missing: b.manifest.missing,
          notes: b.notes,
        };
      },
    },
    {
      name: 'describe_bundle',
      description:
        'Read a TestPion bundle (or a workspace export of an earlier version) without importing it: its title and maker, the items by kind, what it needs (secrets to fill in, environment variables), what to review before running (scripts, programs an MCP server starts, production environments), anything used but missing. Changes nothing. Give `file` (a path in the workspace) or `base64`.',
      inputSchema: { type: 'object', properties: { file: str('The bundle, relative to the workspace'), base64: str('Or the bundle’s bytes as base64') } },
      run: (a) => describeBundle(readFrom(a)),
    },
    {
      name: 'import_bundle_preview',
      description:
        'Say what importing a bundle would do in this workspace, item by item, without changing anything: `create` (not here yet), `identical` (already here, byte for byte), `conflict` (something else is here; `proposed` is what Keep both would name it) or `invalid` (refused, with why). Also what to review before running and what to fill in. The answer’s `plan_id` is what import_bundle_apply takes: it applies exactly this. Give `file` (a path in the workspace) or `base64`.',
      inputSchema: { type: 'object', properties: { file: str('The bundle, relative to the workspace'), base64: str('Or the bundle’s bytes as base64') } },
      run: (a) => {
        const bundle = readFrom(a);
        return { plan_id: rememberBundle(store, bundle), ...previewImport(store, bundle) };
      },
    },
    {
      name: 'import_bundle_apply',
      write: true,
      description:
        'Import a previewed bundle (the `plan_id` of import_bundle_preview) into this workspace. `on_conflict` says what happens to an item that is already here: keep-both (default; the incoming one is renamed), replace (yours is overwritten; undo_import restores it) or skip. `decisions` overrides single items ("kind:id": choice); `only` limits the import to kinds or kind:id items. Scripts are never run, MCP servers that start a program stay untrusted, no URL is fetched. Returns what was created, replaced and skipped, the `import_id` that undo_import takes, and the variables to fill in. Ask the user before applying.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: str('The plan_id from import_bundle_preview'),
          on_conflict: { type: 'string', enum: choices, description: 'keep-both (default), replace or skip' },
          decisions: { type: 'object', description: 'Per item: { "spec:specs/pets.yaml": "replace" }' },
          only: { type: 'array', items: { type: 'string' }, description: 'Kinds (spec) or kind:id items to import; everything else is left out' },
        },
        required: ['plan_id'],
      },
      run: (a) => {
        if (a.on_conflict !== undefined && !choices.includes(String(a.on_conflict))) throw new ApsError('ValidationError', `on_conflict is one of ${choices.join(', ')}`);
        return applyImport(store, recallBundle(store, String(a.plan_id ?? '')), {
          onConflict: a.on_conflict as ImportChoice | undefined,
          decisions: a.decisions && typeof a.decisions === 'object' ? (a.decisions as Record<string, ImportChoice | 'import'>) : undefined,
          only: Array.isArray(a.only) ? a.only.map(String) : undefined,
        });
      },
    },
    {
      name: 'undo_import',
      write: true,
      description:
        'Take back a bundle import as one step: the items it made are removed and the ones it replaced come back byte for byte. A file that changed after the import is left as it is and named in `keptChanged`. Without `import_id` it lists the imports that can still be undone.',
      inputSchema: { type: 'object', properties: { import_id: str('The import_id import_bundle_apply returned') } },
      run: (a) => (typeof a.import_id === 'string' && a.import_id ? undoImport(store, a.import_id) : { imports: listImports(store) }),
    },
  ];
}
