import { kindOfLibrary, type ItemRef } from '@testpion/shared';
import { bundleKindOf, normalizeId as normalizeBundleId } from '../transfer/registry.js';
import { partId } from '../transfer/parts.js';
import type { BundleRef } from '../transfer/types.js';

/**
 * Where a ref meets a bundle: the bundle item an ItemRef names (the facet of each kind that has one), and the ref to open
 * once an item is imported. The one place the transfer code switches on a ref's kind (the registry guard keeps the rest out).
 */

/** The bundle item an ItemRef names; undefined for a ref that is no exportable item (a run, a history entry …). */
export function bundleRefOfItemRef(ref: ItemRef): BundleRef | undefined {
  switch (ref.kind) {
    case 'collection':
      return { kind: 'collection', id: ref.collectionId };
    // a folder or a request travels as a collection of its own, with the folders above it (transfer/parts.ts)
    case 'folder':
      return { kind: 'collection', id: partId(ref.collectionId, [ref.folderId]) };
    case 'request':
      return { kind: 'collection', id: partId(ref.collectionId, [ref.requestId]) };
    case 'environment':
      return ref.environmentId ? { kind: 'environment', id: ref.environmentId } : undefined;
    case 'test':
    case 'flow':
      return { kind: 'test', id: normalizeBundleId('test', ref.path) };
    case 'spec':
      return { kind: 'spec', id: normalizeBundleId('spec', ref.path) };
    case 'dataset':
      return { kind: 'dataset', id: normalizeBundleId('dataset', ref.name) };
    case 'mcp-server':
      return { kind: 'mcp-server', id: ref.serverId };
    case 'provider':
      return { kind: 'provider', id: ref.providerId };
    case 'monitor':
      return { kind: 'monitor', id: ref.monitorId };
    case 'saved': {
      const k = kindOfLibrary(ref.library);
      const b = k && bundleKindOf(k.id);
      return b ? { kind: b, id: ref.itemId } : undefined;
    }
    default:
      return undefined;
  }
}

/** The ref to open for an item that is now in the workspace at `id`. */
export function openRefOfBundleItem(kind: BundleRef['kind'], id: string): ItemRef | undefined {
  switch (kind) {
    case 'collection':
      return { kind: 'collection', collectionId: id };
    case 'environment':
      return { kind: 'environment', environmentId: id };
    case 'test':
      return { kind: 'test', path: id.replace(/^tests\//, '') };
    case 'spec':
      return { kind: 'spec', path: id };
    case 'dataset':
      return { kind: 'dataset', name: id.replace(/^datasets\//, '') };
    case 'mcp-server':
      return { kind: 'mcp-server', serverId: id };
    default:
      return undefined;
  }
}
