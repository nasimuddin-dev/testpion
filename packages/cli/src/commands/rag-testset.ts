/**
 * `testpion rag generate-dataset <docs…>`: a RAG test set from documents (planning/rag-testing.md §4b). The documents are
 * chunked deterministically, the AI writes questions with reference answers and the chunks they come from, every sample is
 * verified (the reference is supported by its chunks, an unanswerable question is not answerable from the corpus, no
 * duplicates) and the result is a proposal; the accepted rows are added to datasets/<name>.jsonl only with --apply (only the
 * ticked rows: those whose checks did not fail). --estimate reads the documents and prints the cost; nothing is sent.
 */
import { Command } from 'commander';
import { formatUsd } from '@testpion/shared';
import { ApsError, aiRunDeps, applyProposal, estimateGeneration, generateTestset, TESTSET_TYPES, WorkspaceManager, type GenerateOptions } from '@testpion/core';
import { EXIT, CliError, bold, cliContext, dim, green, printJson, withWorkspace, yellow } from '../shared.js';
import { machine } from '../output.js';
import { printProposal } from './ai.js';
import { printEstimate } from './rag-eval.js';

const collect = (v: string, prev: string[] = []) => [...prev, v];

interface Flags {
  url?: string[];
  count: string;
  types?: string;
  name?: string;
  seed?: string;
  judge?: string;
  noJudge?: boolean;
  maxCost?: string;
  estimate?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  workspace?: string;
  environment?: string;
  json?: boolean;
}

export function registerRagTestsetCommands(rag: Command): void {
  rag
    .command('generate-dataset')
    .alias('generate-testset')
    .description('make a RAG test set from documents (markdown, text, HTML files or folders, public https pages): questions with reference answers and the chunk ids they come from, each verified, as a proposal; --apply adds the ticked rows to datasets/<name>.jsonl')
    .argument('[docs...]', 'files or folders of documents (md, txt, html); a PDF must be extracted to text first')
    .option('--url <https-url>', 'a public https page to use as a document (repeatable, at most 20)', collect)
    .option('--count <n>', 'how many questions (1 to 60)', '10')
    .option('--types <list>', `question types, comma separated: ${TESTSET_TYPES.join(', ')} (default: all)`)
    .option('--name <name>', 'the dataset: datasets/<name>.jsonl (default: from the first document)')
    .option('--seed <text>', 'which passages are asked about: the same seed and documents ask about the same ones', 'testpion')
    .option('--judge <provider/model>', 'the judge that checks each reference against its chunks (default: the AI settings’ large model)')
    .option('--no-judge-check', 'skip the judge’s check of the references; only the lexical, corpus and duplicate checks run')
    .option('--max-cost <usd>', 'refuse to run when the estimate may exceed this')
    .option('--estimate', 'read the documents, print the calls, tokens and cost range, and exit; nothing is sent')
    .option('--dry-run', 'the same as --estimate')
    .option('--apply', 'add the ticked rows to the dataset when the run is done')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('-e, --environment <name>')
    .option('--json', 'print as JSON')
    .action(async (docs: string[], o: Flags & { judgeCheck?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        if (!docs.length && !o.url?.length) throw new CliError('Name the documents: files or folders, or --url <https page>', EXIT.CONFIG_ERROR);
        const json = !!o.json || machine();
        const opts: GenerateOptions = { paths: docs, urls: o.url, count: Number(o.count), typesText: o.types, name: o.name, seed: o.seed, judge: o.judge, noJudge: o.judgeCheck === false, allowAbsolute: true };
        const ctx = cliContext(store, o.environment);
        const config = async <T>(fn: () => Promise<T>): Promise<T> => {
          try {
            return await fn();
          } catch (e) {
            throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
          }
        };
        try {
          if (o.estimate || o.dryRun || o.maxCost) {
            const e = await config(() => estimateGeneration(store, ctx.services.ragJudge!, opts));
            const max = o.maxCost !== undefined ? Number(o.maxCost) : undefined;
            const over = max !== undefined && e.costUsd !== undefined && e.costUsd.high > max;
            if (o.estimate || o.dryRun) {
              if (json) printJson(e);
              else {
                console.log(`${bold('Test set from documents')} ${dim(`· ${e.corpus.documents} documents · ${e.corpus.passages} passages`)}`);
                for (const s of e.corpus.skipped) console.log(yellow(`  skipped ${s}`));
                printEstimate(e);
              }
              return void (process.exitCode = e.caps.exceeds.length || e.judgeProblem || over ? EXIT.CONFIG_ERROR : EXIT.SUCCESS);
            }
            if (over) throw new CliError(`The estimate may reach ${formatUsd(e.costUsd!.high)}, over --max-cost ${formatUsd(max!)}: nothing was sent`, EXIT.CONFIG_ERROR);
          }
          const settings = new WorkspaceManager().loadSettings();
          const surface = process.env.CI ? 'ci' : 'cli';
          const r = await config(() =>
            generateTestset(aiRunDeps({ ctx, settings, store, surface, env: process.env }), store, opts, (done, of, text) => {
              if (!json && done < of) console.log(dim(text));
            }),
          );
          const ticked = r.proposal.items.filter((i) => i.selected).length;
          const applied = o.apply && ticked ? applyProposal(store, r.proposal.id) : undefined;
          if (json) return printJson({ proposal: r.proposal, tally: r.tally, corpus: r.corpus, calls: r.calls, usage: r.usage, costUsd: r.costUsd, ...(applied ? { applied } : o.apply ? { applied: null, why: 'nothing was ticked' } : {}) });
          console.log(`${bold('Test set')} ${dim(`· ${r.corpus.documents} documents · ${r.corpus.passages} passages · ${r.calls} model calls${r.costUsd !== undefined ? ` · ${formatUsd(r.costUsd)}` : ''}`)}`);
          console.log(`  ${r.tally.verified} verified, ${r.tally.warned} with a warning, ${r.tally.failed} failed a check (unticked)`);
          printProposal(r.proposal, { applied: !!applied });
          if (applied) console.log(green(`Added ${applied.applied.length} row${applied.applied.length === 1 ? '' : 's'} to ${(r.proposal.items[0]!.data as { dataset: string }).dataset}`) + dim(`  ·  undo: testpion ai undo ${r.proposal.id}`));
        } finally {
          await ctx.dispose();
        }
      }),
    );
}
