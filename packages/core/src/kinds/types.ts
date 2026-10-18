import type { ItemKindInfo, ItemRef, KindId, RefResolution } from '@testpion/shared';
import type { WorkspaceStore } from '../storage/workspace.js';

/**
 * The engine half of a kind (planning/master-roadmap.md §1.4): what reads or writes the kind's data. Host-agnostic:
 * storage only through the WorkspaceStore. In the adapter phase (0.52) the facets wrap what exists today; the facets of
 * later releases (serializer, merge, secrets, uses, bundle, import) arrive with their features.
 */
export interface ItemKindDef {
  info: ItemKindInfo;
  /** Whether a ref of this kind still points at something, its name, or the nearest thing that is still there. */
  resolve?(store: WorkspaceStore, ref: ItemRef): RefResolution;
  /** One implementation of delete and restore for the window, the CLI, MCP and a cloud host (through the trash). */
  ops?: {
    /** Move the item to Recently deleted; the trash entry id (restore takes it). */
    remove(store: WorkspaceStore, id: string): string;
    restore(store: WorkspaceStore, trashId: string): { id: string; name: string };
  };
}

/** A kind's facets, keyed by its id. */
export type KindDefs = Partial<Record<KindId, Omit<ItemKindDef, 'info'>>>;
