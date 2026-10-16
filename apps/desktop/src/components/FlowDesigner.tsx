import {
  FileSpreadsheet,
  GanttChart,
  Layers,
  AlignCenterVertical,
  Bot,
  CalendarClock,
  ChevronDown,
  Globe,
  Webhook,
  AlignHorizontalJustifyCenter,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  Bug,
  ChevronsRight,
  ClipboardPaste,
  Copy,
  CopyPlus,
  FileCode2,
  FolderInput,
  Frame,
  Grid3x3,
  History,
  LayoutGrid,
  Map as MapIcon,
  Play,
  Plus,
  Redo2,
  Search,
  Sparkles,
  StepForward,
  StickyNote,
  Trash2,
  Undo2,
  Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FLOW_COLORS, flowChecks, flowGraph, freeSpot, STEP_SIZE, type FlowFrameDef, type FlowGroup, type FlowNote, type FlowStep } from '@testpion/shared';
import { canvasItems, canvasKey, debugItems, edgeItems, frameItems, groupItems, noteItems, stepItems, type DesignerActions } from './FlowDesignerMenus';
import { setPaletteContext } from '../lib/palette-context';
import { LABEL } from '../lib/vocabulary';
import { openRef } from '../lib/open-ref';
import { pref, savePref, useFlowFileFollow } from './flow-designer-lib';
import type { PaletteCommand } from './Shell';
import { asError, call, on } from '../api';
import { confirmAction, promptText, toastError, useApp } from '../store';
import type { TestResult } from '../types';
import { FlowOutputEditor } from './FlowBlockFields';
import { DeployPanel, triggerLabel, type DeployStatus } from './FlowDeploy';
import { FlowRunDock, type FlowDock } from './FlowRunDock';
import { RunWithDataDialog } from './RunWithDataDialog';
import type { StartSpec } from './FlowCanvasParts';
import { CommandPalette } from './Shell';
import { useCollectionTree } from '../lib/collections-store';
import type { FlowDropEvent } from './FlowDrop';
import { FLOW_START, FlowDiagram, type FlowDiagramApi, type FlowMark, type FlowSelection } from './FlowDiagram';
import { FlowHistoryList, PausePanel, VariablesTimeline, type FlowPause, type FlowRunRow } from './FlowDebugParts';
import { API_EXAMPLE, BlockPalette, blockPickerCommands, CollectionPicker, PALETTE, StepInspector, StepPreview } from './FlowDesignerParts';
import { ResultDetail } from './RunPanel';
import { Button, LinkButton, Menu, OverflowActions, PinnablePanel, SectionTitle, Segmented, Split, type MenuItem, type OverflowAction } from './ui';

/** A test file as a flow, as the tests.flow RPC reads it for the designer (with each step as written). */
export interface DesignerFlow {
  steps: FlowStep[];
  run?: { runId: string };
  raw?: Record<string, Record<string, unknown>>;
  /** The auth each HTTP step inherits from the file's `defaults:` (by step id); `overridden` when it has its own. */
  inheritedAuth?: Record<string, { auth: Record<string, unknown>; from: 'defaults'; overridden?: true }>;
  /** The file's output: (what the flow returns). */
  output?: Record<string, unknown>;
  /** The Start node: the flow's inputs and the MCP tool it is exposed as. */
  inputs?: Array<{ name: string; default?: unknown; description?: string }>;
  exposed?: string;
  /** The canvas's sticky notes and frames (layout.notes, layout.frames). */
  notes?: FlowNote[];
  frames?: FlowFrameDef[];
}

/** What tests.flowEdit answers: the text before (undo) and after (the editor), and the flow read again. */
export interface FlowEditAnswer {
  file: string;
  before: string;
  text: string;
  added: string[];
  flow: DesignerFlow;
  /** A drop's notes: values that now flow between steps, variables to set. */
  notes?: string[];
}

type Op = Record<string, unknown> & { op: string };

/** What a run from the designer runs (tests.flowRun): every step, `ids`, from / to a step, a replay (`seedRunId`), a debug run with breakpoints. */
export interface FlowRunRequest {
  ids?: string[];
  from?: string;
  to?: string;
  seedRunId?: string;
  debug?: boolean;
  breakpoints?: string[];
}

/** The designer's state of a file (tests.flowState): breakpoints and pinned responses, kept per computer, never in the YAML. */
interface DesignerState {
  breakpoints: string[];
  pins: Record<string, { status?: number; pinnedAt: string; fromRunId?: string; truncated?: boolean }>;
}


/** A parallel group name no step of the flow uses yet. */
const newGroup = (steps: FlowStep[]) => {
  const used = new Set(steps.map((s) => s.parallel));
  let n = 1;
  while (used.has(`group-${n}`)) n++;
  return `group-${n}`;
};

/** Undo and redo per file: texts of the file before each canvas change (kept while the app runs, across tab switches). */
const history = new Map<string, { undo: string[]; redo: string[] }>();
const historyOf = (file: string) => history.get(file) ?? history.set(file, { undo: [], redo: [] }).get(file)!;
/** Copied steps (Ctrl+C on the canvas), pasted into this or another flow with Ctrl+V. */
let copied: { file: string; ids: string[] } | undefined;
const GAP_X = 284;

/** Where the block picker adds: after this step (on a condition's branch), at the Start node, or (undefined) after the selection. */
type PickTarget = { from?: string; when?: boolean };


/**
 * The flow designer: a test file's steps on an editable FlowDiagram, with a toolbar (Add step, Auto-arrange, Undo,
 * Redo, Run flow, Run step, Fit) and an inspector for the selected step (its request with the request view's editors,
 * what it extracts, its checks with the AssertionEditor, what it waits for). Every change is one tests.flowEdit call
 * that edits the YAML and saves it: the file stays the one source of truth, the Editor tab shows the same text.
 */
export function FlowDesigner({
  file,
  flow,
  onEdited,
  beforeEdit,
  onRun,
  onOpenStep,
  onOpenResult,
  onExpose,
  focusStep,
  savedText,
  onStepChange,
}: {
  /** The test file inside tests/. */
  file: string;
  flow: DesignerFlow;
  /** An edit was saved: the editor and the flow show the new text. */
  onEdited(r: FlowEditAnswer): void;
  /** Before an edit: the editor's unsaved changes are saved first. */
  beforeEdit(): Promise<void>;
  /** Run the file (or part of it, or debug it: tests.flowRun); answers the run's id. */
  onRun(o?: FlowRunRequest): Promise<string | undefined>;
  /** Show the step in the editor (double-click, Open in editor). */
  onOpenStep(step: FlowStep): void;
  /** Show a step's result of a run in the Runs tab. */
  onOpenResult(step: FlowStep, runId: string): void;
  /** The Start node's MCP tool trigger and the Deploy panel: the Expose as MCP tool dialog for this file. */
  onExpose?(): void;
  /** A step a link asked for (openRef with a step): selected and brought into view once the flow has it. */
  focusStep?: { id: string; n: number };
  /** The file's text as the Tests view last saved or read it (its editor saves too): what the canvas compares a change on disk with. */
  savedText?: string;
  /** The one step selected on the canvas (undefined: none, or several): the view's breadcrumb names it. */
  onStepChange?(id: string | undefined): void;
}) {
  const env = useApp((s) => s.environment);
  const [sel, setSel] = useState<FlowSelection>({ steps: [] });
  const stepChange = useRef(onStepChange);
  stepChange.current = onStepChange;
  const onlyStep = sel.steps.length === 1 ? sel.steps[0] : undefined;
  useEffect(() => stepChange.current?.(onlyStep), [onlyStep]);
  const [busy, setBusy] = useState(false);
  // bumped by undo and redo: the inspector's fields take the restored values
  const [version, setVersion] = useState(0);
  const [, rerender] = useState(0);
  const [picking, setPicking] = useState(false);
  const canvasAt = useRef<[number, number] | undefined>(undefined);
  const h = historyOf(file);

  // a run started here lights the steps up as their results come in
  const [liveRun, setLiveRun] = useState<string>();
  const [live, setLive] = useState<Record<string, { status: string; durationMs?: number; tries?: number }>>({});
  // the live run's results in full (the hover card shows the response)
  const liveResults = useRef(new Map<string, TestResult>());
  useEffect(() => {
    if (!liveRun) return;
    liveResults.current = new Map();
    return on<Array<{ type: string; runId: string; id?: string; result?: TestResult }>>('run.events', (evs) => {
      const mine = evs.filter((e) => e.runId === liveRun);
      if (!mine.length) return;
      for (const e of mine) if (e.type === 'test-end' && e.result) liveResults.current.set(e.result.id, e.result);
      setLive((l) => {
        const next = { ...l };
        for (const e of mine) {
          if (e.type === 'test-start' && e.id) next[e.id] = { status: 'running' };
          if (e.type === 'test-end' && e.result)
            next[e.result.id] = { status: e.result.status, durationMs: e.result.durationMs, ...(typeof e.result.metadata?.tries === 'number' ? { tries: e.result.metadata.tries } : {}) };
        }
        return next;
      });
    });
  }, [liveRun]);
  // the finished run read back with the flow: its results are the steps' own now
  useEffect(() => {
    if (liveRun && flow.run?.runId === liveRun) setLiveRun(undefined);
  }, [flow.run?.runId, liveRun]);
  // the debugger: breakpoints and pins of the file, the run history, a run shown on the canvas, a paused run
  const [state, setState] = useState<DesignerState>({ breakpoints: [], pins: {} });
  useEffect(() => {
    let mounted = true;
    call<DesignerState>('tests.flowState', { file }).then(
      (s) => mounted && setState(s),
      () => undefined,
    );
    return () => {
      mounted = false;
    };
  }, [file]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [runs, setRuns] = useState<FlowRunRow[]>();
  const loadRuns = useCallback(() => {
    call<{ runs: FlowRunRow[] }>('tests.flowRuns', { file }).then((h) => setRuns(h.runs), toastError);
  }, [file]);
  useEffect(() => {
    if (historyOpen) loadRuns();
  }, [historyOpen, loadRuns, flow.run?.runId]);
  const [viewRun, setViewRun] = useState<{ runId: string; results: TestResult[] }>();
  const showRun = (runId: string | undefined) => {
    if (!runId) return setViewRun(undefined);
    call<{ results: TestResult[] }>('tests.flowRunResults', { file, runId }).then((r) => setViewRun({ runId, results: r.results }), toastError);
  };
  const [pause, setPause] = useState<FlowPause>();
  useEffect(() => {
    if (!liveRun) return;
    const offs = [
      on<FlowPause>('run.paused', (p) => p.runId === liveRun && setPause(p)),
      on<{ runId: string }>('run.resumed', (p) => p.runId === liveRun && setPause(undefined)),
      on<{ runId: string }>('run.finished', (p) => p.runId === liveRun && setPause(undefined)),
    ];
    // a pause before the first step can come before the run's id did
    call<FlowPause | null>('runs.paused', { runId: liveRun }).then((p) => p && setPause((cur) => cur ?? p), () => undefined);
    return () => offs.forEach((off) => off());
  }, [liveRun]);
  // paused: the steps that finished before the pause show their results (a result that came before the run's id did is read back)
  useEffect(() => {
    if (!pause) return;
    call<{ items: TestResult[] } | TestResult[]>('runs.results', { runId: pause.runId, limit: 500 }).then(
      (page) =>
        setLive((l) => {
          const next = { ...l };
          for (const r of Array.isArray(page) ? page : page.items) next[r.id] ??= { status: r.status, durationMs: r.durationMs };
          return next;
        }),
      () => undefined,
    );
  }, [pause]);
  const [menu, setMenu] = useState<{ step: FlowStep; x: number; y: number }>();
  // the canvas: notes and frames' menus, the double-click menu, the minimap and snapping, what the canvas offers (fit, find)
  const [noteMenu, setNoteMenu] = useState<{ x: number; y: number; items: MenuItem[]; id: string }>();
  const [minimap, setMinimap] = useState(() => pref('minimap', true));
  const [snap, setSnap] = useState(() => pref('snap', false));
  const canvasApi = useRef<FlowDiagramApi | undefined>(undefined);
  // the block picker, where it was opened (a port's step, its branch) and where on screen
  const [picker, setPicker] = useState<PickTarget & { x: number; y: number }>();
  // runs at scale (with data, in several environments) and a run's timeline, in the dock under the canvas
  const [scaleDialog, setScaleDialog] = useState<'data' | 'matrix'>();
  const [dock, setDock] = useState<FlowDock>();
  const root = useRef<HTMLDivElement>(null);
  const [inspectorMode, setInspectorMode] = useState<'result' | 'step'>('result');

  const viewed = useMemo(() => (viewRun ? new Map(viewRun.results.map((r) => [r.id, r])) : undefined), [viewRun]);
  const steps = useMemo(
    () =>
      liveRun
        ? flow.steps.map((s) => ({ ...s, status: live[s.id]?.status, durationMs: live[s.id]?.durationMs, tries: live[s.id]?.tries }))
        : viewed
          ? flow.steps.map((s) => {
              const r = viewed.get(s.id);
              return { ...s, status: r?.status, durationMs: r?.durationMs, tries: typeof r?.metadata?.tries === 'number' ? r.metadata.tries : undefined };
            })
          : flow.steps,
    [flow.steps, liveRun, live, viewed],
  );
  const marks = useMemo(() => {
    const m: Record<string, FlowMark> = {};
    for (const id of state.breakpoints) m[id] = { ...m[id], breakpoint: true };
    for (const id of Object.keys(state.pins)) m[id] = { ...m[id], pinned: true };
    if (pause) m[pause.stepId] = { ...m[pause.stepId], paused: true };
    return m;
  }, [state, pause]);
  const graph = useMemo(() => flowGraph(flow.steps), [flow.steps]);
  // a step asked for from outside: selected and revealed once, when the flow (with it) is there
  const focused = useRef(0);
  useEffect(() => {
    if (!focusStep || focused.current === focusStep.n || !flow.steps.some((s) => s.id === focusStep.id)) return;
    focused.current = focusStep.n;
    setSel({ steps: [focusStep.id] });
    requestAnimationFrame(() => canvasApi.current?.reveal(focusStep.id));
  }, [focusStep, flow.steps]);
  // checks as you edit: unset variables, steps that never run, cycles, when: without a condition, steps waiting for a finally step
  const checks = useMemo(() => flowChecks(flow.steps), [flow.steps]);
  const hasLayout = flow.steps.some((s) => s.position);
  const ids = new Set(flow.steps.map((s) => s.id));
  // a selection of steps that are gone (removed, renamed) is dropped
  const selSteps = sel.steps.filter((id) => ids.has(id));
  const noteIds = new Set((flow.notes ?? []).map((n) => n.id));
  const selNotes = (sel.notes ?? []).filter((id) => noteIds.has(id));
  const one = selSteps.length === 1 ? flow.steps.find((s) => s.id === selSteps[0]) : undefined;

  // an edit whose button, step or suggestion went away leaves the focus nowhere (the body): the canvas takes it, so the
  // designer's keys (Ctrl+Z, Delete) keep working without a click first
  const refocus = useCallback(
    () =>
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if ((!a || a === document.body) && root.current?.offsetParent) canvasApi.current?.focus();
      }),
    [],
  );
  const apply = useCallback(
    async (op: Op, opts: { select?: boolean; restoring?: 'undo' | 'redo' } = {}): Promise<FlowEditAnswer | undefined> => {
      setBusy(true);
      try {
        await beforeEdit();
        const r = await call<FlowEditAnswer>('tests.flowEdit', { file, op, environment: env });
        if (r.before !== r.text) {
          if (opts.restoring === 'undo') h.redo.push(r.before);
          else {
            h.undo.push(r.before);
            if (h.undo.length > 100) h.undo.shift();
            if (!opts.restoring) h.redo.length = 0;
          }
        }
        if (opts.restoring) setVersion((v) => v + 1);
        baseText.current = r.text;
        onEdited(r);
        if (opts.select && r.added.length) setSel({ steps: r.added });
        rerender((n) => n + 1);
        refocus();
        return r;
      } catch (e) {
        toastError(e);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [beforeEdit, env, file, h, onEdited],
  );
  // the file on disk: a change made elsewhere is taken, and the undo history of the old file dropped
  const baseText = useFlowFileFollow(file, h, () => rerender((n) => n + 1), savedText);

  const undo = () => {
    const text = h.undo.pop();
    if (text !== undefined) void apply({ op: 'replace', text }, { restoring: 'undo' });
  };
  const redo = () => {
    const text = h.redo.pop();
    if (text !== undefined) void apply({ op: 'replace', text }, { restoring: 'redo' });
  };

  /** Where a new step goes: after the selected one, or where the canvas was clicked (only when the file has a layout). */
  const placeNew = (): { after?: string; at?: [number, number] } => {
    const after = one?.id;
    if (!hasLayout) return { after };
    const n = after ? graph.nodes.find((x) => x.id === after) : undefined;
    if (n) return { after, at: [n.x + GAP_X, n.y] };
    if (canvasAt.current) return { at: canvasAt.current };
    return { at: [graph.nodes.reduce((m, x) => Math.max(m, x.x + x.w), 0) + 64, 0] };
  };
  const addStep = (step: Record<string, unknown>) => {
    const where = placeNew();
    // after a condition: on its true branch, or the false one when only that is still empty
    let branch: Record<string, unknown> = {};
    if (one?.type === 'condition' && where.after === one.id) {
      const on = (w: boolean) => flow.steps.some((s) => s.when === w && s.dependsOn?.includes(one.id));
      branch = { when: on(true) && !on(false) ? false : true };
    }
    void apply({ op: 'addStep', step: { ...step, ...branch }, ...where }, { select: true });
  };
  /** Add a block where the picker was opened: after a step's port (on a condition's branch), at the Start, or after the selection. */
  const addBlock = (step: Record<string, unknown>, target?: PickTarget) => {
    if (!target || target.from === undefined) return addStep(step);
    if (target.from === FLOW_START) {
      const at: [number, number] | undefined = hasLayout ? [0, graph.nodes.reduce((m, x) => Math.max(m, x.y + x.h), 0) + 40] : undefined;
      return void apply({ op: 'addStep', step, ...(at ? { at } : {}) }, { select: true });
    }
    const n = graph.nodes.find((x) => x.id === target.from);
    const at: [number, number] | undefined = hasLayout && n ? [n.x + GAP_X, n.y + (target.when === false ? 96 : 0)] : undefined;
    void apply({ op: 'addStep', step: { ...step, ...(target.when !== undefined ? { when: target.when } : {}) }, after: target.from, ...(at ? { at } : {}) }, { select: true });
  };
  /**
   * Items or a block dropped on the canvas: one flow edit (one undo step) that adds them where they landed — after a
   * step, on a condition's branch, into a connection, or alone — placed to the right of the step they follow.
   */
  const dropItems = async (d: FlowDropEvent) => {
    const h = d.hint;
    const n = h.kind === 'node' || h.kind === 'port' ? graph.nodes.find((x) => x.id === h.id) : h.kind === 'edge' ? graph.nodes.find((x) => x.id === h.from) : undefined;
    const target = h.kind === 'node' ? { after: h.id } : h.kind === 'port' ? { after: h.id, when: h.when } : h.kind === 'edge' ? { between: { from: h.from, to: h.to } } : {};
    // a flow placed by hand keeps being placed: the new steps go right of the step they follow, or where they were dropped
    const at = hasLayout ? (n ? [Math.round(n.x + GAP_X), Math.round(n.y + (h.kind === 'port' && !h.when ? 96 : 0))] : [Math.round(d.at[0] - 110), Math.round(d.at[1] - 36)]) : undefined;
    const block = d.block ? PALETTE.find((p) => p.type === d.block) : undefined;
    if (d.block && !block) return;
    const r = await apply({ op: 'drop', ...(block ? { steps: [block.step] } : { refs: d.refs }), target: { ...target, ...(at ? { at } : {}) } }, { select: true });
    if (!r) return;
    const what = `${r.added.length} step${r.added.length === 1 ? '' : 's'} added`;
    useApp.getState().toast(r.notes?.length ? `${what}: ${r.notes.join('; ')}` : what, 'info', [{ label: 'Undo', onClick: undo }, { ref: { kind: 'flow', path: file } }]);
  };
  const addParallel = () => {
    const group = newGroup(flow.steps);
    const deps = one ? { dependsOn: [one.id] } : {};
    const at = placeNew().at;
    const steps = [1, 2].map((n) => ({ name: `Request ${n}`, type: 'http', method: 'GET', url: '{{baseUrl}}/', parallel: group, ...deps, assertions: [{ type: 'status', expected: 200 }] }));
    void apply({ op: 'addSteps', steps, ...(at ? { at: [at[0], at[1]] } : {}) }, { select: true }).then((r) => {
      // the second request goes under the first, inside the frame
      if (r && at && r.added.length === 2) void apply({ op: 'setLayout', positions: { [r.added[1]!]: [at[0], at[1] + 96] } });
    });
  };
  const group = (ids: string[], g: Pick<FlowGroup, 'kind' | 'name'> | { kind: 'parallel'; name: null }) =>
    void apply({ op: 'group', ids, ...(g.kind === 'finally' ? { finally: true } : { parallel: g.name }) });
  const addFromCollection = async (collection: string, item: string) => {
    setPicking(false);
    await apply({ op: 'addFromCollection', collection, items: [item], chain: true, ...placeNew() }, { select: true });
  };
  const generate = async () => {
    const job = await promptText('Generate a flow with AI', {
      message: 'What should the flow do? One or two sentences.',
      placeholder: 'e.g. log in, create an order with the token, read it back, cancel it',
      okLabel: 'Generate',
      detail: flow.steps.length
        ? 'The assistant writes the whole file; you review it before it replaces this one (Undo brings it back).'
        : 'The assistant writes the steps as YAML; you review them before they are saved.',
    });
    if (!job) return;
    useApp.getState().set({
      assistant: {
        task: 'design-flow',
        title: 'Design a flow',
        context: { file: `tests/${file}`, environment: env, steps: flow.steps.map(({ id, name, type, method, url, extract, dependsOn }) => ({ id, name, type, method, url, extract, dependsOn })) },
        question: job,
        apply: {
          label: 'Review and use this flow',
          run: async (code) => {
            const problems = await call<Array<{ severity: string; message: string; line: number }>>('tests.lint', { content: code, path: file }).catch((e) => [
              { severity: 'error', message: asError(e).message, line: 1 },
            ]);
            const errors = problems.filter((p) => p.severity === 'error');
            if (errors.length) return `it is not a test file the runner can load: ${errors.map((p) => `line ${p.line}: ${p.message}`).join('; ')}`;
            if (
              !(await confirmAction({
                title: 'Replace the flow',
                message: `Replace tests/${file} with the AI-generated flow?`,
                detail: 'Read the YAML in the assistant first. Undo in the Flow tab brings the current file back.',
                confirmLabel: 'Replace',
              }))
            )
              return 'not used';
            const r = await apply({ op: 'replace', text: code });
            return r ? { done: 'AI-generated flow saved: check each step, then Run flow' } : 'it could not be saved';
          },
        },
      },
    });
  };

  /** Delete what is selected (an edge, steps, notes): one edit, one undo step. */
  const remove = () => {
    const ops: Op[] = [];
    if (sel.edge) ops.push({ op: 'disconnect', from: sel.edge.from, to: sel.edge.to });
    if (selSteps.length) ops.push({ op: 'removeStep', id: selSteps });
    for (const id of selNotes) ops.push({ op: 'removeNote', id });
    if (ops.length) void apply(ops.length === 1 ? ops[0]! : { op: 'batch', ops }).then((r) => r && setSel({ steps: [] }));
  };
  const move = (positions: Record<string, [number, number]>) => {
    // the first move of a flow without a layout keeps every other step where the automatic layout drew it
    const all: Record<string, [number, number]> = hasLayout ? {} : Object.fromEntries(graph.nodes.map((n) => [n.id, [Math.round(n.x), Math.round(n.y)] as [number, number]]));
    void apply({ op: 'setLayout', positions: { ...all, ...positions } });
  };
  /** Run a step with the steps it waits for (and theirs). */
  const withDependencies = (id: string): string[] => {
    const byId = new Map(flow.steps.map((s) => [s.id, s]));
    const out = new Set<string>();
    const walk = (x: string) => {
      if (out.has(x) || !byId.has(x)) return;
      out.add(x);
      for (const d of byId.get(x)!.dependsOn ?? []) walk(d);
    };
    walk(id);
    return flow.steps.filter((s) => out.has(s.id)).map((s) => s.id);
  };
  const run = async (o?: FlowRunRequest) => {
    const id = await onRun(o);
    if (!id) return;
    setLive({});
    setPause(undefined);
    setViewRun(undefined);
    setLiveRun(id);
  };
  const debug = () => void run({ debug: true, breakpoints: state.breakpoints });

  /* ---------------------------------------------------------------- notes, frames, align */
  const addNote = (at?: [number, number]) => {
    const [x, y] = at ?? canvasApi.current?.centre() ?? [0, 0];
    void apply({ op: 'addNote', note: { x: Math.round(x), y: Math.round(y), text: '' } });
  };
  const frameSelection = async (ids = selSteps) => {
    if (!ids.length) return useApp.getState().toast('Select the steps to frame first (Shift+click adds a step to the selection)');
    const title = await promptText('Frame the selected steps', { message: 'A title for the frame (it only groups the steps on the canvas).', placeholder: 'e.g. Sign in', okLabel: 'Frame' });
    if (title === null) return;
    const used = new Set((flow.frames ?? []).map((f) => f.color));
    const color = FLOW_COLORS.find((c) => !used.has(c)) ?? 'blue';
    void apply({ op: 'addFrame', title: String(title).trim() || 'Group', color, steps: ids });
  };
  /** Line the selected steps up (left edges, top edges or centres), or space them evenly along the axis they spread most on. */
  const arrange = (how: 'left' | 'top' | 'center' | 'distribute') => {
    const nodes = graph.nodes.filter((n) => selSteps.includes(n.id));
    if (nodes.length < 2) return useApp.getState().toast('Select two or more steps to align them (Shift+click adds a step to the selection)');
    const out: Record<string, [number, number]> = {};
    if (how === 'left') for (const n of nodes) out[n.id] = [Math.min(...nodes.map((x) => x.x)), n.y];
    else if (how === 'top') for (const n of nodes) out[n.id] = [n.x, Math.min(...nodes.map((x) => x.y))];
    else if (how === 'center') {
      const c = nodes.reduce((sum, x) => sum + x.x + x.w / 2, 0) / nodes.length;
      for (const n of nodes) out[n.id] = [c - n.w / 2, n.y];
    } else {
      if (nodes.length < 3) return useApp.getState().toast('Select three or more steps to space them evenly');
      const spreadX = Math.max(...nodes.map((n) => n.x)) - Math.min(...nodes.map((n) => n.x));
      const spreadY = Math.max(...nodes.map((n) => n.y)) - Math.min(...nodes.map((n) => n.y));
      const horizontal = spreadX >= spreadY;
      const sorted = [...nodes].sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
      const first = sorted[0]!;
      const last = sorted[sorted.length - 1]!;
      const step = ((horizontal ? last.x - first.x : last.y - first.y) as number) / (sorted.length - 1);
      sorted.forEach((n, i) => (out[n.id] = horizontal ? [first.x + step * i, n.y] : [n.x, first.y + step * i]));
    }
    move(Object.fromEntries(Object.entries(out).map(([id, [x, y]]) => [id, [Math.round(x), Math.round(y)] as [number, number]])));
  };
  const toggleMinimap = () =>
    setMinimap((v) => {
      savePref('minimap', !v);
      return !v;
    });
  const toggleSnap = () =>
    setSnap((v) => {
      savePref('snap', !v);
      return !v;
    });
  /** The latest result of a step for the hover card: the live run's, the run shown from the history, or the latest run's (read once). */
  const resultOf = (s: FlowStep): { result?: TestResult; runId?: string } => {
    if (liveRun) return { result: liveResults.current.get(s.id), runId: liveRun };
    if (viewRun) return { result: viewed?.get(s.id), runId: viewRun.runId };
    return { runId: flow.run?.runId };
  };
  const setBreakpoints = (ids: string[]) => {
    setState((s) => ({ ...s, breakpoints: ids }));
    call<DesignerState>('tests.flowBreakpoints', { file, ids }).then(setState, toastError);
    // a debugged run takes the change at once
    if (liveRun) void call('runs.setBreakpoints', { runId: liveRun, ids }).catch(() => undefined);
  };
  const toggleBreakpoint = (id: string) => setBreakpoints(state.breakpoints.includes(id) ? state.breakpoints.filter((x) => x !== id) : [...state.breakpoints, id]);
  const pin = async (s: FlowStep) => {
    try {
      setState(await call<DesignerState>('tests.flowPin', { file, stepId: s.id }));
      useApp.getState().toast(`"${s.name}" is pinned: runs from the designer use its response instead of calling the API`, 'info', { ref: { kind: 'flow', path: file, step: s.id }, label: 'Show the step' });
    } catch (e) {
      toastError(e);
    }
  };
  const unpin = async (s: FlowStep) => {
    try {
      setState(await call<DesignerState>('tests.flowUnpin', { file, stepId: s.id }));
    } catch (e) {
      toastError(e);
    }
  };
  const resume = async (action: 'continue' | 'step' | 'stop', vars: Record<string, unknown>) => {
    if (!pause) return;
    try {
      await call('runs.resume', { runId: pause.runId, action, vars });
      setPause(undefined);
    } catch (e) {
      toastError(e);
    }
  };
  /** What the menus and the keys act with (FlowDesignerMenus). */
  const copy = (list: string[]) => {
    copied = { file, ids: list };
    useApp.getState().toast(`${list.length} step${list.length === 1 ? '' : 's'} copied: Ctrl+V pastes them into this or another flow`, 'info', { ref: { kind: 'flow', path: file } });
  };
  const actions: DesignerActions = {
    apply,
    steps: flow.steps,
    notes: flow.notes ?? [],
    places: () => Object.fromEntries(graph.nodes.map((n) => [n.id, [Math.round(n.x), Math.round(n.y)] as [number, number]])),
    // (the notes too: a step put under a note would be hidden by it)
    boxes: () => [...graph.nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })), ...(flow.notes ?? []).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))],
    hasLayout,
    selection: { steps: selSteps, edge: sel.edge, notes: selNotes },
    setSelection: setSel,
    addNote,
    frameSelection: () => void frameSelection(),
    copy,
    // (read when used: a copy made a moment ago, without a render since, pastes)
    canPaste: () => !!copied,
    paste: (at) => copied && void apply({ op: 'pasteSteps', from: copied.file, ids: copied.ids, ...(at && hasLayout ? { at } : placeNew()) }, { select: true }),
    remove,
    undo,
    redo,
    fit: () => canvasApi.current?.fit(),
    find: () => canvasApi.current?.find(),
    run: (o) => void run({ ...o, ...(o.from ? { seedRunId: viewRun?.runId } : {}) }),
    breakpoints: state.breakpoints,
    toggleBreakpoint,
    pinned: (id) => !!state.pins[id],
    pin: (s) => void pin(s),
    unpin: (s) => void unpin(s),
    openStep: onOpenStep,
  };
  /** Steps dropped into a parallel group or the Finally lane: they join it, placed where they land but never on a step already there (one undo step). */
  const dropIntoGroup = (moved: string[], g: FlowGroup, positions: Record<string, [number, number]>) => {
    const occupied = [...graph.nodes.filter((n) => !positions[n.id]).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })), ...(flow.notes ?? []).map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h }))];
    const out: Record<string, [number, number]> = {};
    for (const [id, at] of Object.entries(positions)) {
      const p = freeSpot(occupied, at);
      out[id] = p;
      occupied.push({ x: p[0], y: p[1], w: STEP_SIZE.w, h: STEP_SIZE.h });
    }
    void apply({ op: 'batch', ops: [{ op: 'setLayout', positions: { ...(hasLayout ? {} : actions.places()), ...out } }, { op: 'group', ids: moved, ...(g.kind === 'finally' ? { finally: true } : { parallel: g.name }) }] });
  };

  /** What the command palette offers first while the canvas has the focus (Ctrl+K). */
  const canvasCommands = (): PaletteCommand[] => {
    const icon = (n: ReactNode) => n;
    return [
      ...PALETTE.map((p) => ({ id: `flow-add-${p.type}`, label: `Add step: ${p.label}`, hint: 'Flow canvas', icon: icon(<Plus size={16} />), run: () => addStep(p.step) })),
      ...(selSteps.length === 2
        ? [{ id: 'flow-connect', label: `Connect selected: "${selSteps[1]}" waits for "${selSteps[0]}"`, hint: 'Flow canvas', icon: <Workflow size={16} />, run: () => void apply({ op: 'connect', from: selSteps[0]!, to: selSteps[1]! }) }]
        : [{ id: 'flow-connect', label: 'Connect selected (select two steps: the second waits for the first)', hint: 'Flow canvas', icon: <Workflow size={16} />, run: () => useApp.getState().toast('Select two steps with Shift+click: the second then waits for the first') }]),
      { id: 'flow-arrange', label: 'Auto-arrange', hint: 'Flow canvas', icon: <LayoutGrid size={16} />, run: () => void apply({ op: 'setLayout', positions: null }) },
      { id: 'flow-run', label: 'Run flow', hint: 'Flow canvas', icon: <Play size={16} />, run: () => void run() },
      { id: 'flow-debug', label: 'Debug flow', hint: 'Flow canvas', icon: <Bug size={16} />, run: debug },
      { id: 'flow-minimap', label: minimap ? 'Hide minimap' : 'Show minimap', hint: 'Flow canvas', icon: <MapIcon size={16} />, run: toggleMinimap },
      { id: 'flow-find', label: 'Find a step…', hint: 'Ctrl+F', icon: <Search size={16} />, run: () => canvasApi.current?.find() },
      { id: 'flow-note', label: 'Add note', hint: 'Flow canvas', icon: <StickyNote size={16} />, run: () => addNote() },
      { id: 'flow-frame', label: 'Frame selection…', hint: 'Flow canvas', icon: <Frame size={16} />, run: () => void frameSelection() },
      { id: 'flow-align-left', label: 'Align left', hint: 'Flow canvas', icon: <AlignStartVertical size={16} />, run: () => arrange('left') },
      { id: 'flow-align-top', label: 'Align top', hint: 'Flow canvas', icon: <AlignStartHorizontal size={16} />, run: () => arrange('top') },
      { id: 'flow-align-center', label: 'Align centres', hint: 'Flow canvas', icon: <AlignCenterVertical size={16} />, run: () => arrange('center') },
      { id: 'flow-distribute', label: 'Distribute evenly', hint: 'Flow canvas', icon: <AlignHorizontalSpaceAround size={16} />, run: () => arrange('distribute') },
      { id: 'flow-snap', label: snap ? 'Snap to grid: off' : 'Snap to grid: on', hint: 'Flow canvas', icon: <Grid3x3 size={16} />, run: toggleSnap },
      { id: 'flow-fit', label: 'Fit the flow in view', hint: 'Flow canvas', icon: <AlignHorizontalJustifyCenter size={16} />, run: () => canvasApi.current?.fit() },
    ];
  };
  const commandsRef = useRef(canvasCommands);
  commandsRef.current = canvasCommands;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    return setPaletteContext({ root: el, commands: () => commandsRef.current() });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable], .monaco-editor')) return;
    if (e.key === 'F9' && one) {
      e.preventDefault();
      return toggleBreakpoint(one.id);
    }
    if (pause && (e.key === 'F8' || e.key === 'F10')) {
      e.preventDefault();
      return void resume(e.key === 'F8' ? 'continue' : 'step', {});
    }
    // a key in a menu or the picker (React passes their events through the designer) is theirs
    if (!root.current?.contains(e.target as Node) && e.target !== document.body) return;
    if (canvasKey(actions, e)) e.preventDefault();
  };
  // the focus on the body (the focused step, suggestion or button went away) after a press in the designer: its keys still work
  const keysRef = useRef(onKeyDown);
  keysRef.current = onKeyDown;
  useEffect(() => {
    let inside = false;
    const onPress = (e: PointerEvent) => (inside = !!root.current?.contains(e.target as Node));
    const onKey = (e: KeyboardEvent) => {
      if (inside && !e.defaultPrevented && document.activeElement === document.body && root.current?.offsetParent) keysRef.current(e as unknown as React.KeyboardEvent);
    };
    // the focused step, suggestion or button removed from the page (deleted, re-rendered): the canvas takes the focus,
    // whenever that happens (after the edit's answer, a render later); a click elsewhere (inside = false) is left alone
    const mo = new MutationObserver(() => {
      if (inside && document.activeElement === document.body && root.current?.offsetParent) canvasApi.current?.focus();
    });
    if (root.current) mo.observe(root.current, { childList: true, subtree: true });
    document.addEventListener('pointerdown', onPress, true);
    window.addEventListener('keydown', onKey);
    return () => {
      mo.disconnect();
      document.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  /* ---------------------------------------------------------------- the block picker (the app's command palette, at a port) */
  const collections = useCollectionTree();
  const [subflows, setSubflows] = useState<string[]>([]);
  const openPicker = (target: PickTarget, at: { x: number; y: number }) => {
    setPicker({ ...target, ...at });
    call<Array<{ kind: string; path: string; children?: unknown[] }>>('tests.tree').then(
      (tree) => {
        const out: string[] = [];
        const walk = (nodes: Array<{ kind: string; path: string; children?: unknown[] }>) => {
          for (const n of nodes) {
            if (n.kind === 'dir') walk((n.children ?? []) as typeof nodes);
            else if (/\.(ya?ml|json)$/i.test(n.path) && !/\.suite\./i.test(n.path) && n.path !== file) out.push(n.path);
          }
        };
        walk(tree);
        setSubflows(out.slice(0, 200));
      },
      () => setSubflows([]),
    );
  };
  const pickerCommands = (target: PickTarget): PaletteCommand[] =>
    blockPickerCommands({
      collections,
      subflows,
      add: (step) => addBlock(step, target),
      addSaved: (collection, item) => {
        const after = target.from === undefined ? one?.id : target.from !== FLOW_START ? target.from : undefined;
        void apply({ op: 'addFromCollection', collection, items: [item], chain: true, ...(after ? { after } : {}) }, { select: true });
      },
      addParallel,
      output: () => {
        setSel({ steps: [] });
        setTimeout(() => document.querySelector<HTMLInputElement>('[data-flow-output] input[aria-label="New name"]')?.focus(), 50);
      },
      fromCollection: () => setPicking(true),
      generate: () => void generate(),
    });

  /* ---------------------------------------------------------------- the Start node and Deploy */
  const [deploy, setDeploy] = useState<{ status?: DeployStatus; error?: string }>({});
  const loadDeploy = useCallback(() => {
    call<DeployStatus>('tests.deployStatus', { file }).then(
      (status) => setDeploy({ status }),
      (e) => setDeploy({ error: asError(e).message }),
    );
  }, [file]);
  useEffect(() => loadDeploy(), [loadDeploy, flow.exposed]);
  const setWebhook = async (on: boolean) => {
    // enabled without a path: the engine gives it /hooks/<the file's name>
    const r = await apply({ op: 'setWebhook', webhook: on ? {} : null });
    if (r) loadDeploy();
  };
  // the monitor that runs this file (opened the one way, openRef), or a new one prefilled with it
  const schedule = () =>
    deploy.status?.schedule ? void openRef({ kind: 'monitor', monitorId: deploy.status.schedule.monitorId }) : useApp.getState().openIntent('monitors', { create: { testFile: file } });
  const triggerItems: MenuItem[] = [
    { label: 'Manual', icon: <Play size={14} />, onSelect: () => useApp.getState().toast('The flow runs when you click Run flow, or from the terminal: testpion test tests/' + file) },
    { label: deploy.status?.schedule ? 'Schedule: open the monitor' : 'Schedule…', icon: <CalendarClock size={14} />, onSelect: schedule },
    { label: deploy.status?.webhook ? 'Webhook (on)' : 'Webhook', icon: <Webhook size={14} />, onSelect: () => (deploy.status?.webhook ? useApp.getState().toast('Webhook: Deploy ▸ Webhook copies its URL and serves it') : void setWebhook(true)) },
    { label: flow.exposed !== undefined ? 'MCP tool (exposed)…' : 'MCP tool…', icon: <Bot size={14} />, onSelect: () => onExpose?.(), disabled: !onExpose },
    { label: 'CI…', icon: <Workflow size={14} />, onSelect: () => useApp.getState().set({ ci: { tests: [file], environment: env } }) },
  ];
  const startSpec: StartSpec = {
    trigger: triggerLabel(deploy.status, flow.exposed),
    triggerItems,
    inputs: flow.inputs ?? [],
    onInputs: (inputs) => void apply({ op: 'setInputs', inputs }),
    suggestions: flow.steps.length
      ? undefined
      : [
          {
            id: 'blocks',
            label: 'Add blocks',
            icon: <Plus size={14} />,
            tone: 'var(--accent)',
            title: 'Pick a block: a request, a condition, a loop …',
            onClick: () => {
              const r = document.querySelector('[data-flow-suggestion="blocks"]')?.getBoundingClientRect();
              openPicker({ from: FLOW_START }, { x: r ? r.left : 200, y: r ? r.bottom + 4 : 200 });
            },
          },
          { id: 'example', label: 'API example', icon: <Globe size={14} />, tone: 'var(--ok)', title: 'A ready request to a public API with an extract and a check: Run flow works at once', onClick: () => addStep(API_EXAMPLE) },
          { id: 'collection', label: 'Create from collection', icon: <FolderInput size={14} />, tone: 'var(--warn)', title: 'Saved requests (or a folder, chained)', onClick: () => setPicking(true) },
          { id: 'record', label: 'Record from the Debugger', icon: <Bug size={14} />, tone: 'var(--bad)', title: 'Use your app; the exchanges become steps', onClick: () => useApp.getState().openIntent('debugger', { record: true }) },
          { id: 'ai', label: 'Generate with AI', icon: <Sparkles size={14} />, tone: 'oklch(0.62 0.18 300)', title: 'Describe the flow; the assistant writes it', onClick: () => void generate() },
        ],
  };
  // the toolbar's less used actions: buttons on a wide canvas, the ⋯ menu on a narrow one
  const moreActions: OverflowAction[] = [
    { label: 'Undo', icon: <Undo2 size={12} />, onSelect: undo, disabled: !h.undo.length || busy, title: 'Undo the last change (Ctrl+Z)', data: { 'data-flow-undo': '' }, minWidth: 480 },
    { label: 'Redo', icon: <Redo2 size={12} />, onSelect: redo, disabled: !h.redo.length || busy, title: 'Redo (Ctrl+Y)', data: { 'data-flow-redo': '' }, minWidth: 480 },
    {
      label: 'History',
      icon: <History size={12} />,
      // closed, it takes the run it showed on the canvas with it (as its own close button does)
      onSelect: () => {
        if (historyOpen) setViewRun(undefined);
        setHistoryOpen(!historyOpen);
      },
      pressed: historyOpen,
      data: { 'data-flow-history-toggle': '' },
      minWidth: 560,
      title: 'The runs of this flow: select one to see its results, requests, responses and variables on the canvas',
    },
    {
      label: 'Auto-arrange',
      icon: <LayoutGrid size={12} />,
      onSelect: () => void apply({ op: 'setLayout', positions: null }),
      disabled: !hasLayout || busy,
      separator: true,
      title: 'Lay the steps out in columns again (forget where they were dragged; notes and frames stay)',
    },
    { label: 'Find', icon: <Search size={12} />, onSelect: () => canvasApi.current?.find(), title: 'Find steps by name, URL, variable or type (Ctrl+F); Enter jumps to the next' },
    {
      label: 'Minimap',
      icon: <MapIcon size={12} />,
      onSelect: toggleMinimap,
      pressed: minimap,
      data: { 'data-flow-minimap-toggle': '' },
      title: flow.steps.length > 8 ? 'Show or hide the overview in the corner' : 'Show or hide the overview in the corner (shown for flows of more than 8 steps)',
    },
    { label: 'Snap', icon: <Grid3x3 size={12} />, onSelect: toggleSnap, pressed: snap, data: { 'data-flow-snap-toggle': '' }, title: 'Snap dragged steps and notes to a 16 px grid; steps that line up with others show a guide either way' },
  ];
  const toolbar: ReactNode = (
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
          openPicker({}, { x: r.left, y: r.bottom + 4 });
        }}
      >
        <span className="hidden @[400px]:inline">Block</span>
      </Button>
      <Button size="sm" icon={<StickyNote size={12} />} onClick={() => addNote()} data-flow-add-note aria-label="Text" title="A sticky note (Markdown) in the middle of the view; double-click the empty canvas to put one there">
        <span className="hidden @[720px]:inline">Text</span>
      </Button>
      <span className="inline-flex">
        <Button size="sm" className="rounded-r-none" icon={<Play size={12} />} onClick={() => void run()} disabled={!flow.steps.length} title="Run every step of the flow; the steps light up as they finish" aria-label="Run flow" data-flow-run>
          <span className="hidden @[560px]:inline">Run flow</span>
        </Button>
        <Menu
          align="start"
          width={250}
          items={[
            {
              label: 'Run with breakpoints',
              icon: <Bug size={14} />,
              onSelect: debug,
              disabled: !flow.steps.length || !!pause,
              title: state.breakpoints.length
                ? `Run the flow one step at a time, pausing before the ${state.breakpoints.length} breakpoint${state.breakpoints.length === 1 ? '' : 's'}: inspect and change variables, then Continue, Step over or Stop`
                : 'Run the flow pausing before breakpoints: add one with F9 or a step\u2019s right-click menu',
            },
            { label: 'Run from selected', icon: <ChevronsRight size={14} />, onSelect: () => one && void run({ from: one.id, seedRunId: viewRun?.runId }), disabled: !one, title: 'The selected step and every step after it, seeded from the latest run' },
            { label: 'Run selected step', icon: <StepForward size={14} />, onSelect: () => one && void run({ ids: withDependencies(one.id) }), disabled: !one, title: 'The selected step with the steps it waits for' },
            { label: 'Run with data…', icon: <FileSpreadsheet size={14} />, separator: true, onSelect: () => setScaleDialog('data'), disabled: !flow.steps.length, title: 'Once per row of a data file, a dataset or a database query: a grid of rows × steps' },
            { label: LABEL.runInEnvironments, icon: <Layers size={14} />, onSelect: () => setScaleDialog('matrix'), disabled: !flow.steps.length, title: 'The flow in each environment picked, compared step by step' },
            {
              label: 'Timeline of the run',
              icon: <GanttChart size={14} />,
              separator: true,
              onSelect: () => {
                const runId = viewRun?.runId ?? liveRun ?? flow.run?.runId;
                if (runId) setDock({ kind: 'timeline', runId });
              },
              disabled: !(viewRun?.runId ?? liveRun ?? flow.run?.runId),
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

  const viewedResult = one && viewed ? viewed.get(one.id) : undefined;
  const timelineIndex = viewRun ? Math.max(0, one ? viewRun.results.findIndex((r) => r.id === one.id) : viewRun.results.length - 1) : 0;
  const inspector = (
    <div className="h-full overflow-auto text-sm" data-flow-inspector>
      {pause && (
        <PausePanel
          key={`${pause.runId}:${pause.stepId}`}
          pause={pause}
          stepName={flow.steps.find((s) => s.id === pause.stepId)?.name ?? pause.stepId}
          onResume={(a, v) => void resume(a, v)}
        />
      )}
      {viewRun && (
        <div className="grid gap-3 p-3 border-b border-line" data-flow-run-view={viewRun.runId}>
          <div className="flex items-center gap-2 text-xs">
            <History size={13} className="text-muted shrink-0" />
            <span className="flex-1 truncate">
              Run <span className="mono">{viewRun.runId}</span>
            </span>
            <LinkButton icon={<GanttChart size={12} />} onClick={() => setDock({ kind: 'timeline', runId: viewRun.runId })} data-flow-timeline-open>
              Timeline
            </LinkButton>
            {one && (
              <Segmented
                label="Inspector"
                value={inspectorMode}
                onChange={setInspectorMode}
                options={[
                  { value: 'result', label: 'Run result' },
                  { value: 'step', label: 'Edit step' },
                ]}
              />
            )}
          </div>
          {(!one || inspectorMode === 'result') && (
            <>
              {one &&
                (viewedResult ? (
                  <div className="h-[380px] border border-line rounded-md overflow-hidden" data-flow-run-result={one.id}>
                    <ResultDetail r={viewedResult} runId={viewRun.runId} initialTab="io" />
                  </div>
                ) : (
                  <p className="text-xs text-muted">&quot;{one.name}&quot; did not run in this run.</p>
                ))}
              <VariablesTimeline results={viewRun.results} index={timelineIndex} onIndex={(i) => setSel({ steps: [viewRun.results[i]!.id] })} />
            </>
          )}
        </div>
      )}
      {(!viewRun || !one || inspectorMode === 'step') && (
        one ? (
          <StepInspector
            key={`${one.id}:${version}`}
            file={file}
            step={one}
            raw={flow.raw?.[one.id]}
            inheritedAuth={flow.inheritedAuth?.[one.id]}
            steps={flow.steps}
            lastRunId={liveRun ?? flow.run?.runId}
            update={(set) => apply({ op: 'updateStep', id: one.id, set })}
            actions={
              <>
                <Button size="sm" icon={<StepForward size={12} />} onClick={() => void run({ ids: withDependencies(one.id) })}>
                  Run step
                </Button>
                <Menu
                  align="start"
                  width={230}
                  items={debugItems(actions, one)}
                  trigger={
                    <Button size="sm" icon={<Bug size={12} />} data-inspector-debug-menu title="Run from here, run to here, breakpoint, pin the response">
                      Debug
                    </Button>
                  }
                />
                <Button size="sm" icon={<FileCode2 size={12} />} onClick={() => onOpenStep(one)} title="Show the step in the YAML editor">
                  Open in editor
                </Button>
                <Button size="sm" icon={<CopyPlus size={12} />} onClick={() => void apply({ op: 'duplicateStep', id: one.id }, { select: true })} title="Ctrl+D">
                  Duplicate
                </Button>
                <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={remove} title="Delete">
                  Delete step
                </Button>
              </>
            }
          />
        ) : selSteps.length > 1 ? (
          <div className="p-3 grid gap-3">
            <SectionTitle>{selSteps.length} steps selected</SectionTitle>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" icon={<CopyPlus size={12} />} onClick={() => void apply({ op: 'duplicateStep', id: selSteps }, { select: true })}>
                Duplicate
              </Button>
              <Button
                size="sm"
                icon={<Copy size={12} />}
                onClick={() => {
                  copied = { file, ids: selSteps };
                  useApp.getState().toast(`${selSteps.length} steps copied: Ctrl+V pastes them into this or another flow`, 'info', { ref: { kind: 'flow', path: file } });
                }}
              >
                Copy
              </Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={remove}>
                Delete steps
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5" data-flow-group-actions>
              <Button
                size="sm"
                data-flow-make-parallel
                onClick={() => group(selSteps, { kind: 'parallel', name: flow.steps.find((s) => selSteps.includes(s.id) && s.parallel)?.parallel ?? newGroup(flow.steps) })}
                title="Put the selected steps in one parallel group: they may run at the same time (what they wait for still applies)"
              >
                Run together (parallel group)
              </Button>
              <Button size="sm" onClick={() => group(selSteps, { kind: 'parallel', name: null })} disabled={!flow.steps.some((s) => selSteps.includes(s.id) && s.parallel)}>
                Leave the group
              </Button>
              <Button size="sm" onClick={() => group(selSteps, { kind: 'finally', name: 'finally' })} title="Clean-up: run these steps after every other step, whatever happened">
                Make finally
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5" data-flow-arrange-actions>
              <Button size="sm" icon={<Frame size={12} />} onClick={() => void frameSelection()} data-flow-frame-selection title="A coloured frame with a title around the selected steps (only on the canvas)">
                Frame selection
              </Button>
              <Button size="sm" icon={<AlignStartVertical size={12} />} onClick={() => arrange('left')} data-flow-align="left" title="Line the left edges up">
                Align left
              </Button>
              <Button size="sm" icon={<AlignStartHorizontal size={12} />} onClick={() => arrange('top')} data-flow-align="top" title="Line the top edges up">
                Align top
              </Button>
              <Button size="sm" icon={<AlignCenterVertical size={12} />} onClick={() => arrange('center')} data-flow-align="center" title="Line the centres up (one above the other)">
                Align centres
              </Button>
              <Button size="sm" icon={<AlignHorizontalSpaceAround size={12} />} onClick={() => arrange('distribute')} disabled={selSteps.length < 3} data-flow-align="distribute" title="Space three or more steps evenly">
                Distribute
              </Button>
            </div>
          </div>
        ) : (
          <div className="p-3 grid gap-2 text-xs text-muted">
            <SectionTitle>Flow</SectionTitle>
            <p>
              {flow.steps.length} step{flow.steps.length === 1 ? '' : 's'}, {graph.edges.length} connection{graph.edges.length === 1 ? '' : 's'}.{' '}
              {sel.edge ? (
                <>
                  <b className="text-fg">{sel.edge.to}</b> waits for <b className="text-fg">{sel.edge.from}</b>: Delete removes the connection.
                </>
              ) : (
                'Select a step to edit it.'
              )}
            </p>
            <ul className="list-disc ml-4 grid gap-1">
              <li>Drag the dot on a step's right edge onto another step: that step then waits for it and can use what it extracts.</li>
              <li>A condition has a true and a false dot: the step you drop it on runs only on that branch; the other branch shows as skipped after a run.</li>
              <li>Drag steps to arrange them; Shift+click selects several; Delete removes the selection; Ctrl+Z undoes.</li>
              <li>Ctrl+C / Ctrl+V copy steps between flows; Ctrl+D duplicates.</li>
              <li>
                Steps that wait for nothing run side by side. A <b className="text-accent">parallel</b> frame marks steps that may run together: drop a step into it to add it, drag its label to
                move it. The <b className="text-warn">Finally</b> lane runs last, whatever happened.
              </li>
              <li>
                A <span className="text-warn font-bold">!</span> marks a step that reads a variable no earlier step extracts and the environment does not define; the problems under the canvas
                list it and other mistakes (steps that never run, cycles): click one to select its step.
              </li>
              <li>Double-click empty canvas for a sticky note; select steps and Frame selection to group them in a coloured frame. Hover a step for its last response.</li>
              <li>Ctrl+F finds steps; Ctrl+K lists the canvas's actions first; dragged steps line up with others (Snap puts them on a grid).</li>
            </ul>
            {copied && (
              <LinkButton icon={<ClipboardPaste size={12} />} onClick={() => void apply({ op: 'pasteSteps', from: copied!.file, ids: copied!.ids, ...placeNew() }, { select: true })}>
                Paste {copied.ids.length} copied step{copied.ids.length === 1 ? '' : 's'}
              </LinkButton>
            )}
            <FlowOutputEditor key={`output:${version}`} output={flow.output} update={(output) => apply({ op: 'setOutput', output })} />
          </div>
        )
      )}
    </div>
  );

  return (
    <div ref={root} className="h-full min-h-0" data-flow-designer onKeyDown={onKeyDown}>
      <Split id="flow-dock" direction="vertical" initial={58} min={20} collapsedSecond={!dock}>
        <Split id="flow-designer" initial={68} min={30}>
          <div className="h-full flex min-h-0">
            {/* the block palette: drag a block onto the canvas, or click it (pinnable, like the app's other side panels) */}
            <PinnablePanel id="flow.blocks" title="Blocks" side="left" defaultWidth={230} autoUnpinBelow={1400}>
              <BlockPalette onAdd={(p) => addStep(p.step)} />
            </PinnablePanel>
            <div className="flex-1 min-w-0 h-full">
              <FlowDiagram
                editable
                fitKey={file}
                steps={steps}
                selection={actions.selection}
                onSelectionChange={setSel}
                onMove={move}
                onCanvasClick={(at) => (canvasAt.current = at)}
                onOpen={onOpenStep}
                onOpenResult={(s) => {
                  const runId = liveRun ?? viewRun?.runId ?? flow.run?.runId;
                  if (runId) onOpenResult(s, runId);
                }}
                toolbar={toolbar}
                toolbarRight={
                  <DeployPanel
                    file={file}
                    status={deploy.status}
                    error={deploy.error}
                    onOpen={loadDeploy}
                    onRefresh={loadDeploy}
                    onEnableWebhook={() => void setWebhook(true)}
                    onDisableWebhook={() => void setWebhook(false)}
                    onSchedule={schedule}
                    onExpose={() => onExpose?.()}
                    onCi={() => useApp.getState().set({ ci: { tests: [file], environment: env } })}
                  />
                }
                start={startSpec}
                onPortClick={(from, when, at) => openPicker({ from, when }, at)}
              onDropItems={(d) => void dropItems(d)}
                onConnect={(from, to, when) => (from === FLOW_START ? void apply({ op: 'updateStep', id: to, set: { dependsOn: null, when: null } }) : void apply({ op: 'connect', from, to, ...(when !== undefined ? { when } : {}) }))}
                marks={marks}
                onNodeMenu={(s, at) => {
                  // a step of a selection keeps it (the menu acts on all of them)
                  if (!selSteps.includes(s.id)) setSel({ steps: [s.id] });
                  setMenu({ step: s, ...at });
                }}
                onGroupDrop={dropIntoGroup}
                onEdgeMenu={(e, at) => setNoteMenu({ ...at, id: 'edge', items: edgeItems(actions, e) })}
                onCanvasMenu={(at, client) => setNoteMenu({ ...client, id: 'canvas', items: canvasItems(actions, at) })}
                onGroupMenu={(g, at) => setNoteMenu({ ...at, id: 'group', items: groupItems(actions, g) })}
                notes={flow.notes}
                frames={flow.frames}
                onNoteChange={(id, set) => void apply({ op: 'updateNote', id, set })}
                onNoteMenu={(n, at) => setNoteMenu({ ...at, id: n.id, items: noteItems(actions, n) })}
                onFrameMenu={(f, at) => setNoteMenu({ ...at, id: f.id, items: frameItems(actions, f) })}
                // a double-click on the empty canvas: a note or a step there
                onCanvasDoubleClick={(at, client) => setNoteMenu({ ...client, id: 'canvas', items: canvasItems(actions, at).slice(0, 2) })}
                checks={checks}
                minimap={minimap}
                snap={snap}
                renderPreview={(s) => <StepPreview step={s} {...resultOf(s)} />}
                apiRef={canvasApi}
              />
            </div>
          </div>
          {historyOpen ? (
            <Split id="flow-history" direction="vertical" initial={34} min={15}>
              <FlowHistoryList
                runs={runs}
                selected={viewRun?.runId}
                onSelect={showRun}
                onReplay={(r) => void run({ seedRunId: r.runId })}
                onClose={() => {
                  setHistoryOpen(false);
                  setViewRun(undefined);
                }}
              />
              {inspector}
            </Split>
          ) : (
            inspector
          )}
        </Split>
        {dock ? (
          <FlowRunDock
            file={file}
            dock={dock}
            onChange={setDock}
            onClose={() => setDock(undefined)}
            onPickStep={(id) => {
              if (!ids.has(id)) return;
              setSel({ steps: [id] });
              canvasApi.current?.reveal(id);
            }}
          />
        ) : (
          <span />
        )}
      </Split>
      {scaleDialog && <RunWithDataDialog file={file} initial={scaleDialog} onClose={() => setScaleDialog(undefined)} onStarted={(r) => (setScaleDialog(undefined), setDock({ kind: 'scale', id: r.id }))} />}
      {menu && (
        <div className="fixed" style={{ left: menu.x, top: menu.y }} data-flow-step-menu={menu.step.id}>
          <Menu open onOpenChange={(o) => !o && setMenu(undefined)} align="start" width={230} items={stepItems(actions, menu.step)} trigger={<span className="block w-px h-px" aria-hidden />} />
        </div>
      )}
      {picker && (
        <CommandPalette
          id="blocks"
          label="Add a block"
          placeholder="Search for blocks or requests"
          empty="No matching blocks or requests"
          anchor={{ x: picker.x, y: picker.y }}
          commands={pickerCommands(picker)}
          onClose={() => setPicker(undefined)}
        />
      )}
      {noteMenu && (
        <div className="fixed" style={{ left: noteMenu.x, top: noteMenu.y }} data-flow-canvas-menu={noteMenu.id}>
          <Menu open onOpenChange={(o) => !o && setNoteMenu(undefined)} align="start" width={210} items={noteMenu.items} trigger={<span className="block w-px h-px" aria-hidden />} />
        </div>
      )}
      {picking && <CollectionPicker onPick={(c, item) => void addFromCollection(c, item)} onClose={() => setPicking(false)} />}
    </div>
  );
}
