import { useEffect, useSyncExternalStore } from 'react';
import { startAi } from '../components/ai/AiAction';
import type { ItemRef } from '@testpion/shared';
import { openRef } from './open-ref';
import { call, on } from '../api';
import { useApp } from '../store';
import { touchesFiles, type DataChangedEvent, type FileKind } from './data-changed';

/**
 * WF-03 Problems: one list of what is failing in the workspace — files that can't be read, monitors, the latest run
 * (failures and errors told apart), requests whose latest response failed, certificates, flaky tests — from the backend's
 * `stats.attention` (core workspaceAttention, cached by what it reads; `what_needs_attention` and `testpion problems`
 * answer the same). The bottom panel's Problems tab, the status bar's count, Home's "Needs attention" and F8 use it.
 *
 * One read for all of them: the list is module state with one subscription (the status bar is always mounted, so it is
 * always this workspace's), read again once a burst of events settled, and kept as the same array while the answer is
 * the same (a component renders only when the list changed).
 */
export interface Problem {
  kind: 'monitor' | 'certificate' | 'flaky' | 'request' | 'run' | 'file';
  severity: 'high' | 'medium' | 'low';
  group: string;
  type: 'failure' | 'error' | 'warning';
  at?: string;
  message: string;
  ref: ItemRef & { monitorId?: string; runId?: string };
}

const NONE: Problem[] = [];
/** The file kinds the list depends on (the rest of a `data.changed` — a run's results, a connection — changes nothing in it). */
const KINDS: FileKind[] = ['collections', 'environments', 'library', 'workspace'];
/** How long after the last event the list is read (a run or an import saves many files in a row). */
const SETTLE_MS = 500;

let current: Problem[] = NONE;
let signature = '';
const listeners = new Set<() => void>();
let users = 0;
let offs: Array<() => void> = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let again = false;

async function read(): Promise<void> {
  if (running) return void (again = true);
  running = true;
  try {
    do {
      again = false;
      if (!useApp.getState().workspace?.path) {
        if (current !== NONE) ((current = NONE), (signature = ''), listeners.forEach((l) => l()));
        continue;
      }
      const list = await call<Problem[]>('stats.attention').catch(() => NONE);
      const sig = JSON.stringify(list);
      if (sig === signature) continue;
      signature = sig;
      current = list;
      listeners.forEach((l) => l());
    } while (again);
  } finally {
    running = false;
  }
}

const soon = () => {
  clearTimeout(timer);
  timer = setTimeout(() => ((timer = undefined), void read()), SETTLE_MS);
};

/** Start keeping the list read (the first user starts the subscriptions); returns the stop (the last one ends them). Exported for the tests. */
export function startProblemsLive(): () => void {
  if (users++ === 0) {
    void read();
    offs = [
      on('run.finished', soon),
      on('monitor.result', soon),
      on<DataChangedEvent>('data.changed', (e) => touchesFiles(e, KINDS) && soon()),
      // another workspace opened: its own list (the status bar outlives a workspace switch)
      useApp.subscribe((s, prev) => {
        if (s.workspace?.path !== prev.workspace?.path) ((signature = ''), void read());
      }),
    ];
  }
  return () => {
    if (--users === 0) {
      offs.forEach((o) => o());
      offs = [];
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

export function useProblems(): Problem[] {
  useEffect(() => startProblemsLive(), []);
  const list = useSyncExternalStore(subscribe, () => current);
  // F8 steps through what is shown (the status bar's count is always mounted, so the list is always this workspace's)
  useEffect(() => noteProblems(list), [list]);
  return list;
}

/** The latest list read by any user of useProblems, for F8 (no extra call per key press). */
let last: Problem[] = [];
let at = -1;
export function noteProblems(list: Problem[]): void {
  if (list !== last) ((last = list), (at = -1));
}

/** F8 / Shift+F8: open the next (or previous) problem, wrapping around; the list is read when nothing has read it yet. */
export async function stepProblem(dir: 1 | -1): Promise<void> {
  if (!last.length) last = await call<Problem[]>('stats.attention').catch(() => []);
  if (!last.length) return useApp.getState().toast('No problems', 'success');
  at = (at + dir + last.length) % last.length;
  const p = last[at]!;
  useApp.getState().toast(`${at + 1}/${last.length} · ${p.message}`, p.severity === 'high' ? 'error' : 'warning');
  void openRef(p.ref);
}

/** Ask the assistant about one problem: its message, kind and what it names (never values). */
export function askAboutProblem(p: Problem): void {
  startAi({ task: 'triage-attention', title: 'What to do about this', context: { items: [{ severity: p.severity, kind: p.kind, type: p.type, message: p.message, ref: p.ref }] }, preflight: true });
}

/** Test hook: the list as a fresh start (the store is module state). */
export function resetProblemsForTest(): void {
  current = NONE;
  signature = '';
  clearTimeout(timer);
  timer = undefined;
  users = 0;
  offs.forEach((o) => o());
  offs = [];
  running = false;
  again = false;
}
