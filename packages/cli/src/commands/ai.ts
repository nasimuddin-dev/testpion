import type { Command } from 'commander';
import { formatUsd, plural } from '@testpion/shared';
import { readFileSync } from 'node:fs';
import {
  aiRunDeps,
  aiUsageSummary,
  applyProposal,
  discardProposal,
  getProposal,
  listAiTasks,
  listProposals,
  parseItemRef,
  runAiTask,
  undoProposal,
  WorkspaceManager,
  type AiTaskResult,
  type ItemRef,
  type Proposal,
} from '@testpion/core';
import { bold, cliContext, CliError, cyan, dim, EXIT, green, printJson, red, withWorkspace, yellow } from '../shared.js';
import { machine } from '../output.js';
import { dryRunActive } from '../dry-run.js';

/** The surface a CLI call is recorded under in the usage ledger: CI when the pipeline says so. */
const surface = () => (process.env.CI ? 'ci' : 'cli') as 'ci' | 'cli';

const ref = (text: string | undefined, what: string): ItemRef | undefined => {
  if (!text) return undefined;
  const r = parseItemRef(text);
  if (!r)
    throw Object.assign(new CliError(`${what}: "${text}" is not an item reference`, EXIT.CONFIG_ERROR), {
      hint: 'Write kind:id, e.g. request:<collectionId>:<requestId>, run:<runId>, test:smoke/login.yaml (testpion open --help lists the kinds).',
    });
  return r;
};

/** `--context '{"error":…}'` or `--context @file.json`. */
function contextOption(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return undefined;
  const raw = text.startsWith('@') ? readFileSync(text.slice(1), 'utf8') : text;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
    return v as Record<string, unknown>;
  } catch (e) {
    throw new CliError(`--context: ${(e as Error).message}`, EXIT.CONFIG_ERROR);
  }
}

const badge = (s: string) => (s === 'pass' ? green('✓') : s === 'fail' ? red('✗') : s === 'warn' ? yellow('!') : dim('–'));

/** A proposal for people: its items, each with its verification, and how to apply it. */
export function printProposal(p: Proposal, o: { applied?: boolean } = {}): void {
  console.log(bold(`\nProposal ${p.id}`) + dim(` · ${p.items.length} item${p.items.length === 1 ? '' : 's'} · ${p.provider}/${p.model} · ${p.taskVersion === 0 ? 'made without AI' : 'AI-generated'}, review before applying`));
  if (p.summary && p.task !== 'design-flow') console.log(`  ${p.summary.split('\n')[0]}`);
  for (const a of p.assumptions) console.log(dim(`  assumed: ${a}`));
  for (const n of p.notes ?? []) console.log(yellow(`  note: ${n}`));
  for (const i of p.items) {
    // the path once: an item titled by its file (a flow, a test file) does not repeat it
    const where = i.path && !i.title.includes(i.path) ? dim(`  tests/${i.path}`) : '';
    console.log(`  ${i.selected ? '[x]' : '[ ]'} ${i.id}  ${i.title}${where}`);
    for (const b of i.verification) console.log(`        ${badge(b.status)} ${b.label}${b.detail ? dim(` — ${b.detail.split('\n')[0]}`) : ''}`);
  }
  if (p.problems?.length) console.log(yellow(`  Still wrong after the repairs: ${p.problems.slice(0, 3).join('; ')}`));
  // applied already (--apply): how to undo it follows, not how to apply it
  if (o.applied) return;
  console.log(
    dim(
      `\nApply: testpion ai apply ${p.id}${p.items.some((i) => !i.selected) ? ` (the ticked items; --items ${p.items.map((i) => i.id).join(',')} to choose)` : ''} · discard: testpion ai discard ${p.id}`,
    ),
  );
}

export function printPreview(r: AiTaskResult): void {
  const p = r.preview;
  console.log(bold(`What will be sent — ${p.title}`));
  console.log(`  model     ${p.providerName} / ${p.model} (${p.tier} task, from ${p.modelSource})${p.local ? green(' · stays on this computer') : ''}`);
  console.log(`  privacy   ${p.privacy}`);
  console.log(
    `  estimate  ≈ ${p.estimate.inputTokens.toLocaleString('en-US')} tokens in, up to ${p.estimate.maxOutputTokens.toLocaleString('en-US')} out${p.estimate.priceKnown ? ` · up to ${formatUsd(p.estimate.maxCostUsd)}` : dim(' · no price for this model (Settings ▸ Model pricing)')}`,
  );
  for (const s of p.context.sections) console.log(dim(`  section   ${s.name}: ${s.tokens} tokens${s.notes.length ? ` (${s.notes.join('; ')})` : ''}`));
  if (p.redactionCount) console.log(dim(`  masked    ${p.redactionCount}: ${[...new Set(p.redactions.map((x) => x.kind))].join(', ')}`));
  for (const m of p.messages ?? []) console.log(`\n${cyan(`── ${m.role}`)}\n${m.content}`);
  console.log(dim('\nNothing was sent (--dry-run).'));
}

/** `testpion ai …`: the AI tasks from the terminal and CI — run (propose), apply, undo, usage. */
export function registerAiCommands(program: Command): void {
  const ai = program.command('ai').description('AI tasks with your own model (or a local one): explain, generate tests and flows as proposals you apply; usage and caps');

  ai.command('tasks')
    .description('list the AI tasks: what each does, its tier (small/large model), its output and whether it proposes changes')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action((o: { json?: boolean }) => {
      const tasks = listAiTasks();
      if (o.json || machine()) return printJson({ tasks });
      for (const t of tasks) console.log(`${bold(t.id.padEnd(24))} ${t.title}${t.proposes ? dim(' · proposes') : ''}${dim(` · ${t.tier}`)}\n${' '.repeat(25)}${dim(t.description)}`);
    });

  ai.command('run')
    .description('run an AI task: an answer, and for generating tasks a proposal (nothing is written until you apply it)')
    .argument('<task>', 'task id (testpion ai tasks lists them)')
    .option('--item <ref>', 'the workspace item it is about: request:<c>:<r>, history:<id>, run:<id>[:<resultId>] (run:last: the newest finished run), test:<path>, flow:<path>, spec:<path>, collection:<id>, folder:<c>:<f>')
    .option('-q, --question <text>', 'the question or what to generate')
    .option('--context <json|@file>', 'context as a JSON object (instead of, or on top of, --item)')
    .option('--privacy <level>', 'full (redacted, default) | metadata (shapes and names, no bodies) | names (names only)')
    .option('--provider <id>', 'provider id or name (default: TESTPION_AI_PROVIDER, then the app settings)')
    .option('--model <name>', 'model name (default: TESTPION_AI_MODEL[_SMALL|_LARGE], then the app settings)')
    .option('--hint <text>', 'an extra instruction (regenerate with a hint)')
    .option('--path <file>', 'where a generated test file goes, under tests/ (default tests/ai/<name>.yaml)')
    .option('--target <ref>', 'where a generated request goes: collection:<id> or folder:<c>:<f>')
    .option('--max-tokens <n>', 'most output tokens', (v) => Number(v))
    .option('--dry-run', 'send nothing: print what would be sent (messages, sections, tokens, cost, what was masked)')
    .option('--apply', 'apply the proposal right away (the ticked items; --items to choose)')
    .option('--items <ids>', 'with --apply: the items to apply, comma-separated (i1,i3)')
    .option('-e, --environment <name>', 'environment whose variable names (never values) the task may use')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action(
      (
        task: string,
        o: {
          item?: string;
          question?: string;
          context?: string;
          privacy?: string;
          provider?: string;
          model?: string;
          hint?: string;
          path?: string;
          target?: string;
          maxTokens?: number;
          dryRun?: boolean;
          apply?: boolean;
          items?: string;
          environment?: string;
          workspace?: string;
          json?: boolean;
        },
      ) =>
        withWorkspace(o.workspace, async (store) => {
          const settings = new WorkspaceManager().loadSettings();
          const ctx = cliContext(store, o.environment);
          const human = !o.json && !machine();
          let streamed = false;
          try {
            const r = await runAiTask(
              aiRunDeps({
                ctx,
                settings,
                store,
                surface: surface(),
                env: process.env,
                // prose streams to the terminal as it is written
                onDelta: human && !o.dryRun ? (d) => ((streamed = true), process.stdout.write(d)) : undefined,
              }),
              {
                task,
                question: o.question,
                context: contextOption(o.context),
                item: ref(o.item, '--item'),
                privacy: o.privacy,
                provider: o.provider,
                model: o.model,
                hint: o.hint,
                path: o.path,
                target: ref(o.target, '--target'),
                maxTokens: o.maxTokens,
                dryRun: o.dryRun,
              },
            );
            const applied =
              o.apply && r.proposal
                ? applyProposal(store, r.proposal.id, {
                    items: o.items
                      ?.split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                : undefined;
            // an answer still invalid after the repairs: a failed check (exit 1, envelope status "failed"), said in words too
            const invalid = !r.dryRun && r.problems.length > 0;
            if (invalid) process.exitCode = EXIT.TEST_FAILURE;
            if (!human) return printJson({ ...r, ...(applied ? { applied } : {}) });
            if (r.dryRun) return printPreview(r);
            if (!streamed) console.log(r.text);
            else console.log();
            // a proposal lists them itself (printProposal)
            if (invalid && !r.proposal?.problems?.length)
              console.log(red(`\nStill invalid after ${plural(r.repairs, 'repair')}:`) + r.problems.slice(0, 8).map((p) => `\n  ${red('✗')} ${p}`).join('') + dim('\n  Review the answer before using it; run it again (--hint) for another.'));
            if (r.truncated) console.log(yellow('\n(The answer was cut at the output limit: ask a narrower question, or pass --max-tokens.)'));
            console.log(
              dim(
                `\n${r.provider}/${r.model} · ${r.usage.inputTokens.toLocaleString('en-US')} in / ${r.usage.outputTokens.toLocaleString('en-US')} out${r.costUsd !== undefined ? ` · ${formatUsd(r.costUsd)}` : ''} · ${r.repairs ? `${plural(r.repairs, 'repair')} · ` : ''}AI-generated`,
              ),
            );
            if (r.proposal && !applied) printProposal(r.proposal);
            if (applied)
              console.log(
                green(`\nApplied ${applied.applied.length} item(s) of ${applied.id}`) +
                  (applied.skipped.length ? yellow(`; skipped: ${applied.skipped.map((s) => `${s.item} (${s.reason})`).join(', ')}`) : '') +
                  dim(` · undo: testpion ai undo ${applied.id}`),
              );
          } finally {
            await ctx.dispose();
          }
        }),
    );

  ai.command('apply')
    .description('apply an AI proposal: all its ticked items, or the ones you name (writes test files / collections)')
    .argument('<id>', 'proposal id (ai-…)')
    .option('--items <ids>', 'the items to apply, comma-separated (i1,i3)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action((id: string, o: { items?: string; workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const r = applyProposal(store, id, {
          items: o.items
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        });
        if (o.json || machine()) return printJson(r);
        // --dry-run (the CLI's sandbox): nothing was applied, so nothing to undo; the dry-run report lists the files
        if (dryRunActive()) {
          for (const a of r.applied) console.log(`would apply ${a.item}  ${a.title}`);
          for (const s of r.skipped) console.log(yellow(`would skip ${s.item}  ${s.reason}`));
          return;
        }
        for (const a of r.applied) console.log(green(`✓ ${a.item}  ${a.title}`));
        for (const s of r.skipped) console.log(yellow(`– ${s.item}  ${s.reason}`));
        console.log(dim(`undo: testpion ai undo ${id}`));
      }),
    );

  ai.command('undo')
    .description('put back what an applied AI proposal replaced')
    .argument('<id>', 'proposal id (ai-…)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action((id: string, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const r = undoProposal(store, id);
        if (o.json || machine()) return printJson(r);
        console.log(green(`Restored ${r.restored} change(s) of ${id}.`));
      }),
    );

  ai.command('discard')
    .description('discard an AI proposal (it can no longer be applied)')
    .argument('<id>', 'proposal id (ai-…)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action((id: string, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const p = discardProposal(store, id);
        if (o.json || machine()) return printJson({ id: p.id, status: p.status });
        console.log(`Discarded ${id}.`);
      }),
    );

  ai.command('proposals')
    .description('the AI proposals of this workspace (kept a day), or one of them with its items (--id)')
    .option('--id <id>', 'one proposal with its items, before/after text and verification')
    .option('--status <status>', 'open | applied | discarded')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action((o: { id?: string; status?: string; workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        if (o.id) {
          const p = getProposal(store, o.id);
          if (o.json || machine()) return printJson(p);
          return printProposal(p);
        }
        const list = listProposals(store, { status: o.status as Proposal['status'] | undefined });
        if (o.json || machine()) return printJson({ proposals: list });
        if (!list.length) return console.log(dim('No AI proposals (testpion ai run <task> makes one).'));
        for (const p of list) console.log(`${bold(p.id)}  ${p.status.padEnd(9)} ${p.title} ${dim(`· ${plural(p.items, 'item')} · ${p.model} · ${p.createdAt}`)}`);
      }),
    );

  ai.command('usage')
    .description('what the AI features used in this workspace: today, per task, model and surface (app, CLI, MCP, CI), and the caps')
    .option('--days <n>', 'the period (default 30)', (v) => Number(v))
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action((o: { days?: number; workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const s = aiUsageSummary(store, { days: o.days, settings: new WorkspaceManager().loadSettings().ai, recent: 20 });
        if (o.json || machine()) return printJson(s);
        const t = (x: { calls: number; inputTokens: number; outputTokens: number; costUsd: number }) =>
          `${plural(x.calls, 'call')} · ${plural(x.inputTokens + x.outputTokens, 'token')} · ${formatUsd(x.costUsd)}`;
        console.log(`${bold('Today')}        ${t(s.today)}`);
        console.log(`${bold(`${s.period.days} days`)}${' '.repeat(Math.max(1, 13 - `${s.period.days} days`.length))}${t(s.period)}`);
        if (s.caps.dailyTokens || s.caps.dailyBudgetUsd || s.caps.maxTokensPerCall)
          console.log(
            dim(
              `Caps: ${[s.caps.maxTokensPerCall && `${plural(s.caps.maxTokensPerCall, 'token')} per call`, s.caps.dailyTokens && `${plural(s.caps.dailyTokens, 'token')} per day (${(s.caps.tokensLeftToday ?? 0).toLocaleString('en-US')} left)`, s.caps.dailyBudgetUsd && `${formatUsd(s.caps.dailyBudgetUsd)} per day (${formatUsd(s.caps.budgetLeftToday)} left)`].filter(Boolean).join(' · ')}`,
            ),
          );
        if (s.byTask.length) console.log(bold('\nPer task'));
        for (const x of s.byTask) console.log(`  ${x.task.padEnd(26)} ${t(x)}`);
        if (s.byModel.length) console.log(bold('\nPer model'));
        for (const x of s.byModel) console.log(`  ${`${x.provider}/${x.model}`.padEnd(40)} ${t(x)}`);
        if (s.aiLab.length) console.log(dim(`\nAI Lab prompts: ${s.aiLab.reduce((n, x) => n + x.calls, 0)} (testpion history llm)`));
      }),
    );
}
