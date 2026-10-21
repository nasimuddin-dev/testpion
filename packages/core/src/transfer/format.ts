/**
 * Bundle format v1 (docs/getting-started/export-import.md has the user-facing description): what a `.testpion.zip` or
 * `.testpion.json` holds, and the checks every reader applies before it believes a word of it.
 *
 * A bundle is a **selection**, not a nesting: any items of the workspace, with whatever they use when asked, in one
 * file. `manifest.json` lists the items (kind, id, name, size, sha256, entry name); one entry per item holds its
 * content. The zip form has the manifest and the entries as files; the JSON form is the manifest's fields plus
 * `entries` (utf8 text or base64 per entry), small and pasteable.
 *
 * The importer never uses a name from the file as a place to write: a file's destination is computed from the item's
 * kind and id, after the same path rules as every other import (workspace-bundle.ts `bundleFilePath`).
 */
import { ApsError } from '../errors.js';
import { safeKey } from '../util/safe-key.js';
import { isRecord } from '@testpion/shared';

export const BUNDLE_FORMAT = 'testpion-bundle';
/** The format version this build writes and the highest it reads (a higher one is refused: "update TestPion"). */
export const BUNDLE_VERSION = 1;

/** The kinds a bundle can hold: the registry kinds with the export and import capabilities (a flow is a test file). */
export const BUNDLE_KIND_IDS = [
  'collection',
  'environment',
  'test',
  'spec',
  'dataset',
  'proto',
  'script-package',
  'mcp-server',
  'mcp-mock',
  'provider',
  'grpc-call',
  'ws-connection',
  'prompt',
  'load-test',
  'evaluation',
  'monitor',
] as const;
export type BundleKindId = (typeof BUNDLE_KIND_IDS)[number];

export const isBundleKind = (k: unknown): k is BundleKindId => typeof k === 'string' && (BUNDLE_KIND_IDS as readonly string[]).includes(k);

/** The most a bundle may be, read or written in this process (the CLI's `--max-size` and tests lower them). */
export interface TransferLimits {
  /** Largest bundle file, in bytes. */
  fileBytes: number;
  /** Largest manifest, in bytes. */
  manifestBytes: number;
  /** Most items. */
  items: number;
}
export const TRANSFER_LIMITS: Readonly<TransferLimits> = { fileBytes: 1536 * 1024 * 1024, manifestBytes: 16 * 1024 * 1024, items: 20_000 };

/** A dataset up to this size travels inside the bundle; a bigger one goes by reference unless `datasets: 'embed'` is asked for. */
export const DATASET_EMBED_BYTES = 10 * 1024 * 1024;

/** One item of the manifest. */
export interface BundleItem {
  kind: BundleKindId;
  /** The item's identity in the source workspace: an id, or the workspace path of a file. */
  id: string;
  name: string;
  /** The entry holding its content (absent for a dataset sent by reference). */
  entry?: string;
  sha256?: string;
  size?: number;
  /** `reference`: only the description travels (a dataset over the embed limit): the importer says where to copy the file from. */
  mode?: 'embed' | 'reference';
  summary?: Record<string, string | number>;
}

export interface BundleEdge {
  from: string;
  to: string;
  via: string;
}

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  formatVersion: number;
  createdBy: { app: string; version: string };
  createdAt: string;
  title: string;
  /** What the user picked; the rest came in because something picked uses it. */
  root: Array<{ kind: BundleKindId; id: string }>;
  items: BundleItem[];
  /** The dependency graph: who uses whom (display only, the importer never acts on it). */
  edges: BundleEdge[];
  /** Used by an item but not in the bundle (left out, or not in the workspace). */
  missing: Array<{ from: string; to: string; reason: string }>;
  requires: {
    /** Variables the exporter replaced a secret with: set them after import. */
    secrets: Array<{ name: string; where: string }>;
    /** Environment variables the bundle's datasets read (`connectionEnv`). */
    osEnv: string[];
  };
  flags: { scripts: number; production: string[]; strippedSecrets: number; stdioServers: string[] };
  /** What was left out and why, in words. */
  notes: string[];
}

/** A bundle read and checked: the manifest and the bytes of each entry (never trusted names: see `entryOf`). */
export interface ParsedBundle {
  manifest: BundleManifest;
  /** Entry name → content. */
  entries: Map<string, Buffer>;
  /** Where it came from: a zip, the JSON form, or a workspace export of earlier versions read as a bundle. */
  source: 'zip' | 'json' | 'legacy-workspace';
  /** What the reader noticed (unknown kinds skipped, fields it does not know): shown in the preview. */
  warnings: string[];
}

export { sha256Hex as sha256 } from '../util/hash.js';

/* ------------------------------------------------------------------ ids and names */

/** An id that becomes (part of) a file name: letters, digits, `.`, `_`, `-`; no leading dot; at most 120 characters. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/** An id of an item kept inside a JSON file (an MCP server, a library item): any printable text, bounded. */
export const isPlainId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id);

/** A name for display: text, bounded, with no control characters. */
export const plainName = (v: unknown, fallback: string): string =>
  typeof v === 'string' && v.trim()
    ? v
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, 200)
    : fallback;

/** The folder each file kind lives in (the root of every id of that kind). */
export const RAW_ROOT: Partial<Record<BundleKindId, string>> = { test: 'tests', spec: 'specs', dataset: 'datasets', proto: 'protos', 'script-package': 'packages', 'mcp-mock': 'mocks' };

/** The library of each saved-item kind. */
export const LIBRARY_OF: Partial<Record<BundleKindId, string>> = {
  'grpc-call': 'grpc',
  'ws-connection': 'websocket',
  prompt: 'ai-prompts',
  'load-test': 'load-tests',
  evaluation: 'evaluations',
  monitor: 'monitors',
};

export const itemKey = (kind: string, id: string): string => `${kind}:${id}`;

/* ------------------------------------------------------------------ parsing JSON from outside */

/** `JSON.parse` that drops `__proto__`, `constructor` and `prototype` keys at every depth (a hostile file never reaches an assignment with them). */
export function parseJsonSafe(text: string): unknown {
  return JSON.parse(text, (k, v) => (safeKey(k) ? v : undefined));
}

const text = (v: unknown, max = 500): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, max) : '');

const refuse = (why: string): never => {
  throw new ApsError('ValidationError', `Not a valid TestPion bundle: ${why}`, { suggestions: ['Export the items again', 'Open the file with `testpion bundle inspect <file>`'] });
};

/**
 * The manifest of a file, checked field by field into a clean object: every string bounded, every list capped, an item
 * of an unknown kind set aside with a warning (a newer bundle still imports what this version understands), a higher
 * format version refused. Nothing of `raw` is kept by reference.
 */
export function checkManifest(raw: unknown, limits: TransferLimits = TRANSFER_LIMITS): { manifest: BundleManifest; warnings: string[] } {
  if (!isRecord(raw)) return refuse('the manifest is not an object');
  if (raw.format !== BUNDLE_FORMAT) return refuse(`its format is "${text(raw.format, 60)}", not "${BUNDLE_FORMAT}"`);
  const v = raw.formatVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return refuse('it has no format version');
  if (v > BUNDLE_VERSION) throw new ApsError('ValidationError', `This bundle is format version ${v}; this TestPion reads up to ${BUNDLE_VERSION}`, { suggestions: ['Update TestPion'] });
  if (!Array.isArray(raw.items)) return refuse('"items" is not a list');
  if (raw.items.length > limits.items) return refuse(`it lists ${raw.items.length} items (at most ${limits.items})`);
  const warnings: string[] = [];
  const items: BundleItem[] = [];
  const seen = new Set<string>();
  for (const it of raw.items) {
    if (!isRecord(it)) return refuse('an item is not an object');
    if (!isBundleKind(it.kind)) {
      warnings.push(`Skipped an item of kind "${text(it.kind, 60)}": this version of TestPion does not know it.`);
      continue;
    }
    if (!isPlainId(it.id)) return refuse(`an item of kind ${it.kind} has no usable id`);
    const key = itemKey(it.kind, it.id);
    if (seen.has(key)) return refuse(`${key} is listed twice`);
    seen.add(key);
    const mode = it.mode === 'reference' ? 'reference' : 'embed';
    const size = typeof it.size === 'number' && Number.isFinite(it.size) && it.size >= 0 ? it.size : undefined;
    if (mode === 'embed' && (typeof it.entry !== 'string' || !it.entry)) return refuse(`${key} has no entry`);
    if (mode === 'embed' && (typeof it.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(it.sha256))) return refuse(`${key} has no checksum`);
    const summary: Record<string, string | number> = {};
    if (isRecord(it.summary))
      for (const [k, s] of Object.entries(it.summary).slice(0, 20)) if (typeof s === 'number' || typeof s === 'string') summary[text(k, 40)] = typeof s === 'string' ? text(s, 200) : s;
    items.push({
      kind: it.kind,
      id: it.id,
      name: plainName(it.name, it.id),
      ...(mode === 'embed' ? { entry: String(it.entry), sha256: String(it.sha256).toLowerCase() } : {}),
      ...(size !== undefined ? { size } : {}),
      mode,
      ...(Object.keys(summary).length ? { summary } : {}),
    });
  }
  const list = <T>(v: unknown, f: (x: Record<string, unknown>) => T | undefined, max = 2000): T[] =>
    (Array.isArray(v) ? v : [])
      .slice(0, max)
      .filter(isRecord)
      .map(f)
      .filter((x): x is T => x !== undefined);
  const req = isRecord(raw.requires) ? raw.requires : {};
  const flags = isRecord(raw.flags) ? raw.flags : {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const strings = (v: unknown, max = 500) =>
    Array.isArray(v)
      ? v
          .slice(0, max)
          .filter((s): s is string => typeof s === 'string')
          .map((s) => text(s, 200))
      : [];
  const created = isRecord(raw.createdBy) ? raw.createdBy : {};
  return {
    manifest: {
      format: BUNDLE_FORMAT,
      formatVersion: v,
      createdBy: { app: text(created.app, 40) || 'unknown', version: text(created.version, 40) },
      createdAt: text(raw.createdAt, 40),
      title: text(raw.title, 200) || 'TestPion bundle',
      root: list(raw.root, (r) => (isBundleKind(r.kind) && isPlainId(r.id) ? { kind: r.kind, id: r.id } : undefined)),
      items,
      edges: list(raw.edges, (e) => (typeof e.from === 'string' && typeof e.to === 'string' ? { from: text(e.from, 300), to: text(e.to, 300), via: text(e.via, 200) } : undefined), 5000),
      missing: list(raw.missing, (e) => (typeof e.from === 'string' && typeof e.to === 'string' ? { from: text(e.from, 300), to: text(e.to, 300), reason: text(e.reason, 200) } : undefined)),
      requires: {
        secrets: list(req.secrets, (s) => (typeof s.name === 'string' ? { name: text(s.name, 120), where: text(s.where, 300) } : undefined), 500),
        osEnv: strings(req.osEnv, 100),
      },
      flags: { scripts: num(flags.scripts), production: strings(flags.production, 100), strippedSecrets: num(flags.strippedSecrets), stdioServers: strings(flags.stdioServers, 100) },
      notes: strings(raw.notes, 100),
    },
    warnings,
  };
}
