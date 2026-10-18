import { createElement, type ReactNode } from 'react';
import {
  AlarmClock,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  FileCheck2,
  FileCode2,
  FolderInput,
  FolderOpen,
  FolderPlus,
  History,
  Link2,
  LocateFixed,
  Pencil,
  Play,
  Settings2,
  Sparkles,
  SquareArrowOutUpRight,
  Star,
  Trash2,
  Upload,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { KIND_INFO, type Capability, type ItemKindInfo, type ItemRef, type KindId } from '@testpion/shared';
import type { MenuItem } from '../components/ui';
import { LABEL, type MenuGroup } from './vocabulary';

/**
 * The actions of node menus, as data (lib/node-menu.ts builds every tree and list row's menu from them): which group an
 * action belongs to, its label (from LABEL), its icon, and the capability of the item kind it needs. Kind-specific
 * actions are declared in lib/node-menu-kinds/*; a view only says which actions it can do (handlers), never which
 * items a menu has.
 */

/** A node of a tree or list: an item kind, a section header, a folder of a kind, a protocol category, Favorites. */
export type NodeKind = KindId | `section:${KindId}` | `folder:${KindId}` | 'category' | 'favorites';

/** A handler: what the action does, or the items of its submenu. */
export type Act = (() => unknown) | MenuItem[];

export interface NodeMenuCtx {
  /** The node's name (only for messages). */
  name?: string;
  /** The node's ItemRef (an item); the test file action names what it saves by it. */
  ref?: ItemRef;
  /** What this view can do with the node, by action id; an action without a handler is left out. */
  on: Partial<Record<string, Act>>;
  /** Actions that apply but cannot run now: id → why (the item is shown disabled, the reason as its tooltip). */
  disabled?: Partial<Record<string, string>>;
  /** The "New …" items of a container (first in the create group). */
  create?: MenuItem[];
  /** The request is a favorite (Add to / Remove from favorites). */
  favorite?: boolean;
  /** The workspace is a git repository (the git group shows). */
  repo?: boolean;
}

export interface ActionDef {
  id: string;
  group: MenuGroup;
  label: string | ((c: NodeMenuCtx, kind: NodeKind) => string);
  icon?: LucideIcon;
  /** The capability of the item kind the action needs (`true` in the registry); a node kind's own capabilities are generated. */
  cap?: Capability;
  danger?: boolean;
  /** Only for these node kinds (kind-specific actions, lib/node-menu-kinds). */
  kinds?: readonly NodeKind[];
  /** Only when the context says so (the git group needs a repository). */
  when?: (c: NodeMenuCtx) => boolean;
  /** Only for the node kinds this says (an action without a capability of its own: Copy as, Reveal file …). */
  appliesTo?: (kind: NodeKind) => boolean;
  /** Offered only by some views (Reveal in sidebar: outside the sidebar), so a kind's shape leaves it out. */
  contextual?: boolean;
  /** After the kind's own actions of its group (Export… ends the share group, Settings… the tools group). */
  last?: boolean;
}

export const icon = (i: LucideIcon | undefined): ReactNode => (i ? createElement(i, { size: 14 }) : undefined);

const isFolderNode = (k: NodeKind) => k.startsWith('folder:');
/** A file the user keeps in the workspace's folders (a test file, an API definition, a dataset): Reveal file, Copy path. */
const isDocument = (k: NodeKind) => (KIND_INFO as Record<string, ItemKindInfo>)[k]?.storage.layout === 'raw-document' && (KIND_INFO as Record<string, ItemKindInfo>)[k]!.capabilities.open === true;

/** The test-file action's label by what it saves (WF-07). */
const testFileLabel = (_c: NodeMenuCtx, k: NodeKind) => (k === 'folder' ? LABEL.createTestFileFromFolder : k === 'collection' ? LABEL.createTestFileFromCollection : LABEL.saveAsTest);

/** The shared actions, in their order inside each group (kind actions follow the shared ones of their group). */
export const STANDARD_ACTIONS: readonly ActionDef[] = [
  { id: 'newFolder', group: 'create', label: LABEL.newFolder, icon: FolderPlus, cap: 'container' },
  { id: 'import', group: 'create', label: LABEL.import, icon: Upload, cap: 'import' },
  { id: 'open', group: 'open', label: LABEL.open, icon: ExternalLink, cap: 'open' },
  { id: 'openNewTab', group: 'open', label: LABEL.openNewTab, icon: SquareArrowOutUpRight, cap: 'open-new-tab' },
  { id: 'revealInSidebar', group: 'open', label: LABEL.revealInSidebar, icon: LocateFixed, cap: 'open', contextual: true },
  { id: 'revealFile', group: 'open', label: LABEL.revealFile, icon: FolderOpen, appliesTo: isDocument },
  { id: 'expandAll', group: 'tree', label: LABEL.expandAll, icon: ChevronsUpDown, cap: 'container' },
  { id: 'collapseAll', group: 'tree', label: LABEL.collapseAll, icon: ChevronsDownUp, cap: 'container' },
  {
    id: 'run',
    group: 'run',
    label: (_c, k) => (k === 'collection' || k === 'category' ? LABEL.runCollection : k === 'folder' || isFolderNode(k) ? LABEL.runFolder : k === 'monitor' ? LABEL.runNow : LABEL.run),
    icon: Play,
    cap: 'run',
  },
  { id: 'copyLink', group: 'share', label: LABEL.copyLink, icon: Link2, cap: 'link' },
  { id: 'copyAs', group: 'share', label: LABEL.copyAs, icon: Copy, appliesTo: (k) => k === 'request' },
  { id: 'copyPath', group: 'share', label: LABEL.copyPath, icon: FileCode2, appliesTo: isDocument },
  { id: 'export', group: 'share', label: (c) => (Array.isArray(c.on.export) ? LABEL.exportSubmenu : LABEL.export), icon: Download, cap: 'export', last: true },
  { id: 'monitor', group: 'tools', label: LABEL.monitor, icon: AlarmClock, cap: 'monitor' },
  { id: 'ci', group: 'tools', label: LABEL.runInCi, icon: Workflow, cap: 'ci' },
  { id: 'testFile', group: 'tools', label: testFileLabel, icon: FileCheck2, cap: 'test-file' },
  { id: 'flow', group: 'tools', label: LABEL.generateFlow, icon: Sparkles, cap: 'flow' },
  { id: 'settings', group: 'tools', label: LABEL.settings, icon: Settings2, appliesTo: (k) => k === 'mcp-server' || k === 'provider', last: true },
  { id: 'historyInGit', group: 'git', label: LABEL.historyInGit, icon: History, cap: 'git-history', when: (c) => !!c.repo },
  { id: 'rename', group: 'edit', label: (_c, k) => (isFolderNode(k) ? LABEL.renameFolder : LABEL.rename), icon: Pencil, cap: 'rename' },
  { id: 'duplicate', group: 'edit', label: LABEL.duplicate, icon: CopyPlus, cap: 'duplicate' },
  // a dialog (Move to…), or a submenu of the list's folders, or of the collections a gRPC call or connection can be in
  {
    id: 'move',
    group: 'edit',
    label: (c, k) => (!Array.isArray(c.on.move) ? LABEL.moveTo : k === 'grpc-call' || k === 'ws-connection' ? LABEL.moveToCollection : LABEL.moveToFolder),
    icon: FolderInput,
    cap: 'move',
  },
  { id: 'favorite', group: 'edit', label: (c) => (c.favorite ? LABEL.removeFavorite : LABEL.addFavorite), icon: Star, cap: 'favorite' },
  { id: 'delete', group: 'danger', label: (_c, k) => (isFolderNode(k) ? LABEL.deleteFolder : LABEL.delete), icon: Trash2, cap: 'delete', danger: true },
];
