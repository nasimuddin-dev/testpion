/**
 * RPC handlers: the flow designer's debugger. Runs of a flow file from the designer (all of it, one step with what it
 * waits for, from a step on or to a step, a replay of a failed run on its data, a debug run that pauses at
 * breakpoints), the run history of the file, the designer's state (breakpoints, pinned responses) and the pause
 * bridge: the engine's `pauseBefore` becomes a `run.paused` event, `runs.resume` answers it. Pins are used by these
 * runs only: tests.run, the CLI, CI, monitors and MCP never read them.
 */
import {
  ApsError,
  boundValue,
  createDebugger,
  flowRunPlan,
  flowRunResults,
  flowRuns,
  pinFlowStep,
  readFlowState,
  REDACTED,
  runTests,
  setFlowBreakpoints,
  storedStepResponse,
  streamTests,
  unpinFlowStep,
  PIN_BODY_LIMIT,
  type FlowDebugger,
  type PauseAction,
  type StepResponse,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

/** The recent runs whose unredacted variables and responses are kept in memory (Run from here and replay start from them). */
const KEEP_RUNS = 3;
/** The most of the latest responses (one per step of a file) kept for "Pin last response". */
const KEEP_RESPONSES = 200;
/** The most variables a pause shows. */
const PAUSE_VARS = 300;

interface FlowRunParams {
  file: string;
  environment?: string;
  concurrency?: number;
  retries?: number;
  /** Only these steps (Run step: a step with what it waits for). */
  ids?: string[];
  /** Run from this step on, the steps before it seeded from `seedRunId` (default: the file's latest run). */
  from?: string;
  /** Run this step with only the steps it waits for. */
  to?: string;
  /** The run to seed from; alone: replay it from its first failing step. */
  seedRunId?: string;
  /** Pause before the breakpoint steps (and step by step after Step over). */
  debug?: boolean;
  breakpoints?: string[];
  /** Answer pinned steps with their pinned response (default true). */
  usePins?: boolean;
}

type Kept = Map<string, { vars?: Record<string, unknown>; response?: StepResponse }>;

const capResponse = (r: StepResponse): StepResponse => {
  if ((r.text?.length ?? 0) <= PIN_BODY_LIMIT) return r;
  return { status: r.status, headers: r.headers, text: r.text!.slice(0, PIN_BODY_LIMIT) };
};

export function flowDebugHandlers(be: Backend): Handlers {
  const debuggers = new Map<string, FlowDebugger & { file: string }>();
  /** What each paused run's run.paused event said (a window that missed it asks runs.paused). */
  const pauses = new Map<string, Record<string, unknown>>();
  const memory = new Map<string, Kept>();
  const latest = new Map<string, StepResponse & { runId: string }>();
  const keyOf = (file: string, id: string) => `${file.replace(/\\/g, '/').toLowerCase()}|${id}`;

  return {
    /**
     * Run a flow file from the designer: every step, `ids`, `from` / `to` a step, or a replay (`seedRunId`), with its
     * pins; `debug` pauses before the `breakpoints` (a `run.paused` event; runs.resume goes on). Answers { runId, plan }.
     */
    'tests.flowRun': async (p: FlowRunParams) => {
      const plan = p.from || p.to || p.seedRunId ? await flowRunPlan(be.ws, p.file, { from: p.from, to: p.to, seedRunId: p.seedRunId, memory: (id) => memory.get(id) }) : undefined;
      const pins = p.usePins === false ? {} : readFlowState(be.ws, p.file).pins;
      const pinned = Object.keys(pins).length;
      const label = plan?.from
        ? p.from
          ? ` from ${plan.from}`
          : ` (replay of ${plan.seedRunId})`
        : p.to
          ? ` to ${p.to}`
          : p.ids?.length
            ? ` (${p.ids.length} step${p.ids.length === 1 ? '' : 's'})`
            : '';
      const name = `${p.debug ? 'Debug ' : ''}${p.file}${label}`;
      const tests = streamTests([p.file], be.ws.path('tests'), { ids: p.ids?.length ? p.ids : undefined });
      const r = be.startRun(name, tests, { environment: p.environment, concurrency: p.debug ? 1 : p.concurrency, retries: p.retries, traceMode: 'all' }, async (o) => {
        const runId = o.runId!;
        const kept: Kept = new Map();
        memory.set(runId, kept);
        while (memory.size > KEEP_RUNS) memory.delete(memory.keys().next().value!);
        let dbg: (FlowDebugger & { file: string }) | undefined;
        if (p.debug) {
          const vars = o.services.vars;
          const redactor = o.services.redactor;
          dbg = Object.assign(
            createDebugger({
              breakpoints: p.breakpoints ?? [],
              signal: o.signal,
              onPause: (pause) => {
                const shown: Record<string, unknown> = {};
                const secrets: string[] = [];
                for (const [k, v] of Object.entries(pause.vars).slice(0, PAUSE_VARS)) {
                  if (vars.isSecret(k) || redactor.isSensitiveKey(k)) {
                    shown[k] = REDACTED;
                    secrets.push(k);
                  } else shown[k] = redactor.redact(boundValue(v));
                }
                const runtime = Object.keys(vars.scopeValues('runtime'));
                const payload = { runId, file: p.file, stepId: pause.stepId, vars: shown, secrets, runtime };
                pauses.set(runId, payload);
                be.host.emit('run.paused', payload);
              },
            }),
            { file: p.file },
          );
          debuggers.set(runId, dbg);
        }
        try {
          return await runTests({
            ...o,
            ...(plan?.onlyIds ? { onlyIds: plan.onlyIds } : {}),
            ...(plan?.seed ? { seed: plan.seed } : {}),
            ...(pinned ? { pins } : {}),
            ...(dbg ? { pauseBefore: dbg.pauseBefore } : {}),
            onStepEnd: (id, info) => {
              const response = info.response ? capResponse(info.response) : undefined;
              kept.set(id, { vars: info.vars, response });
              if (response && !pins[id]) {
                const k = keyOf(p.file, id);
                latest.delete(k);
                latest.set(k, { ...response, runId });
                while (latest.size > KEEP_RESPONSES) latest.delete(latest.keys().next().value!);
              }
            },
          });
        } finally {
          debuggers.delete(runId);
          pauses.delete(runId);
        }
      });
      return { runId: r.runId, ...(plan ? { plan: plan.note, from: plan.from, seedRunId: plan.seedRunId } : {}), pinned };
    },
    /** Where a debugged run waits, if it does: { stepId, vars } (null when it runs or has finished). */
    'runs.paused': ({ runId }: { runId: string }) => (debuggers.get(runId)?.paused ? (pauses.get(runId) ?? null) : null),
    /** Go on from a pause: `continue` to the next breakpoint, `step` to the next step, `stop` ends the run; `vars` changes variables for the rest of the run. */
    'runs.resume': ({ runId, action, vars }: { runId: string; action: PauseAction; vars?: Record<string, unknown> }) => {
      if (!['continue', 'step', 'stop'].includes(action)) throw new ApsError('ValidationError', `runs.resume: action is continue, step or stop, not "${String(action)}"`);
      const d = debuggers.get(runId);
      if (!d) throw new ApsError('ValidationError', `Run ${runId} is not being debugged (it may have finished)`);
      const edits = vars ? Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== REDACTED)) : undefined;
      if (!d.resume(action, edits)) throw new ApsError('ValidationError', `Run ${runId} is not paused`);
      be.host.emit('run.resumed', { runId, action });
      return { runId, action };
    },
    /** Change a debugged run's breakpoints while it runs (the designer toggles one). */
    'runs.setBreakpoints': ({ runId, ids }: { runId: string; ids: string[] }) => {
      const d = debuggers.get(runId);
      if (!d) return null;
      d.breakpoints.clear();
      for (const id of ids) d.breakpoints.add(id);
      return { runId, breakpoints: [...d.breakpoints] };
    },
    /** The flow file's runs, newest first (the designer's History panel). */
    'tests.flowRuns': ({ file, limit }: { file: string; limit?: number }) => flowRuns(be.ws, file, { limit }),
    /** One run of the flow file in full: each step's result with the variables after it, in file order. */
    'tests.flowRunResults': ({ file, runId }: { file: string; runId: string }) => flowRunResults(be.ws, file, runId),
    /** The designer's state of a flow file: breakpoints and pinned responses (per computer, never in the YAML). */
    'tests.flowState': ({ file }: { file: string }) => readFlowState(be.ws, file),
    'tests.flowBreakpoints': ({ file, ids }: { file: string; ids: string[] }) => setFlowBreakpoints(be.ws, file, ids ?? []),
    /** Pin a step's last response (from a run of the designer, else as the latest run stored it): runs from the designer use it instead of calling the API. */
    'tests.flowPin': async ({ file, stepId, runId }: { file: string; stepId: string; runId?: string }) => {
      const inMemory = latest.get(keyOf(file, stepId));
      const response = inMemory && (!runId || inMemory.runId === runId) ? { ...inMemory, fromRunId: inMemory.runId } : await storedStepResponse(be.ws, file, stepId, runId);
      if (!response) throw new ApsError('ValidationError', `No response of ${stepId} to pin: run the step first`);
      const { runId: _r, ...rest } = response as typeof response & { runId?: string };
      return pinFlowStep(be.ws, file, stepId, rest);
    },
    'tests.flowUnpin': ({ file, stepId }: { file: string; stepId: string }) => unpinFlowStep(be.ws, file, stepId),
  };
}
