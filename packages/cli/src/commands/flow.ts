/** `testpion flow <file>`: a test file as a flow, in columns (what runs first, what waits), as JSON or as Graphviz DOT. */
import { Command } from 'commander';
import { ApsError, applyFlowEdit, editFlowFile, flowOfFile, flowReport, flowRunResults, flowRuns, flowStepsOfText, testFileRef, type FlowEditOp, type FlowFileEdit } from '@testpion/core';
import { flowChecks, flowGraph, stepDetail, toDot, untilLabel } from '@testpion/shared';
import { bold, cliContext, dim, green, printJson, red, withWorkspace, yellow, WORKSPACE_OPTION, groupOptions } from '../shared.js';

export function registerFlowCommand(program: Command): void {
  const flow = program.command('flow');
  flow
    .description("a test file as a flow: its steps in columns (what runs first, what waits on dependsOn), what each extracts, and the latest run's result per step")
    .argument('<file>', 'a test file (inside tests/, e.g. rest/patient-lifecycle.yaml, or from the current folder)')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print the steps, edges, layers, problems and the latest run as JSON (for scripts and AI agents)')
    .option('--dot', 'print the flow as Graphviz DOT (pipe into `dot -Tsvg`)')
    .option('-e, --environment <name>', "check the steps' {{variables}} against this environment: a variable nothing sets and the environment does not define is reported")
    .action(async (file: string, o: { workspace?: string; json?: boolean; dot?: boolean; environment?: string }) => {
      return withWorkspace(o.workspace, async (store) => {
        let known: string[] | undefined;
        if (o.environment) {
          const ctx = cliContext(store, o.environment);
          try {
            known = ctx.vars.names();
          } finally {
            await ctx.dispose();
          }
        }
        const flow = await flowOfFile(store, testFileRef(store, file), { known });
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
              stepDetail(s),
              s.type !== 'condition' && s.if ? `if ${s.if}` : '',
              s.when !== undefined ? `on the ${s.when} branch` : '',
              s.loop ?? '',
              untilLabel(s) ?? '',
              s.parallel ? `parallel group ${s.parallel}` : '',
              s.finally ? 'finally: runs last, whatever happened' : '',
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
        // the designer's checks (what the problems above do not say already)
        const said = new Set(g.problems.map((p) => p.step));
        for (const c of flowChecks(flow.steps)) if (!(c.kind === 'cycle' && said.has(c.step)) && c.kind !== 'missing-step') console.log(`${c.severity === 'error' ? red('error') : yellow('check')}  ${c.message}`);
        if (flow.notes?.length || flow.frames?.length) console.log(dim(`${flow.notes?.length ?? 0} note(s), ${flow.frames?.length ?? 0} frame(s) on the canvas`));
        console.log(dim(`\n${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'}, ${g.edges.length} edge${g.edges.length === 1 ? '' : 's'}; --dot for Graphviz, --json for everything.`));
      });
    });

  // testpion flow runs <file>: the flow's run history (the designer's History panel), or one run's steps with --run
  flow
    .command('runs')
    .description("a flow's run history, newest first (status, when, how long, the first failing step); --run <id> shows that run's steps with the variables after each. Re-run part of it: testpion test <file> --from <step> [--seed-run <id>]")
    .argument('<file>', 'a test file (inside tests/, or from the current folder)')
    .option('--run <runId>', "one run's steps in file order: status, timing, input, output and variables")
    .option('-n, --limit <n>', 'how many runs (default 30)')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print the runs (or the run) as JSON (for scripts and AI agents)')
    .action(async (file: string, o: { run?: string; limit?: string; workspace?: string; json?: boolean }) => {
      const workspace = groupOptions(flow, o);
      return withWorkspace(workspace, async (store) => {
        const ref = testFileRef(store, file);
        if (o.run) {
          const r = await flowRunResults(store, ref, o.run);
          if (o.json) return printJson(r);
          if (!r.results.length) return console.log(dim(`Run ${o.run} did not include tests/${r.file}.`));
          console.log(bold(`tests/${r.file}`) + dim(`  run ${o.run}`));
          for (const x of r.results) {
            const status = x.status === 'passed' ? green('passed') : x.status === 'skipped' ? yellow('skipped') : red(x.status);
            console.log(`  ${x.name}  ${dim(`[${x.id}]`)}  ${status}${dim(` ${x.durationMs} ms`)}${x.metadata?.pinned ? yellow('  pinned') : ''}`);
            if (x.input) console.log(dim(`    ${x.input.split('\n')[0]!.slice(0, 160)}`));
            for (const [k, v] of Object.entries(x.variables ?? {})) console.log(dim(`    {{${k}}} = ${(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 120)}`));
          }
          return;
        }
        const h = await flowRuns(store, ref, { limit: o.limit ? Number(o.limit) : undefined });
        if (o.json) return printJson(h);
        if (!h.runs.length) return console.log(dim(`tests/${h.file} has not been run yet.`));
        console.log(bold(`tests/${h.file}`) + dim(`  ${h.runs.length} run${h.runs.length === 1 ? '' : 's'}, newest first`));
        for (const r of h.runs) {
          const status = r.status === 'passed' ? green('passed') : r.status === 'cancelled' || r.status === 'skipped' ? yellow(r.status) : red('failed');
          console.log(
            `  ${r.runId}  ${status}  ${dim(new Date(r.startedAt).toLocaleString())}  ${dim(`${r.durationMs} ms`)}  ${r.passed}/${r.steps} passed${r.firstFailed ? red(`  first failing step: ${r.firstFailed}`) : ''}`,
          );
        }
        const failed = h.runs.find((r) => r.status === 'failed');
        console.log(dim(`\ntestpion flow runs ${ref} --run <id> shows a run's steps${failed ? `; testpion test ${ref} --seed-run ${failed.runId} replays it on its own data` : ''}.`));
      });
    });

  // testpion flow edit <file> --op '{"op":"connect","from":"login","to":"me"}': the flow designer's edits, for scripts and agents
  flow
    .command('edit')
    .description(
      'edit a flow the way the app\'s flow designer does (comments, key order and line endings kept): --op \'{"op":"addStep","step":{"name":"Health","type":"http","url":"{{baseUrl}}/health"},"after":"login"}\'; ops: addStep, addSteps, updateStep, removeStep, renameStep, connect (with "when": true|false from a condition), disconnect, setLayout, duplicateStep, setOutput, setWebhook ({"op":"setWebhook","webhook":{"path":"/hooks/order","secret":"{{HOOK_SECRET}}"}}), group, addFromCollection, pasteSteps; the canvas: addNote ({"op":"addNote","note":{"x":0,"y":300,"text":"**Why** this flow"}}), updateNote, removeNote, addFrame ({"op":"addFrame","title":"Login","color":"blue","steps":["login","me"]}), updateFrame, removeFrame. Blocks: type condition (if:), script (script:), flow (file:, inputs:), log (message:), set (set:, scope:), assert (assertions:, subject:), wait (a request with until:); any step: if, when, repeat, forEach, until, finally, parallel',
    )
    .argument('<file>', 'a test file (inside tests/, or from the current folder); an empty flow is "name: X\\ntests: []"')
    .option('--op <json>', 'the edit as JSON, or several as a JSON list (applied in order)')
    .option('--connect <from>', 'shorthand: make --to wait for this step')
    .option('--disconnect <from>', 'shorthand: --to no longer waits for this step')
    .option('--to <step>', 'the step that waits (with --connect / --disconnect)')
    .option('--when <branch>', 'with --connect from a condition step: the branch the step runs on (true or false)')
    .option('--output <json>', 'shorthand: set what the flow returns, e.g. \'{"token":"{{token}}"}\' (null removes it)')
    .option('--remove <step>', 'shorthand: remove this step (and every dependsOn that names it)')
    .option('--webhook [path]', 'shorthand: serve the flow behind a webhook (testpion serve flows) on this path (default /hooks/<file>)')
    .option('--no-webhook', 'shorthand: remove the webhook of the flow')
    .option('--webhook-secret <secret>', 'with --webhook: the secret callers send (best a {{VARIABLE}} kept as a secret); "" removes it')
    .option('--parallel <group>', 'shorthand: put the --steps in this parallel group (they may run at the same time); "" takes them out')
    .option('--finally <steps>', 'shorthand: make these steps (comma separated) finally steps: they run after every other step, whatever happened')
    .option('--steps <ids>', 'with --parallel: the steps, comma separated')
    .option('--dry-run', 'print the new text (or, with --json, the result) without writing the file')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print { file, written, added, steps, edges, problems } as JSON (for scripts and AI agents)')
    .action(async (file: string, o: { op?: string; connect?: string; disconnect?: string; to?: string; when?: string; output?: string; remove?: string; webhook?: string | boolean; webhookSecret?: string; parallel?: string; finally?: string; steps?: string; dryRun?: boolean; workspace?: string; json?: boolean }) => {
      const workspace = groupOptions(flow, o);
      return withWorkspace(workspace, async (store) => {
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
          if (o.when !== undefined && !['true', 'false'].includes(o.when)) throw new ApsError('ValidationError', `--when is true or false, not "${o.when}"`);
          ops.push(o.connect ? { op: 'connect', from: o.connect, to: o.to, ...(o.when !== undefined ? { when: o.when === 'true' } : {}) } : { op: 'disconnect', from: o.disconnect!, to: o.to });
        }
        if (o.output !== undefined) {
          let output: unknown;
          try {
            output = JSON.parse(o.output);
          } catch (e) {
            throw new ApsError('ValidationError', `--output is not JSON: ${(e as Error).message}`);
          }
          ops.push({ op: 'setOutput', output: output as Record<string, unknown> | null });
        }
        if (o.remove) ops.push({ op: 'removeStep', id: o.remove });
        if (o.webhook === false) ops.push({ op: 'setWebhook', webhook: null });
        else if (o.webhook !== undefined || o.webhookSecret !== undefined)
          ops.push({ op: 'setWebhook', webhook: { ...(typeof o.webhook === 'string' ? { path: o.webhook } : {}), ...(o.webhookSecret !== undefined ? { secret: o.webhookSecret || null } : {}) } });
        const list = (v?: string) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
        if (o.parallel !== undefined) {
          if (!list(o.steps).length) throw new ApsError('ValidationError', '--parallel <group> needs --steps a,b: the steps to put in the group');
          ops.push({ op: 'group', ids: list(o.steps), parallel: o.parallel.trim() || null });
        }
        if (o.finally !== undefined) ops.push({ op: 'group', ids: list(o.finally), finally: true });
        if (!ops.length)
          throw new ApsError('ValidationError', "Nothing to do: give --op '<json>', --connect/--disconnect <from> --to <step> [--when true|false], --output '<json>', --remove <step>, --webhook [path] / --no-webhook, --parallel <group> --steps a,b, or --finally <steps>");
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
          return printJson({ file: ref, written: false, added, steps, edges: g.edges, groups: g.groups.map(({ kind, name, ids }) => ({ kind, name, ids })), problems: g.problems, text });
        }
        for (const op of ops) {
          r = editFlowFile(store, ref, op);
          added.push(...(r.added ?? []));
        }
        const g = flowGraph(r!.steps);
        if (o.json) return printJson({ file: r!.file, written: true, added, steps: r!.steps, edges: g.edges, groups: g.groups.map(({ kind, name, ids }) => ({ kind, name, ids })), problems: g.problems });
        console.log(`${green('saved')} tests/${r!.file}${added.length ? dim(`  added ${added.join(', ')}`) : ''}`);
        console.log(dim(`${r!.steps.length} step${r!.steps.length === 1 ? '' : 's'}, ${g.edges.length} edge${g.edges.length === 1 ? '' : 's'}; testpion flow ${ref} shows them in columns.`));
        for (const p of g.problems) console.log(`${yellow('problem')}  ${p.message}`);
      });
    });
}
