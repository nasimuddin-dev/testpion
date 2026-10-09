/** `testpion flow <file>`: a test file as a flow, in columns (what runs first, what waits), as JSON or as Graphviz DOT. */
import { Command } from 'commander';
import { flowOfFile, flowReport, testFileRef } from '@testpion/core';
import { flowGraph, toDot } from '@testpion/shared';
import { bold, dim, green, printJson, red, withWorkspace, yellow } from '../shared.js';

export function registerFlowCommand(program: Command): void {
  program
    .command('flow')
    .description("a test file as a flow: its steps in columns (what runs first, what waits on dependsOn), what each extracts, and the latest run's result per step")
    .argument('<file>', 'a test file (inside tests/, e.g. rest/patient-lifecycle.yaml, or from the current folder)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the steps, edges, layers, problems and the latest run as JSON (for scripts and AI agents)')
    .option('--dot', 'print the flow as Graphviz DOT (pipe into `dot -Tsvg`)')
    .action(async (file: string, o: { workspace?: string; json?: boolean; dot?: boolean }) => {
      return withWorkspace(o.workspace, async (store) => {
        const flow = await flowOfFile(store, testFileRef(store, file));
        if (o.dot) {
          process.stdout.write(toDot(flow.steps, flow.file));
          return;
        }
        if (o.json) return printJson(flowReport(flow));
        if (!flow.steps.length) return console.log(dim(`tests/${flow.file}: no steps (a suite names other files; see them with testpion flow <file> on each).`));
        const g = flowGraph(flow.steps);
        const layers: string[][] = [];
        for (const n of g.nodes) (layers[n.layer] ??= []).push(n.id);
        console.log(bold(`tests/${flow.file}`) + (flow.run ? dim(`  latest run ${flow.run.runId} (${flow.run.name}, ${new Date(flow.run.startedAt).toLocaleString()})`) : dim('  not run yet')));
        const byId = new Map(flow.steps.map((s) => [s.id, s]));
        layers.forEach((ids, i) => {
          console.log(`\n${dim(`column ${i + 1}`)}${i === 0 ? dim(' — runs first') : ''}`);
          for (const id of ids) {
            const s = byId.get(id)!;
            const status = s.status === 'passed' ? green('passed') : s.status === 'failed' || s.status === 'error' ? red(s.status) : s.status === 'skipped' ? yellow('skipped') : '';
            const detail = [
              s.method && s.url ? `${s.method} ${s.url}` : s.type,
              s.extract?.length ? `extracts ${s.extract.join(', ')}` : '',
              s.dependsOn?.length ? `after ${s.dependsOn.join(', ')}` : '',
            ]
              .filter(Boolean)
              .join('  ·  ');
            console.log(`  ${s.name}  ${dim(`[${s.id}]`)}${status ? `  ${status}${s.durationMs !== undefined ? dim(` ${s.durationMs} ms`) : ''}` : ''}`);
            if (detail) console.log(`    ${dim(detail)}`);
          }
        });
        for (const p of g.problems) console.log(`\n${yellow('problem')}  ${p.message}`);
        console.log(dim(`\n${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'}, ${g.edges.length} edge${g.edges.length === 1 ? '' : 's'}; --dot for Graphviz, --json for everything.`));
      });
    });
}
