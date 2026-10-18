import { createElement, type ReactNode } from 'react';
import {
  AlarmClock,
  ArchiveRestore,
  Bot,
  Braces,
  CheckCircle2,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  Eye,
  FileCheck2,
  FileCode2,
  FileText,
  FolderCog,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitCompare,
  History,
  Link2,
  ListChecks,
  LocateFixed,
  Pause,
  Pencil,
  Play,
  Plug,
  RotateCcw,
  ScanSearch,
  Settings2,
  Sparkles,
  SquareArrowOutUpRight,
  Star,
  Terminal,
  Trash2,
  Unplug,
  Upload,
  Wand2,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { ActionId, ItemRef, NodeMenuContext } from '@testpion/shared';
import type { MenuItem } from '../components/ui';

/**
 * The window's half of the node menus: the actions themselves are data in @testpion/shared (packages/shared/src/node-menu.ts:
 * group, LABEL key, lucide icon name, capability, key); here the icon names become components, and a view's context
 * carries its handlers. A view only says which actions it can do (`on`), never which items a menu has.
 */

export type { ActionDef, ActionId, NodeKind } from '@testpion/shared';

/** A handler: what the action does, or the items of its submenu. */
export type Act = (() => unknown) | MenuItem[];

export interface NodeMenuCtx extends Omit<NodeMenuContext, 'on' | 'disabled'> {
  /** The node's name (only for messages). */
  name?: string;
  /** The node's ItemRef (an item); the test file action names what it saves by it. */
  ref?: ItemRef;
  /** What this view can do with the node, by action id (a typo is a compile error); an action without a handler is left out. */
  on: Partial<Record<ActionId, Act>>;
  /** Actions that apply but cannot run now: id → why (the item is shown disabled, the reason as its tooltip). */
  disabled?: Partial<Record<ActionId, string>>;
  /** The "New …" items of a container (first in the create group). */
  create?: MenuItem[];
}

/** The lucide component of each icon name the action tables use (a name without one shows no icon; the unit test lists them). */
export const ACTION_ICONS: Readonly<Record<string, LucideIcon>> = {
  'alarm-clock': AlarmClock,
  'archive-restore': ArchiveRestore,
  bot: Bot,
  braces: Braces,
  'check-circle-2': CheckCircle2,
  'chevrons-down-up': ChevronsDownUp,
  'chevrons-up-down': ChevronsUpDown,
  copy: Copy,
  'copy-plus': CopyPlus,
  download: Download,
  'external-link': ExternalLink,
  eye: Eye,
  'file-check-2': FileCheck2,
  'file-code-2': FileCode2,
  'file-text': FileText,
  'folder-cog': FolderCog,
  'folder-input': FolderInput,
  'folder-open': FolderOpen,
  'folder-plus': FolderPlus,
  'git-compare': GitCompare,
  history: History,
  'link-2': Link2,
  'list-checks': ListChecks,
  'locate-fixed': LocateFixed,
  pause: Pause,
  pencil: Pencil,
  play: Play,
  plug: Plug,
  'rotate-ccw': RotateCcw,
  'scan-search': ScanSearch,
  'settings-2': Settings2,
  sparkles: Sparkles,
  'square-arrow-out-up-right': SquareArrowOutUpRight,
  star: Star,
  terminal: Terminal,
  'trash-2': Trash2,
  unplug: Unplug,
  upload: Upload,
  'wand-2': Wand2,
  workflow: Workflow,
};

/** An action's icon element (made only while the menu is open), or undefined for an action without one. */
export const icon = (name: string | undefined): ReactNode => {
  const c = name ? ACTION_ICONS[name] : undefined;
  return c ? createElement(c, { size: 14 }) : undefined;
};
