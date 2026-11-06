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
  monitorTenants,
  monitorConsent,
  listMonitorDefinitions,
  monitorStatus,
  notifyMonitorWebhook,
  saveMonitor,
  shortId,
  type Monitor,
  type MonitorResult, pauseMonitor, resumeMonitor } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { approveMonitor, monitorApproved } from '../monitor-trust.js';

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

/** The latest results of a monitor, newest first: the scheduler's `recent` (a monitor that alerts after n failures in a row). */
export { monitorOwners } from '@testpion/core';
export const recentMonitorResults = (be: Backend, id: string, n: number) => monitorResults(be.ws, id, n);

function keepingApproval(be: Backend, id: string, change: () => Monitor): Monitor {
  const was = monitorApproved(be, findMonitor(be.ws, id));
  const m = change();
  if (was) approveMonitor(be, m);
  return m;
}

export function monitorHandlers(be: Backend): Handlers {
  // `recent`: results of the latest runs, oldest first, for the small strips in lists
  // `uptime7d`: share of the last 7 days' runs that passed (absent when nothing ran)
  const status = (m: Monitor) => {
    const days = monitorDaily(be.ws, m.id, 7);
    const runs = days.reduce((n, d) => n + d.runs, 0);
    const passed = days.reduce((n, d) => n + d.passed, 0);
    // `needsApproval`: it came with a pull or a clone (or changed outside this app) and waits for this person's yes before its schedule runs here
    return { ...monitorStatus(be.ws, m), ...(m.enabled && !monitorApproved(be, m) ? { needsApproval: true } : {}), running: be.runningMonitors.has(m.id), recent: monitorResults(be.ws, m.id, 20).map((r) => r.status).reverse(), ...(runs ? { uptime7d: Math.round((passed / runs) * 1000) / 10 } : {}) };
  };
  return {
    'monitor.list': () => listMonitors(be.ws).map(status),
    /**
     * A monitor on a production environment runs on its schedule only with consent: the production guard asked before
     * this call (allowProduction), or it was given before for the same environment. Never taken from the monitor sent.
     */
    'monitor.save': ({ monitor, allowProduction }: { monitor: Omit<Monitor, 'id'> & { id?: string }; allowProduction?: boolean }) => {
      const id = monitor.id || shortId('mon-');
      // (a tenant row of a grouped definition saves the definition: its consent is per production environment of the group)
      const of = (monitor as Monitor).tenant?.of ?? id.split('@')[0]!;
      const before = listMonitorDefinitions(be.ws).find((m) => m.id === of);
      // what a row shows and no monitor has (its last result, its schedule in words …) is not saved with it
      for (const k of ['lastResult', 'running', 'schedule', 'nextRunAt', 'due', 'recent', 'uptime7d', 'needsApproval', 'paused']) delete (monitor as Record<string, unknown>)[k];
      const saved = saveMonitor(be.ws, { ...monitor, id, ...monitorConsent(be.ws, monitor, before, allowProduction === true) });
      approveMonitor(be, saved); // saved here, by this person: its schedule runs on this computer
      return status(findMonitor(be.ws, id.includes('@') ? id : saved.id));
    },
    /** "Allow on this computer": a monitor that came with a pull or a clone runs on its schedule from now on. */
    'monitor.approve': ({ id }: { id: string }) => {
      const m = findMonitor(be.ws, id);
      approveMonitor(be, m);
      return status(m);
    },
    'monitor.delete': ({ id }: { id: string }) => deleteMonitor(be.ws, id),
    // a pause for a while (a deploy): the schedule goes on by itself when the time comes
    // (a pause or a resume changes what was approved here: an approved monitor stays approved, one that waits still waits)
    'monitor.pause': ({ id, minutes, until, reason }: { id: string; minutes?: number; until?: string; reason?: string }) => status(keepingApproval(be, id, () => pauseMonitor(be.ws, id, { minutes, until, reason }))),
    'monitor.resume': ({ id }: { id: string }) => status(keepingApproval(be, id, () => resumeMonitor(be.ws, id))),
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
      // a grouped definition by its own id: every tenant of it runs (a tenant's id runs that one)
      let r: MonitorResult | undefined;
      for (const m of monitorTenants(be.ws, findMonitor(be.ws, id))) {
        const previous = monitorResults(be.ws, m.id, 1)[0];
        r = await runMonitorNow(be, m, 'manual');
        be.host.emit('monitor.result', { monitor: m, result: r, previous });
      }
      if (!r) throw new ApsError('ValidationError', 'No environment is in this monitor\'s group', { suggestions: [] });
      return r;
    },
  };
}
