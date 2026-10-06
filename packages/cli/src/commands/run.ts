/** Commands that run things: test files, suites, collections and load tests; re-generating reports. */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { Command, Option } from 'commander';
import {
  isSuiteFile,
  lintTestFile,
  ChainSecretStore,
  EnvSecretStore,
  WorkspaceManager,
  collectionLoadTarget,
  parseGrpcTarget,
  reflectServer,
  evaluateThresholds,
  parseThreshold,
  createEngineContext,
  runLoadTest,
  recordLoadRun,
  loadRunRecord,
  Redactor,
  writeReports,
  type LoadTarget,
} from '@testpion/core';
import { EXIT, bold, dim, green, red, yellow, CliError, collectVar, openWorkspace, readResults, printLoad } from '../shared.js';
import { runWatching, watchTargets } from '../watch.js';
import { type RunCliOptions, executeRun, type CollectionCliOptions, executeCollectionRun, executeSend, resolveSelection, runOptions } from '../run.js';

export function registerRunCommands(program: Command): void {

  runOptions(program.command('test').description('run tests from files, directories, globs or a *.suite.yaml').argument('[paths...]', 'test files/dirs/globs')).action(async (paths: string[], o: RunCliOptions & { watch?: boolean }) => {
    process.exitCode = o.watch ? await runWatching(watchTargets(o.workspace, paths), () => executeRun(paths, o)) : await executeRun(paths, o);
  });
  program
    .command('lint-tests')
    .description('check test files before running them: unknown test or check types, keys the runner does not read (typos), dependsOn ids nobody defines; exit 1 when there are errors')
    .argument('[paths...]', 'test files or folders under tests/ (default: all)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
    .option('--json', 'print the problems as JSON (for scripts and AI agents)')
    .action((paths: string[], o) => {
      const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        const tests = store.path('tests');
        const files: string[] = [];
        const walk = (p: string) => {
          const abs = store.safePath(p, tests);
          if (!existsSync(abs)) throw new CliError(`No such test file or folder: ${p}`, EXIT.CONFIG_ERROR);
          if (statSync(abs).isDirectory()) for (const e of readdirSync(abs).sort()) walk(join(p, e));
          else if (/\.(ya?ml|json)$/.test(abs)) files.push(abs);
        };
        for (const p of paths.length ? paths : ['.']) walk(p);
        const results = files.map((f) => ({ file: relative(tests, f).split(sep).join('/'), problems: lintTestFile(readFileSync(f, 'utf8'), { file: f, suite: isSuiteFile(f) }) })).filter((x) => x.problems.length);
        const errors = results.reduce((n, x) => n + x.problems.filter((p) => p.severity === 'error').length, 0);
        const total = results.reduce((n, x) => n + x.problems.length, 0);
        if (o.json) console.log(JSON.stringify({ files: files.length, problems: total, errors, results }, null, 2));
        else {
          for (const r of results) for (const p of r.problems) console.log(`${p.severity === 'error' ? red('error') : p.severity === 'warning' ? yellow('warning') : dim('info')}  ${r.file}:${p.line}:${p.column}  ${p.message}`);
          console.log(total ? `${total} problem${total === 1 ? '' : 's'} in ${results.length} of ${files.length} files (${errors} error${errors === 1 ? '' : 's'})` : green(`${files.length} test files, nothing to fix.`));
        }
        if (errors) process.exitCode = EXIT.TEST_FAILURE;
      } finally {
        store.close();
      }
    });
  runOptions(program.command('run').description('run a named suite from a workspace').requiredOption('-s, --suite <name>', 'suite name (tests/<name>.suite.yaml)')).action(async (o: RunCliOptions & { watch?: boolean }) => {
    process.exitCode = o.watch ? await runWatching(watchTargets(o.workspace), () => executeRun([], o)) : await executeRun([], o);
  });
  program
    .command('run-collection')
    .description(
      'run a collection like Postman\'s Collection Runner / Newman: requests in order, pm.* scripts, iterations and data files\n' +
        '<collection> is a collection name or id in the workspace, or a TestPion / Postman v2.1 collection or OpenAPI file or link',
    )
    .argument('<collection>', 'collection name or id, a file, or an http(s) link')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-e, --environment <nameOrFile>', 'environment name, or a Postman environment file')
    .option('-d, --iteration-data <file>', 'CSV, JSON or JSONL data file, a SQLite database, or a PostgreSQL / MySQL database (postgres://…, mysql://…, or env:NAME for a variable holding the URL) with --iteration-query: one row per iteration (pm.iterationData, {{column}})')
    .option('--iteration-query <sql>', 'with a database as --iteration-data: the SELECT whose rows are the iterations (read-only)')
    .option('-n, --iteration-count <n>', 'number of iterations (default: data rows, or 1)')
    .option('--delay-request <ms>', 'pause between requests')
    .option('--folder <nameOrId...>', 'only run these folders or requests (repeatable)')
    .option('--bail', 'stop after the first failure')
    .option('--timeout <ms>', 'per-request timeout in ms')
    .option('--cookie-jar <file>', 'start with the cookies in this JSON file (TestPion or Newman cookie jar)')
    .option('--export-cookie-jar <file>', 'write the cookie jar to this JSON file after the run')
    .option('-g, --globals <file>', 'Postman globals file')
    .option('--env-var <key=value>', 'set an environment variable (repeatable)', collectVar)
    .option('--global-var <key=value>', 'set a global variable (repeatable)', collectVar)
    .option('--export-environment <file>', 'write the environment after the run, with values scripts set (secret values left empty)')
    .option('--export-globals <file>', 'write the globals after the run')
    .option('-k, --insecure', 'do not verify TLS certificates (development servers only)')
    .option('--suppress-exit-code', 'exit 0 even when tests fail')
    .addOption(new Option('--timeout-request <ms>', 'same as --timeout (Newman)').hideHelp())
    .addOption(new Option('--reporters <formats...>', 'same as --reporter (Newman)').hideHelp())
    .option('--reporter-junit-export <file>', 'also write the JUnit report to this file')
    .addOption(new Option('-r, --reporter <formats...>', 'reporters: console, junit, json, html, markdown').default(['console', 'junit', 'json', 'html', 'markdown']))
    .option('-o, --out <dir>', 'output directory for results and reports')
    .option('--var <key=value>', 'runtime variable (repeatable)', collectVar)
    .option('--baseline <name>', 'compare results against a saved baseline')
    .option('--save-baseline <name>', 'save this run as a baseline')
    .option('--fail-on-regression', 'exit 1 when the baseline comparison finds regressions')
    .addOption(new Option('--trace <mode>', 'persist traces').choices(['all', 'failures', 'none']).default('failures'))
    .option('-v, --verbose', 'show passing checks')
    .option('-q, --quiet', 'only print the summary exit code')
    .option('--log-level <level>', 'ERROR | WARN | INFO | DEBUG | TRACE (secrets are always redacted)')
    .option('--watch', 'run again whenever the collection, an environment or the data file changes (until Ctrl+C)')
    .option('--rerun-failed [runId]', 'only the requests that failed in a run of this collection (default: the last run)')
    .option('--otlp <url>', 'send the traces to an OpenTelemetry collector (OTLP/HTTP); default: OTEL_EXPORTER_OTLP_ENDPOINT')
    .option('--otlp-header <key:value...>', 'headers for the collector (also OTEL_EXPORTER_OTLP_HEADERS)')
    .action(async (ref: string, o: CollectionCliOptions & { watch?: boolean }) => {
      const dataFile = o.iterationData && !/^https?:/i.test(o.iterationData) ? [o.iterationData] : [];
      process.exitCode = o.watch ? await runWatching(watchTargets(o.workspace, [ref, ...dataFile]), () => executeCollectionRun(ref, o)) : await executeCollectionRun(ref, o);
    });
  program
    .command('load')
    .description('run a load test against a URL or a collection (safeguarded: local hosts only unless --allow-remote)')
    .argument('[url]', 'target URL (or use --collection); with --grpc, the gRPC server address (host:port, grpcs://host:port for TLS)')
    .option('--collection <nameOrId>', 'load-test a collection: every virtual user sends its requests in order, again and again')
    .option('-w, --workspace <nameOrPath>', 'workspace (for --collection, --saved and {{variables}})')
    .option('-e, --environment <name>', 'environment (for --collection, --saved and {{variables}})')
    .option('--folder <nameOrId...>', 'with --collection: only these folders or requests')
    .option('--warm-up', 'with --collection: run it once first with scripts (e.g. to log in), then use the variables they set')
    .option('--grpc <method>', 'load-test a gRPC method (package.Service/Method) on the server given as [url]; -d is the request message as JSON, -H metadata')
    .option('--proto <files...>', 'with --grpc: .proto files (default: ask the server through reflection)')
    .option('-X, --method <method>', 'HTTP method', 'GET')
    .option('-H, --header <header...>', 'headers "Name: value"')
    .option('-d, --data <body>', 'request body')
    .option('-u, --vus <n>', 'virtual users', '10')
    .option('--duration <sec>', 'duration in seconds', '10')
    .option('--rps <n>', 'max requests per second')
    .option('--ramp-up <sec>', 'ramp-up seconds', '0')
    .option('--ramp-down <sec>', 'ramp-down seconds', '0')
    .option('--allow-remote', 'allow non-local hosts (only systems you are authorised to test)')
    .option('--json <file>', 'write final metrics as JSON')
    .option('-t, --threshold <rule...>', 'pass/fail rules for CI, e.g. "p95<500" "errors<1%" "rps>=50" "p99[Get pet]<800"; exit 1 when one fails')
    .option('--saved <name>', 'a load test saved in the app (Load ▸ Save): its target, users, duration, ramps, rate and pass/fail rules; options given here win')
    .action(async (urlArg: string | undefined, o, cmd: Command) => {
      let url = urlArg;
      if (o.saved) url = applySavedLoadTest(o, cmd, url);
      if (!url && !o.collection) throw new CliError('Give a URL, --collection or --saved <name>', EXIT.CONFIG_ERROR);
      // thresholds are checked before the test runs, so a typo doesn't waste a run
      const rules = ((o.threshold as string[] | undefined) ?? []).map((r) => {
        try {
          return parseThreshold(r);
        } catch (e) {
          throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
        }
      });
      const headers = ((o.header as string[]) ?? []).map((h) => {
        const i = h.indexOf(':');
        return { key: h.slice(0, i).trim(), value: h.slice(i + 1).trim() };
      });
      const mgr = new WorkspaceManager();
      const settings = mgr.loadSettings();
      let target: LoadTarget = { kind: 'http', request: { method: o.method, url: url ?? '', headers, body: o.data ? { type: /^\s*[{[]/.test(o.data) ? 'json' : 'text', content: o.data } : undefined } };
      let isProduction = false;
      if (o.grpc) {
        if (!url) throw new CliError('Give the gRPC server address, e.g. testpion load localhost:50051 --grpc pkg.Service/Method', EXIT.CONFIG_ERROR);
        const protoFiles = ((o.proto as string[] | undefined) ?? []).map((f) => ({ name: f.replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));
        let descriptorSet: string | undefined;
        if (!protoFiles.length) {
          const t = parseGrpcTarget(url);
          descriptorSet = (await reflectServer(t, { metadata: headers })).descriptorSet;
        }
        target = { kind: 'grpc', request: { target: url, method: o.grpc, message: o.data ?? '{}', metadata: headers, protoFiles, descriptorSet } };
      } else if (o.collection) {
        const { store } = openWorkspace(o.workspace, undefined, mgr);
        const ctx = createEngineContext({ store, secrets: new ChainSecretStore([new EnvSecretStore()]), settings, environment: o.environment });
        try {
          const cols = store.listCollections().filter((c) => !c.problem);
          const col = cols.find((c) => c.id === o.collection) ?? cols.find((c) => c.name.toLowerCase() === String(o.collection).toLowerCase());
          if (!col) throw new CliError(`Collection "${o.collection}" not found. Available: ${cols.map((c) => c.name).join(', ') || 'none'}`, EXIT.CONFIG_ERROR);
          const t = await collectionLoadTarget({ collection: col, selection: resolveSelection(col, o.folder), services: ctx.services, warmUp: !!o.warmUp });
          if (t.warmUp) console.log(dim(`Warm-up: ${t.warmUp.passed} passed, ${t.warmUp.failed + t.warmUp.errors} failed`));
          if (t.unresolved.length) console.log(yellow(`Unresolved variables: ${t.unresolved.join(', ')} (set them in the environment, or use --warm-up when scripts set them)`));
          target = t.target;
          isProduction = !!ctx.environment?.isProduction;
          console.log(dim(`${t.target.requests.length} requests per pass: ${t.target.requests.map((r) => r.name).join(' → ')}`));
        } finally {
          await ctx.dispose();
          store.close();
        }
      }
      // {{variables}} in a URL / saved load test resolve from the workspace and -e environment
      if (target.kind !== 'sequence' && JSON.stringify(target).includes('{{')) {
        const { store, ephemeral } = openWorkspace(o.workspace, undefined, mgr);
        const ctx = createEngineContext({ store, secrets: new ChainSecretStore([new EnvSecretStore()]), settings, environment: o.environment });
        try {
          target = ctx.vars.resolveDeep(target);
          isProduction = !!ctx.environment?.isProduction;
          if (ctx.vars.unresolved.size) console.log(yellow(`Unresolved variables: ${[...ctx.vars.unresolved].join(', ')}${ephemeral ? ' (no workspace found: pass -w)' : ' (pick an environment with -e)'}`));
        } finally {
          await ctx.dispose();
          store.close();
        }
      }
      let last = 0;
      const startedAt = new Date().toISOString();
      const snap = await runLoadTest(
        {
          target,
          environmentIsProduction: isProduction,
          virtualUsers: Number(o.vus),
          durationSec: Number(o.duration),
          rampUpSec: Number(o.rampUp),
          rampDownSec: Number(o.rampDown),
          requestsPerSecond: o.rps ? Number(o.rps) : undefined,
          allowRemoteHosts: !!o.allowRemote,
          maxVirtualUsers: settings.loadTesting.maxVirtualUsers,
        },
        {
          onSnapshot: (s) => {
            if (s.done || Date.now() - last < 1000) return;
            last = Date.now();
            console.log(dim(`[${s.elapsedSec}s] vus=${s.activeVUs} rps=${s.currentRps} total=${s.requests} errors=${s.errors} p95=${s.latency.p95}ms`));
          },
        },
      );
      printLoad(snap);
      const checked = rules.length ? evaluateThresholds(rules, snap) : undefined;
      if (checked) {
        console.log(bold('\nThresholds'));
        for (const t of checked) console.log(`  ${t.passed ? green('✓') : red('✗')} ${t.expr} ${dim(`(actual ${t.actual ?? 'n/a'}${t.percent ? '%' : ''})`)}`);
      }
      if (o.json) writeFileSync(o.json, JSON.stringify({ ...snap, ...(checked ? { thresholds: checked } : {}) }, null, 2));
      // in a workspace, the run joins its load test history (the app's Load view and the load_history MCP tool)
      if ((o.workspace || o.saved || o.collection) && snap.requests) {
        try {
          const { store, ephemeral } = openWorkspace(o.workspace, undefined, mgr);
          try {
            if (!ephemeral) {
              const targetText =
                target.kind === 'http'
                  ? `${target.request.method} ${new Redactor(settings.redactFields).redactUrl(target.request.url)}`
                  : target.kind === 'grpc'
                    ? `gRPC ${target.request.target} ${target.request.method}`
                    : target.kind === 'sequence'
                      ? `collection ${String(o.collection)}${o.folder ? ` / ${String(o.folder)}` : ''}`
                      : 'load test';
              recordLoadRun(
                store,
                loadRunRecord(snap, {
                  id: `load-${Date.now().toString(36)}`,
                  startedAt,
                  savedId: o._savedId as string | undefined,
                  name: (o._savedName as string | undefined) ?? targetText,
                  target: targetText,
                  environment: o.environment,
                  virtualUsers: Number(o.vus),
                  durationSec: Number(o.duration),
                  thresholds: checked?.map((t) => ({ expr: t.expr, passed: t.passed, actual: t.actual })),
                }),
              );
            }
          } finally {
            store.close();
          }
        } catch {
          /* the history is a convenience: never fail the run for it */
        }
      }
      // with thresholds, they decide; without, more than 5% errors fails
      process.exitCode = (checked ? checked.some((t) => !t.passed) : snap.errorRate > 0.05) ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
    });
  program
    .command('send')
    .description('send one request, like curl: a saved request by name ("Collection/Request" or just "Request", with its scripts, auth and checks) or a URL; {{variables}} resolve from the environment')
    .argument('<request>', 'saved request ("Collection/Folder/Request", "Request") or a URL (may use {{variables}})')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-e, --environment <name>', 'environment')
    .option('-X, --method <method>', 'HTTP method for a URL', 'GET')
    .option('-H, --header <header...>', 'headers "Name: value" for a URL')
    .option('-d, --data <body>', 'request body for a URL (JSON is detected)')
    .option('-i, --include', 'print the status line and response headers')
    .option('--fail', 'exit 1 on an HTTP error status (400+) or a failed check')
    .option('--json', 'print { status, headers, body, durationMs, checks } as JSON')
    .action(async (target: string, o: { workspace?: string; environment?: string; method: string; header?: string[]; data?: string; include?: boolean; fail?: boolean; json?: boolean }) => {
      process.exitCode = await executeSend(target, o);
    });
  program
    .command('report')
    .description('generate reports from a results.jsonl file')
    .argument('<results>', 'results.jsonl')
    .addOption(new Option('-f, --format <formats...>').default(['html', 'junit', 'markdown', 'json']))
    .option('-o, --out <dir>', 'output directory')
    .action(async (file: string, o) => {
      const summaryPath = join(dirname(file), 'summary.json');
      if (!existsSync(summaryPath)) throw new CliError(`summary.json not found next to ${file}`, EXIT.CONFIG_ERROR);
      const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
      const out = await writeReports(o.out ?? dirname(file), summary, () => readResults(file), o.format);
      for (const [f, p] of Object.entries(out)) console.log(`${f}: ${p}`);
    });
}

interface SavedLoadTest {
  kind: 'http' | 'llm' | 'collection' | 'grpc';
  grpcTarget?: string;
  grpcMethod?: string;
  collectionId?: string;
  folderId?: string;
  warmUp?: boolean;
  thresholds?: string;
  method?: string;
  url?: string;
  headers?: Array<{ key: string; value: string; enabled?: boolean }>;
  body?: string;
  vus?: number;
  duration?: number;
  rampUp?: number;
  rampDown?: number;
  rps?: string | number;
}

/**
 * `testpion load --saved <name>`: fill the options from a load test saved in the app (library/load-tests.json).
 * Options typed on the command line win; remote hosts still need --allow-remote here.
 */
function applySavedLoadTest(o: Record<string, unknown>, cmd: Command, url: string | undefined): string | undefined {
  const { store } = openWorkspace(o.workspace as string | undefined, undefined, new WorkspaceManager());
  let item: { id: string; name: string; data: SavedLoadTest } | undefined;
  let names: string[] = [];
  try {
    const items = store.getLibrary<SavedLoadTest>('load-tests').items;
    names = items.map((i) => i.name);
    const ref = String(o.saved).toLowerCase();
    item = items.find((i) => i.id === o.saved) ?? items.find((i) => i.name.toLowerCase() === ref);
  } finally {
    store.close();
  }
  if (item) {
    // remembered for the load history
    o._savedId = item.id;
    o._savedName = item.name;
  }
  if (!item) throw new CliError(`No saved load test "${String(o.saved)}". Saved: ${names.join(', ') || 'none (save one in the app: Load ▸ Save)'}`, EXIT.CONFIG_ERROR);
  const d = item.data;
  const fromCli = (k: string) => cmd.getOptionValueSource(k) === 'cli';
  const setIfUnset = (k: string, v: unknown) => {
    if (v !== undefined && v !== '' && !fromCli(k)) o[k] = String(v);
  };
  if (d.kind === 'llm') throw new CliError(`"${item.name}" load-tests an LLM provider, which runs in the app only`, EXIT.CONFIG_ERROR);
  if (d.kind === 'collection') {
    if (!fromCli('collection')) o.collection = d.collectionId;
    if (!fromCli('folder') && d.folderId) o.folder = [d.folderId];
    if (!fromCli('warmUp') && d.warmUp) o.warmUp = true;
  } else if (d.kind === 'grpc') {
    url = url ?? d.grpcTarget;
    if (!fromCli('grpc')) o.grpc = d.grpcMethod;
    setIfUnset('data', d.body);
  } else {
    url = url ?? d.url;
    setIfUnset('method', d.method);
    setIfUnset('data', d.body);
  }
  if (!fromCli('header') && d.headers?.length && d.kind !== 'collection') o.header = d.headers.filter((h) => h.enabled !== false && h.key).map((h) => `${h.key}: ${h.value}`);
  setIfUnset('vus', d.vus);
  setIfUnset('duration', d.duration);
  setIfUnset('rampUp', d.rampUp);
  setIfUnset('rampDown', d.rampDown);
  setIfUnset('rps', d.rps);
  if (!fromCli('threshold') && d.thresholds?.trim()) o.threshold = d.thresholds.split(/[,\n]/).map((r) => r.trim()).filter(Boolean);
  console.log(dim(`Saved load test "${item.name}"`));
  return url;
}
