/**
 * `testpion rag capture`: a RAG dataset from real calls (History, a saved Debugger session, a HAR file, an evaluation run),
 * the question read out of each request where the RAG target writes it and the answer and contexts out of the response with
 * the target's mapping. Secrets and personal data are masked before anything is written. Nothing is sent to any model.
 */
import { Command, Option } from 'commander';
import { ApsError, captureDataset, type CaptureSourceSpec } from '@testpion/core';
import { EXIT, CliError, bold, cliContext, dim, green, printJson, withWorkspace, yellow } from '../shared.js';

interface Opts {
  target?: string;
  from?: 'history' | 'debugger' | 'run' | 'har';
  session?: string;
  run?: string;
  har?: string;
  history?: string[];
  name?: string;
  limit?: string;
  sample?: string;
  seed?: string;
  dedupe?: boolean;
  keep: 'newest' | 'first';
  since?: string;
  until?: string;
  all?: boolean;
  maskPii: boolean;
  asQuestions?: boolean;
  overwrite?: boolean;
  dryRun?: boolean;
  questionPath?: string;
  workspace?: string;
  environment?: string;
  json?: boolean;
}

const num = (s: string | undefined, what: string): number | undefined => {
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`${what} is a whole number of 1 or more`, EXIT.CONFIG_ERROR);
  return n;
};

function sourceOf(o: Opts): CaptureSourceSpec {
  const from = o.from ?? (o.session ? 'debugger' : o.run ? 'run' : o.har ? 'har' : 'history');
  if (from === 'debugger') {
    if (!o.session) throw new CliError('--from debugger needs --session <saved session, or the History id that saved it>', EXIT.CONFIG_ERROR);
    return { kind: 'debugger', session: o.session };
  }
  if (from === 'run') {
    if (!o.run) throw new CliError('--from run needs --run <run id>', EXIT.CONFIG_ERROR);
    return { kind: 'run', run: o.run };
  }
  if (from === 'har') {
    if (!o.har) throw new CliError('--from har needs --har <file in the workspace>', EXIT.CONFIG_ERROR);
    return { kind: 'har', file: o.har };
  }
  return { kind: 'history', ...(o.history?.length ? { ids: o.history } : {}) };
}

export function registerRagCaptureCommands(rag: Command): void {
  rag
    .command('capture')
    .description('make a RAG dataset from real calls: History, a saved Debugger session, a HAR file or an evaluation run; secrets and personal data are masked before it is written')
    .addOption(new Option('--from <source>', 'where the calls are (default: found from the options below, else History)').choices(['history', 'debugger', 'run', 'har']))
    .option('--target <name>', 'the RAG target the calls were made to: its request says where the question is, its mapping reads the answer and contexts (not needed for --run)')
    .option('--history <ids...>', 'History entry ids (default: the recent HTTP entries)')
    .option('--session <name>', 'a saved Debugger session (debugger/<name>.har) or the id of the History entry that saved it')
    .option('--run <id>', 'an evaluation run: its answered samples become records')
    .option('--har <file>', 'a HAR file inside the workspace')
    .option('--question-path <path>', 'where the question is when the target does not say: a JSONPath into the JSON request body ($.input.q) or query:<parameter>')
    .option('--name <name>', 'the dataset file: datasets/<name>.jsonl (default captured-<date>)')
    .option('--limit <n>', 'at most n records (the newest)')
    .option('--sample <n>', 'a random sample of n records, the same every time with the same --seed')
    .option('--seed <seed>', 'the seed of --sample', 'testpion')
    .option('--dedupe', 'keep one record per question (the newest, or --keep first)')
    .addOption(new Option('--keep <which>', 'with --dedupe: which call stays').choices(['newest', 'first']).default('newest'))
    .option('--since <time>', 'only calls from this ISO time on')
    .option('--until <time>', 'only calls up to this ISO time')
    .option('--all', 'also calls that did not answer 2xx')
    .option('--no-mask-pii', 'leave personal data (emails, phone numbers, ID and card numbers) as it is; secrets and tokens are always masked')
    .option('--as-questions', 'write the questions only, so the target is called again when the dataset is run')
    .option('--overwrite', 'replace a dataset file that exists')
    .option('--dry-run', 'show the first records and the report, write nothing')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('-e, --environment <name>')
    .option('--json', 'print as JSON')
    .action((o: Opts) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        const ctx = cliContext(store, o.environment);
        try {
          const r = await captureDataset(
            store,
            {
              target: o.target,
              source: sourceOf(o),
              name: o.name,
              questionPath: o.questionPath,
              dedupe: o.dedupe ? o.keep : false,
              limit: num(o.limit, '--limit'),
              sample: num(o.sample, '--sample'),
              seed: o.seed,
              since: o.since,
              until: o.until,
              onlySuccess: !o.all,
              maskPii: o.maskPii,
              asQuestions: o.asQuestions,
              overwrite: o.overwrite,
              dryRun: o.dryRun,
            },
            { redactor: ctx.redactor },
          );
          if (o.json) return printJson(r);
          const rep = r.report;
          console.log(`${bold('Read')} ${rep.read} calls · ${bold('matched')} ${rep.matched} · ${bold('records')} ${rep.records}${rep.questionAt ? dim(`  (question: ${rep.questionAt})`) : ''}`);
          for (const s of rep.skipped) console.log(`  ${yellow('skipped')} ${s.count} × ${s.reason}${s.examples.length ? dim(` (${s.examples.join(', ')})`) : ''}`);
          if (rep.masked.strings) console.log(`  masked ${rep.masked.strings} text${rep.masked.strings === 1 ? '' : 's'} ${dim(Object.entries(rep.masked.kinds).map(([k, n]) => `${k} ${n}`).join(', '))}`);
          if (rep.deduped) console.log(`  ${rep.deduped} repeated question${rep.deduped === 1 ? '' : 's'} merged`);
          if (rep.sampled) console.log(`  ${rep.sampled} left out by --sample / --limit`);
          for (const w of rep.warnings) console.log(`  ${yellow('warning')} ${w}`);
          if (r.written) console.log(`${green('Wrote')} ${r.written.rows} records → ${r.written.path}`);
          else {
            for (const p of r.preview.slice(0, 5)) console.log(`  ${dim('·')} ${p.question}${p.answer ? ` ${dim('→')} ${p.answer.slice(0, 80)}` : ''}`);
            console.log(dim('Dry run: nothing was written.'));
          }
        } catch (e) {
          throw e instanceof ApsError ? new CliError(`${e.message}${e.suggestions?.length ? `\n  ${e.suggestions.join('\n  ')}` : ''}`, EXIT.CONFIG_ERROR) : e;
        } finally {
          await ctx.dispose();
        }
      }),
    );
}
