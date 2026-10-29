/**
 * `testpion eval generate-cases` (AU-13) and `testpion eval trust` (AU-23).
 *
 * generate-cases: test cases for a saved evaluation, written by AI from its prompt, an API definition, a collection or
 * folder, documents or real calls in History; every case is verified and offered as a proposal; --apply adds the ticked ones
 * to the evaluation. trust: grade ten answers of a finished run yourself and see how often the AI reviewer agreed.
 */
import type { Command } from 'commander';
import { ApsError, aiRunDeps, applyProposal, CASE_SOURCES, findCollection, findSavedEvaluation, generateEvalCases, trustReviewer, WorkspaceManager, type CaseSource, type GenerateCasesOptions } from '@testpion/core';
import { EXIT, bold, dim, green, red, yellow, CliError, printJson, withWorkspace, cliContext, JSON_OPTION, WORKSPACE_OPTION } from '../shared.js';
import { machine } from '../output.js';
import { printPreview, printProposal } from './ai-print.js';

const collect = (v: string, prev: string[] = []) => [...prev, v];

export function registerEvalCasesCommands(ev: Command): void {
  ev.command('generate-cases')
    .description('write test cases for a saved evaluation with AI: from its prompt, an API definition (--spec), a collection or folder (--collection), documents (--documents) or real calls in History (--from history); each case is verified and offered as a proposal; --apply adds the ticked ones')
    .argument('<name>', 'saved evaluation name or id')
    .option('--from <source>', `where the cases come from: ${CASE_SOURCES.join(', ')} (default: prompt, or the one implied by --spec, --collection or --documents)`)
    .option('--spec <file>', 'an API definition of the workspace (specs/<file>): cases are questions about its operations')
    .option('--collection <nameOrId>', 'a collection whose saved requests the cases are about')
    .option('--folder <id>', 'with --collection: only this folder')
    .option('--documents <path...>', 'files or folders of documents; the cases are questions with expected answers from them (the RAG test-set generator)')
    .option('--url <https-url>', 'with documents: a public https page (repeatable)', collect)
    .option('--history-limit <n>', 'with --from history: how many recent prompts to read (1 to 50)', '20')
    .option('--count <n>', 'how many cases (1 to 30)', '10')
    .option('--hint <text>', 'what to focus on, e.g. "more about refunds"')
    .option('--provider <id>', 'write them with this provider instead of the AI settings (the offline demo model is "demo")')
    .option('--dry-run', 'say what would be sent and what it costs; send nothing')
    .option('--apply', 'add the ticked cases to the evaluation when done')
    .option(...WORKSPACE_OPTION)
    .option('-e, --environment <name>', 'environment to use')
    .option(...JSON_OPTION)
    .action(
      (ref: string, o: { from?: string; spec?: string; collection?: string; folder?: string; documents?: string[]; url?: string[]; historyLimit: string; count: string; hint?: string; provider?: string; dryRun?: boolean; apply?: boolean; workspace?: string; environment?: string; json?: boolean }) =>
        withWorkspace(o.workspace, async (store, ephemeral) => {
          if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
          const saved = findSavedEvaluation(store, ref);
          if (saved.type === 'rag') throw new CliError('This is an evaluation of a bot with sources: its test set comes from `testpion rag generate-dataset`', EXIT.CONFIG_ERROR);
          const source = (o.from ?? (o.spec ? 'spec' : o.collection ? 'collection' : o.documents?.length || o.url?.length ? 'documents' : 'prompt')) as CaseSource;
          if (!CASE_SOURCES.includes(source)) throw new CliError(`--from is one of: ${CASE_SOURCES.join(', ')}`, EXIT.CONFIG_ERROR);
          let collection: string | undefined;
          if (o.collection) {
            const c = findCollection(store, o.collection);
            if (!c) throw new CliError(`No collection "${o.collection}"`, EXIT.CONFIG_ERROR);
            collection = c.id;
          }
          const opts: GenerateCasesOptions = { source, draft: saved, evaluation: saved.id, count: Number(o.count), spec: o.spec, collection, folder: o.folder, paths: o.documents, urls: o.url, historyLimit: Number(o.historyLimit), hint: o.hint, provider: o.provider, dryRun: o.dryRun };
          const json = !!o.json || machine();
          const ctx = cliContext(store, o.environment);
          try {
            let r;
            try {
              r = await generateEvalCases(aiRunDeps({ ctx, settings: new WorkspaceManager().loadSettings(), store, surface: process.env.CI ? 'ci' : 'cli', env: process.env }), store, opts, (done, of, text) => {
                if (!json && done < of) console.log(dim(text));
              });
            } catch (e) {
              throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
            }
            if (r.dryRun) {
              if (json) return printJson(r);
              if (r.preview) return printPreview({ preview: r.preview } as never);
              return console.log(`${bold('Cases from documents')} ${dim('· estimate')}\n${JSON.stringify(r.estimate, null, 2)}\nNothing was sent.`);
            }
            const p = r.proposal!;
            const ticked = p.items.filter((i) => i.selected).length;
            const applied = o.apply && ticked ? applyProposal(store, p.id) : undefined;
            if (json) return printJson({ ...r, ...(applied ? { applied } : o.apply ? { applied: null, why: 'nothing was ticked' } : {}) });
            console.log(`${bold(`Test cases for ${saved.name}`)} ${dim(`· from ${source} · ${r.calls} model call${r.calls === 1 ? '' : 's'}${r.costUsd !== undefined ? ` · $${r.costUsd.toFixed(4)}` : ''}`)}`);
            console.log(`  ${r.tally.verified} verified, ${r.tally.warned} with a warning, ${r.tally.failed} failed a check (unticked)`);
            printProposal(p, { applied: !!applied });
            if (applied) console.log(green(`Added ${applied.applied.length} case${applied.applied.length === 1 ? '' : 's'} to ${saved.name}`) + dim(`  ·  undo: testpion ai undo ${p.id}`));
          } finally {
            await ctx.dispose();
          }
        }),
    );

  ev.command('trust')
    .description('trust the AI reviewer: grade ten answers of a finished run yourself (its verdict stays hidden), then see how often it agreed with you')
    .argument('<run>', 'run id (testpion history list)')
    .option('--check <name>', 'the AI reviewer check to compare (default: the first one)')
    .option('--count <n>', 'how many answers to grade (3 to 50)', '10')
    .option('--grade <resultId>', 'record your verdict on this answer (with --as)')
    .option('--as <verdict>', 'pass or fail, or clear to remove your verdict')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_OPTION)
    .action((run: string, o: { check?: string; count: string; grade?: string; as?: string; workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        if (o.grade && !['pass', 'fail', 'clear'].includes(o.as ?? '')) throw new CliError('Say your verdict: --as pass, --as fail or --as clear', EXIT.CONFIG_ERROR);
        let s;
        try {
          s = await trustReviewer(store, { run, metric: o.check, count: Number(o.count), ...(o.grade ? { label: { result: o.grade, verdict: o.as === 'clear' ? null : (o.as as 'pass' | 'fail') } } : {}) });
        } catch (e) {
          throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
        }
        if (o.json || machine()) return printJson(s);
        console.log(`${bold('Trust the AI reviewer')} ${dim(`· ${s.evaluation ?? s.run}${s.metric ? ` · ${s.metric}` : ''}`)}`);
        console.log(s.summary);
        s.cases.forEach((c, i) => {
          console.log(`\n${bold(`${i + 1}. ${c.resultId}`)} ${c.yours ? (c.yours === 'pass' ? green('you: pass') : red('you: fail')) : yellow('not graded')}`);
          if (c.input) console.log(`   asked:    ${c.input}`);
          if (c.reply) console.log(`   answered: ${c.reply}`);
          if (c.rule) console.log(dim(`   rule:     ${c.rule}`));
        });
        if (!s.done && s.cases.length) console.log(dim(`\nGrade one: testpion eval trust ${run} --grade <resultId> --as pass|fail`));
      }),
    );
}
