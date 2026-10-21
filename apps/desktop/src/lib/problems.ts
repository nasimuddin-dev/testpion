import { useEffect } from 'react';
import { startAi } from '../components/ai/AiAction';
import type { ItemRef } from '@testpion/shared';
import { useRpc } from './use-rpc';
import { openRef } from './open-ref';
import { call } from '../api';
import { useApp } from '../store';

/**
 * WF-03 Problems: one list of what is failing in the workspace — files that can't be read, monitors, the latest run
 * (failures and errors told apart), requests whose latest response failed, certificates, flaky tests — from the backend's
 * `stats.attention` (core workspaceAttention, cached per data change; `what_needs_attention` and `testpion problems`
 * answer the same). The bottom panel's Problems tab, the status bar's count, Home's "Needs attention" and F8 use it.
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

/** The events after which the list is read again (a run finished, a monitor ran, files changed). */
const RELOAD = ['run.finished', 'monitor.result', 'data.changed'];
const NONE: Problem[] = [];

export function useProblems(): Problem[] {
  // the open workspace's list: read again when another one opens (the status bar outlives a workspace switch)
  const scope = useApp((s) => s.workspace?.path);
  const list = useRpc<Problem[]>('stats.attention', undefined, { fallback: [], reloadOn: RELOAD, enabled: !!scope, scope });
  // F8 steps through what is shown (the status bar's count is always mounted, so the list is always this workspace's)
  useEffect(() => noteProblems(list ?? NONE), [list]);
  return list ?? NONE;
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
