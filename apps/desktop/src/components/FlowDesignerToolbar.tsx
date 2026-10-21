import { ChevronDown, ChevronsRight, FileSpreadsheet, GanttChart, Grid3x3, History, LayoutGrid, Layers, Map as MapIcon, Play, Plus, Redo2, Search, StepForward, StickyNote, Undo2, Bug } from 'lucide-react';
import type { FlowStep } from '@testpion/shared';
import { LABEL } from '../lib/vocabulary';
import { Button, Menu, OverflowActions, type OverflowAction } from './ui';

/**
 * The flow designer's toolbar above the canvas: Block, Text and Run flow (with its menu of other ways to run), and the less used
 * actions (Undo, Redo, History, Auto-arrange, Find, Minimap, Snap) that fold into a ⋯ menu on a narrow canvas.
 */
export function FlowDesignerToolbar({
  one,
  stepCount,
  busy,
  hasLayout,
  canUndo,
  canRedo,
  historyOpen,
  minimap,
  snap,
  paused,
  breakpoints,
  runId,
  onBlock,
  onNote,
  onRun,
  onDebug,
  onRunFrom,
  onRunStep,
  onRunWithData,
  onRunInEnvironments,
  onTimeline,
  onUndo,
  onRedo,
  onHistory,
  onAutoArrange,
  onFind,
  onMinimap,
  onSnap,
}: {
  /** The one step selected: Block adds after it, Run from / Run selected step act on it. */
  one: FlowStep | undefined;
  stepCount: number;
  busy: boolean;
  hasLayout: boolean;
  canUndo: boolean;
  canRedo: boolean;
  historyOpen: boolean;
  minimap: boolean;
  snap: boolean;
  /** A debugged run is paused. */
  paused: boolean;
  breakpoints: number;
  /** The run the Timeline shows: the one on the canvas, the live one, or the latest (undefined: none yet). */
  runId: string | undefined;
  /** The block picker, opened under the button. */
  onBlock(at: { x: number; y: number }): void;
  onNote(): void;
  onRun(): void;
  onDebug(): void;
  onRunFrom(): void;
  onRunStep(): void;
  onRunWithData(): void;
  onRunInEnvironments(): void;
  onTimeline(): void;
  onUndo(): void;
  onRedo(): void;
  onHistory(): void;
  onAutoArrange(): void;
  onFind(): void;
  onMinimap(): void;
  onSnap(): void;
}) {
  // the toolbar's less used actions: buttons on a wide canvas, the ⋯ menu on a narrow one
  const moreActions: OverflowAction[] = [
    { label: 'Undo', icon: <Undo2 size={12} />, onSelect: onUndo, disabled: !canUndo || busy, title: 'Undo the last change (Ctrl+Z)', data: { 'data-flow-undo': '' }, minWidth: 480 },
    { label: 'Redo', icon: <Redo2 size={12} />, onSelect: onRedo, disabled: !canRedo || busy, title: 'Redo (Ctrl+Y)', data: { 'data-flow-redo': '' }, minWidth: 480 },
    {
      label: 'History',
      icon: <History size={12} />,
      onSelect: onHistory,
      pressed: historyOpen,
      data: { 'data-flow-history-toggle': '' },
      minWidth: 560,
      title: 'The runs of this flow: select one to see its results, requests, responses and variables on the canvas',
    },
    {
      label: 'Auto-arrange',
      icon: <LayoutGrid size={12} />,
      onSelect: onAutoArrange,
      disabled: !hasLayout || busy,
      separator: true,
      title: 'Lay the steps out in columns again (forget where they were dragged; notes and frames stay)',
    },
    { label: 'Find', icon: <Search size={12} />, onSelect: onFind, title: 'Find steps by name, URL, variable or type (Ctrl+F); Enter jumps to the next' },
    {
      label: 'Minimap',
      icon: <MapIcon size={12} />,
      onSelect: onMinimap,
      pressed: minimap,
      data: { 'data-flow-minimap-toggle': '' },
      title: stepCount > 8 ? 'Show or hide the overview in the corner' : 'Show or hide the overview in the corner (shown for flows of more than 8 steps)',
    },
    { label: 'Snap', icon: <Grid3x3 size={12} />, onSelect: onSnap, pressed: snap, data: { 'data-flow-snap-toggle': '' }, title: 'Snap dragged steps and notes to a 16 px grid; steps that line up with others show a guide either way' },
  ];
  return (
    <>
      <Button
        size="sm"
        variant="primary"
        icon={<Plus size={12} />}
        data-flow-add
        aria-label="Block"
        title={one ? `Add a block after "${one.name}" (it waits for it)` : 'Add a block to the flow'}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onBlock({ x: r.left, y: r.bottom + 4 });
        }}
      >
        <span className="hidden @[400px]:inline">Block</span>
      </Button>
      <Button size="sm" icon={<StickyNote size={12} />} onClick={onNote} data-flow-add-note aria-label="Text" title="A sticky note (Markdown) in the middle of the view; double-click the empty canvas to put one there">
        <span className="hidden @[720px]:inline">Text</span>
      </Button>
      <span className="inline-flex">
        <Button size="sm" className="rounded-r-none" icon={<Play size={12} />} onClick={onRun} disabled={!stepCount} title="Run every step of the flow; the steps light up as they finish" aria-label="Run flow" data-flow-run>
          <span className="hidden @[560px]:inline">Run flow</span>
        </Button>
        <Menu
          align="start"
          width={250}
          items={[
            {
              label: 'Run with breakpoints',
              icon: <Bug size={14} />,
              onSelect: onDebug,
              disabled: !stepCount || paused,
              title: breakpoints
                ? `Run the flow one step at a time, pausing before the ${breakpoints} breakpoint${breakpoints === 1 ? '' : 's'}: inspect and change variables, then Continue, Step over or Stop`
                : 'Run the flow pausing before breakpoints: add one with F9 or a step’s right-click menu',
            },
            { label: 'Run from selected', icon: <ChevronsRight size={14} />, onSelect: onRunFrom, disabled: !one, title: 'The selected step and every step after it, seeded from the latest run' },
            { label: 'Run selected step', icon: <StepForward size={14} />, onSelect: onRunStep, disabled: !one, title: 'The selected step with the steps it waits for' },
            { label: 'Run with data…', icon: <FileSpreadsheet size={14} />, separator: true, onSelect: onRunWithData, disabled: !stepCount, title: 'Once per row of a data file, a dataset or a database query: a grid of rows × steps' },
            { label: LABEL.runInEnvironments, icon: <Layers size={14} />, onSelect: onRunInEnvironments, disabled: !stepCount, title: 'The flow in each environment picked, compared step by step' },
            {
              label: 'Timeline of the run',
              icon: <GanttChart size={14} />,
              separator: true,
              onSelect: onTimeline,
              disabled: !runId,
              title: 'Each step of the run shown in History (or the latest) as a bar from its start to its end: what waited, what ran together, the critical path',
            },
          ]}
          trigger={
            <Button size="sm" className="rounded-l-none border-l-0 px-1.5" aria-label="More ways to run" data-flow-run-menu>
              <ChevronDown size={12} />
            </Button>
          }
        />
      </span>
      {/* (measured in the toolbar's left part: the view's buttons on the right keep their room) */}
      <OverflowActions at={860} label="More canvas actions" items={moreActions} />
    </>
  );
}
