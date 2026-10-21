import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlowStep } from '@testpion/shared';
import { call, on } from '../api';
import { toastError, useApp, attempt } from '../store';
import type { TestResult } from '../types';
import type { FlowMark } from './FlowDiagram';
import type { FlowPause, FlowRunRow } from './FlowDebugParts';

/** The designer's state of a file (tests.flowState): breakpoints and pinned responses, kept per computer, never in the YAML. */
export interface DesignerState {
  breakpoints: string[];
  pins: Record<string, { status?: number; pinnedAt: string; fromRunId?: string; truncated?: boolean }>;
}

/**
 * The runs of the flow designer: the run started here that lights the steps up as their results come in, the debugger's
 * breakpoints, pins and paused run, the run history and the past run shown on the canvas. One hook, so FlowDesigner keeps the
 * editing and the layout. `runId` is the run the flow was last read with (it ends the live run when it arrives).
 */
export function useDesignerRun(file: string, steps: FlowStep[], runId: string | undefined) {
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
    if (liveRun && runId === liveRun) setLiveRun(undefined);
  }, [runId, liveRun]);
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
  }, [historyOpen, loadRuns, runId]);
  const [viewRun, setViewRun] = useState<{ runId: string; results: TestResult[] }>();
  const showRun = (id: string | undefined) => {
    if (!id) return setViewRun(undefined);
    call<{ results: TestResult[] }>('tests.flowRunResults', { file, runId: id }).then((r) => setViewRun({ runId: id, results: r.results }), toastError);
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

  const viewed = useMemo(() => (viewRun ? new Map(viewRun.results.map((r) => [r.id, r])) : undefined), [viewRun]);
  /** The flow's steps with the status of the live run, or of the run shown from the history. */
  const shownSteps = useMemo(
    () =>
      liveRun
        ? steps.map((s) => ({ ...s, status: live[s.id]?.status, durationMs: live[s.id]?.durationMs, tries: live[s.id]?.tries }))
        : viewed
          ? steps.map((s) => {
              const r = viewed.get(s.id);
              return { ...s, status: r?.status, durationMs: r?.durationMs, tries: typeof r?.metadata?.tries === 'number' ? r.metadata.tries : undefined };
            })
          : steps,
    [steps, liveRun, live, viewed],
  );
  const marks = useMemo(() => {
    const m: Record<string, FlowMark> = {};
    for (const id of state.breakpoints) m[id] = { ...m[id], breakpoint: true };
    for (const id of Object.keys(state.pins)) m[id] = { ...m[id], pinned: true };
    if (pause) m[pause.stepId] = { ...m[pause.stepId], paused: true };
    return m;
  }, [state, pause]);

  /** A run was started here (its id): the steps light up from the start; a run shown from the history goes. */
  const begin = (id: string) => {
    setLive({});
    setPause(undefined);
    setViewRun(undefined);
    setLiveRun(id);
  };
  /** The latest result of a step for the hover card: the live run's, the run shown from the history, or the latest run's (read once). */
  const resultOf = (s: FlowStep): { result?: TestResult; runId?: string } => {
    if (liveRun) return { result: liveResults.current.get(s.id), runId: liveRun };
    if (viewRun) return { result: viewed?.get(s.id), runId: viewRun.runId };
    return { runId };
  };
  const setBreakpoints = (ids: string[]) => {
    setState((s) => ({ ...s, breakpoints: ids }));
    call<DesignerState>('tests.flowBreakpoints', { file, ids }).then(setState, toastError);
    // a debugged run takes the change at once
    if (liveRun) void call('runs.setBreakpoints', { runId: liveRun, ids }).catch(() => undefined);
  };
  const toggleBreakpoint = (id: string) => setBreakpoints(state.breakpoints.includes(id) ? state.breakpoints.filter((x) => x !== id) : [...state.breakpoints, id]);
  const pin = async (s: FlowStep) => {
    await attempt(async () => {
      setState(await call<DesignerState>('tests.flowPin', { file, stepId: s.id }));
      useApp.getState().toast(`"${s.name}" is pinned: runs from the designer use its response instead of calling the API`, 'info', { ref: { kind: 'flow', path: file, step: s.id }, label: 'Show the step' });
    });
  };
  const unpin = async (s: FlowStep) => {
    await attempt(async () => {
      setState(await call<DesignerState>('tests.flowUnpin', { file, stepId: s.id }));
    });
  };
  const resume = async (action: 'continue' | 'step' | 'stop', vars: Record<string, unknown>) => {
    if (!pause) return;
    await attempt(async () => {
      await call('runs.resume', { runId: pause.runId, action, vars });
      setPause(undefined);
    });
  };
  return { liveRun, state, historyOpen, setHistoryOpen, runs, viewRun, setViewRun, showRun, pause, viewed, shownSteps, marks, begin, resultOf, toggleBreakpoint, pin, unpin, resume };
}
