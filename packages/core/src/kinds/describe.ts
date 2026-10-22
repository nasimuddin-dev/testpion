import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ApsError } from '../errors.js';
import { KIND_IDS, KIND_INFO, kindByName, liveKinds, nodeMenusOf, type CapabilityState, type ItemKindInfo, type KindId, type NodeMenuShape } from '@testpion/shared';
import type { WorkspaceStore } from '../storage/workspace.js';
import { kind } from './registry.js';

/** One kind as agents and scripts read it (CLI `testpion kinds --json`, MCP `list_kinds`, RPC `kinds.list`). */
export interface KindDescription {
  id: KindId;
  label: string;
  plural: string;
  /** The ItemRef kind ('saved' with `library` for library items); absent: no ItemRef. */
  ref?: string;
  library?: string;
  variantOf?: KindId;
  aliases: readonly string[];
  storage: ItemKindInfo['storage'];
  folders: ItemKindInfo['folders'];
  opens: ItemKindInfo['opens'];
  /** Registered ahead of its release: not live in this version. */
  since?: string;
  /** What items of this kind offer: `true`, `{ na: why }` (never applies) or `{ planned: release }`. */
  capabilities: Record<string, CapabilityState>;
  /** The capabilities that are `true`, for a quick read. */
  can: string[];
  /** How its items are deleted: at once with Undo, or after asking (it cannot be put back); absent when the kind has no delete. */
  deletes?: ItemKindInfo['deletes'];
  /** The engine facets this version has for it (resolve, ops). */
  facets: string[];
  /**
   * The menus of its nodes as the app builds them (the item's row, its section header, its folders; a request's also
   * the protocol group's and Favorites'): the groups in order, each action's id, label key and key.
   */
  nodes: NodeMenuShape[];
}

export interface KindsReport {
  kinds: KindDescription[];
  /** Facts about the open workspace that depend on it (only with a workspace). */
  workspace?: { git: boolean; libraries: string[] };
}

const describe = (info: ItemKindInfo): KindDescription => {
  const def = kind(info.id);
  return {
    id: info.id,
    label: info.label,
    plural: info.plural,
    ...(info.ref ? { ref: info.ref } : {}),
    ...(info.library ? { library: info.library } : {}),
    ...(info.variantOf ? { variantOf: info.variantOf } : {}),
    aliases: info.aliases,
    storage: info.storage,
    folders: info.folders,
    opens: info.opens,
    ...(info.since ? { since: info.since } : {}),
    capabilities: { ...info.capabilities },
    can: Object.entries(info.capabilities)
      .filter(([, s]) => s === true)
      .map(([c]) => c),
    ...(info.deletes ? { deletes: info.deletes } : {}),
    facets: (['resolve', 'ops'] as const).filter((f) => !!def[f]),
    nodes: nodeMenusOf(info.id),
  };
};

/**
 * Every kind of item a workspace can hold and what each one offers, so an agent knows what it can do with an item before
 * trying. `kind` narrows it to one (an id or an alias: `library:grpc`, `test-file` …); `all` adds the kinds registered
 * ahead of their release.
 */
export function describeKinds(o: { kind?: string; all?: boolean } = {}, store?: WorkspaceStore): KindsReport {
  let list = o.all ? KIND_IDS.map((id) => KIND_INFO[id]) : liveKinds();
  if (o.kind) {
    const k = kindByName(o.kind);
    if (!k) throw new ApsError('ValidationError', `Unknown kind "${o.kind}"`, { suggestions: [`Kinds: ${KIND_IDS.join(', ')}`] });
    list = [k];
  }
  return {
    kinds: list.map(describe),
    ...(store ? { workspace: { git: existsSync(join(store.root, '.git')), libraries: store.libraryKinds() } } : {}),
  };
}
