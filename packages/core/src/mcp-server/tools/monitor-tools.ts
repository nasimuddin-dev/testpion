import { createEngineContext } from '../../engine.js';
import type { TestResult } from '../../model/types.js';
import { monitorRequestStats } from '../../runner/monitor-requests.js';
import { executeMonitor, findMonitor, listMonitors, monitorDaily, monitorResults, monitorStatus } from '../../runner/monitors.js';
import type { RunEvent } from '../../runner/runner.js';
import { str, limitArg } from '../tool.js';
import type { Tool } from '../tool.js';
import type { ModuleToolDeps } from './deps.js';

/** Monitors: list, results, slow requests, uptime, run now. */
export function monitorTools(d: ModuleToolDeps): Tool[] {
  const { store, secrets, settings, checkEnvironment, summarizeResult } = d;
  return [
    {
      name: 'list_monitors',
      description: 'Monitors (collections, or test files / flows under tests/, that run on a schedule; save_monitor adds one): collection and folders or testFile, environment, schedule, enabled, last result (passed / failed / error with counts), next run.',
      inputSchema: { type: 'object', properties: {} },
      run: () => listMonitors(store).map((m) => monitorStatus(store, m)),
    },
    {
      name: 'monitor_results',
      description: "A monitor's recent results, newest first: status, passed / failed / errors, duration, median response time, what started it and the run id. Use it to see when a check started failing.",
      inputSchema: { type: 'object', properties: { monitor: str('Monitor name or id'), limit: { type: 'number', description: 'How many (default 20, max 200)' } }, required: ['monitor'] },
      run: (a) => monitorResults(store, findMonitor(store, String(a.monitor)).id, limitArg(a.limit, 20, 200)),
    },
    {
      name: 'monitor_requests',
      description: "Each request of a monitor over its latest runs, slowest first: runs, failures, median and p95 time and the latest failure. Use it to find which request makes a monitor slow or fail.",
      inputSchema: { type: 'object', properties: { monitor: str('Monitor name or id'), runs: { type: 'number', description: 'How many of the latest runs (default 20, max 200)' } }, required: ['monitor'] },
      run: (a) => monitorRequestStats(store, findMonitor(store, String(a.monitor)).id, { runs: Number(a.runs) || 20 }),
    },
    {
      name: 'monitor_uptime',
      description: "A monitor's uptime per day over the last N days (oldest first): runs, passed, uptime percent and the slowest p95 response time of each day. Days without runs have runs: 0. Use it for an SLA view or to find when an API became unreliable.",
      inputSchema: { type: 'object', properties: { monitor: str('Monitor name or id'), days: { type: 'number', description: 'How many days (default 30, max 366)' } }, required: ['monitor'] },
      run: (a) => {
        const days = monitorDaily(store, findMonitor(store, String(a.monitor)).id, Number(a.days) || 30);
        const runs = days.reduce((n, d) => n + d.runs, 0);
        const passed = days.reduce((n, d) => n + d.passed, 0);
        return { uptime: runs ? Math.round((passed / runs) * 1000) / 10 : undefined, runs, passed, days };
      },
    },
    {
      name: 'run_monitor',
      write: true,
      description: 'Run a monitor now (outside its schedule) and record the result like a scheduled run. Returns the result with per-request details of failures.',
      inputSchema: { type: 'object', properties: { monitor: str('Monitor name or id') }, required: ['monitor'] },
      run: async (a) => {
        const m = findMonitor(store, String(a.monitor));
        checkEnvironment(m.environment);
        const failures: TestResult[] = [];
        const r = await executeMonitor({
          store,
          monitor: m,
          trigger: 'manual',
          context: (o) => createEngineContext({ store, secrets, settings, environment: o.environment, collectionId: o.collectionId }),
          onEvent: (e: RunEvent) => e.type === 'test-end' && e.result.status !== 'passed' && e.result.status !== 'skipped' && failures.push(e.result),
        });
        return { ...r, name: m.name, environment: m.environment ?? null, failures: failures.slice(0, 50).map(summarizeResult) };
      },
    },
  ];
}
