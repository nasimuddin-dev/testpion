/**
 * Putting a bundle together and taking it apart: the manifest and the entries as a zip or as the JSON form, with every
 * check a reader owes a file from outside (size limits, checksums, entry names, the manifest's shape).
 */
import { ApsError } from '../errors.js';
import { WORKSPACE_FORMATS } from '../storage/workspace-formats.js';
import { writeZip, readZip, looksLikeZip, badEntryName, type ZipLimits, ZIP_LIMITS } from './zip.js';
import {
  TRANSFER_LIMITS,
  checkManifest,
  parseJsonSafe,
  sha256,
  type BundleManifest,
  type ParsedBundle,
  type TransferLimits,
} from './format.js';
import { legacyToBundle } from './legacy.js';

export { assemble, entryNameFor, type BundlePart, type ManifestMeta, type PartMeta } from './assemble.js';

const refuse = (why: string): never => {
  throw new ApsError('ValidationError', `Not a valid TestPion bundle: ${why}`, { suggestions: ['Export the items again', '`testpion bundle inspect <file>` says what is wrong'] });
};

/** A short README for a person who opens the zip: never read on import. */
function readme(m: BundleManifest): string {
  const lines = [
    `# ${m.title}`,
    '',
    `A TestPion bundle (format ${m.formatVersion}), made by ${m.createdBy.app} ${m.createdBy.version} on ${m.createdAt}.`,
    '',
    'Import it in TestPion with Import…, or `testpion import <file> --preview`.',
    '',
    '## Items',
    '',
  ];
  for (const i of m.items) lines.push(`- ${i.kind}: ${i.name}${i.mode === 'reference' ? ' (by reference: the file is not included)' : ''}`);
  if (m.requires.secrets.length) lines.push('', '## Fill in after import', '', ...m.requires.secrets.map((s) => `- ${s.name} (${s.where})`));
  if (m.notes.length) lines.push('', '## Notes', '', ...m.notes.map((n) => `- ${n}`));
  return lines.join('\n') + '\n';
}

/** Whether a bundle should be a zip: binary entries, many entries or a large total do not belong in a JSON file. */
export function wantsZip(b: ParsedBundle): boolean {
  let total = 0;
  for (const d of b.entries.values()) {
    total += d.length;
    if (d.includes(0) || !Buffer.from(d.toString('utf8'), 'utf8').equals(d)) return true;
  }
  return total > 5 * 1024 * 1024 || b.entries.size > 200;
}

/** The file's bytes: a zip (manifest.json, README.md and the entries), or the JSON form (the manifest's fields and `entries`). */
export function serialize(b: ParsedBundle, format: 'zip' | 'json'): Buffer {
  if (format === 'zip') {
    return writeZip([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(b.manifest, null, 2) + '\n', 'utf8') },
      { name: 'README.md', data: Buffer.from(readme(b.manifest), 'utf8') },
      ...[...b.entries].map(([name, data]) => ({ name, data })),
    ]);
  }
  const entries: Record<string, { encoding: 'utf8' | 'base64'; content: string }> = {};
  for (const [name, data] of b.entries) {
    const text = data.toString('utf8');
    entries[name] = !data.includes(0) && Buffer.from(text, 'utf8').equals(data) ? { encoding: 'utf8', content: text } : { encoding: 'base64', content: data.toString('base64') };
  }
  return Buffer.from(JSON.stringify({ ...b.manifest, entries }, null, 2) + '\n', 'utf8');
}

/** Whether bytes could be a bundle of any form (a zip, the JSON form, or a workspace export of earlier versions). */
export function looksLikeBundle(bytes: Buffer): boolean {
  if (looksLikeZip(bytes)) return true;
  const head = bytes.toString('utf8', 0, Math.min(bytes.length, 4000));
  return /"format"\s*:\s*"(testpion-bundle|testpion-workspace|fluxpion-workspace|protopion-workspace|protolens-workspace)"/.test(head);
}

export interface ReadOptions {
  limits?: TransferLimits;
  zip?: ZipLimits;
}

/**
 * Read a bundle file of any form. A zip is read with the hardened reader; the JSON form is parsed without `__proto__`
 * keys; a workspace export of earlier versions is converted. Then every embedded item's checksum is verified: a
 * mismatch is a hard error, never a warning.
 */
export function readBundle(bytes: Buffer, opts: ReadOptions = {}): ParsedBundle {
  const limits = opts.limits ?? TRANSFER_LIMITS;
  if (bytes.length > limits.fileBytes) refuse(`the file is ${bytes.length} bytes (at most ${limits.fileBytes})`);
  let manifestRaw: unknown;
  const entries = new Map<string, Buffer>();
  let source: ParsedBundle['source'];
  if (looksLikeZip(bytes)) {
    source = 'zip';
    const files = readZip(bytes, { ...ZIP_LIMITS, ...opts.zip });
    const m = files.find((f) => f.name === 'manifest.json');
    if (!m) return refuse('there is no manifest.json in the archive');
    if (m.data.length > limits.manifestBytes) refuse('the manifest is too large');
    try {
      manifestRaw = parseJsonSafe(m.data.toString('utf8'));
    } catch {
      return refuse('manifest.json is not valid JSON');
    }
    for (const f of files) if (f.name !== 'manifest.json') entries.set(f.name, f.data);
  } else {
    let raw: unknown;
    try {
      raw = parseJsonSafe(bytes.toString('utf8'));
    } catch {
      return refuse('it is neither a zip archive nor a JSON file');
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && WORKSPACE_FORMATS.has(String((raw as Record<string, unknown>).format))) return legacyToBundle(raw as Record<string, unknown>);
    source = 'json';
    const o = raw as Record<string, unknown>;
    const { entries: inline, ...rest } = o ?? {};
    manifestRaw = rest;
    if (inline !== undefined && (!inline || typeof inline !== 'object' || Array.isArray(inline))) refuse('"entries" is not an object');
    for (const [name, v] of Object.entries((inline as Record<string, unknown>) ?? {})) {
      const why = badEntryName(name);
      if (why) refuse(why);
      const e = v as { encoding?: unknown; content?: unknown };
      if (!e || typeof e.content !== 'string' || (e.encoding !== 'utf8' && e.encoding !== 'base64')) refuse(`entry "${name}" is not text or base64`);
      entries.set(name, e.encoding === 'base64' ? Buffer.from(e.content as string, 'base64') : Buffer.from(e.content as string, 'utf8'));
    }
  }
  const { manifest, warnings } = checkManifest(manifestRaw, limits);
  for (const i of manifest.items) {
    if (i.mode === 'reference') continue;
    const name = i.entry!;
    const why = badEntryName(name);
    if (why) refuse(why);
    const data = entries.get(name);
    if (!data) refuse(`the entry "${name}" of ${i.kind} ${JSON.stringify(i.id.slice(0, 80))} is missing`);
    if (sha256(data!) !== i.sha256) refuse(`the entry "${name}" does not match its checksum (the file was changed or damaged)`);
  }
  const listed = new Set(manifest.items.map((i) => i.entry));
  const extra = [...entries.keys()].filter((n) => !listed.has(n) && n.toLowerCase() !== 'readme.md');
  if (extra.length) warnings.push(`Ignored ${extra.length} file${extra.length === 1 ? '' : 's'} the manifest does not list: ${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ' …' : ''}.`);
  return { manifest, entries, source, warnings };
}
