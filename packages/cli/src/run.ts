/** Running tests, suites, collections and mock servers from the command line; results, reports and exit codes. */
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { Command, Option } from 'commander';
import {
  ApsError,
  collectionRequests,
  ChainSecretStore,
  EnvSecretStore,
  Logger,
  WorkspaceManager,
  WorkspaceStore,
  compareToBaseline,
  consoleSink,
  createBaseline,
  createEngineContext,
  executeHttp,
  timingSummary,
  formatDuration,
  CookieJar,
  cookiesFromJson,
  exportPostmanEnvironment,
  startMockServer,
  type MockServer,
  loadSuite,
  runTests,
  runCollection,
  readDataset,
  dbKindOf,
  shortId,
  streamTests,
  writeReports,
  loadTestsFromFile,
  isSuiteFile,
  DEFAULT_THRESHOLDS,
  type ReportFormat,
  type RunSummary,
  type Collection,
  type CollectionNode,
  type Environment,
  type DatasetRecord,
  type RunEvent,
  type TestCase,
  type TestResult,
  type Trace,
  type Redactor,
  exportOtlp,
  otlpTargetFromEnv,
  collectionRealtimeTests,
} from '@testpion/core';
import { EXIT, green, red, yellow, dim, bold, cyan, CliError, collectVar, openWorkspace, readImport, loadCollectionRef, cleanupFailedRun, readResults } from './shared.js';

export function printResult(r: TestResult, verbose: boolean): void {
  const icon = r.status === 'passed' ? green('✓') : r.status === 'skipped' ? yellow('○') : red('✗');
  const meta = [r.latencyMs !== undefined ? `${Math.round(r.latencyMs)}ms` : `${r.durationMs}ms`, r.tokens ? `${r.tokens.totalTokens} tok` : '', r.attempts > 1 ? `${r.attempts} attempts` : ''].filter(Boolean).join(', ');
  console.log(`  ${icon} ${r.name} ${dim(`(${meta})`)}`);
  if (r.status === 'skipped' && r.metadata?.reason) console.log(dim(`      skipped: ${r.metadata.reason}`));
  if (r.error) {
    console.log(red(`      ${r.error.kind}: ${r.error.message}`));
    if (r.error.why && r.error.why !== r.error.message) console.log(dim(`      why: ${r.error.why}`));
    for (const s of r.error.suggestions.slice(0, 3)) console.log(dim(`      → ${s}`));
  }
  for (const ch of r.checks) {
    if (ch.passed && !verbose) continue;
    const tag = ch.source === 'deterministic' ? '' : dim(` [${ch.source}]`);
    console.log(`      ${ch.passed ? green('✓') : red('✗')} ${ch.name}${tag}: ${ch.message}${ch.score !== undefined ? dim(` score=${ch.score}`) : ''}`);
    if (!ch.passed && ch.explanation) console.log(dim(`        ${ch.explanation.slice(0, 300)}`));
  }
}

export interface RunCliOptions {
  workspace?: string;
  environment?: string;
  concurrency?: string;
  retries?: string;
  timeout?: string;
  reporter: string[];
  out?: string;
  tags?: string;
  grep?: string;
  bail?: boolean;
  resume?: string;
  var?: Record<string, string>;
  baseline?: string;
  saveBaseline?: string;
  trace: 'all' | 'failures' | 'none';
  verbose?: boolean;
  quiet?: boolean;
  suite?: string;
  failOnRegression?: boolean;
  logLevel?: string;
  otlp?: string;
  otlpHeader?: string[];
  rerunFailed?: string | boolean;
}

export async function executeRun(paths: string[], o: RunCliOptions, label?: string): Promise<number> {
  const mgr = new WorkspaceManager();
  const settings = mgr.loadSettings();
  const firstPath = paths[0] ? resolve(paths[0]) : undefined;
  const { store, ephemeral } = openWorkspace(o.workspace, firstPath && existsSync(firstPath) ? dirname(firstPath) : undefined, mgr);
  const logger = new Logger((o.logLevel?.toUpperCase() as 'INFO') ?? 'WARN');
  if (o.logLevel) logger.addSink(consoleSink());
  const secrets = new ChainSecretStore([new EnvSecretStore()]);

  let suite: Awaited<ReturnType<typeof loadSuite>> | undefined;
  let patterns = paths;
  let cwd = process.cwd();
  if (o.suite) {
    const candidates = [o.suite, join(store.path('tests'), o.suite), join(store.path('tests'), `${o.suite}.suite.yaml`), join(store.path('tests'), `${o.suite}.suite.yml`)];
    const file = candidates.find((p) => existsSync(p) && isSuiteFile(p));
    if (!file) throw new CliError(`Suite "${o.suite}" not found in ${store.path('tests')}`, EXIT.CONFIG_ERROR);
    suite = await loadSuite(file);
    patterns = suite.tests;
    cwd = dirname(file);
  } else if (paths.length === 1 && isSuiteFile(paths[0]!)) {
    suite = await loadSuite(resolve(paths[0]!));
    patterns = suite.tests;
    cwd = dirname(resolve(paths[0]!));
  } else if (!paths.length) {
    patterns = [store.path('tests')];
  }

  const environment = o.environment ?? suite?.environment ?? (store.listEnvironments().length === 1 ? store.listEnvironments()[0]!.name : undefined);
  if (o.environment && !store.getEnvironment(o.environment))
    throw new CliError(`Environment "${o.environment}" not found. Available: ${store.listEnvironments().map((e) => e.name).join(', ')}`, EXIT.CONFIG_ERROR);

  const ctx = createEngineContext({ store, secrets, settings, environment, logger, runtimeVars: o.var, fileRoot: ephemeral ? process.cwd() : undefined });
  const runId = o.resume ?? shortId('run-');
  // outside a workspace the ephemeral one is deleted afterwards, so keep results next to the caller (like Newman's ./newman)
  const outDir = o.out ? resolve(o.out) : ephemeral ? resolve('testpion-results', runId) : store.runDir(runId);
  const resultsFile = join(outDir, 'results.jsonl');
  if (o.resume && !existsSync(resultsFile)) throw new CliError(`Cannot resume: ${resultsFile} does not exist`, EXIT.CONFIG_ERROR);

  const loadList = async (list?: string[]) => {
    const out: TestCase[] = [];
    for (const p of list ?? []) for await (const t of loadTestsFromFile(isAbsolute(p) ? p : resolve(cwd, p))) out.push(t);
    return out;
  };

  const name = label ?? suite?.name ?? (paths.length ? paths.map((p) => relative(process.cwd(), resolve(p)) || '.').join(', ') : store.workspace.name);
  if (!o.quiet) {
    console.log(bold(`TestPion — ${name}`));
    console.log(dim(`workspace: ${ephemeral ? '(ephemeral)' : store.root}${environment ? ` · environment: ${environment}` : ''} · run: ${runId}`));
  }

  const otlp = otlpExporter(o);
  // --rerun-failed: the failed and errored tests of an earlier run
  const rerun = o.rerunFailed ? store.failedTestIds(typeof o.rerunFailed === 'string' ? o.rerunFailed : 'last') : undefined;
  if (rerun && !o.quiet) console.log(dim(`Re-running ${rerun.ids.length} failed test${rerun.ids.length === 1 ? '' : 's'} of ${rerun.runId}`));
  if (rerun && !rerun.ids.length) {
    console.log(green('Nothing failed in that run.'));
    await ctx.dispose();
    return EXIT.SUCCESS;
  }
  const concurrency = Number(o.concurrency ?? suite?.concurrency ?? 4);
  const ctrl = new AbortController();
  let interrupted = 0;
  const onSigint = () => {
    interrupted++;
    if (interrupted > 1) process.exit(EXIT.EXECUTION_ERROR);
    console.error(yellow('\nCancelling… (press Ctrl+C again to force quit). Resume later with --resume ' + runId));
    ctrl.abort();
  };
  process.on('SIGINT', onSigint);

  const onEvent = (e: RunEvent) => {
    if (e.type === 'test-end' && !o.quiet) printResult(e.result, !!o.verbose);
  };
  let summary;
  try {
    summary = await runTests({
      name,
      runId,
      tests: streamTests(patterns, cwd, { tags: o.tags?.split(',').map((t) => t.trim()).filter(Boolean), grep: o.grep, ...(rerun ? { ids: rerun.ids } : {}) }),
      setup: await loadList(suite?.setup),
      teardown: await loadList(suite?.teardown),
      concurrency,
      retries: Number(o.retries ?? suite?.retries ?? 0),
      timeoutMs: o.timeout ? Number(o.timeout) : suite?.timeoutMs,
      services: ctx.services,
      signal: ctrl.signal,
      resultsFile,
      resume: !!o.resume,
      traceMode: o.trace,
      onTrace: (trace) => {
        void store.saveTrace(trace, 'test', runId);
        otlp.add(trace);
      },
      onEvent,
      environment,
      bail: o.bail,
    });
  } catch (e) {
    cleanupFailedRun({ ephemeral, outDir, explicitOut: !!o.out, store });
    throw e;
  } finally {
    process.off('SIGINT', onSigint);
    await otlp.flush(ctx.redactor, { 'testpion.run.id': runId, 'testpion.run.name': name }, !!o.quiet);
    await ctx.dispose();
  }

  return finishRun({ store, ephemeral, summary, outDir, resultsFile, o, rerun: `testpion test ${paths.join(' ')} --resume ${runId}` });
}

/** Write reports, compare baselines, print the summary and work out the exit code (shared by test/run/run-collection). */
export async function finishRun(a: {
  store: WorkspaceStore;
  ephemeral?: string;
  summary: RunSummary;
  outDir: string;
  resultsFile: string;
  o: Pick<RunCliOptions, 'reporter' | 'baseline' | 'saveBaseline' | 'quiet' | 'failOnRegression'>;
  rerun?: string;
  emptyMessage?: string;
}): Promise<number> {
  const { store, ephemeral, summary, outDir, resultsFile, o } = a;
  const results = () => readResults(resultsFile);
  const formats = o.reporter.filter((r) => r !== 'console') as ReportFormat[];
  const paths2 = formats.length ? await writeReports(outDir, summary, results, formats) : ({} as Record<string, string>);
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  if (!ephemeral) store.meta.addRun(summary, outDir);

  let regressionFailed = false;
  if (o.baseline) {
    const report = await compareToBaseline(store.getBaseline(o.baseline), summary, results(), DEFAULT_THRESHOLDS);
    writeFileSync(join(outDir, 'regression.json'), JSON.stringify(report, null, 2));
    const metricRegressions = report.summary.filter((m) => m.regressed);
    console.log(bold(`\nRegression vs baseline "${o.baseline}": ${report.passed ? green('no regressions') : red(`${report.regressions.length + metricRegressions.length} regression(s)`)}`));
    for (const m of metricRegressions) console.log(red(`  ✗ ${m.metric}: ${m.baseline} → ${m.current} (${m.deltaPct > 0 ? '+' : ''}${m.deltaPct}%)`));
    for (const r of report.regressions.slice(0, 20)) console.log(red(`  ✗ ${r.id}: ${r.message}`));
    for (const r of report.improvements.slice(0, 10)) console.log(green(`  ✓ ${r.id}: ${r.message}`));
    regressionFailed = !report.passed;
  }
  if (o.saveBaseline) {
    store.saveBaseline(await createBaseline(o.saveBaseline, summary, results()));
    console.log(dim(`Saved baseline "${o.saveBaseline}"`));
  }

  if (!o.quiet) {
    const ok = summary.failed + summary.errors === 0;
    console.log(
      `\n${ok ? green(bold('PASSED')) : red(bold('FAILED'))}  ${summary.passed} passed, ${summary.failed} failed, ${summary.errors} errors, ${summary.skipped} skipped · ${formatDuration(summary.durationMs)}`,
    );
    if (summary.latency.count) console.log(dim(`latency p50 ${summary.latency.p50}ms · p95 ${summary.latency.p95}ms · p99 ${summary.latency.p99}ms`));
    if (summary.tokens.totalTokens) console.log(dim(`tokens ${summary.tokens.inputTokens} in / ${summary.tokens.outputTokens} out${summary.costUsd ? ` · est. cost $${summary.costUsd}` : ''}`));
    for (const [k, v] of Object.entries(summary.scores)) console.log(dim(`score ${k}: ${v.mean} (${v.count})`));
    for (const [f, p] of Object.entries(paths2)) console.log(dim(`${f} report: ${p}`));
    if (summary.cancelled && a.rerun) console.log(yellow(`Run cancelled. Resume with: ${a.rerun}`));
  }
  store.close();
  if (ephemeral) rmSync(ephemeral, { recursive: true, force: true });
  if (summary.cancelled) return EXIT.EXECUTION_ERROR;
  if (summary.total === 0) {
    console.error(yellow(a.emptyMessage ?? 'No tests found.'));
    return EXIT.CONFIG_ERROR;
  }
  return summary.failed + summary.errors > 0 || (o.failOnRegression && regressionFailed) ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
}

export interface CollectionCliOptions extends Pick<RunCliOptions, 'workspace' | 'environment' | 'bail' | 'timeout' | 'reporter' | 'out' | 'var' | 'baseline' | 'saveBaseline' | 'failOnRegression' | 'trace' | 'verbose' | 'quiet' | 'logLevel' | 'otlp' | 'otlpHeader' | 'rerunFailed'> {
  iterationData?: string;
  iterationQuery?: string;
  iterationCount?: string;
  delayRequest?: string;
  folder?: string[];
  /** Only requests with these methods (GET for a smoke run that changes nothing). */
  method?: string[];
  cookieJar?: string;
  exportCookieJar?: string;
  /** Newman-compatible options */
  globals?: string;
  envVar?: Record<string, string>;
  globalVar?: Record<string, string>;
  timeoutRequest?: string;
  insecure?: boolean;
  exportEnvironment?: string;
  exportGlobals?: string;
  suppressExitCode?: boolean;
  reporters?: string[];
  reporterJunitExport?: string;
}

/** A copy of the collection with TLS verification off for every request (Newman's --insecure). */
function insecureCollection(c: Collection): Collection {
  const walk = (nodes: CollectionNode[]): CollectionNode[] =>
    nodes.map((n) => (n.kind === 'folder' ? { ...n, items: walk(n.items) } : { ...n, request: { ...n.request, settings: { ...n.request.settings, insecure: true } } } as CollectionNode));
  return { ...c, items: walk(c.items) };
}

/** Write a scope's values after a run as a Postman environment / globals file. Secret values are left empty. */
function writeScopeFile(file: string, name: string, values: Record<string, unknown>, isSecret: (k: string) => boolean, scope: 'environment' | 'globals'): number {
  const variables = Object.entries(values).map(([key, v]) => ({ key, value: typeof v === 'string' ? v : JSON.stringify(v), secret: isSecret(key), enabled: true }));
  const doc = { ...exportPostmanEnvironment({ id: name, name, variables } as unknown as Environment), _postman_variable_scope: scope };
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return variables.length;
}

/** Map --folder names/ids to node ids (folders or requests), like Newman's --folder. */
export function resolveSelection(collection: Collection, refs: string[] | undefined): string[] | undefined {
  if (!refs?.length) return undefined;
  const all: CollectionNode[] = [];
  const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => (all.push(n), n.kind === 'folder' && walk(n.items)));
  walk(collection.items);
  return refs.map((ref) => {
    const n = all.find((x) => x.id === ref) ?? all.find((x) => x.name === ref) ?? all.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!n) throw new CliError(`No folder or request "${ref}" in collection "${collection.name}"`, EXIT.CONFIG_ERROR);
    return n.id;
  });
}

export async function executeCollectionRun(ref: string, o: CollectionCliOptions): Promise<number> {
  const mgr = new WorkspaceManager();
  const settings = mgr.loadSettings();
  const fromUrl = /^https?:\/\//i.test(ref);
  const fromFile = fromUrl || (existsSync(ref) && statSync(ref).isFile());
  // a collection file never touches the user's workspace: it runs in an ephemeral one unless -w is given
  const { store, ephemeral } = openWorkspace(o.workspace, fromFile && !o.workspace ? tmpdir() : undefined, mgr);
  const logger = new Logger((o.logLevel?.toUpperCase() as 'INFO') ?? 'WARN');
  if (o.logLevel) logger.addSink(consoleSink());
  const secrets = new ChainSecretStore([new EnvSecretStore()]);

  let collection: Collection;
  if (fromUrl) collection = await loadCollectionRef(ref, undefined);
  else if (fromFile) collection = readImport(resolve(ref), 'collection');
  else {
    const cols = store.listCollections().filter((c) => !c.problem);
    const found = cols.find((c) => c.id === ref) ?? cols.find((c) => c.name.toLowerCase() === ref.toLowerCase());
    if (!found) throw new CliError(`Collection "${ref}" not found. Available: ${cols.map((c) => c.name).join(', ') || 'none'} (or pass a collection file)`, EXIT.CONFIG_ERROR);
    collection = found;
  }

  let envFile: Environment | undefined;
  let envName: string | undefined;
  if (o.environment && existsSync(o.environment) && statSync(o.environment).isFile()) envFile = readImport(resolve(o.environment), 'environment');
  else if (o.environment) {
    if (!store.getEnvironment(o.environment)) throw new CliError(`Environment "${o.environment}" not found. Available: ${store.listEnvironments().map((e) => e.name).join(', ') || 'none'} (or pass an environment file)`, EXIT.CONFIG_ERROR);
    envName = o.environment;
  } else if (!fromFile && store.listEnvironments().length === 1) envName = store.listEnvironments()[0]!.name;

  if (o.insecure) collection = insecureCollection(collection);
  const globalsFile = o.globals ? readImport(resolve(o.globals), 'environment') : undefined;
  // --rerun-failed: only the requests that failed in an earlier run of this collection
  const rerun = o.rerunFailed && !ephemeral ? store.failedTestIds(typeof o.rerunFailed === 'string' ? o.rerunFailed : 'last') : undefined;
  if (rerun && !rerun.ids.length) {
    console.log(green('Nothing failed in that run.'));
    return EXIT.SUCCESS;
  }
  let selection = rerun ? rerun.ids : resolveSelection(collection, o.folder);
  if (o.method?.length) {
    // --method GET: only the requests that read, e.g. a smoke run against a fresh deployment
    const wanted = new Set(o.method.flatMap((m) => m.split(',')).map((m) => m.trim().toUpperCase()));
    selection = collectionRequests(collection, selection)
      .filter((r) => wanted.has(r.node.kind === 'http' ? r.node.request.method.toUpperCase() : 'GRAPHQL'))
      .map((r) => r.node.id);
    if (!selection.length) throw new CliError(`No ${[...wanted].join(' / ')} requests to run in "${collection.name}"`, EXIT.CONFIG_ERROR);
  }
  if (rerun && !o.quiet) console.log(dim(`Re-running ${rerun.ids.length} failed request${rerun.ids.length === 1 ? '' : 's'} of ${rerun.runId}`));
  let data: DatasetRecord[] | undefined;
  if (o.iterationData) {
    // a database (postgres://…, mysql://… or env:NAME holding the URL) is read as it is; a file is relative to here
    const database = !!dbKindOf(o.iterationData) || /^env:\w+$/.test(o.iterationData);
    const file = database ? o.iterationData : resolve(o.iterationData);
    if (!database && !existsSync(file)) throw new CliError(`Data file ${file} does not exist`, EXIT.CONFIG_ERROR);
    data = [];
    for await (const r of readDataset({ path: file, query: o.iterationQuery, limit: 100_000 })) data.push(r);
  }
  const iterations = o.iterationCount ? Number(o.iterationCount) : undefined;
  if (iterations !== undefined && !(iterations >= 1)) throw new CliError('--iteration-count must be 1 or more', EXIT.CONFIG_ERROR);

  let cookieJar = new CookieJar();
  if (o.cookieJar) {
    try {
      cookieJar = new CookieJar(cookiesFromJson(JSON.parse(readFileSync(resolve(o.cookieJar), 'utf8'))));
    } catch (e) {
      throw new CliError(`Could not read cookie jar ${o.cookieJar}: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
    }
  }
  const ctx = createEngineContext({ store, secrets, settings, environment: envName, collectionId: fromFile ? undefined : collection.id, logger, runtimeVars: o.var, cookieJar, fileRoot: ephemeral ? process.cwd() : undefined });
  if (fromFile) ctx.vars.setScope('collection', collection.variables);
  if (envFile) ctx.vars.setScope('environment', envFile.variables);
  if (envFile) ctx.services.environmentName = envFile.name;
  // Newman: -g globals file, then --global-var / --env-var overrides
  for (const v of globalsFile?.variables ?? []) if (v.key && v.enabled !== false) ctx.vars.set(v.key, v.value, 'global');
  for (const [k, v] of Object.entries(o.globalVar ?? {})) ctx.vars.set(k, v, 'global');
  for (const [k, v] of Object.entries(o.envVar ?? {})) ctx.vars.set(k, v, 'environment');
  const environment = envName ?? envFile?.name;
  const runId = shortId('run-');
  // outside a workspace the ephemeral one is deleted afterwards, so keep results next to the caller (like Newman's ./newman)
  const outDir = o.out ? resolve(o.out) : ephemeral ? resolve('testpion-results', runId) : store.runDir(runId);
  const resultsFile = join(outDir, 'results.jsonl');

  if (!o.quiet) {
    console.log(bold(`TestPion — ${collection.name}`));
    const bits = [ephemeral ? '' : `workspace: ${store.root}`, environment ? `environment: ${environment}` : '', data ? `data: ${data.length} rows` : '', `run: ${runId}`];
    console.log(dim(bits.filter(Boolean).join(' · ')));
  }

  const ctrl = new AbortController();
  let interrupted = 0;
  const onSigint = () => {
    if (++interrupted > 1) process.exit(EXIT.EXECUTION_ERROR);
    console.error(yellow('\nCancelling… (press Ctrl+C again to force quit)'));
    ctrl.abort();
  };
  process.on('SIGINT', onSigint);
  const otlp = otlpExporter(o);
  let lastIteration = 0;
  let summary: RunSummary;
  try {
    summary = await runCollection({
      name: collection.name,
      runId,
      collection,
      selection,
      // the collection's gRPC calls and connections (a workspace collection; a collection file has none)
      realtime: fromFile ? undefined : collectionRealtimeTests(store, collection, selection),
      data,
      iterations,
      delayMs: o.delayRequest ? Number(o.delayRequest) : undefined,
      timeoutMs: o.timeout ?? o.timeoutRequest ? Number(o.timeout ?? o.timeoutRequest) : undefined,
      bail: o.bail,
      services: ctx.services,
      signal: ctrl.signal,
      resultsFile,
      traceMode: o.trace,
      onTrace: (trace) => {
        void store.saveTrace(trace, 'test', runId);
        otlp.add(trace);
      },
      environment,
      onEvent: (e: RunEvent) => {
        if (e.type !== 'test-end' || o.quiet) return;
        const it = Number(/@(\d+)/.exec(e.result.id)?.[1] ?? 1);
        if (it !== lastIteration && (iterations ?? data?.length ?? 1) > 1) console.log(cyan(`\nIteration ${it}`));
        lastIteration = it;
        printResult(e.result, !!o.verbose);
      },
    });
  } catch (e) {
    cleanupFailedRun({ ephemeral, outDir, explicitOut: !!o.out, store });
    throw e instanceof ApsError && e.kind === 'ValidationError' ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
  } finally {
    process.off('SIGINT', onSigint);
  }
  // values after the run, including what scripts set (Newman's --export-environment / --export-globals)
  const isSecret = (k: string) => ctx.vars.isSecret(k);
  if (o.exportEnvironment) {
    const n = writeScopeFile(resolve(o.exportEnvironment), environment ?? 'environment', ctx.vars.scopeValues('environment'), isSecret, 'environment');
    if (!o.quiet) console.log(dim(`Environment written to ${resolve(o.exportEnvironment)} (${n} variables; secret values left empty)`));
  }
  if (o.exportGlobals) {
    const n = writeScopeFile(resolve(o.exportGlobals), 'globals', ctx.vars.scopeValues('global'), isSecret, 'globals');
    if (!o.quiet) console.log(dim(`Globals written to ${resolve(o.exportGlobals)} (${n} variables; secret values left empty)`));
  }
  await otlp.flush(ctx.redactor, { 'testpion.run.id': runId, 'testpion.run.name': collection.name }, !!o.quiet);
  await ctx.dispose();
  if (o.exportCookieJar) {
    const file = resolve(o.exportCookieJar);
    writeFileSync(file, JSON.stringify({ cookies: cookieJar.toJSON() }, null, 2) + '\n', { mode: 0o600 });
    if (!o.quiet) console.log(dim(`Cookie jar written to ${file} (${cookieJar.toJSON().length} cookies; values are in plain text, keep it out of git)`));
  }
  const reporter = [...(o.reporters?.length ? o.reporters : o.reporter)];
  if (o.reporterJunitExport && !reporter.includes('junit')) reporter.push('junit');
  const code = await finishRun({ store, ephemeral, summary, outDir, resultsFile, o: { ...o, reporter }, emptyMessage: 'No requests ran.' });
  if (o.reporterJunitExport) {
    const target = resolve(o.reporterJunitExport);
    writeFileSync(target, readFileSync(join(outDir, 'junit.xml')));
    if (!o.quiet) console.log(dim(`junit report: ${target}`));
  }
  // --suppress-exit-code: test failures don't fail the command (configuration errors still do)
  return o.suppressExitCode && code === EXIT.TEST_FAILURE ? EXIT.SUCCESS : code;
}

/** `testpion send`: one saved request (scripts, auth, checks) or an ad-hoc URL; prints the response like curl. */
export async function executeSend(
  target: string,
  o: { workspace?: string; environment?: string; method: string; header?: string[]; data?: string; include?: boolean; fail?: boolean; json?: boolean },
): Promise<number> {
  const mgr = new WorkspaceManager();
  const settings = mgr.loadSettings();
  const isUrl = /^(https?:\/\/|\{\{)/i.test(target);
  const { store, ephemeral } = openWorkspace(o.workspace, isUrl && !o.workspace ? tmpdir() : undefined, mgr);
  const secrets = new ChainSecretStore([new EnvSecretStore()]);
  let response: { status: number; statusText: string; headers: Array<[string, string]>; body: string; durationMs: number; url: string; timing?: ReturnType<typeof timingSummary> } | undefined;
  let checks: Array<{ name: string; passed: boolean; message?: string }> = [];
  let error: string | undefined;
  try {
    if (isUrl) {
      const ctx = createEngineContext({ store, secrets, settings, environment: o.environment });
      try {
        const headers = (o.header ?? []).map((h) => ({ key: h.slice(0, h.indexOf(':')).trim(), value: h.slice(h.indexOf(':') + 1).trim(), enabled: true }));
        const body = o.data === undefined ? undefined : /^\s*[{[]/.test(o.data) ? { type: 'json' as const, content: o.data } : { type: 'text' as const, content: o.data };
        const spec = ctx.vars.resolveDeep({ method: o.method.toUpperCase(), url: target, headers, body });
        const { response: r, prepared } = await executeHttp({ ...spec, settings: { timeoutMs: settings.defaultTimeoutMs } }, { redactor: ctx.redactor, maxPreviewBytes: 10 * 1024 * 1024, cookieJar: ctx.services.cookieJar });
        response = { status: r.status, statusText: r.statusText, headers: r.headers, body: r.bodyPreview, durationMs: r.durationMs, url: prepared.url, timing: timingSummary(r) };
      } finally {
        await ctx.dispose();
      }
    } else {
      // "Collection/Folder/Request" or just "Request" (must be unique)
      const parts = target.split('/').map((s) => s.trim()).filter(Boolean);
      const cols = store.listCollections().filter((c) => !c.problem);
      const matches: Array<{ c: Collection; id: string; path: string }> = [];
      for (const c of cols) {
        const within = parts.length > 1 && (c.name.toLowerCase() === parts[0]!.toLowerCase() || c.id === parts[0]) ? parts.slice(1) : parts.length > 1 ? undefined : parts;
        if (!within) continue;
        const walk = (nodes: CollectionNode[], path: string[]) => {
          for (const n of nodes) {
            const p = [...path, n.name];
            if (n.kind === 'folder') walk(n.items, p);
            else if (n.id === within.join('/') || p.join('/').toLowerCase().endsWith(within.join('/').toLowerCase())) matches.push({ c, id: n.id, path: [c.name, ...p].join(' / ') });
          }
        };
        walk(c.items, []);
      }
      if (!matches.length) throw new CliError(`No saved request "${target}". Use "Collection/Request", or a URL.`, EXIT.CONFIG_ERROR);
      if (matches.length > 1) throw new CliError(`"${target}" matches ${matches.length} requests: ${matches.slice(0, 5).map((m) => m.path).join('; ')}. Add the collection or folder.`, EXIT.CONFIG_ERROR);
      const { c, id } = matches[0]!;
      const ctx = createEngineContext({ store, secrets, settings, environment: o.environment, collectionId: c.id });
      ctx.services.onHttpResponse = (r) => (response = r);
      try {
        await runCollection({
          name: `send ${target}`,
          collection: c,
          selection: [id],
          services: ctx.services,
          traceMode: 'none',
          onEvent: (e: RunEvent) => {
            if (e.type !== 'test-end') return;
            checks = e.result.checks.map((x) => ({ name: x.name, passed: x.passed, message: x.message }));
            if (e.result.error) error = e.result.error.message;
          },
        });
      } finally {
        await ctx.dispose();
      }
    }
  } finally {
    store.close();
    if (ephemeral) rmSync(ephemeral, { recursive: true, force: true });
  }
  if (!response) {
    if (o.json) console.log(JSON.stringify({ error: error ?? 'no response', checks }, null, 2));
    else console.error(red(error ?? 'The request got no response'));
    return EXIT.EXECUTION_ERROR;
  }
  const failed = response.status >= 400 || checks.some((c) => !c.passed);
  if (o.json) {
    let body: unknown = response.body;
    try {
      body = JSON.parse(response.body);
    } catch {
      /* not JSON */
    }
    console.log(JSON.stringify({ status: response.status, statusText: response.statusText, url: response.url, durationMs: response.durationMs, timing: response.timing, headers: Object.fromEntries(response.headers), body, checks }, null, 2));
  } else {
    if (o.include) {
      console.log(bold(`${response.status} ${response.statusText}`) + dim(`  ${response.url} · ${formatDuration(response.durationMs)}`));
      const t = response.timing;
      if (t) {
        const parts = [t.dnsMs !== undefined && `DNS ${formatDuration(t.dnsMs)}`, t.tcpMs !== undefined && `TCP ${formatDuration(t.tcpMs)}`, t.tlsMs !== undefined && `TLS ${formatDuration(t.tlsMs)}`, t.reusedConnection && 'reused connection', t.ttfbMs !== undefined && `first byte ${formatDuration(t.ttfbMs)}`, t.downloadMs !== undefined && `download ${formatDuration(t.downloadMs)}`].filter(Boolean);
        if (parts.length) console.log(dim(`timing: ${parts.join(' · ')}`));
        if (t.certificateDaysLeft !== undefined) console.log(dim(`certificate: ${t.tlsProtocol ?? 'TLS'} · `) + (t.certificateDaysLeft < 0 ? red('expired') : t.certificateDaysLeft < 14 ? yellow(`${t.certificateDaysLeft} days left`) : dim(`${t.certificateDaysLeft} days left`)));
      }
      for (const [k, v] of response.headers) console.log(`${dim(k + ':')} ${v}`);
      console.log('');
    }
    let text = response.body;
    try {
      text = JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      /* not JSON: as is */
    }
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    for (const c of checks) console.error(`${c.passed ? green('✓') : red('✗')} ${c.name}${c.passed ? '' : dim(`: ${c.message ?? ''}`)}`);
  }
  return o.fail && failed ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
}

/** `testpion mock`: serve saved examples until interrupted. */
export async function executeMock(ref: string, o: { workspace?: string; port?: string; delay?: string; fallback?: string; quiet?: boolean }): Promise<number> {
  const collection = await loadCollectionRef(ref, o.workspace);
  const port = o.port ? Number(o.port) : 0;
  if (!(port >= 0 && port < 65536)) throw new CliError('--port must be between 0 and 65535', EXIT.CONFIG_ERROR);
  let mock: MockServer;
  try {
    mock = await startMockServer(collection, {
      port,
      delayMs: o.delay ? Number(o.delay) : undefined,
      fallbackUrl: o.fallback,
      onRequest: (e) => {
        if (o.quiet) return;
        const status = e.status < 400 ? green(String(e.status)) : e.example ? yellow(String(e.status)) : red(String(e.status));
        console.log(`${dim(new Date().toLocaleTimeString())} ${e.method} ${e.path} ${status} ${e.example ? dim(e.example) : e.forwarded ? cyan('forwarded') : red('no matching example')}`);
      },
    });
  } catch (e) {
    throw e instanceof ApsError && e.kind === 'ConfigurationError' ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
  }
  if (!mock.routes.length) console.log(yellow(`"${collection.name}" has no saved examples yet: every request will get a 404.`));
  console.log(bold(`Mock server for ${collection.name}: ${mock.url}`));
  for (const r of mock.routes) console.log(dim(`  ${r.method.padEnd(7)} ${r.path} → ${r.example.status} ${r.example.name}`));
  console.log(dim('Press Ctrl+C to stop.'));
  await new Promise<void>((done) => {
    const stop = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      done();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  await mock.close();
  return EXIT.SUCCESS;
}

/**
 * OpenTelemetry export of a run's traces: to --otlp, or to the collector in the standard
 * OTEL_EXPORTER_OTLP_* environment variables. Traces are sent in batches while the run goes on.
 */
export function otlpExporter(o: { otlp?: string; otlpHeader?: string[] }) {
  const headers: Record<string, string> = {};
  for (const h of o.otlpHeader ?? []) {
    const i = h.indexOf(':');
    if (i <= 0) throw new CliError(`--otlp-header expects key:value, got "${h}"`, EXIT.CONFIG_ERROR);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  const envTarget = otlpTargetFromEnv();
  const target = o.otlp ? { endpoint: o.otlp, headers: { ...(envTarget?.headers ?? {}), ...headers } } : envTarget;
  let pending: Trace[] = [];
  let sent = 0;
  let url = '';
  let failed: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  let redactor: Redactor | undefined;
  let resource: Record<string, string> = {};
  const send = () => {
    if (!target || !pending.length || failed) return;
    const batch = pending;
    pending = [];
    chain = chain.then(() =>
      exportOtlp(batch, target, { redactor, resource }).then(
        (r) => {
          sent += r.spans;
          url = r.url;
        },
        (e: Error) => {
          failed = e.message;
        },
      ),
    );
  };
  return {
    enabled: !!target,
    add(trace: Trace) {
      if (!target) return;
      pending.push(trace);
      if (pending.length >= 200) send();
    },
    async flush(r: Redactor, res: Record<string, string>, quiet: boolean) {
      if (!target) return;
      redactor = r;
      resource = res;
      send();
      await chain;
      if (failed) console.error(yellow(`OpenTelemetry export failed: ${failed}`));
      else if (!quiet && sent) console.log(dim(`OpenTelemetry: ${sent} spans sent to ${url}`));
      else if (!quiet) console.log(dim('OpenTelemetry: no traces to send (only failing tests are traced; add --trace all for every test)'));
    },
  };
}

export function runOptions(cmd: Command): Command {
  return cmd
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-e, --environment <name>', 'environment to use')
    .option('-c, --concurrency <n>', 'parallel workers')
    .option('--retries <n>', 'retries per failing test')
    .option('--timeout <ms>', 'per-test timeout in ms')
    .addOption(new Option('-r, --reporter <formats...>', 'reporters: console, junit, json, html, markdown').default(['console', 'junit', 'json', 'html', 'markdown']))
    .option('-o, --out <dir>', 'output directory for results and reports')
    .option('-t, --tags <tags>', 'only run tests with these tags (comma separated)')
    .option('-g, --grep <pattern>', 'only run tests whose name/id matches')
    .option('--bail', 'stop after the first failure')
    .option('--resume <runId>', 'resume a cancelled/crashed run')
    .option('--var <key=value>', 'runtime variable (repeatable)', collectVar)
    .option('--baseline <name>', 'compare results against a saved baseline')
    .option('--save-baseline <name>', 'save this run as a baseline')
    .option('--fail-on-regression', 'exit 1 when the baseline comparison finds regressions')
    .addOption(new Option('--trace <mode>', 'persist traces').choices(['all', 'failures', 'none']).default('failures'))
    .option('-v, --verbose', 'show passing checks')
    .option('-q, --quiet', 'only print the summary exit code')
    .option('--log-level <level>', 'ERROR | WARN | INFO | DEBUG | TRACE (secrets are always redacted)')
    .option('--watch', 'run again whenever a test, collection, environment or data file changes (until Ctrl+C)')
    .option('--rerun-failed [runId]', 'only the tests that failed or errored in a run (default: the last one)')
    .option('--otlp <url>', 'send the traces to an OpenTelemetry collector (OTLP/HTTP, e.g. http://localhost:4318); default: OTEL_EXPORTER_OTLP_ENDPOINT')
    .option('--otlp-header <key:value...>', 'headers for the collector, e.g. an API key (also OTEL_EXPORTER_OTLP_HEADERS)');
}
