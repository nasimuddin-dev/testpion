/**
 * Putting a bundle's parts together: entry names, checksums and sizes are made in one place (container.ts reads and writes the
 * zip and JSON forms; legacy.ts makes parts from the old workspace export).
 */
import { BUNDLE_FORMAT, BUNDLE_VERSION, LIBRARY_OF, RAW_ROOT, sha256, type BundleItem, type BundleKindId, type BundleManifest, type ParsedBundle } from './format.js';

const JSON_DIR: Partial<Record<BundleKindId, string>> = { collection: 'collections', environment: 'environments', 'mcp-server': 'mcp-servers', provider: 'providers' };

/** The entry name of an item: `files/<path>` for a file kind, `<folder>/<id>.json` for the rest (made unique without case). */
export function entryNameFor(kind: BundleKindId, id: string, taken: Set<string>): string {
  if (RAW_ROOT[kind]) {
    const n = `files/${id}`;
    taken.add(n.toLowerCase());
    return n;
  }
  const dir = JSON_DIR[kind] ?? `library/${LIBRARY_OF[kind] ?? kind}`;
  const base =
    id
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 100) || 'item';
  let name = `${dir}/${base}.json`;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${dir}/${base}-${i}.json`;
  taken.add(name.toLowerCase());
  return name;
}

export type PartMeta = Omit<BundleItem, 'entry' | 'sha256' | 'size' | 'mode'>;
export interface BundlePart {
  item: PartMeta;
  /** Absent: the item travels by reference (a dataset over the embed limit). */
  data?: Buffer;
}

/** The manifest fields the exporter fills (everything but the item list, which `assemble` makes from the parts). */
export type ManifestMeta = Pick<BundleManifest, 'title' | 'root' | 'edges' | 'missing' | 'requires' | 'flags' | 'notes'> & { createdBy: BundleManifest['createdBy']; createdAt?: string };

/** Parts → a bundle: entry names, checksums and sizes are made here, so no caller can write them wrong. */
export function assemble(meta: ManifestMeta, parts: BundlePart[], source: ParsedBundle['source'] = 'zip', warnings: string[] = []): ParsedBundle {
  const taken = new Set<string>(['manifest.json', 'readme.md']);
  const entries = new Map<string, Buffer>();
  const items: BundleItem[] = parts.map((p) => {
    if (!p.data) return { ...p.item, mode: 'reference' };
    const entry = entryNameFor(p.item.kind, p.item.id, taken);
    entries.set(entry, p.data);
    return { ...p.item, entry, sha256: sha256(p.data), size: p.data.length, mode: 'embed' };
  });
  const manifest: BundleManifest = { format: BUNDLE_FORMAT, formatVersion: BUNDLE_VERSION, createdAt: new Date().toISOString(), ...meta, items };
  return { manifest, entries, source, warnings };
}
