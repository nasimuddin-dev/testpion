import { call, on } from '../api';
import type { ItemRef } from '@testpion/shared';
import { notifySystem, useApp } from '../store';

/** Mirrors core's Monitor / MonitorResult (runner/monitors.ts). */
export interface MonitorResult {
  monitorId: string;
  runId: string;
  startedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'error';
  total: number;
  passed: number;
  failed: number;
  errors: number;
  p50Ms?: number;
  p95Ms?: number;
  certDaysLeft?: number;
  /** Why a run whose checks passed still failed (too slow). */
  reason?: string;
  error?: string;
  trigger: 'schedule' | 'manual';
}

/**
 * Toasts when a monitor starts failing or recovers (and a system notification when the window is in the
 * background). Watched for the whole app, so it works whichever view is open; returns the unsubscribe.
 */
/**
 * Once a day, when the app starts: a toast (and a system notification if allowed) for each recorded TLS certificate
 * that expires within 7 days, so it is renewed in time.
 */
export function remindExpiringCertificates(): void {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (localStorage.getItem('tp:certReminder') === today) return;
  } catch {
    /* no storage: remind every start */
  }
  void call<Array<{ host: string; daysLeft?: number }>>('certificates.list').then(
    (list) => {
      const soon = list.filter((c) => c.daysLeft !== undefined && c.daysLeft < 7);
      if (!soon.length) return;
      const text = soon.length === 1 ? `The certificate of ${soon[0]!.host} ${soon[0]!.daysLeft! < 0 ? 'has expired' : `expires in ${soon[0]!.daysLeft} days`}` : `${soon.length} certificates expire within 7 days: ${soon.map((c) => c.host).join(', ')}`;
      // the soonest first: the action opens it in Settings ▸ Certificates (the list shows the others too)
      const first = [...soon].sort((a, b) => a.daysLeft! - b.daysLeft!)[0]!;
      const ref: ItemRef = { kind: 'certificate', host: first.host };
      useApp.getState().toast(text, 'error', { ref, label: soon.length === 1 ? 'Open certificate' : 'Open certificates' });
      notifySystem('TestPion certificates', text, { ref });
      try {
        localStorage.setItem('tp:certReminder', today);
      } catch {
        /* no storage */
      }
    },
    () => undefined,
  );
}

export function watchMonitorAlerts(): () => void {
  return on<{ monitor: { id?: string; name: string }; result: MonitorResult & { runId?: string }; previous?: MonitorResult }>('monitor.result', ({ monitor, result, previous }) => {
    const bad = result.status !== 'passed';
    const wasBad = previous ? previous.status !== 'passed' : false;
    if (bad === wasBad) return;
    const text = bad
      ? `Monitor "${monitor.name}" ${result.status === 'error' ? `could not run: ${result.error}` : result.reason && !(result.failed + result.errors) ? (result.reason.startsWith('p95') ? `is too slow: ${result.reason}` : `needs attention: ${result.reason}`) : `failed: ${result.failed + result.errors} of ${result.total} requests`}`
      : `Monitor "${monitor.name}" passes again`;
    // a failed run opens at its results; otherwise (it could not run, it recovered) the monitor
    const ref: ItemRef | undefined = bad && result.runId && result.total ? { kind: 'run', runId: result.runId } : monitor.id ? { kind: 'monitor', monitorId: monitor.id } : undefined;
    useApp.getState().toast(text, bad ? 'error' : 'success', ref && { ref });
    if (bad && document.hidden) notifySystem('TestPion monitor', text, { ref, tag: monitor.id });
  });
}
