import { on } from '../api';
import { notifySystem, useApp } from '../store';
import { formatMs } from './format';

interface RunFinished {
  runId: string;
  name: string;
  total?: number;
  passed?: number;
  failed?: number;
  errors?: number;
  durationMs: number;
  cancelled?: boolean;
}

/**
 * A desktop notification when a run (tests, a collection, an evaluation) finishes while TestPion isn't in
 * front: long runs can be left to themselves. Clicking it brings the run up. Settings ▸ General turns it off.
 */
export function watchRunNotifications(): () => void {
  return on<RunFinished>('run.finished', (p) => {
    if (useApp.getState().settings?.notifyRunFinished === false) return;
    if (p.cancelled || !p.total || document.hasFocus()) return;
    const bad = (p.failed ?? 0) + (p.errors ?? 0);
    notifySystem(bad ? `${p.name}: ${bad} of ${p.total} failed` : `${p.name}: all ${p.total} passed`, `${p.passed ?? 0} passed${p.failed ? ` · ${p.failed} failed` : ''}${p.errors ? ` · ${p.errors} errors` : ''} · ${formatMs(p.durationMs)}`, {
      ref: { kind: 'run', runId: p.runId },
      tag: p.runId,
    });
  });
}
