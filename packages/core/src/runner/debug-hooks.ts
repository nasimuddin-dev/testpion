/**
 * The flow debugger's engine hooks: what runTests records and asks while a flow runs. The variables after each step
 * (bounded, secrets redacted) go into the results for the run history and the variables timeline; `pauseBefore` stops
 * a run before a step (breakpoints, step over) until the person continues, steps or stops; a seed starts a run from
 * a step with the variables and responses an earlier run had there; pins answer a step with a stored response.
 */
import type { VariableScope } from '../vars/variables.js';
import { REDACTED, type Redactor } from '../util/redact.js';
import type { StepResponse } from './flow-blocks.js';

/** The most a recorded variable value keeps (characters of its text, or of its JSON). */
export const VARIABLE_VALUE_LIMIT = 4096;
/** The most variables recorded after one step. */
export const MAX_RECORDED_VARIABLES = 200;
/** The most of a pinned response's body that is kept. */
export const PIN_BODY_LIMIT = 1024 * 1024;

export type PauseAction = 'continue' | 'step' | 'stop';
/** What the person chose at a pause: go on (`continue` to the next breakpoint, `step` to the next step) or stop the run; `vars` changes variables for the rest of this run. */
export interface PauseAnswer {
  action: PauseAction;
  vars?: Record<string, unknown>;
}
/** Called before each step that runs (not before skipped ones); answering nothing goes on. While it waits, nothing of the run times out. */
export type PauseBefore = (stepId: string, vars: Record<string, unknown>) => Promise<PauseAnswer | void> | PauseAnswer | void;

/** What a run that starts part-way through takes from an earlier run: the variables, the steps' responses (for if:), the conditions' outcomes and the steps their branch skipped. */
export interface RunSeed {
  vars?: Record<string, unknown>;
  responses?: Record<string, StepResponse>;
  conditions?: Record<string, boolean>;
  branchSkipped?: string[];
}

/** A step's response kept in the designer's state: runs from the designer answer the step with it instead of calling the API. */
export interface PinnedResponse extends StepResponse {
  pinnedAt: string;
  /** The run the response came from. */
  fromRunId?: string;
  /** The body was longer than PIN_BODY_LIMIT and was cut. */
  truncated?: boolean;
}

const isPlain = (v: unknown) => v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean';

/** A value as recorded: as it is when small, else its text (or JSON) cut at VARIABLE_VALUE_LIMIT. */
export function boundValue(v: unknown): unknown {
  if (isPlain(v)) return v;
  if (typeof v === 'string') return v.length > VARIABLE_VALUE_LIMIT ? `${v.slice(0, VARIABLE_VALUE_LIMIT)}… [${v.length - VARIABLE_VALUE_LIMIT} more chars]` : v;
  let s: string | undefined;
  try {
    s = JSON.stringify(v);
  } catch {
    s = undefined;
  }
  if (s === undefined) return String(v);
  return s.length > VARIABLE_VALUE_LIMIT ? `${s.slice(0, VARIABLE_VALUE_LIMIT)}… [${s.length - VARIABLE_VALUE_LIMIT} more chars]` : v;
}

/** A recorded value that is not the real one: redacted, or cut. A seed leaves such a variable to its environment. */
export function isPartialValue(v: unknown): boolean {
  return typeof v === 'string' && (v.includes(REDACTED) || v === '***' || /… \[\d+ more chars\]$/.test(v));
}

/**
 * The run's variables worth recording after a step: the runtime ones (extracted, set by scripts, seeded) and any
 * other whose value changed since the run started (a script's tp.environment.set …).
 */
export class VariableTracker {
  private start: Record<string, unknown>;
  constructor(private vars: VariableScope) {
    this.start = vars.toObject();
  }

  /** The values as they are (for a seed kept in memory); undefined when there are none. */
  raw(): Record<string, unknown> | undefined {
    const runtime = this.vars.scopeValues('runtime');
    const all = this.vars.toObject();
    let out: Record<string, unknown> | undefined;
    for (const [k, v] of Object.entries(all)) {
      if (!(k in runtime) && this.start[k] === v) continue;
      (out ??= {})[k] = v;
    }
    return out;
  }

  /** The values to store in a result: at most MAX_RECORDED_VARIABLES, each bounded, secrets redacted. */
  recorded(redactor: Redactor, raw = this.raw()): Record<string, unknown> | undefined {
    if (!raw) return undefined;
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (n++ >= MAX_RECORDED_VARIABLES) break;
      out[k] = this.vars.isSecret(k) || redactor.isSensitiveKey(k) ? REDACTED : redactor.redact(boundValue(v));
    }
    return out;
  }
}

/** Where a debugged run is paused. */
export interface DebugPause {
  stepId: string;
  vars: Record<string, unknown>;
}

/**
 * Breakpoints and step over for runTests' `pauseBefore`: the run pauses before a breakpoint step (and, after Step
 * over, before the next step) and waits for `resume`. Stopping the run (the signal) ends a pause as `stop`.
 */
export function createDebugger(o: { breakpoints?: Iterable<string>; onPause?(p: DebugPause): void; signal?: AbortSignal } = {}) {
  const breakpoints = new Set(o.breakpoints ?? []);
  let stepping = false;
  let pending: { finish(a: PauseAnswer): void; pause: DebugPause } | undefined;
  const pauseBefore: PauseBefore = (stepId, vars) => {
    if (!stepping && !breakpoints.has(stepId)) return;
    if (o.signal?.aborted) return { action: 'stop' };
    return new Promise<PauseAnswer>((resolve) => {
      const pause = { stepId, vars };
      const onAbort = () => finish({ action: 'stop' });
      const finish = (a: PauseAnswer) => {
        o.signal?.removeEventListener('abort', onAbort);
        pending = undefined;
        stepping = a.action === 'step';
        resolve(a);
      };
      pending = { finish, pause };
      o.signal?.addEventListener('abort', onAbort, { once: true });
      o.onPause?.(pause);
    });
  };
  return {
    pauseBefore,
    breakpoints,
    /** Where the run waits now, if it does. */
    get paused(): DebugPause | undefined {
      return pending?.pause;
    },
    /** Go on from the pause: false when the run is not paused. */
    resume(action: PauseAction, vars?: Record<string, unknown>): boolean {
      if (!pending) return false;
      pending.finish({ action, ...(vars && Object.keys(vars).length ? { vars } : {}) });
      return true;
    },
  };
}
export type FlowDebugger = ReturnType<typeof createDebugger>;
