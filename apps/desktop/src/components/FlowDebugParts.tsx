import { History, Pause, Play, RotateCcw, Square, StepForward } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TestResult } from '../types';
import { formatMs, timeAgo } from '../lib/format';
import { StatusIcon } from './Results';
import { Badge, Button, cx, Empty, Input, LinkButton, SectionTitle } from './ui';
import { valueText, VariablesTable } from './VariablesTable';

/** A run of a flow file, as tests.flowRuns lists it. */
export interface FlowRunRow {
  runId: string;
  name: string;
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'cancelled';
  environment?: string;
  steps: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  firstFailed?: string;
}

/** Where a debugged run waits (the run.paused event). */
export interface FlowPause {
  runId: string;
  stepId: string;
  vars: Record<string, unknown>;
  secrets: string[];
  /** The variables the run made (extracted, set, seeded): listed first. */
  runtime?: string[];
}

/**
 * The flow designer's History panel: the file's runs, newest first (status, when, how long, steps passed); selecting
 * one colours the canvas with its results. A failed run offers a replay on its own data.
 */
export function FlowHistoryList({
  runs,
  selected,
  onSelect,
  onReplay,
  onClose,
}: {
  runs: FlowRunRow[] | undefined;
  selected?: string;
  onSelect(runId: string | undefined): void;
  onReplay(run: FlowRunRow): void;
  onClose(): void;
}) {
  return (
    <div className="h-full flex flex-col min-h-0" data-flow-history>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0">
        <History size={14} className="text-muted" />
        <span className="font-medium text-sm flex-1">Run history</span>
        {selected && (
          <LinkButton onClick={() => onSelect(undefined)} title="Show the latest results on the canvas again">
            Back to latest
          </LinkButton>
        )}
        <LinkButton onClick={onClose}>Close</LinkButton>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {!runs ? (
          <p className="p-3 text-xs text-muted">Reading the runs…</p>
        ) : !runs.length ? (
          <Empty title="No runs yet">Run the flow: every run is kept here with each step's request, response and variables.</Empty>
        ) : (
          runs.map((r) => (
            <div
              key={r.runId}
              role="button"
              tabIndex={0}
              data-flow-history-run={r.runId}
              data-status={r.status}
              aria-pressed={selected === r.runId}
              className={cx('px-3 py-1.5 border-b border-line/50 cursor-pointer text-xs grid gap-0.5', selected === r.runId ? 'bg-accent-soft' : 'hover:bg-hover')}
              onClick={() => onSelect(selected === r.runId ? undefined : r.runId)}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(r.runId)}
              title={r.name}
            >
              <div className="flex items-center gap-2">
                <StatusIcon status={r.status === 'cancelled' ? 'skipped' : r.status} />
                <span className="font-medium">{r.status}</span>
                <span className="text-muted">{timeAgo(r.startedAt)}</span>
                <span className="flex-1" />
                <span className="text-muted tabular-nums">{formatMs(r.durationMs)}</span>
              </div>
              <div className="flex items-center gap-2 text-muted">
                <span className="tabular-nums">
                  {r.passed}/{r.steps} passed
                </span>
                {r.firstFailed && <span className="text-bad truncate">first failing: {r.firstFailed}</span>}
                {r.environment && <span className="truncate">{r.environment}</span>}
                <span className="flex-1" />
                {r.status === 'failed' && (
                  <LinkButton
                    icon={<RotateCcw size={11} />}
                    data-flow-replay={r.runId}
                    title="Run the flow as it is now from the first failing step, with the variables and responses this run had before it"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReplay(r);
                    }}
                  >
                    Replay with this run's data
                  </LinkButton>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** Each step's variables in a run, and which changed at the step (new, or another value than after the step before). */
export function variablesTimeline(results: TestResult[]): Array<{ vars: Record<string, unknown>; changed: Set<string> }> {
  let prev: Record<string, unknown> = {};
  return results.map((r) => {
    const vars = r.variables ?? (r.status === 'skipped' ? prev : {});
    const changed = new Set(Object.keys(vars).filter((k) => !(k in prev) || valueText(prev[k]) !== valueText(vars[k])));
    prev = vars;
    return { vars, changed };
  });
}

/**
 * The variables timeline of a run: a slider over its steps; at each, every variable's value after the step, the ones
 * the step changed highlighted. Moving it selects the step on the canvas.
 */
export function VariablesTimeline({ results, index, onIndex }: { results: TestResult[]; index: number; onIndex(i: number): void }) {
  const timeline = useMemo(() => variablesTimeline(results), [results]);
  if (!results.length) return null;
  const i = Math.min(Math.max(index, 0), results.length - 1);
  const at = timeline[i]!;
  const r = results[i]!;
  return (
    <div className="grid gap-2" data-variables-timeline data-step={r.id}>
      <SectionTitle right={<span className="text-xs text-muted tabular-nums">{`step ${i + 1} of ${results.length}`}</span>}>Variables timeline</SectionTitle>
      <input
        type="range"
        min={0}
        max={results.length - 1}
        step={1}
        value={i}
        onChange={(e) => onIndex(Number(e.target.value))}
        aria-label="Step of the run"
        className="w-full accent-[var(--accent)]"
      />
      <div className="flex items-center gap-2 text-xs">
        <StatusIcon status={r.status} />
        <span className="font-medium truncate">{r.name}</span>
        <span className="text-muted">after this step</span>
        {at.changed.size > 0 && <Badge tone="accent">{`${at.changed.size} changed`}</Badge>}
      </div>
      <div className="border border-line rounded-md overflow-hidden">
        <VariablesTable vars={at.vars} changed={at.changed} empty="No variables yet at this step." />
      </div>
    </div>
  );
}

/**
 * A debugged run paused before a step: its variables (editable: the new values hold for the rest of this run) and
 * Continue (to the next breakpoint), Step over (pause before the next step) and Stop.
 */
export function PausePanel({ pause, stepName, onResume }: { pause: FlowPause; stepName: string; onResume(action: 'continue' | 'step' | 'stop', vars: Record<string, unknown>): void }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const secrets = new Set(pause.secrets);
  const runtime = new Set(pause.runtime ?? []);
  const keys = Object.keys(pause.vars).sort((a, b) => Number(runtime.has(b)) - Number(runtime.has(a)) || a.localeCompare(b));
  const parsed = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, text] of Object.entries(edits)) {
      if (text === valueText(pause.vars[k])) continue;
      // a value that was not text (a number, a list …) is read back as JSON when it parses
      if (typeof pause.vars[k] !== 'string' && pause.vars[k] !== undefined) {
        try {
          out[k] = JSON.parse(text);
          continue;
        } catch {
          /* text */
        }
      }
      out[k] = text;
    }
    return out;
  };
  return (
    <div className="grid gap-3 p-3 border-b border-line bg-accent-soft/40" data-flow-paused-panel={pause.stepId}>
      <div className="flex items-center gap-2">
        <Pause size={14} className="text-accent" />
        <span className="text-sm">
          Paused before <b>{stepName}</b>
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="primary" icon={<Play size={12} />} onClick={() => onResume('continue', parsed())} data-flow-continue title="Run on to the next breakpoint (F8)">
          Continue
        </Button>
        <Button size="sm" icon={<StepForward size={12} />} onClick={() => onResume('step', parsed())} data-flow-step-over title="Run this step and pause before the next one (F10)">
          Step over
        </Button>
        <Button size="sm" variant="danger" icon={<Square size={12} />} onClick={() => onResume('stop', {})} data-flow-stop title="Stop the run here">
          Stop
        </Button>
      </div>
      <SectionTitle>Variables</SectionTitle>
      {keys.length ? (
        <div className="grid gap-1" data-flow-paused-vars>
          {keys.map((k) => (
            <label key={k} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-center gap-2 text-xs" data-var-row={k}>
              <span className={cx('mono truncate', runtime.has(k) ? 'text-fg' : 'text-muted')} title={runtime.has(k) ? 'Made by this run' : 'From the environment or globals'}>
                {k}
              </span>
              {secrets.has(k) ? (
                <span className="text-muted">secret (not shown)</span>
              ) : (
                <Input aria-label={`Value of ${k}`} className="mono text-xs" value={edits[k] ?? valueText(pause.vars[k])} onChange={(e) => setEdits({ ...edits, [k]: e.target.value })} />
              )}
            </label>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">No variables yet.</p>
      )}
      <p className="text-xs text-muted">A changed value holds for the rest of this run only; the environment and the file stay as they are.</p>
    </div>
  );
}
