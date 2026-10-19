import { Command } from 'commander';
import { OUTPUT_PARAMS, listOutputSurfaces, type OutputParams } from '@testpion/core';
import { CliError, EXIT, dim, green, printJson, withWorkspace } from '../shared.js';
import { machine } from '../output.js';
import { saveSurface, savedLine } from '../output-save.js';

/**
 * `testpion output <surface> --format <f> --out <file>`: any output of the app (the down arrow in the window) written
 * from a workspace, byte for byte what the app saves; `--list` shows them. The window and MCP's `save_output` use the
 * same builders (packages/core/src/output).
 */
export function registerOutputCommand(program: Command): void {
  program
    .command('output')
    .description(
      'save an output of the app to a file, as the down arrow in the window does: run results, History, traces, a flow timeline, a data run or evaluation matrix, monitor runs, the runs list, the workspace changes or a saved response body (`output --list` shows them with their formats)',
    )
    .argument('[surface]', 'the output, e.g. run.results, history, traces (see --list)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-e, --environment <name>', "mask this environment's secret values as well")
    .option('--list', 'list the outputs this command can save, with their formats and parameters')
    .option('--format <format>', 'the format (default: from the --out extension, else the output’s default)')
    .option('--out <file>', 'write the file here (default: print it; --json needs --out)')
    .option('--include-secrets', 'keep the secrets that are masked by default (not for outputs masked when recorded)')
    .option('--run <runId>', 'run.results, flow.timeline: the run')
    .option('--file <flowFile>', 'flow.timeline: a flow file in the workspace (its latest run)')
    .option('--data-run <id>', 'flow.grid: the data run or matrix')
    .option('--status <status>', 'flow.grid: all | failed | passed | cancelled | skipped rows')
    .option('--runs <runIds...>', 'eval.matrix: the evaluation runs (columns)')
    .option('--baseline <runId>', 'eval.matrix: the run to compare against')
    .option('-q, --query <text>', 'history, traces, runs.overview: only entries matching this text')
    .option('--kind <kind>', 'history, traces: only this kind')
    .option('--failed', 'history, traces: only failed ones')
    .option('-n, --limit <n>', 'history, traces, monitor.runs, runs.overview: how many, newest first')
    .option('--traces <ids...>', 'traces: these trace ids')
    .option('--monitor <nameOrId>', 'monitor.runs: the monitor')
    .option('--path <file>', 'git.diff: one file (default: every uncommitted change)')
    .option('--staged', 'git.diff: the staged changes only')
    .option('--days <n>', 'workspace.report: days of activity (1 to 90)')
    .option('--history-id <id>', 'response.body: a History entry whose saved response body is written')
    .option('--json', 'print the result as JSON')
    .action(async (surface: string | undefined, o: Record<string, unknown>) => {
      if (o.list || !surface) {
        const list = listOutputSurfaces();
        if (o.json) printJson(list);
        else
          for (const s of list)
            console.log(
              `${green(String(s.surface).padEnd(18))} ${String(s.label).padEnd(34)} ${(s.formats as string[]).join(', ')}\n${' '.repeat(19)}${dim(
                `default ${String(s.default)}${s.includeSecrets ? ', --include-secrets' : ''}; ${String(s.hint)}: ${(s.params as Array<{ option: string; required: boolean }>).map((p) => (p.required ? p.option : `[${p.option}]`)).join(' ')}`,
              )}`,
            );
        if (!o.list && !surface) process.exitCode = EXIT.CONFIG_ERROR;
        return;
      }
      if (!OUTPUT_PARAMS[surface]) throw new CliError(`${surface} cannot be saved with this command. \`testpion output --list\` shows the ones that can.`, EXIT.CONFIG_ERROR);
      if (machine() && !o.out) throw new CliError('--json needs --out <file>: the file is the output, stdout is the JSON result', EXIT.CONFIG_ERROR);
      const params: OutputParams = {
        run: o.run as string | undefined,
        file: o.file as string | undefined,
        dataRun: o.dataRun as string | undefined,
        status: o.status as string | undefined,
        runs: o.runs as string[] | undefined,
        baseline: o.baseline as string | undefined,
        query: o.query as string | undefined,
        kind: o.kind as string | undefined,
        failed: o.failed === true ? true : undefined,
        limit: o.limit === undefined ? undefined : Number(o.limit),
        traces: o.traces as string[] | undefined,
        monitor: o.monitor as string | undefined,
        path: o.path as string | undefined,
        staged: o.staged === true ? true : undefined,
        days: o.days === undefined ? undefined : Number(o.days),
        historyId: o.historyId as string | undefined,
      };
      await withWorkspace(o.workspace as string | undefined, async (store) => {
        const saved = await saveSurface({
          store,
          surface,
          format: o.format as string | undefined,
          params,
          out: o.out as string | undefined,
          includeSecrets: o.includeSecrets === true,
          environment: o.environment as string | undefined,
        });
        if (o.json) printJson(saved);
        else if (saved.path) console.log(savedLine(saved));
      });
    });
}
