/** `testpion flow <file>`: a test file as a flow, in columns (what runs first, what waits), as JSON or as Graphviz DOT. */
import { Command } from 'commander';
import { ApsError, applyFlowEdit, editFlowFile, flowOfFile, flowReport, flowStepsOfText, testFileRef, type FlowEditOp, type FlowFileEdit } from '@testpion/core';
import { flowGraph, toDot } from '@testpion/shared';
import { bold, dim, green, printJson, red, withWorkspace, yellow } from '../shared.js';

export function registerFlowCommand(program: Command): void {
  const flow = program.command('flow');
  flow
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

  // testpion flow edit <file> --op '{"op":"connect","from":"login","to":"me"}': the flow designer's edits, for scripts and agents
  flow
    .command('edit')
    .description(
      'edit a flow the way the app\'s flow designer does (comments, key order and line endings kept): --op \'{"op":"addStep","step":{"name":"Health","type":"http","url":"{{baseUrl}}/health"},"after":"login"}\'; ops: addStep, addSteps, updateStep, removeStep, renameStep, connect, disconnect, setLayout, duplicateStep, addFromCollection, pasteSteps',
    )
    .argument('<file>', 'a test file (inside tests/, or from the current folder); an empty flow is "name: X\\ntests: []"')
    .option('--op <json>', 'the edit as JSON, or several as a JSON list (applied in order)')
    .option('--connect <from>', 'shorthand: make --to wait for this step')
    .option('--disconnect <from>', 'shorthand: --to no longer waits for this step')
    .option('--to <step>', 'the step that waits (with --connect / --disconnect)')
    .option('--remove <step>', 'shorthand: remove this step (and every dependsOn that names it)')
    .option('--dry-run', 'print the new text (or, with --json, the result) without writing the file')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print { file, written, added, steps, edges, problems } as JSON (for scripts and AI agents)')
    .action(async (file: string, o: { op?: string; connect?: string; disconnect?: string; to?: string; remove?: string; dryRun?: boolean; workspace?: string; json?: boolean }) => {
      // the parent command reads -w and --json wherever they are written: take them from it too
      const parent = flow.opts() as { workspace?: string; json?: boolean };
      o.json ||= parent.json;
      return withWorkspace(o.workspace ?? parent.workspace, async (store) => {
        const ops: FlowEditOp[] = [];
        if (o.op) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(o.op);
          } catch (e) {
            throw new ApsError('ValidationError', `--op is not JSON: ${(e as Error).message}`);
          }
          ops.push(...((Array.isArray(parsed) ? parsed : [parsed]) as FlowEditOp[]));
        }
        if (o.connect || o.disconnect) {
          if (!o.to) throw new ApsError('ValidationError', `--${o.connect ? 'connect' : 'disconnect'} needs --to <step>`);
          ops.push(o.connect ? { op: 'connect', from: o.connect, to: o.to } : { op: 'disconnect', from: o.disconnect!, to: o.to });
        }
        if (o.remove) ops.push({ op: 'removeStep', id: o.remove });
        if (!ops.length) throw new ApsError('ValidationError', 'Nothing to do: give --op \'<json>\', --connect/--disconnect <from> --to <step>, or --remove <step>');
        const ref = testFileRef(store, file);
        let r: FlowFileEdit | undefined;
        const added: string[] = [];
        if (o.dryRun) {
          // every op on the text in memory; nothing is written
          let text = store.readTestFile(ref);
          for (const op of ops) {
            const x = applyFlowEdit(text, op, { file: ref });
            text = x.text;
            added.push(...(x.added ?? []));
          }
          if (!o.json) return void process.stdout.write(text);
          const steps = flowStepsOfText(text, ref);
          const g = flowGraph(steps);
          return printJson({ file: ref, written: false, added, steps, edges: g.edges, problems: g.problems, text });
        }
        for (const op of ops) {
          r = editFlowFile(store, ref, op);
          added.push(...(r.added ?? []));
        }
        const g = flowGraph(r!.steps);
        if (o.json) return printJson({ file: r!.file, written: true, added, steps: r!.steps, edges: g.edges, problems: g.problems });
        console.log(`${green('saved')} tests/${r!.file}${added.length ? dim(`  added ${added.join(', ')}`) : ''}`);
        console.log(dim(`${r!.steps.length} step${r!.steps.length === 1 ? '' : 's'}, ${g.edges.length} edge${g.edges.length === 1 ? '' : 's'}; testpion flow ${ref} shows them in columns.`));
        for (const p of g.problems) console.log(`${yellow('problem')}  ${p.message}`);
      });
    });
}
