/** Monitors: collections run on a schedule (list, add, remove, run now or when due, results, a long-running scheduler). */
import { Command } from 'commander';
import {
  MonitorScheduler,
  monitorStateChanged,
  notifyMonitorWebhook,
  deleteMonitor,
  executeMonitor,
  findMonitor,
  formatDuration,
  formatEvery,
  isDue,
  lastMonitorResult,
  listMonitors,
  monitorDaily,
  monitorRequestStats,
  monitorResults,
  monitorStatus,
  parseEvery,
  saveMonitor,
  shortId,
  type Monitor,
  type MonitorResult,
  type WorkspaceStore,
} from '@testpion/core';
import { EXIT, green, red, yellow, dim, bold, CliError, printJson, withWorkspace, cliContext, requireCollection } from '../shared.js';
import { resolveSelection } from '../run.js';

const collect = (v: string, prev: string[] = []) => [...prev, v];

const statusText = (r?: MonitorResult) =>
  !r ? dim('never ran') : r.status === 'passed' ? green(`passed ${r.passed}/${r.total}`) : r.status === 'failed' ? red(r.reason && !(r.failed + r.errors) ? (r.reason.startsWith('p95') ? `too slow: ${r.reason}` : r.reason) : `failed ${r.failed + r.errors}/${r.total}`) : red(`error: ${r.error}`);

function runner(store: WorkspaceStore) {
  return (m: Monitor, trigger: MonitorResult['trigger']) => executeMonitor({ store, monitor: m, trigger, context: (o) => cliContext(store, o.environment, { collectionId: o.collectionId }) });
}

/** A monitor's webhook URL with the {{variables}} of its environment resolved. */
function webhookUrl(store: WorkspaceStore, m: Monitor): string {
  const ctx = cliContext(store, m.environment);
  try {
    return ctx.vars.resolve(m.webhook ?? '');
  } finally {
    void ctx.dispose();
  }
}

export function registerMonitorCommands(program: Command): void {
  const mon = program.command('monitor').description('collections that run on a schedule (monitors): list, add, remove, run, results, start the scheduler');

  mon
    .command('list')
    .description('monitors with their schedule, last result and next run')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print as JSON')
    .action((o) =>
      withWorkspace(o.workspace, (store) => {
        const rows = listMonitors(store).map((m) => monitorStatus(store, m));
        if (o.json) return printJson(rows);
        if (!rows.length) return console.log(dim('No monitors. Add one with: testpion monitor add <name> --collection <name> --every 15m -w <workspace>'));
        for (const r of rows) console.log(`${bold(r.name)}  ${dim(r.enabled ? r.schedule : 'paused')}  ${statusText(r.lastResult)}${r.nextRunAt ? dim(`  next ${r.nextRunAt}`) : ''}`);
      }),
    );

  mon
    .command('add')
    .description('add a monitor (or replace one with the same name)')
    .argument('<name>')
    .requiredOption('-w, --workspace <nameOrPath>')
    .requiredOption('--collection <nameOrId>', 'collection to run')
    .requiredOption('--every <interval>', 'how often: minutes, or e.g. 15m, 1h, 1d (1 minute to 7 days)')
    .option('--folder <nameOrId>', 'run only this folder or request (repeatable)', collect)
    .option('-e, --environment <name>', 'environment to run with')
    .option('-n, --iteration-count <n>', 'iterations per run')
    .option('--bail', 'stop a run at the first failure')
    .option('--webhook <url>', 'POST an alert here when the monitor starts failing or recovers (Slack / Teams / Discord webhook or any URL; {{variables}} work)')
    .option('--max-p95 <ms>', 'fail a run whose p95 response time is over this many milliseconds (even when its checks pass)')
    .option('--min-cert-days <days>', 'fail a run when the TLS certificate of a host it calls expires within this many days')
    .option('--paused', 'save it paused')
    .option('--json', 'print the monitor as JSON')
    .action((name: string, o) =>
      withWorkspace(o.workspace, (store) => {
        const collection = requireCollection(store, String(o.collection), { loadable: true });
        const existing = listMonitors(store).find((m) => m.name.toLowerCase() === name.toLowerCase());
        const m = saveMonitor(store, {
          id: existing?.id ?? shortId('mon-'),
          name,
          collectionId: collection.id,
          selection: resolveSelection(collection, o.folder),
          environment: o.environment,
          everyMinutes: parseEvery(o.every),
          enabled: !o.paused,
          iterations: o.iterationCount ? Number(o.iterationCount) : undefined,
          bail: o.bail || undefined,
          webhook: o.webhook || existing?.webhook,
          maxP95Ms: o.maxP95 !== undefined ? Number(o.maxP95) : existing?.maxP95Ms,
          minCertDays: o.minCertDays !== undefined ? Number(o.minCertDays) : existing?.minCertDays,
        });
        console.log(o.json ? JSON.stringify(m, null, 2) : green(`${existing ? 'Updated' : 'Added'} monitor "${m.name}": ${collection.name}, ${m.enabled ? formatEvery(m.everyMinutes) : 'paused'}`));
      }),
    );

  mon
    .command('remove')
    .description('remove a monitor (its past results stay in runs/)')
    .argument('<nameOrId>')
    .requiredOption('-w, --workspace <nameOrPath>')
    .action((ref: string, o) =>
      withWorkspace(o.workspace, (store) => {
        const m = findMonitor(store, ref);
        deleteMonitor(store, m.id);
        console.log(green(`Removed monitor "${m.name}"`));
      }),
    );

  mon
    .command('run')
    .description('run monitors now: one by name, --all, or --due (the ones whose time has come; for cron). Exit code 1 if any failed')
    .argument('[nameOrId]')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--all', 'every enabled monitor')
    .option('--due', 'only enabled monitors that are due')
    .option('--json', 'print the results as JSON')
    .action(async (ref: string | undefined, o) => {
      return withWorkspace(o.workspace, async (store) => {
        const all = listMonitors(store);
        const chosen = ref ? [findMonitor(store, ref)] : o.all ? all.filter((m) => m.enabled) : o.due ? all.filter((m) => isDue(m, lastMonitorResult(store, m.id))) : undefined;
        if (!chosen) throw new CliError('Name a monitor, or pass --all or --due', EXIT.CONFIG_ERROR);
        const run = runner(store);
        const results: Array<MonitorResult & { name: string }> = [];
        for (const m of chosen) {
          if (!o.json) process.stdout.write(`${m.name} … `);
          const previous = lastMonitorResult(store, m.id);
          const r = await run(m, ref || o.all ? 'manual' : 'schedule');
          // cron (`--due`) and manual runs alert the webhook too, when the state changes
          if (m.webhook && monitorStateChanged(r, previous)) {
            const sent = await notifyMonitorWebhook(webhookUrl(store, m), m, r);
            if (!sent.ok && !o.json) console.error(yellow(`webhook for ${m.name} failed: ${sent.error ?? `HTTP ${sent.status}`}`));
          }
          results.push({ ...r, name: m.name });
          if (!o.json) console.log(`${statusText(r)} ${dim(`${formatDuration(r.durationMs)} · run ${r.runId}`)}`);
        }
        if (o.json) printJson(results);
        else if (!chosen.length) console.log(dim(o.due ? 'No monitors are due.' : 'No enabled monitors.'));
        process.exitCode = results.some((r) => r.status === 'error') ? EXIT.EXECUTION_ERROR : results.some((r) => r.status === 'failed') ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
      });
    });

  mon
    .command('results')
    .description("a monitor's recent results, newest first")
    .argument('<nameOrId>')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-n, --limit <n>', 'how many', '20')
    .option('--json', 'print as JSON')
    .action((ref: string, o) =>
      withWorkspace(o.workspace, (store) => {
        const m = findMonitor(store, ref);
        const rows = monitorResults(store, m.id, Math.min(Number(o.limit) || 20, 500));
        if (o.json) return printJson(rows);
        if (!rows.length) return console.log(dim('No results yet.'));
        const ok = rows.filter((r) => r.status === 'passed').length;
        console.log(`${bold(m.name)}  ${dim(`${ok}/${rows.length} passed`)}`);
        for (const r of rows) console.log(`  ${r.startedAt}  ${statusText(r)}  ${dim(`${formatDuration(r.durationMs)} · ${r.trigger} · ${r.runId}`)}`);
      }),
    );

  mon
    .command('requests')
    .description("each request of a monitor over its latest runs, slowest first: median / p95 time and failures")
    .argument('<nameOrId>')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-n, --runs <n>', 'how many of the latest runs', '20')
    .option('--json', 'print as JSON')
    .action(async (ref: string, o) => {
      // not withStore: the results are read asynchronously, so the store closes after them
      return withWorkspace(o.workspace, async (store) => {
        const m = findMonitor(store, ref);
        const rows = await monitorRequestStats(store, m.id, { runs: Number(o.runs) || 20 });
        if (o.json) return printJson(rows);
        if (!rows.length) return console.log(dim('No results yet.'));
        const w = Math.min(56, Math.max(...rows.map((r) => r.name.length)));
        for (const r of rows)
          console.log(`${r.name.slice(0, w).padEnd(w)}  ${dim(`median ${r.medianMs ?? '-'} ms · p95 ${r.p95Ms ?? '-'} ms · ${r.runs} runs`)}${r.failed ? red(`  ${r.failed} failed: ${r.lastFailure ?? ''}`) : ''}`);
      });
    });

  mon
    .command('uptime')
    .description("a monitor's uptime per day, oldest first (like a status page)")
    .argument('<nameOrId>')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('-d, --days <n>', 'how many days', '30')
    .option('--json', 'print as JSON')
    .action((ref: string, o) =>
      withWorkspace(o.workspace, (store) => {
        const m = findMonitor(store, ref);
        const days = monitorDaily(store, m.id, Number(o.days) || 30);
        const runs = days.reduce((n, d) => n + d.runs, 0);
        const passed = days.reduce((n, d) => n + d.passed, 0);
        const uptime = runs ? Math.round((passed / runs) * 1000) / 10 : undefined;
        if (o.json) return printJson({ monitor: m.name, uptime, runs, passed, days });
        console.log(`${bold(m.name)}  ${uptime === undefined ? dim('no runs in this period') : `${uptime === 100 ? green(`${uptime}%`) : uptime >= 90 ? yellow(`${uptime}%`) : red(`${uptime}%`)} ${dim(`of ${runs} runs over ${days.length} days`)}`}`);
        // one block per day: █ all passed, ▓ some failed, ░ mostly failed, · no runs
        console.log('  ' + days.map((d) => (!d.runs ? dim('·') : d.uptime === 100 ? green('█') : (d.uptime ?? 0) >= 90 ? yellow('▓') : red('░'))).join(''));
        for (const d of days.filter((x) => x.runs && x.uptime !== 100)) console.log(`  ${d.date}  ${red(`${d.uptime}%`)}  ${dim(`${d.passed}/${d.runs} passed`)}`);
      }),
    );

  mon
    .command('start')
    .description('run the scheduler until stopped (Ctrl+C): every monitor runs when it is due. For a server or a machine without the app open')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print each result as a JSON line')
    .action((o) =>
      withWorkspace(o.workspace, async (store) => {
        const run = runner(store);
        const scheduler = new MonitorScheduler({
          list: () => listMonitors(store),
          last: (id) => lastMonitorResult(store, id),
          run: (m) => run(m, 'schedule'),
          onResult: (m, r, prev) => {
            if (o.json) return printJson({ ...r, name: m.name });
            const changed = prev && prev.status !== r.status ? yellow(` (was ${prev.status})`) : '';
            console.log(`${dim(new Date().toISOString())}  ${m.name}  ${statusText(r)}${changed}`);
          },
          onError: (m, e) => console.error(red(`${m.name}: ${(e as Error).message}`)),
          resolve: (m) => webhookUrl(store, m),
          onWebhook: (m, r) => {
            if (!r.ok) console.error(yellow(`webhook for ${m.name} failed: ${r.error ?? `HTTP ${r.status}`}`));
          },
        });
        const count = listMonitors(store).filter((m) => m.enabled).length;
        if (!o.json) console.log(dim(`Scheduler started: ${count} enabled monitor${count === 1 ? '' : 's'} in ${store.root}. Press Ctrl+C to stop.`));
        scheduler.start();
        await new Promise<void>((resolve) => {
          const keep = setInterval(() => undefined, 60_000);
          process.once('SIGINT', () => {
            clearInterval(keep);
            scheduler.stop();
            resolve();
          });
        });
      }),
    );
}
