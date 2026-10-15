/** RPC handlers: monitors (collections run on a schedule while the app — or any other host — runs). */
import {
  ApsError,
  deleteMonitor,
  executeMonitor,
  findMonitor,
  listMonitors,
  monitorDaily,
  monitorRequestStats,
  monitorResults,
  monitorStatus,
  notifyMonitorWebhook,
  saveMonitor,
  shortId,
  type Monitor,
  type MonitorResult,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

/** Run a monitor with the app's secrets and current values; the result is sent to the renderer too. */
export async function runMonitorNow(be: Backend, m: Monitor, trigger: MonitorResult['trigger']): Promise<MonitorResult> {
  const store = be.ws;
  be.runningMonitors.add(m.id);
  be.host.emit('monitor.started', { id: m.id });
  try {
    const r = await executeMonitor({ store, monitor: m, trigger, context: (o) => be.context(o) });
    be.logger[r.status === 'passed' ? 'info' : 'warn'](`Monitor ${m.name}: ${r.status}${r.error ? ` (${r.error})` : ` ${r.passed}/${r.total}`}`, { runId: r.runId });
    return r;
  } finally {
    be.runningMonitors.delete(m.id);
  }
}

export function monitorHandlers(be: Backend): Handlers {
  // `recent`: results of the latest runs, oldest first, for the small strips in lists
  // `uptime7d`: share of the last 7 days' runs that passed (absent when nothing ran)
  const status = (m: Monitor) => {
    const days = monitorDaily(be.ws, m.id, 7);
    const runs = days.reduce((n, d) => n + d.runs, 0);
    const passed = days.reduce((n, d) => n + d.passed, 0);
    return { ...monitorStatus(be.ws, m), running: be.runningMonitors.has(m.id), recent: monitorResults(be.ws, m.id, 20).map((r) => r.status).reverse(), ...(runs ? { uptime7d: Math.round((passed / runs) * 1000) / 10 } : {}) };
  };
  return {
    'monitor.list': () => listMonitors(be.ws).map(status),
    /**
     * A monitor on a production environment runs on its schedule only with consent: the production guard asked before
     * this call (allowProduction), or it was given before for the same environment. Never taken from the monitor sent.
     */
    'monitor.save': ({ monitor, allowProduction }: { monitor: Omit<Monitor, 'id'> & { id?: string }; allowProduction?: boolean }) => {
      const id = monitor.id || shortId('mon-');
      const before = listMonitors(be.ws).find((m) => m.id === id);
      const production = !!monitor.environment && !!be.ws.getEnvironment(monitor.environment)?.isProduction;
      const consent = production && (allowProduction === true || (!!before?.allowProduction && before.environment === monitor.environment));
      return status(saveMonitor(be.ws, { ...monitor, id, allowProduction: consent || undefined }));
    },
    'monitor.delete': ({ id }: { id: string }) => deleteMonitor(be.ws, id),
    /** Post a sample "failed" alert to a webhook, to check it before relying on it. */
    'monitor.testWebhook': async ({ webhook, environment, name }: { webhook: string; environment?: string; name?: string }) => {
      const ctx = be.context({ environment });
      try {
        const url = ctx.vars.resolve(webhook);
        const sample: MonitorResult = { monitorId: 'test', runId: 'test', startedAt: new Date().toISOString(), durationMs: 0, status: 'failed', total: 1, passed: 0, failed: 1, errors: 0, trigger: 'manual' };
        const r = await notifyMonitorWebhook(url, { id: 'test', name: `${name || 'Monitor'} (test alert)` }, sample);
        if (!r.ok) throw new ApsError('NetworkError', r.error ? `Couldn't reach the webhook: ${r.error}` : `The webhook answered HTTP ${r.status}`, { suggestions: ['Check the URL (and the variable it uses, if any).'] });
        return { status: r.status };
      } finally {
        void ctx.dispose();
      }
    },
    'monitor.results': ({ id, limit }: { id: string; limit?: number }) => monitorResults(be.ws, id, Math.min(limit ?? 50, 500)),
    // each request of the monitor over its latest runs: median / p95 time and failures
    'monitor.requests': ({ id, runs }: { id: string; runs?: number }) => monitorRequestStats(be.ws, id, { runs }),
    // uptime per day, in the caller's time zone (its Date#getTimezoneOffset)
    'monitor.daily': ({ id, days, tzOffsetMin }: { id: string; days?: number; tzOffsetMin?: number }) => monitorDaily(be.ws, id, days ?? 30, tzOffsetMin),
    'monitor.run': async ({ id }: { id: string }) => {
      if (be.runningMonitors.has(id)) throw new ApsError('ValidationError', 'This monitor is already running', { suggestions: [] });
      const m = findMonitor(be.ws, id);
      const previous = monitorResults(be.ws, id, 1)[0];
      const r = await runMonitorNow(be, m, 'manual');
      be.host.emit('monitor.result', { monitor: m, result: r, previous });
      return r;
    },
  };
}
