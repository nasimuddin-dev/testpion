/**
 * Export: items of the workspace (a selection, a section, everything, or a collection with what it uses) into one
 * bundle. Secret values are never written: every item goes through the one SecretStripper (storage/bundle-secrets.ts),
 * and what it replaced is listed in the manifest (`requires.secrets`) and in the answer, never the value.
 */
import { ApsError } from '../errors.js';
import { SecretStripper, type ReplacedSecret } from '../storage/bundle-secrets.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { ENGINE_VERSION } from '../version.js';
import { assemble, serialize, wantsZip, type BundlePart } from './container.js';
import { DATASET_EMBED_BYTES, itemKey, type BundleItem, type BundleKindId, type BundleManifest, type ParsedBundle } from './format.js';
import { noun } from './items.js';
import { adapter, ALL_BUNDLE_KINDS } from './registry.js';
import { everythingRefs, uniqueRefs, type BundleRef } from './selection.js';
import { collectUses } from './uses.js';

export interface BuildOptions {
  /** Add what the picked items use (a collection's environments, API definitions, datasets, mocks, protos, tests, flows …). */
  uses?: boolean;
  /** AI providers are left out of a whole-workspace export unless asked for (a provider picked by hand is always in). */
  providers?: boolean;
  /** Datasets: `auto` embeds up to 10 MB and sends bigger ones by reference; `embed` always; `reference` never. */
  datasets?: 'auto' | 'embed' | 'reference';
  /** The file form; `auto`: a zip when there is a binary file, more than 5 MB or more than 200 entries, else JSON. */
  format?: 'zip' | 'json' | 'auto';
  title?: string;
  /** The dataset size that still travels inside the bundle (default 10 MB). */
  embedBytes?: number;
}

export interface BuildResult {
  bytes: Buffer;
  format: 'zip' | 'json';
  /** `<title>.testpion.zip` or `.json`: a name any OS can hold. */
  fileName: string;
  manifest: BundleManifest;
  /** Items by kind. */
  counts: Partial<Record<BundleKindId, number>>;
  replaced: ReplacedSecret[];
  notes: string[];
  /** What the bundle holds, what was replaced and what was left out, in words (the CLI, the app and MCP print the same). */
  lines: string[];
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 1024 * 1024 ? 2 : 1)} MB`;
const label = (k: BundleKindId, n: number) => `${n} ${adapter(k).label}${n === 1 ? '' : 's'}`;

/** The default file name of a bundle: `<title>.testpion.zip` / `.json`. */
export function bundleFileName(title: string, format: 'zip' | 'json'): string {
  const safe = String(title ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 120);
  return `${safe || 'bundle'}.testpion.${format}`;
}

const isTextual = (b: Buffer) => !b.includes(0);

/** Build a bundle of `selection` (the picked items; `opts.uses` adds what they use). Throws when a picked item is not there. */
export function buildBundle(store: WorkspaceStore, selection: readonly BundleRef[] | 'all', opts: BuildOptions = {}): BuildResult {
  const roots = selection === 'all' ? everythingRefs(store, { providers: opts.providers }) : uniqueRefs(selection);
  if (!roots.length) throw new ApsError('ValidationError', 'Nothing to export: the selection is empty');
  const strip = new SecretStripper();
  const notes: string[] = [];

  // what an item says about what it uses is read from a stripper of its own: only items that end up in the bundle count
  const texts = new Map<string, string | undefined>();
  const readText = (r: BundleRef): string | undefined => {
    const key = itemKey(r.kind, r.id);
    if (!texts.has(key)) {
      const s = adapter(r.kind).snapshot(store, r.id, new SecretStripper());
      texts.set(key, s && isTextual(s.data) ? s.data.toString('utf8') : undefined);
    }
    return texts.get(key);
  };

  if (selection !== 'all')
    for (const r of roots) if (!adapter(r.kind).snapshot(store, r.id, new SecretStripper())) throw new ApsError('ValidationError', `No ${noun(adapter(r.kind).label)} "${r.id}" in this workspace`, { suggestions: ['`testpion export --section <kind>` lists nothing by itself: use `testpion kinds` for the kinds and the app for the names'] });

  let refs: BundleRef[] = roots;
  let edges: BundleManifest['edges'] = [];
  let missing: BundleManifest['missing'] = [];
  if (opts.uses) {
    const u = collectUses(store, roots, readText);
    refs = u.refs;
    edges = u.edges;
    missing = u.missing;
  }
  const rootKeys = new Set(roots.map((r) => itemKey(r.kind, r.id)));
  // a provider that was only found as a use is a person's setup, not the project's: left out unless asked for
  refs = refs.filter((r) => r.kind !== 'provider' || opts.providers || rootKeys.has(itemKey(r.kind, r.id)));
  refs.sort((a, b) => ALL_BUNDLE_KINDS.indexOf(a.kind) - ALL_BUNDLE_KINDS.indexOf(b.kind) || a.id.localeCompare(b.id));

  const embedBytes = opts.embedBytes ?? DATASET_EMBED_BYTES;
  const datasets = opts.datasets ?? 'auto';
  const parts: BundlePart[] = [];
  const unscanned: string[] = [];
  const production: string[] = [];
  const stdio: string[] = [];
  const osEnv = new Set<string>();
  let scripts = 0;
  for (const r of refs) {
    const snap = adapter(r.kind).snapshot(store, r.id, strip);
    if (!snap) {
      notes.push(`${adapter(r.kind).label} ${r.id} is gone from the workspace and was left out.`);
      continue;
    }
    if (snap.unscanned) unscanned.push(r.id);
    const item: BundleItem = { kind: r.kind, id: snap.id, name: snap.name, ...(snap.summary ? { summary: snap.summary } : {}) };
    if (r.kind === 'collection') scripts += Number(snap.summary?.scripts ?? 0);
    if (r.kind === 'environment' && snap.summary?.production) production.push(snap.name);
    if (r.kind === 'mcp-server' && snap.summary?.transport === 'stdio') stdio.push(snap.name);
    if (isTextual(snap.data)) for (const m of snap.data.toString('utf8').matchAll(/connectionEnv["']?\s*:\s*["']?([A-Za-z_][A-Za-z0-9_]*)/g)) osEnv.add(m[1]!);
    if (r.kind === 'dataset' && (datasets === 'reference' || (datasets === 'auto' && snap.data.length > embedBytes))) {
      parts.push({ item: { ...item, summary: { ...item.summary, bytes: snap.data.length } } });
      notes.push(`Dataset ${snap.id} (${mb(snap.data.length)}) travels by reference: the file is not in the bundle. Copy it to the other workspace by hand${datasets === 'auto' ? ', or export with datasets embedded' : ''}.`);
      continue;
    }
    parts.push({ item, data: snap.data });
  }
  if (!parts.length) throw new ApsError('ValidationError', 'Nothing to export: the selected items are not in the workspace');
  if (unscanned.length) notes.push(`Exported as is (not scanned for secrets): ${unscanned.slice(0, 20).join(', ')}${unscanned.length > 20 ? ` and ${unscanned.length - 20} more` : ''}.`);

  const replaced = strip.replaced;
  const secrets = [...new Map(replaced.map((x) => [x.variable, { name: x.variable, where: `${x.item}, ${x.field}` }])).values()];
  const first = roots.length === 1 ? parts.find((p) => p.item.kind === roots[0]!.kind && p.item.id === roots[0]!.id)?.item.name : undefined;
  const title = opts.title ?? (first ? (opts.uses ? `${first} (with everything it uses)` : first) : selection === 'all' ? `${store.workspace.name}` : `${parts.length} items from ${store.workspace.name}`);
  const bundle: ParsedBundle = assemble(
    {
      title,
      createdBy: { app: 'testpion', version: ENGINE_VERSION },
      root: roots.map((r) => ({ kind: r.kind, id: r.id })),
      edges,
      missing,
      requires: { secrets: secrets.slice(0, 500), osEnv: [...osEnv].slice(0, 100) },
      flags: { scripts, production, strippedSecrets: replaced.length, stdioServers: stdio },
      notes,
    },
    parts,
  );
  const format = opts.format && opts.format !== 'auto' ? opts.format : wantsZip(bundle) ? 'zip' : 'json';
  const bytes = serialize(bundle, format);

  const counts: Partial<Record<BundleKindId, number>> = {};
  for (const i of bundle.manifest.items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  const lines = [`Exported ${bundle.manifest.items.length} item${bundle.manifest.items.length === 1 ? '' : 's'}: ${(Object.entries(counts) as Array<[BundleKindId, number]>).map(([k, n]) => label(k, n)).join(', ')}.`];
  if (replaced.length) lines.push(`Replaced ${replaced.length} secret${replaced.length === 1 ? '' : 's'} with variables: ${secrets.map((s) => `{{${s.name}}}`).join(', ')}. Set them in the other workspace.`);
  if (missing.length) lines.push(`Named but not in the workspace (${missing.length}): ${missing.slice(0, 5).map((m) => m.to).join(', ')}${missing.length > 5 ? ' …' : ''}.`);
  lines.push(...notes);
  return { bytes, format, fileName: bundleFileName(title, format), manifest: bundle.manifest, counts, replaced, notes, lines };
}
