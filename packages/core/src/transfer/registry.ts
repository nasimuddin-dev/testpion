/**
 * The bundle half of the item-kind registry: the adapter of each kind a bundle holds, and the lookups the export and the
 * import share. The kinds themselves (labels, capabilities) are in @testpion/shared; a kind with the `export` capability
 * set to `true` there must have an adapter here (tests/unit/transfer-kinds.test.ts keeps the two in step).
 */
import { kindByName, type KindId } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { BUNDLE_KIND_IDS, RAW_ROOT, isBundleKind, type BundleKindId } from './format.js';
import type { ItemAdapter } from './items.js';
import { FILE_ADAPTERS } from './items-files.js';
import { JSON_ADAPTERS } from './items-json.js';

const ADAPTERS = new Map<BundleKindId, ItemAdapter>([...JSON_ADAPTERS, ...FILE_ADAPTERS].map((a) => [a.kind, a]));

export function adapter(kind: BundleKindId): ItemAdapter {
  const a = ADAPTERS.get(kind);
  if (!a) throw new ApsError('ValidationError', `No bundle adapter for ${kind}`);
  return a;
}

/** The registry kinds a bundle holds, with the bundle kind each is stored as (a flow is a test file). */
export function bundleKindOf(kind: KindId | string): BundleKindId | undefined {
  const id = kindByName(kind)?.id ?? kind;
  const k = id === 'flow' ? 'test' : id;
  return isBundleKind(k) ? k : undefined;
}

export const ALL_BUNDLE_KINDS: readonly BundleKindId[] = BUNDLE_KIND_IDS;

/** The id of a file item as a person types it (`users.csv`, `smoke/login.yaml`, `helpers`) → the workspace path (`datasets/users.csv` …). */
export function normalizeId(kind: BundleKindId, id: string): string {
  const root = RAW_ROOT[kind];
  if (!root) return id;
  let p = id.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p.startsWith(`${root}/`)) p = `${root}/${p}`;
  if (kind === 'script-package' && !p.endsWith('.js')) p += '.js';
  return p;
}
