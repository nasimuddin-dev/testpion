/**
 * `testpion rag targets|probe|import|export`: RAG systems under test (the app's AI Lab ▸ RAG). A target is a request to
 * any protocol plus the mapping of its response; `probe` calls it once, `import` / `export` convert datasets from and to
 * Ragas and DeepEval. Evaluations that use a target run with `testpion eval run`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  ApsError,
  RAG_DATASET_FORMATS,
  exportRagRecords,
  findRagTarget,
  findSavedEvaluation,
  importBeir,
  importRagRecords,
  parseRagImportText,
  listRagTargets,
  parseRagDatasetText,
  parseYaml,
  probeRagTarget,
  stringifyRagRecords,
  withCapturedSamples,
  type RagDatasetFormat,
  type RagTarget,
} from '@testpion/core';
import { datasetFormatOfName } from '@testpion/shared';
import { registerRagEvalCommands } from './rag-eval.js';
import { EXIT, CliError, bold, cliContext, dim, green, printJson, readResults, red, yellow, withWorkspace } from '../shared.js';

const FORMATS = RAG_DATASET_FORMATS.join(', ');

/** A target written in a file (YAML or JSON): { protocol, step, mapping }. */
function targetFromFile(file: string): RagTarget {
  const doc = parseYaml(readFileSync(resolve(file), 'utf8')) as Partial<RagTarget> | undefined;
  if (!doc || typeof doc !== 'object') throw new CliError(`${file} is not a RAG target (expected protocol, step and mapping)`, EXIT.CONFIG_ERROR);
  return doc as RagTarget;
}

const shortText = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function registerRagCommands(program: Command): void {
  const rag = program.command('rag').description('RAG systems under test: connect and probe a target, the metric catalogue, run an evaluation with metrics and gates, re-score and compare runs, convert datasets from and to Ragas, DeepEval, BEIR, NVIDIA and promptfoo');
  registerRagEvalCommands(rag);

  rag
    .command('targets')
    .description('list the RAG targets of a workspace (a request of any protocol and the mapping of its response)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print as JSON (for scripts and AI agents)')
    .action((o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        const list = listRagTargets(store);
        if (o.json) return printJson(list);
        if (!list.length) return console.log(dim('No RAG targets. Connect one in the app: AI Lab ▸ RAG ▸ Connect a RAG system.'));
        for (const t of list) {
          console.log(`${bold(t.name)}${t.folder ? dim(`  (${t.folder})`) : ''}  ${dim(t.protocol)}${t.problems.length ? red(`  ${t.problems[0]}`) : ''}`);
          console.log(`  ${dim(t.mapped)}`);
        }
      }),
    );

  rag
    .command('probe')
    .description('call a RAG target once with a question and show the sample its mapping reads (answer, retrieved contexts, usage) and the raw response')
    .argument('[target]', 'target name or id (or use --file)')
    .argument('[question]', 'the question to ask', 'What does this system know?')
    .option('--file <file>', 'a target written in a YAML or JSON file instead of a saved one')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-e, --environment <name>', 'environment to use ({{variables}} of the request)')
    .option('--raw', 'also print the response the mapping reads')
    .option('--json', 'print { question, status, latencyMs, sample, response } as JSON')
    .action(async (name: string | undefined, question: string, o: { file?: string; workspace?: string; environment?: string; raw?: boolean; json?: boolean }) => {
      if (!name && !o.file) throw new CliError('Name a target, or pass --file <target.yaml>. `testpion rag targets` lists them.', EXIT.CONFIG_ERROR);
      await withWorkspace(o.workspace, async (store, ephemeral) => {
        if (ephemeral && !o.file) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        let target: RagTarget;
        try {
          target = o.file ? targetFromFile(o.file) : (({ id: _i, name: _n, ...t }) => t)(findRagTarget(store, name!));
        } catch (e) {
          throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
        }
        const ctx = cliContext(store, o.environment);
        try {
          const p = await probeRagTarget(ctx, target, question);
          if (o.json) return printJson({ target: o.file ?? name, ...p, response: { ...p.response, text: undefined, ...(o.raw ? { text: p.response.text } : {}) } });
          console.log(`${bold('Question')}  ${question}`);
          console.log(`${bold('Status')}    ${p.status ?? '—'} · ${p.latencyMs} ms · ${p.response.kind} response`);
          console.log(`${bold('Answer')}    ${p.sample.answer ? p.sample.answer : red('(none: the mapping found no answer)')}`);
          if (p.sample.contexts.length) {
            console.log(bold('Contexts'));
            p.sample.contexts.forEach((d, i) => console.log(`  ${i + 1}. ${green(d.id)}${d.score !== undefined ? dim(` · score ${d.score}`) : ''}${d.source ? dim(` · ${d.source}`) : ''}  ${shortText(d.text)}`));
          } else console.log(`${bold('Contexts')}  ${dim('none read')}`);
          if (p.sample.usage) console.log(`${bold('Usage')}     ${JSON.stringify(p.sample.usage)}`);
          for (const w of p.sample.warnings) console.log(yellow(`warning: ${w}`));
          if (o.raw) console.log(`\n${dim(typeof p.response.doc === 'string' ? p.response.doc : JSON.stringify(p.response.doc, null, 2))}`);
        } finally {
          await ctx.dispose();
        }
      });
    });

  rag
    .command('import')
    .description('convert a dataset of another tool (Ragas, DeepEval, BEIR queries + qrels, NVIDIA retriever data, promptfoo tests; JSON, JSONL, CSV or YAML; only data is read, nothing is executed) into a TestPion RAG dataset: question, reference, reference_contexts, reference_ids')
    .argument('<file>', 'the dataset file')
    .addOption(new Option('--from <format>', `the format of the file (default: found by its columns): ${FORMATS}`).choices([...RAG_DATASET_FORMATS]))
    .option('--qrels <file>', 'BEIR: the qrels file (query-id, corpus-id, score)')
    .option('--corpus <file>', 'BEIR: the corpus (corpus.jsonl), to fill reference_contexts')
    .option('--limit <n>', 'BEIR: only the first n queries')
    .option('-o, --out <file>', 'write the dataset here (JSON Lines; default: print it)')
    .option('--format <format>', 'jsonl or json output', 'jsonl')
    .option('--json', 'print { from, records, notes } as JSON')
    .action((file: string, o: { from?: RagDatasetFormat; qrels?: string; corpus?: string; limit?: string; out?: string; format: string; json?: boolean }) => {
      const text0 = readFileSync(resolve(file), 'utf8');
      let r: ReturnType<typeof importRagRecords>;
      try {
        if (o.from === 'beir') {
          if (!o.qrels) throw new CliError('A BEIR import needs --qrels <file> (and --corpus <file> for the texts)', EXIT.CONFIG_ERROR);
          r = { ...importBeir({ queries: text0, qrels: readFileSync(resolve(o.qrels), 'utf8'), corpus: o.corpus ? readFileSync(resolve(o.corpus), 'utf8') : undefined }, { limit: o.limit ? Number(o.limit) : undefined }), from: 'beir' };
        } else r = importRagRecords(parseRagImportText(text0, file, o.from), o.from);
      } catch (e) {
        throw e instanceof ApsError ? new CliError(e.message, EXIT.CONFIG_ERROR) : e;
      }
      const text = stringifyRagRecords(r.records, o.format === 'json' ? 'json' : 'jsonl');
      if (o.out) writeFileSync(resolve(o.out), text);
      if (o.json) return printJson({ from: r.from, count: r.records.length, notes: r.notes, ...(o.out ? { out: resolve(o.out) } : { records: r.records }) });
      for (const n of r.notes) console.error(yellow(`note: ${n}`));
      if (o.out) console.log(`${green('Imported')} ${r.records.length} records from ${r.from} → ${o.out}`);
      else process.stdout.write(text);
    });

  rag
    .command('export')
    .description('convert a TestPion RAG dataset (a file, or a saved evaluation by name) into Ragas or DeepEval records; with --run the answers and retrieved contexts that run captured are included')
    .argument('<dataset>', 'a dataset file, or the name of a saved evaluation')
    .addOption(new Option('--to <format>', 'the format to write').choices(['ragas', 'deepeval']).makeOptionMandatory())
    .option('--run <runId>', 'add the answer and the retrieved contexts each record got in this run (response / retrieved_contexts, actual_output / retrieval_context)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (needed for an evaluation name or --run)')
    .option('-o, --out <file>', 'write the file here (default: print it)')
    .option('--format <format>', 'jsonl or json output', 'jsonl')
    .option('--json', 'print { to, records } as JSON')
    .action(async (dataset: string, o: { to: RagDatasetFormat; run?: string; workspace?: string; out?: string; format: string; json?: boolean }) => {
      await withWorkspace(o.workspace, async (store, ephemeral) => {
        let text: string;
        let format = datasetFormatOfName(dataset) ?? 'jsonl';
        try {
          text = readFileSync(resolve(dataset), 'utf8');
        } catch {
          if (ephemeral) throw new CliError(`${dataset} is not a file, and there is no workspace to look for an evaluation of that name in (-w <nameOrPath>)`, EXIT.CONFIG_ERROR);
          try {
            const e = findSavedEvaluation(store, dataset);
            text = e.dataset;
            format = e.datasetFormat;
          } catch (err) {
            throw err instanceof ApsError ? new CliError(err.message, EXIT.CONFIG_ERROR) : err;
          }
        }
        let records = importRagRecords(parseRagDatasetText(text, format)).records;
        if (o.run) {
          if (ephemeral) throw new CliError('--run needs the workspace the run is in (-w <nameOrPath>)', EXIT.CONFIG_ERROR);
          const results: Array<{ id: string; metadata?: Record<string, unknown> }> = [];
          try {
            for await (const r of readResults(`${store.runDir(o.run)}/results.jsonl`)) results.push(r);
          } catch {
            throw new CliError(`No finished run "${o.run}" in this workspace`, EXIT.CONFIG_ERROR);
          }
          records = withCapturedSamples(records, results);
        }
        const out = exportRagRecords(records, o.to);
        const body = stringifyRagRecords(out, o.format === 'json' ? 'json' : 'jsonl');
        if (o.out) writeFileSync(resolve(o.out), body);
        if (o.json) return printJson({ to: o.to, count: out.length, ...(o.out ? { out: resolve(o.out) } : { records: out }) });
        if (o.out) console.log(`${green('Exported')} ${out.length} records as ${o.to} → ${o.out}`);
        else process.stdout.write(body);
      });
    });
}
