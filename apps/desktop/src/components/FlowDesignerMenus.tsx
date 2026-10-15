// The flow designer's right-click menus (a step, an edge, the empty canvas, a parallel group or the Finally lane, a note,
// a frame) and its keyboard: one place for what each can do, in the app's menu order (open, run, copy, organize, delete).
import {
  ChevronsRight,
  CircleDot,
  ClipboardPaste,
  Copy,
  CopyPlus,
  FileCode2,
  Flag,
  Frame,
  LayoutGrid,
  Maximize2,
  MousePointerSquareDashed,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Plus,
  StickyNote,
  Target,
  Trash2,
  Unlink,
} from 'lucide-react';
import { FLOW_COLORS, freeSpot, STEP_SIZE, type FlowEdge, type FlowFrameDef, type FlowGroup, type FlowNote, type FlowStep } from '@testpion/shared';
import { promptText } from '../store';
import { COLOR_LABEL } from './flow-designer-lib';
import { flowColor } from './FlowCanvasParts';
import type { FlowSelection } from './FlowDiagram';
import { PALETTE } from './FlowDesignerParts';
import type { MenuItem } from './ui';

type Op = Record<string, unknown> & { op: string };

/** What the menus and keys act with: the designer's edits, selection and view. */
export interface DesignerActions {
  apply(op: Op, opts?: { select?: boolean }): Promise<unknown>;
  steps: FlowStep[];
  notes: FlowNote[];
  /** Every step's place on the canvas now (a flow without a layout gets these when a step is placed by hand). */
  places(): Record<string, [number, number]>;
  /** The steps' boxes on the canvas now (a step put "here" goes to the nearest free place). */
  boxes(): Array<{ x: number; y: number; w: number; h: number }>;
  hasLayout: boolean;
  selection: FlowSelection;
  setSelection(s: FlowSelection): void;
  addNote(at?: [number, number]): void;
  frameSelection(): void;
  copy(ids: string[]): void;
  /** Steps were copied (Ctrl+C, a step's Copy): Paste pastes them. */
  canPaste(): boolean;
  paste(at?: [number, number]): void;
  remove(): void;
  undo(): void;
  redo(): void;
  fit(): void;
  find(): void;
  run(o: { from?: string; to?: string }): void;
  breakpoints: string[];
  toggleBreakpoint(id: string): void;
  pinned(id: string): boolean;
  pin(s: FlowStep): void;
  unpin(s: FlowStep): void;
  openStep(s: FlowStep): void;
}

/** An edit at a place on the canvas: a flow without a layout is placed first (where the automatic layout drew it), in the same undo step. */
export function placed(a: DesignerActions, op: Op): Op {
  return a.hasLayout ? op : { op: 'batch', ops: [{ op: 'setLayout', positions: a.places() }, op] };
}

const blocks = (onPick: (step: Record<string, unknown>) => void): MenuItem[] => PALETTE.map((p) => ({ label: p.label, onSelect: () => onPick(p.step) }));

/** A step's run and debug actions (its menu, the inspector's Debug menu). */
export function debugItems(a: DesignerActions, s: FlowStep): MenuItem[] {
  return [
    {
      label: 'Run from here',
      icon: <ChevronsRight size={14} />,
      onSelect: () => a.run({ from: s.id }),
      title: 'Run this step and every step after it, with the variables and responses the steps before it had in the selected (or latest) run',
    },
    { label: 'Run to here', icon: <Target size={14} />, onSelect: () => a.run({ to: s.id }), title: 'Run this step with only the steps it waits for' },
    { label: a.breakpoints.includes(s.id) ? 'Remove breakpoint' : 'Add breakpoint', icon: <CircleDot size={14} />, shortcut: 'F9', onSelect: () => a.toggleBreakpoint(s.id) },
    a.pinned(s.id)
      ? { label: 'Unpin response', icon: <PinOff size={14} />, onSelect: () => a.unpin(s), title: 'Call the API again in runs from the designer' }
      : {
          label: 'Pin last response',
          icon: <Pin size={14} />,
          onSelect: () => a.pin(s),
          title: 'Keep the step’s last response: runs from the designer use it instead of calling the API (the CLI, CI and monitors never do)',
        },
  ];
}

/** A step's menu (right-click on it). */
export function stepItems(a: DesignerActions, s: FlowStep): MenuItem[] {
  const ids = a.selection.steps.includes(s.id) ? a.selection.steps : [s.id];
  const many = ids.length > 1 ? ` (${ids.length})` : '';
  const run = debugItems(a, s);
  return [
    ...run,
    { label: 'Open in editor', icon: <FileCode2 size={14} />, separator: true, onSelect: () => a.openStep(s) },
    { label: `Copy${many}`, icon: <Copy size={14} />, shortcut: 'Ctrl+C', separator: true, onSelect: () => a.copy(ids) },
    {
      label: 'Rename…',
      icon: <Pencil size={14} />,
      separator: true,
      onSelect: async () => {
        const name = await promptText('Rename the step', { value: s.name, okLabel: 'Rename' });
        if (name && String(name).trim() && String(name).trim() !== s.name) void a.apply({ op: 'renameStep', id: s.id, name: String(name).trim() });
      },
    },
    {
      label: s.finally ? `Move out of Finally${many}` : `Make finally${many}`,
      icon: <Flag size={14} />,
      title: s.finally ? 'Run in the normal order again' : 'Clean-up: run after every other step, whatever happened',
      onSelect: () => void a.apply({ op: 'group', ids, finally: !s.finally }),
    },
    { label: `Duplicate${many}`, icon: <CopyPlus size={14} />, shortcut: 'Ctrl+D', onSelect: () => void a.apply({ op: 'duplicateStep', id: ids }, { select: true }) },
    {
      label: `Delete${many}`,
      icon: <Trash2 size={14} />,
      shortcut: 'Del',
      danger: true,
      separator: true,
      onSelect: () => {
        a.setSelection({ steps: ids });
        void a.apply({ op: 'removeStep', id: ids }).then((r) => r && a.setSelection({ steps: [] }));
      },
    },
  ];
}

/** A connection's menu: a step put into it, or the connection removed. */
export function edgeItems(a: DesignerActions, e: FlowEdge): MenuItem[] {
  return [
    {
      label: 'Insert step here',
      icon: <Plus size={14} />,
      onSelect: () => undefined,
      items: blocks((step) => void a.apply({ op: 'insertSteps', steps: [step], between: { from: e.from, to: e.to } }, { select: true })),
    },
    {
      label: 'Delete connection',
      icon: <Unlink size={14} />,
      shortcut: 'Del',
      danger: true,
      separator: true,
      onSelect: () => void a.apply({ op: 'disconnect', from: e.from, to: e.to }).then((r) => r && a.setSelection({ steps: [] })),
    },
  ];
}

/** The empty canvas's menu (right-click, or a double-click), at a place in the diagram's units. */
export function canvasItems(a: DesignerActions, at: [number, number]): MenuItem[] {
  return [
    { label: 'Add note here', icon: <StickyNote size={14} />, onSelect: () => a.addNote([at[0] - 20, at[1] - 20]) },
    {
      label: 'Add step here',
      icon: <Plus size={14} />,
      onSelect: () => undefined,
      items: blocks((step) => {
        a.setSelection({ steps: [] });
        void a.apply(placed(a, { op: 'addStep', step, at: freeSpot(a.boxes(), [at[0] - 20, at[1] - 20], STEP_SIZE, 16, true) }), { select: true });
      }),
    },
    ...(a.canPaste() ? [{ label: 'Paste', icon: <ClipboardPaste size={14} />, shortcut: 'Ctrl+V', onSelect: () => a.paste(at) }] : []),
    ...(a.selection.steps.length ? [{ label: 'Frame selection…', icon: <Frame size={14} />, onSelect: () => a.frameSelection() }] : []),
    {
      label: 'Select all',
      icon: <MousePointerSquareDashed size={14} />,
      shortcut: 'Ctrl+A',
      separator: true,
      onSelect: () => a.setSelection({ steps: a.steps.map((s) => s.id), notes: a.notes.map((n) => n.id) }),
    },
    { label: 'Auto-arrange', icon: <LayoutGrid size={14} />, onSelect: () => void a.apply({ op: 'setLayout', positions: null }) },
    { label: 'Fit', icon: <Maximize2 size={14} />, onSelect: () => a.fit() },
  ];
}

/** A parallel group's or the Finally lane's menu (right-click on its label). */
export function groupItems(a: DesignerActions, g: FlowGroup): MenuItem[] {
  const fin = g.kind === 'finally';
  return [
    { label: 'Select its steps', icon: <Target size={14} />, onSelect: () => a.setSelection({ steps: g.ids }) },
    {
      label: fin ? 'Move out of Finally' : 'Ungroup',
      icon: <Unlink size={14} />,
      separator: true,
      title: fin ? 'The steps run in the normal order again' : 'The steps stay; they are no longer one parallel group',
      onSelect: () => void a.apply({ op: 'group', ids: g.ids, ...(fin ? { finally: false } : { parallel: null }) }),
    },
  ];
}

export function noteItems(a: DesignerActions, n: FlowNote): MenuItem[] {
  return [
    {
      label: 'Colour',
      icon: <Palette size={14} />,
      onSelect: () => undefined,
      items: FLOW_COLORS.map((c) => ({ label: COLOR_LABEL(c), icon: <Swatch c={c} />, onSelect: () => void a.apply({ op: 'updateNote', id: n.id, set: { color: c } }) })),
    },
    { label: 'Delete note', icon: <Trash2 size={14} />, danger: true, separator: true, onSelect: () => void a.apply({ op: 'removeNote', id: n.id }) },
  ];
}

export function frameItems(a: DesignerActions, f: FlowFrameDef): MenuItem[] {
  const ids = new Set(a.steps.map((s) => s.id));
  return [
    {
      label: 'Rename frame…',
      icon: <Pencil size={14} />,
      onSelect: async () => {
        const t = await promptText('Rename the frame', { value: f.title, okLabel: 'Rename' });
        if (t && String(t).trim()) void a.apply({ op: 'updateFrame', id: f.id, set: { title: String(t).trim() } });
      },
    },
    {
      label: 'Colour',
      icon: <Palette size={14} />,
      onSelect: () => undefined,
      items: FLOW_COLORS.map((c) => ({ label: COLOR_LABEL(c), icon: <Swatch c={c} />, onSelect: () => void a.apply({ op: 'updateFrame', id: f.id, set: { color: c } }) })),
    },
    { label: 'Select its steps', icon: <Target size={14} />, onSelect: () => a.setSelection({ steps: f.steps.filter((id) => ids.has(id)) }) },
    { label: 'Remove frame', icon: <Trash2 size={14} />, danger: true, separator: true, onSelect: () => void a.apply({ op: 'removeFrame', id: f.id }), title: 'The steps stay; only the frame goes' },
  ];
}

const Swatch = ({ c }: { c: string }) => <span className="block w-3 h-3 rounded-full" style={{ background: flowColor(c).stroke }} />;

/**
 * The canvas's keys, wherever the focus is in the designer (the canvas, a toolbar button, the + Block button the picker
 * gave the focus back to) or nowhere (the body, after the focused step or button went away): Delete / Backspace,
 * Ctrl+A, Esc, Ctrl+Z / Y, Ctrl+D, Ctrl+C / V, Ctrl+F. Text fields keep their own keys. True when the key was used.
 */
export function canvasKey(a: DesignerActions, e: KeyboardEvent | React.KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t?.closest?.('input, textarea, select, [contenteditable], .monaco-editor, [role=menu], [role=dialog], [role=listbox]')) return false;
  const sel = a.selection;
  const any = sel.steps.length > 0 || !!sel.edge || !!sel.notes?.length;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (!mod && !e.altKey && (e.key === 'Delete' || e.key === 'Backspace')) {
    if (!any) return false;
    a.remove();
    return true;
  }
  // Enter opens the selected step in the editor (a focused step handles its own Enter; a button's Enter is the button's)
  if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
    const one = sel.steps.length === 1 && !t?.closest?.('button, a, [data-flow-node]') ? a.steps.find((s) => s.id === sel.steps[0]) : undefined;
    if (!one) return false;
    a.openStep(one);
    return true;
  }
  if (e.key === 'Escape') {
    if (!any) return false;
    a.setSelection({ steps: [] });
    return true;
  }
  if (!mod || e.altKey) return false;
  if (k === 'a' && !e.shiftKey) a.setSelection({ steps: a.steps.map((s) => s.id), notes: a.notes.map((n) => n.id) });
  else if (k === 'z' && !e.shiftKey) a.undo();
  else if (k === 'y' || (k === 'z' && e.shiftKey)) a.redo();
  else if (k === 'f' && !e.shiftKey) a.find();
  else if (k === 'd' && sel.steps.length) void a.apply({ op: 'duplicateStep', id: sel.steps }, { select: true });
  else if (k === 'c' && sel.steps.length && !String(getSelection?.() ?? '')) a.copy(sel.steps);
  else if (k === 'v' && a.canPaste()) a.paste();
  else return false;
  return true;
}
