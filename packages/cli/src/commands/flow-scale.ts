/**
 * A flow at scale from the command line: `testpion test <file> --data <rows>` (the flow once per row, a row's fields
 * as variables), `testpion test <file> --env-matrix dev,staging` (or -e repeated: the flow in each environment, side
 * by side) and `testpion flow report <file>` (a run's timeline with its critical path, as text, JSON or HTML).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  WorkspaceManager,
  normalizeError,
  flowDataSource,
  flowRunTimeline,
  flowRunTimelineHtml,
  isSuiteFile,
  prefetchEnvironmentSecrets,
  readFlowDataHeader,
  runFlowData,
  runFlowMatrix,
  saveScaleRun,
  scaleRunRow,
  scaleRunId,
  ScaleRowsWriter,
  testFileRef,
  type DataRowResult,
  type FlowMatrixResult,
  removeScratchDir,
} from '@testpion/core';
import { formatMs } from '@testpion/shared';
import { EXIT, CliError, bold, cliContext, dim, green, openWorkspace, printJson, red, requireEnvironment, withWorkspace, yellow, WORKSPACE_OPTION, subcommand } from '../shared.js';
import { cli, emitEvent, machine, noteError, streamData } from '../output.js';

export interface ScaleCliOptions {
  workspace?: string;
  environment?: string | string[];
  data?: string | boolean;
  dataQuery?: string;
  dataLimit?: string;
  dataConcurrency?: string;
  envMatrix?: string[];
  concurrency?: string;
  retries?: string;
  timeout?: string;
  bail?: boolean;
  json?: boolean;
  quiet?: boolean;
  var?: Record<string, string>;
  /** A run where nothing ran (every step skipped) exits 0 instead of 1. */
  allowSkipped?: boolean;
}

const NOTHING_RAN = 'Nothing ran: every step was skipped (a step it depends on is in another file, or a condition skipped it)';

/** Whether `testpion test` was asked for a data-driven run or an environment matrix. */
export function isScaleRun(o: ScaleCliOptions): boolean {
  return o.data !== undefined || !!o.envMatrix?.length || Array.isArray(o.environment);
}

const short = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? '' : s.length > 24 ? `${s.slice(0, 23)}…` : s;
};

/**
 * `testpion test <file> --data … | --env-matrix …`: exit 0 when every row / environment passed, 1 when one failed or
 * when nothing ran (every row / environment skipped every step; --allow-skipped: 0).
 */
export async function executeScaleRun(paths: string[], o: ScaleCliOptions): Promise<number> {
  if (paths.length !== 1) throw new CliError('--data and --env-matrix run one flow file: give exactly one test file', EXIT.CONFIG_ERROR);
  const given = resolve(paths[0]!);
  const { store, ephemeral } = openWorkspace(o.workspace, existsSync(given) ? dirname(given) : undefined, new WorkspaceManager());
  try {
    const abs = existsSync(given) ? given : store.safePath(paths[0]!, store.path('tests'));
    if (!existsSync(abs)) throw new CliError(`No such test file: ${paths[0]}`, EXIT.CONFIG_ERROR);
    if (isSuiteFile(abs)) throw new CliError('--data and --env-matrix run one flow file, not a suite', EXIT.CONFIG_ERROR);
    const rel = testFileRef(store, abs);
    const ctrl = new AbortController();
    const onSigint = () => {
      console.error(yellow('\nCancelling…'));
      ctrl.abort();
    };
    process.on('SIGINT', onSigint);
    try {
      const matrix = [...(o.envMatrix ?? []).flatMap((e) => e.split(',')), ...(Array.isArray(o.environment) ? o.environment : [])].map((e) => e.trim()).filter(Boolean);
      if (matrix.length) {
        if (o.data !== undefined) throw new CliError('Use --data or an environment matrix, not both', EXIT.CONFIG_ERROR);
        for (const e of matrix) requireEnvironment(store, e);
        for (const e of matrix) for (const f of (await prefetchEnvironmentSecrets(store, e, { trustAll: true })).failed) console.error(yellow(`${f.ref}: ${f.error}`));
        if (!o.json && !o.quiet) console.log(bold(`TestPion — tests/${rel} in ${matrix.length} environments`));
        const m = await runFlowMatrix({
          file: abs,
          environments: matrix,
          contextFor: (environment) => cliContext(store, environment, { runtimeVars: o.var }),
          stepConcurrency: o.concurrency ? Number(o.concurrency) : undefined,
          retries: o.retries ? Number(o.retries) : undefined,
          timeoutMs: o.timeout ? Number(o.timeout) : undefined,
          signal: ctrl.signal,
          onColumn: (c) =>
            !o.json &&
            !o.quiet &&
            console.log(
              `  ${c.status === 'passed' ? green('✓') : c.status === 'skipped' ? yellow('○') : red('✗')} ${c.environment} ${dim(formatMs(c.durationMs))}${c.failedStep ? red(`  failed at ${c.failedStep}${c.error ? `: ${c.error}` : ''}`) : ''}`,
            ),
        });
        const id = scaleRunId('matrix');
        const { status } = ephemeral ? scaleRunRow({ id, kind: 'matrix', ...m, file: rel }) : saveScaleRun(store, { id, kind: 'matrix', ...m, file: rel });
        if (o.json) printJson({ id, status, ...m, file: rel, columns: m.columns.map(({ results: _r, ...c }) => c) });
        else if (!o.quiet) printMatrix(m, status);
        if (ctrl.signal.aborted) return EXIT.EXECUTION_ERROR;
        if (status === 'skipped') {
          if (!o.quiet) console.error(yellow(NOTHING_RAN));
          return o.allowSkipped ? EXIT.SUCCESS : EXIT.TEST_FAILURE;
        }
        return m.failed ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
      }

      // a data-driven run: --data <file|db>, or the file's own data:
      const spec = typeof o.data === 'string' ? o.data : readFlowDataHeader(abs);
      if (spec === undefined) throw new CliError(`tests/${rel} has no data: give --data <file> (CSV, JSON, JSONL, SQLite, postgres://…, env:NAME) or add data: to the file`, EXIT.CONFIG_ERROR);
      const environment = typeof o.environment === 'string' ? o.environment : undefined;
      if (environment) requireEnvironment(store, environment);
      const src = flowDataSource(spec, {
        file: typeof o.data === 'string' ? undefined : abs,
        roots: [process.cwd(), store.root, store.path('tests')],
        query: o.dataQuery,
        limit: o.dataLimit ? Number(o.dataLimit) : undefined,
      });
      const ctx = cliContext(store, environment, { runtimeVars: o.var });
      const id = scaleRunId('data');
      // every row goes to disk as it finishes (the workspace's runs/scale/<id>/), never into a list in memory
      const writer = ephemeral ? undefined : new ScaleRowsWriter(store, id);
      // --json: the rows are streamed as they finish ({ "rows": [ … ], "summary": { … } }), so 100,000 rows need no memory
      let first = true;
      // --json: the envelope's data streamed as rows finish; --jsonl: a line per row
      const out = cli.json ? streamData() : undefined;
      out?.('{"rows":[');
      const show = !machine() && !o.quiet;
      if (show) console.log(bold(`TestPion — tests/${rel}, a run per row`) + dim(environment ? ` · environment: ${environment}` : ''));
      let r;
      try {
        r = await runFlowData({
          file: abs,
          data: src,
          services: ctx.services,
          concurrency: o.dataConcurrency ? Number(o.dataConcurrency) : 1,
          stepConcurrency: o.concurrency ? Number(o.concurrency) : undefined,
          retries: o.retries ? Number(o.retries) : undefined,
          timeoutMs: o.timeout ? Number(o.timeout) : undefined,
          bail: o.bail,
          signal: ctrl.signal,
          environment,
          onRow: (row, kept) => {
            writer?.write(row, kept);
            if (cli.jsonl) emitEvent('row', row);
            else if (out) {
              out(`${first ? '\n' : ',\n'}${JSON.stringify(row)}`);
              first = false;
            } else if (show) printRow(row);
          },
        });
      } catch (e) {
        // the JSON stays one document: the error closes it (and the exit code says what kind it was)
        if (out) {
          const err = normalizeError(e);
          out(`\n],"error":${JSON.stringify({ kind: err.kind, message: err.message, suggestions: err.suggestions })}}\n`);
        }
        throw e;
      } finally {
        writer?.close();
        await ctx.dispose();
      }
      const record = { id, kind: 'data' as const, ...r, file: rel, ...(environment ? { environment } : {}) };
      const { status } = ephemeral ? scaleRunRow(record) : saveScaleRun(store, record);
      const summary = { id: ephemeral ? undefined : id, status, ...r, file: rel };
      if (out) out(`\n],"summary":${JSON.stringify(summary)}}`);
      else if (cli.jsonl) printJson({ summary });
      else if (!o.quiet) {
        const head = status === 'passed' ? green(bold('PASSED')) : status === 'skipped' ? yellow(bold('SKIPPED')) : red(bold('FAILED'));
        console.log(
          `\n${head}  ${r.passed} of ${r.total} rows passed${r.failed ? `, ${r.failed} failed` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}${r.cancelled ? `, ${r.cancelled} cancelled` : ''} · ${formatMs(r.durationMs)}`,
        );
        if (r.bailed) console.log(yellow('Stopped at the first failing row (--bail).'));
        if (r.truncated) console.log(yellow(`Only the first ${r.total} rows ran (--data-limit, or the most a run reads).`));
        if (r.dataError) console.log(yellow(`The data could not be read to the end: ${r.dataError}`));
        if (!ephemeral) console.log(dim(`data run: ${id}`));
      }
      if (ctrl.signal.aborted) return EXIT.EXECUTION_ERROR;
      if (!r.total) {
        console.error(yellow('The data has no rows.'));
        noteError(new CliError('The data has no rows', EXIT.CONFIG_ERROR));
        return EXIT.CONFIG_ERROR;
      }
      if (status === 'skipped') {
        if (!o.quiet) console.error(yellow(NOTHING_RAN));
        return o.allowSkipped ? EXIT.SUCCESS : EXIT.TEST_FAILURE;
      }
      return r.failed ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
    } finally {
      process.off('SIGINT', onSigint);
    }
  } finally {
    store.close();
    if (ephemeral) removeScratchDir(ephemeral);
  }
}

function printRow(row: DataRowResult): void {
  const icon = row.status === 'passed' ? green('✓') : row.status === 'cancelled' || row.status === 'skipped' ? yellow('○') : red('✗');
  const values = Object.entries(row.values)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${short(v)}`)
    .join(' ');
  console.log(`  ${icon} row ${row.index}  ${dim(values)}  ${dim(formatMs(row.durationMs))}`);
  if (row.failedStep) console.log(red(`      failed at ${row.failedStepName ?? row.failedStep}${row.error ? `: ${row.error}` : ''}`));
}

function printMatrix(m: FlowMatrixResult, status: string): void {
  const w = Math.min(32, Math.max(4, ...m.steps.map((s) => s.name.length)));
  const col = Math.max(12, ...m.environments.map((e) => e.length + 2));
  console.log(`\n${bold('step'.padEnd(w))}  ${m.environments.map((e) => bold(e.padEnd(col))).join('')}`);
  for (const s of m.steps) {
    const cells = m.columns.map((c) => {
      const x = c.cells[s.id];
      const text = x ? `${x.status} ${x.status === 'skipped' ? '' : formatMs(x.ms)}`.trim() : 'not run';
      const padded = text.padEnd(col);
      return x?.status === 'passed' ? green(padded) : x?.status === 'skipped' || !x ? yellow(padded) : red(padded);
    });
    console.log(`${s.name.slice(0, w).padEnd(w)}  ${cells.join('')}${m.differingSteps.includes(s.id) ? yellow('  ≠') : ''}`);
  }
  if (m.outputs.length) {
    console.log(bold('\nOutputs'));
    for (const out of m.outputs) console.log(`  ${out.differs ? yellow('≠') : dim('=')} ${out.key}: ${m.environments.map((e, i) => `${e}=${short(out.values[i])}`).join('  ')}`);
  }
  const head = status === 'passed' ? green(bold('PASSED')) : status === 'skipped' ? yellow(bold('SKIPPED')) : red(bold('FAILED'));
  console.log(`\n${head}  ${m.passed} of ${m.environments.length} environments passed${m.skipped ? `, ${m.skipped} skipped` : ''} · ${formatMs(m.durationMs)}`);
}

/** `testpion flow report <file> [--run id] [--html out.html | --json]`. */
export function registerFlowReportCommand(program: Command): void {
  const flow = subcommand(program, 'flow');
  if (!flow) return;
  flow
    .command('report')
    .description(
      "a run of a flow as a timeline: each step's start and end, waits, steps that ran at the same time, the critical path (the chain of steps that decided the total time) and the slowest steps; --html writes it as one self-contained HTML file to share",
    )
    .argument('<file>', 'a test file (inside tests/, e.g. rest/patient-lifecycle.yaml)')
    .option('--run <runId>', 'the run (default: the latest run that included the file; see testpion flow runs)')
    .option('--html <out>', 'write the timeline as a self-contained HTML file (no network needed to view it)')
    .option('--json', 'print the timeline as JSON (bars, lanes, criticalPath, slowest; for scripts and AI agents)')
    .option(...WORKSPACE_OPTION)
    .action(async (file: string, o: { run?: string; html?: string; json?: boolean; workspace?: string }) => {
      const parent = flow.opts() as { workspace?: string; json?: boolean };
      return withWorkspace(o.workspace ?? parent.workspace, async (store) => {
        const ref = testFileRef(store, file);
        if (o.html) {
          const h = await flowRunTimelineHtml(store, ref, o.run);
          writeFileSync(resolve(o.html), h.html);
          if (!(o.json || parent.json)) console.log(green(`Timeline of run ${h.runId} written to ${resolve(o.html)}`));
        }
        const t = await flowRunTimeline(store, ref, o.run);
        if (o.json || parent.json) return printJson({ ...t, ...(o.html ? { html: resolve(o.html) } : {}) });
        if (o.html) return;
        const tl = t.timeline;
        console.log(bold(`tests/${t.file}`) + dim(`  run ${t.runId}${t.run ? ` (${t.run.status}, ${new Date(t.run.startedAt).toLocaleString()})` : ''}`));
        console.log(`total ${bold(formatMs(tl.totalMs))} · ${tl.bars.length} steps · at most ${tl.lanes} at once`);
        const scale = 40 / Math.max(1, tl.totalMs);
        const w = Math.min(28, Math.max(4, ...tl.bars.map((b) => b.name.length)));
        for (const b of tl.bars) {
          const pad = ' '.repeat(Math.round(b.start * scale));
          const bar = '█'.repeat(Math.max(1, Math.round(b.durationMs * scale)));
          const colored = b.status === 'passed' ? green(bar) : b.status === 'skipped' ? dim(bar) : red(bar);
          console.log(`  ${b.critical ? bold(b.name.slice(0, w).padEnd(w)) : b.name.slice(0, w).padEnd(w)}  ${pad}${colored} ${dim(formatMs(b.durationMs))}${b.critical ? yellow(' *') : ''}`);
        }
        console.log(
          `\n${bold('Critical path')} ${dim('(*)')}: ${tl.criticalPath.join(' → ')} ${dim(`· ${formatMs(tl.criticalBusyMs)} running${tl.waitMs ? `, ${formatMs(tl.waitMs)} waiting` : ''}`)}`,
        );
        if (tl.slowest.length) console.log(`${bold('Slowest')}: ${tl.slowest.map((s) => `${s.name} ${formatMs(s.durationMs)}`).join(', ')}`);
      });
    });
}
