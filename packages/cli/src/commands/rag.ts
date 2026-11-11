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
  importOtelTraces,
  startOtlpReceiver,
  importRagRecords,
  metricScoreColumns,
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
import { registerRagMetricFileCommands } from './rag-metric-files.js';
import { registerRagR4Commands } from './rag-r4.js';
import { registerRagProbeCommands } from './rag-probes.js';
import { EXIT, CliError, bold, cliContext, dim, green, printJson, readResults, red, yellow, withWorkspace, WORKSPACE_OPTION } from '../shared.js';

const FORMATS = RAG_DATASET_FORMATS.join(', ');

/** A target written in a file (YAML or JSON): { protocol, step, mapping }. */
function targetFromFile(file: string): RagTarget {
  const doc = parseYaml(readFileSync(resolve(file), 'utf8')) as Partial<RagTarget> | undefined;
  if (!doc || typeof doc !== 'object') throw new CliError(`${file} is not a RAG target (expected protocol, step and mapping)`, EXIT.CONFIG_ERROR);
  return doc as RagTarget;
}

const shortText = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Receives OTLP/JSON traces on 127.0.0.1 until Ctrl+C or the time is up; progress goes to stderr so stdout stays the dataset. */
async function receiveTraces(port: number, seconds: number | undefined, quiet: boolean): Promise<Array<Record<string, unknown>>> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new CliError('--listen takes a port (0 for a free one)', EXIT.CONFIG_ERROR);
  if (seconds !== undefined && !(seconds > 0)) throw new CliError('--for takes a number of seconds', EXIT.CONFIG_ERROR);
  const rx = await startOtlpReceiver({ port, onBatch: (n) => !quiet && process.stderr.write(dim(`  received ${n} span${n === 1 ? '' : 's'}\n`)) });
  if (!quiet) {
    console.error(`${green('Listening')} for traces on ${rx.endpoint}/v1/traces ${dim(seconds ? `for ${seconds} s` : '(Ctrl+C to stop and write the records)')}`);
    console.error(dim(`On your application: OTEL_EXPORTER_OTLP_ENDPOINT=${rx.endpoint} OTEL_EXPORTER_OTLP_PROTOCOL=http/json`));
  }
  await new Promise<void>((done) => {
    const stop = () => done();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (seconds) setTimeout(stop, seconds * 1000).unref?.();
  });
  await rx.close();
  const s = rx.stats();
  if (!quiet) console.error(dim(`${s.requests} request${s.requests === 1 ? '' : 's'}, ${s.spans} span${s.spans === 1 ? '' : 's'}${s.refused ? `, ${s.refused} refused (not OTLP/JSON traces)` : ''}`));
  if (!s.requests) throw new CliError(`No traces arrived${s.refused ? ` (${s.refused} request${s.refused === 1 ? ' was' : 's were'} refused: the exporter must send JSON, OTEL_EXPORTER_OTLP_PROTOCOL=http/json)` : ''}`, EXIT.CONFIG_ERROR);
  return rx.batches();
}

export function registerRagCommands(program: Command): void {
  const rag = program.command('rag').description('RAG systems under test: connect and probe a target, the metric catalogue, run an evaluation with metrics and gates, re-score and compare runs, convert datasets from and to Ragas, DeepEval, BEIR, NVIDIA and promptfoo');
  registerRagEvalCommands(rag);
  registerRagMetricFileCommands(rag);
  registerRagR4Commands(rag);
  registerRagProbeCommands(rag);

  rag
    .command('targets')
    .description('list the RAG targets of a workspace (a request of any protocol and the mapping of its response)')
    .option(...WORKSPACE_OPTION)
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
    .option(...WORKSPACE_OPTION)
    .option('-e, --environment <name>', 'environment to use ({{variables}} of the request)')
    .option('--raw', 'also print the response the mapping reads')
    .option('--json', 'print { question, status, latencyMs, sample, shapes, response } as JSON')
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
          for (const s of p.shapes.slice(0, 2)) console.log(`${bold('Looks like')} ${s.name} ${dim(`(${s.id}): reads "${shortText(s.reads.answer)}"${s.reads.documents ? ` and ${s.reads.documents} document${s.reads.documents === 1 ? '' : 's'}` : ''}; mapping ${JSON.stringify(s.mapping)}`)}`);
          for (const w of p.sample.warnings) console.log(yellow(`warning: ${w}`));
          if (o.raw) console.log(`\n${dim(typeof p.response.doc === 'string' ? p.response.doc : JSON.stringify(p.response.doc, null, 2))}`);
        } finally {
          await ctx.dispose();
        }
      });
    });

  rag
    .command('import')
    .description('convert a dataset of another tool (Ragas, DeepEval, BEIR queries + qrels, NVIDIA retriever data, promptfoo tests, or traces of your AI application exported from OpenTelemetry as OTLP/JSON; JSON, JSONL, CSV or YAML; only data is read, nothing is executed) into a TestPion RAG dataset: question, reference, reference_contexts, reference_ids')
    .argument('[file]', 'the dataset file (not with --listen)')
    .addOption(new Option('--from <format>', `the format of the file (default: found by its columns): ${FORMATS}`).choices([...RAG_DATASET_FORMATS]))
    .option('--qrels <file>', 'BEIR: the qrels file (query-id, corpus-id, score)')
    .option('--corpus <file>', 'BEIR: the corpus (corpus.jsonl), to fill reference_contexts')
    .option('--limit <n>', 'BEIR: only the first n queries; traces: only the first n records')
    .option('--only-errors', 'traces (--from otel): only the traces where a span failed')
    .option('--listen [port]', 'traces: instead of a file, receive them from your application over OTLP/HTTP as JSON on 127.0.0.1 (default port 4318) until Ctrl+C or --for, then write the records')
    .option('--for <seconds>', 'with --listen: stop after this many seconds')
    .option('-o, --out <file>', 'write the dataset here (JSON Lines; default: print it)')
    .option('--format <format>', 'jsonl or json output', 'jsonl')
    .option('--json', 'print { from, records, notes } as JSON')
    .action(async (file: string | undefined, o: { from?: RagDatasetFormat; qrels?: string; corpus?: string; limit?: string; onlyErrors?: boolean; out?: string; format: string; json?: boolean; listen?: string | boolean; for?: string }) => {
      if (!o.listen && !file) throw new CliError('Give the dataset file, or --listen to receive traces from your application', EXIT.CONFIG_ERROR);
      const text0 = o.listen ? '' : readFileSync(resolve(file!), 'utf8');
      let r: ReturnType<typeof importRagRecords>;
      try {
        if (o.listen) {
          const t = importOtelTraces(await receiveTraces(o.listen === true ? 4318 : Number(o.listen), o.for ? Number(o.for) : undefined, !!o.json), { limit: o.limit ? Number(o.limit) : undefined, onlyErrors: !!o.onlyErrors });
          r = { records: t.records, notes: t.notes, from: 'otel' };
        } else if (o.from === 'beir') {
          if (!o.qrels) throw new CliError('A BEIR import needs --qrels <file> (and --corpus <file> for the texts)', EXIT.CONFIG_ERROR);
          r = { ...importBeir({ queries: text0, qrels: readFileSync(resolve(o.qrels), 'utf8'), corpus: o.corpus ? readFileSync(resolve(o.corpus), 'utf8') : undefined }, { limit: o.limit ? Number(o.limit) : undefined }), from: 'beir' };
        } else {
          const raw = parseRagImportText(text0, file!, o.from);
          // an OpenTelemetry export: traces of an AI application become records with the answer the system gave
          if (o.from === 'otel' || (!o.from && raw[0] && 'resourceSpans' in raw[0])) {
            const t = importOtelTraces(raw, { limit: o.limit ? Number(o.limit) : undefined, onlyErrors: !!o.onlyErrors });
            r = { records: t.records, notes: t.notes, from: 'otel' };
          } else r = importRagRecords(raw, o.from);
        }
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
    .option('--run <runId>', 'add the answer and the retrieved contexts each record got in this run (response / retrieved_contexts, actual_output / retrieval_context), and one column per metric of the run')
    .addOption(new Option('--names <names>', 'with --run: name the metric columns as Ragas does (faithfulness, answer_relevancy, nv_accuracy …) so Ragas can be run on the same file and the scores compared').choices(['testpion', 'ragas']).default('testpion'))
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (needed for an evaluation name or --run)')
    .option('-o, --out <file>', 'write the file here (default: print it)')
    .option('--format <format>', 'jsonl or json output', 'jsonl')
    .option('--json', 'print { to, records } as JSON')
    .action(async (dataset: string, o: { to: RagDatasetFormat; run?: string; names: 'testpion' | 'ragas'; workspace?: string; out?: string; format: string; json?: boolean }) => {
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
        let scores: ReturnType<typeof metricScoreColumns> | undefined;
        if (o.run) {
          if (ephemeral) throw new CliError('--run needs the workspace the run is in (-w <nameOrPath>)', EXIT.CONFIG_ERROR);
          const results: Array<{ id: string; metadata?: Record<string, unknown> }> = [];
          try {
            for await (const r of readResults(`${store.runDir(o.run)}/results.jsonl`)) results.push(r);
          } catch {
            throw new CliError(`No finished run "${o.run}" in this workspace`, EXIT.CONFIG_ERROR);
          }
          records = withCapturedSamples(records, results);
          scores = metricScoreColumns(records, results as never, { names: o.names });
        }
        const exported = exportRagRecords(records, o.to);
        const out = scores ? exported.map((r, i) => ({ ...r, ...scores![i] })) : exported;
        const body = stringifyRagRecords(out, o.format === 'json' ? 'json' : 'jsonl');
        if (o.out) writeFileSync(resolve(o.out), body);
        if (o.json) return printJson({ to: o.to, count: out.length, ...(o.out ? { out: resolve(o.out) } : { records: out }) });
        if (o.out) console.log(`${green('Exported')} ${out.length} records as ${o.to} → ${o.out}`);
        else process.stdout.write(body);
      });
    });
}
