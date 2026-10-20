/**
 * `testpion rag metrics|presets|metric|run|rescore|compare|connect|cache`: the metric side of RAG testing. The catalogue
 * (one table: kind, inputs, direction, calls), "try on one sample", running an evaluation with chosen metrics and gates
 * (`--min`), re-scoring a finished run with another judge or more metrics (no call to the RAG system), comparing two runs
 * metric by metric, connecting a target from a preset, and emptying the judge cache. Exit 1 when a gate fails or a metric
 * regresses, 2 for a configuration error (a missing judge, an unknown metric, a target that cannot be called).
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  ApsError,
  METRIC_GROUPS,
  METRIC_PRESETS,
  buildMetricMatrix,
  checkGates,
  chooseRagRun,
  compareMetricRuns,
  estimateRagEvaluation,
  estimateRescore,
  findRagTarget,
  findSavedEvaluation,
  metricCatalogueRows,
  metricsOfRun,
  parseGates,
  parseYaml,
  probeRagTarget,
  rescoreRun,
  resolveMetric,
  runRagEvaluation,
  runResults,
  saveRagTarget,
  storedSample,
  judgeSetupOf,
  tryMetric,
  type MetricMatrix,
  type RagRunChoices,
  type ReportFormat,
  type RunEstimate,
  type TrySample,
} from '@testpion/core';
import { RAG_TARGET_PRESETS, findRagTargetPreset, type RagTarget } from '@testpion/shared';
import { EXIT, CliError, bold, cliContext, dim, green, printJson, red, withWorkspace, yellow } from '../shared.js';

const collect = (v: string, prev: string[]) => [...prev, ...v.split(',').map((s) => s.trim()).filter(Boolean)];
const money = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

/** A configuration problem of the core (a missing judge, an unknown metric) is the CLI's configuration exit code. */
async function config<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApsError && (e.kind === 'ConfigurationError' || e.kind === 'ValidationError')) {
      const hint = e.suggestions?.length ? `\n${e.suggestions.map((s) => `  → ${s}`).join('\n')}` : '';
      throw new CliError(`${e.message}${e.why && e.why !== e.message ? `\n  ${e.why}` : ''}${hint}`, EXIT.CONFIG_ERROR);
    }
    throw e;
  }
}

function needWorkspace(ephemeral: string | undefined): void {
  if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
}

function printEstimate(e: RunEstimate): void {
  console.log(`${bold('Estimate')} ${dim(`${e.samples} samples · sizes from ${e.basis === 'stored' ? 'the stored answers' : e.basis === 'probe' ? 'one real call' : e.basis === 'dataset' ? 'the dataset' : 'typical values'}`)}`);
  for (const m of e.metrics) console.log(`  ${m.id.padEnd(24)} ${m.llmCalls ? `${m.llmCalls} judge call(s)` : m.embedCalls ? `${m.embedCalls} embedding call(s)` : 'no model'}${m.note ? dim(`  (${m.note})`) : ''}`);
  console.log(`${bold('Judge calls')} ${e.total.llmCalls}${e.cache.exact ? ` (${e.cache.hits} already cached)` : ''} · ${e.total.inputTokens.toLocaleString()} tokens in, about ${e.total.outputTokens.toLocaleString()} out${e.total.embedCalls ? ` · ${e.total.embedCalls} embedding calls` : ''}`);
  if (e.judge) console.log(`${bold('Judge')} ${e.judge.provider} / ${e.judge.model}${e.judge.local ? dim(' (stays on this computer)') : dim(' (sent to the provider)')}`);
  if (e.judgeProblem) console.log(red(`No judge: ${e.judgeProblem}`));
  if (e.costUsd) console.log(`${bold('Cost')} ${money(e.costUsd.low)} to ${money(e.costUsd.high)}`);
  else if (e.judge) console.log(`${bold('Cost')} ${yellow('no price set for this model: add one in Settings ▸ AI assistant to see a cost')}`);
  if (e.target) console.log(`${bold('Your RAG system')} ${e.target.calls} call(s)`);
  for (const x of e.caps.exceeds) console.log(red(`Would exceed ${x}`));
  for (const n of e.notes) console.log(dim(n));
  for (const u of e.unknown) console.log(yellow(`Unknown metric: ${u}`));
}

function printMatrix(m: MetricMatrix): void {
  console.log(`${bold('Metric'.padEnd(26))}${'mean'.padStart(7)}${'p10'.padStart(7)}${'pass'.padStart(7)}${'n'.padStart(6)}${'n/a'.padStart(5)}   95% interval`);
  for (const a of m.aggregates) {
    const col = m.columns.find((c) => c.key === a.key)!;
    console.log(`${a.key.padEnd(26)}${(a.mean ?? '—').toString().padStart(7)}${(a.p10 ?? '—').toString().padStart(7)}${(a.passRate !== undefined ? `${Math.round(a.passRate * 100)}%` : '—').padStart(7)}${String(a.n).padStart(6)}${String(a.naCount).padStart(5)}   ${a.ci ? `${a.ci[0]} – ${a.ci[1]}` : '—'}${col.direction === 'lower' ? dim('  lower is better') : ''}`);
  }
  if (m.failures.length) console.log(`\n${bold('Why samples failed')}  ${m.failures.map((f) => `${f.label} ${f.count}`).join(' · ')}`);
}

async function sampleFromOptions(store: Parameters<Parameters<typeof withWorkspace>[1]>[0], o: Record<string, unknown>, env?: string): Promise<TrySample> {
  if (o.sample) {
    const text = readFileSync(resolve(String(o.sample)), 'utf8').trim();
    const j = JSON.parse(text.startsWith('[') ? text : text.split('\n')[0]!) as TrySample | TrySample[];
    return Array.isArray(j) ? j[0]! : j;
  }
  if (o.run) {
    for await (const r of runResults(store, String(o.run))) {
      if (o.record && !r.id.endsWith(`:${o.record}`) && r.id !== o.record) continue;
      const s = storedSample(r);
      if (s) return s;
    }
    throw new CliError(`No stored sample${o.record ? ` for "${String(o.record)}"` : ''} in run ${String(o.run)}`, EXIT.CONFIG_ERROR);
  }
  if (o.probe) {
    if (!o.target) throw new CliError('--probe needs --target <name>', EXIT.CONFIG_ERROR);
    const { id: _i, name: _n, ...target } = findRagTarget(store, String(o.target));
    const ctx = cliContext(store, env);
    try {
      const p = await probeRagTarget(ctx, target as RagTarget, String(o.probe));
      return { question: String(o.probe), answer: p.sample.answer, contexts: p.sample.contexts, latencyMs: p.latencyMs, reference: o.reference as string | undefined, referenceIds: o.referenceId as string[] | undefined };
    } finally {
      await ctx.dispose();
    }
  }
  return { question: o.question as string | undefined, answer: o.answer as string | undefined, contexts: (o.context as string[] | undefined)?.map((text) => ({ text })), reference: o.reference as string | undefined, referenceIds: (o.referenceId as string[] | undefined)?.length ? (o.referenceId as string[]) : undefined };
}

const judgeRef = (j: string | undefined) => (j ? { provider: j.split('/')[0], ...(j.includes('/') ? { model: j.split('/').slice(1).join('/') } : {}) } : undefined);

export function registerRagEvalCommands(rag: Command): void {
  rag
    .command('metrics')
    .description('the RAG metric catalogue: every metric with its kind (no model / judge / embedding), what it reads, direction and cost in judge calls')
    .option('--group <group>', `only one group: ${METRIC_GROUPS.map((g) => g.id).join(', ')}`)
    .option('--kind <kind>', 'only deterministic, judged, embedding or sql')
    .option('--search <text>', 'metrics whose id, name, aliases or description contain this (a Ragas name works)')
    .option('--json', 'print the catalogue as JSON (for scripts and AI agents)')
    .action((o: { group?: string; kind?: string; search?: string; json?: boolean }) => {
      let rows = metricCatalogueRows();
      if (o.group) rows = rows.filter((m) => m.group === o.group);
      if (o.kind) rows = rows.filter((m) => m.kind === o.kind);
      if (o.search) {
        const q = o.search.toLowerCase();
        const hit = resolveMetric(o.search)?.def.id;
        rows = rows.filter((m) => m.id === hit || [m.id, m.name, m.what, ...m.aliases, ...(m.ragas?.names ?? [])].some((s) => s.toLowerCase().includes(q)));
      }
      if (o.json) return printJson({ count: rows.length, groups: METRIC_GROUPS, metrics: rows });
      let group = '';
      for (const m of rows) {
        if (m.group !== group) console.log(`\n${bold(METRIC_GROUPS.find((g) => g.id === m.group)?.label ?? m.group)}`);
        group = m.group;
        console.log(`  ${m.id.padEnd(26)} ${dim(`${m.kind}${m.direction === 'lower' ? ' · lower is better' : ''} · ${m.calls === '0' ? 'no calls' : `${m.calls} judge call(s)`}`)}`);
        console.log(`  ${' '.repeat(26)} ${m.what.length > 110 ? `${m.what.slice(0, 109)}…` : m.what}`);
      }
      console.log(dim(`\n${rows.length} metrics. \`testpion rag metric show <name>\` for one; \`testpion rag presets\` for ready-made sets.`));
    });

  rag
    .command('presets')
    .description('metric presets (RAG triad, Ragas core, Free …) and target presets (OpenAI-compatible, LangServe, LlamaIndex, Haystack, Dify, Flowise)')
    .option('--json', 'print as JSON')
    .action((o: { json?: boolean }) => {
      if (o.json) return printJson({ metricPresets: METRIC_PRESETS, targetPresets: RAG_TARGET_PRESETS.map(({ sample: _s, ...p }) => p) });
      console.log(bold('Metric presets') + dim('  (rag run --preset <id>)'));
      for (const p of METRIC_PRESETS) console.log(`  ${p.id.padEnd(22)} ${p.description}`);
      console.log(`\n${bold('Target presets')}${dim('  (rag connect <id> --name …)')}`);
      for (const p of RAG_TARGET_PRESETS) console.log(`  ${p.id.padEnd(26)} ${p.name}`);
    });

  const metric = rag.command('metric').description('one metric: show what it is, or try it on one sample');
  metric
    .command('show')
    .argument('<name>', 'a metric id, alias or Ragas name')
    .option('--json', 'print as JSON')
    .action((name: string, o: { json?: boolean }) => {
      const r = resolveMetric(name);
      if (!r) throw new CliError(`No RAG metric called "${name}". \`testpion rag metrics --search ${name}\` looks for it.`, EXIT.CONFIG_ERROR);
      const { estimate: _e, ...def } = r.def;
      if (o.json) return printJson({ ...def, resolvedFrom: name, options: r.options });
      console.log(`${bold(def.name)} ${dim(`(${def.id}) · ${def.kind} · ${def.direction === 'lower' ? 'lower' : 'higher'} is better${def.threshold !== undefined ? ` · passes at ${def.threshold}` : ''}`)}`);
      console.log(`\n${def.what}\n\n${bold('How')}      ${def.how}\n${bold('Example')}  ${def.example}\n${bold('Reads')}    ${def.requires.join(', ') || 'nothing from the dataset'}${def.optional?.length ? dim(` (also: ${def.optional.join(', ')})`) : ''}\n${bold('Calls')}    ${def.calls}`);
      if (Object.keys(r.options).length) console.log(`${bold('Options from this name')}  ${JSON.stringify(r.options)}`);
      if (def.aliases.length || def.ragas?.names.length) console.log(`${bold('Also called')} ${[...def.aliases, ...(def.ragas?.names ?? [])].join(', ')}`);
      if (def.ragas?.differs) console.log(`${bold('Ragas')}    ${def.ragas.differs}`);
    });
  metric
    .command('test')
    .description('try a metric on one sample: --dry-run shows the exact prompts that would be sent (nothing is sent), without it the sample is scored')
    .argument('<name>', 'a metric id, alias or Ragas name')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('-e, --environment <name>', 'environment ({{variables}} of a probed request)')
    .option('--sample <file>', 'a JSON file: { question, answer, contexts: [{ id, text }], reference, referenceIds }')
    .option('--run <runId>', 'take the sample from a finished run (with --record <id>: the dataset record)')
    .option('--record <id>', 'the record of --run')
    .option('--probe <question>', 'ask the RAG target this question and score what it answers (with --target)')
    .option('--target <name>', 'the RAG target of --probe')
    .option('--question <text>')
    .option('--answer <text>')
    .option('--context <text>', 'a retrieved context (repeat for several)', (v: string, p: string[] = []) => [...p, v])
    .option('--reference <text>')
    .option('--reference-id <id>', 'a gold chunk id (repeat)', (v: string, p: string[] = []) => [...p, v])
    .option('--judge <provider/model>', 'the judge (default: the AI settings’ large model)')
    .option('--option <key=value...>', 'metric options, e.g. mode=chunks k=5', (v: string, p: string[] = []) => [...p, v])
    .option('--dry-run', 'show what will be sent, send nothing')
    .option('--json', 'print as JSON')
    .action(async (name: string, o: Record<string, unknown> & { workspace?: string; environment?: string; dryRun?: boolean; json?: boolean; judge?: string; option?: string[] }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        needWorkspace(ephemeral);
        const sample = await config(() => sampleFromOptions(store, o, o.environment));
        const ctx = cliContext(store, o.environment);
        try {
          const options = Object.fromEntries((o.option ?? []).map((kv) => [kv.split('=')[0]!, (() => { const v = kv.slice(kv.indexOf('=') + 1); return /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v; })()]));
          const r = await config(() => tryMetric({ providers: ctx.services.providers, ragJudge: ctx.services.ragJudge! }, { metric: { type: name, ...options }, sample, judge: judgeRef(o.judge), dryRun: o.dryRun }));
          if (o.json) return printJson(r);
          console.log(`${bold(r.metric.name)} ${dim(`(${r.metric.id})`)}`);
          for (const m of r.missing) console.log(yellow(`missing: ${m.message}`));
          if (r.willSend) {
            if (!r.willSend.length) console.log(dim('This metric needs no model: nothing would be sent.'));
            for (const c of r.willSend) {
              console.log(`\n${bold('Would send')} ${c.metric} (${c.version}) to ${c.preview.providerName} / ${c.preview.model}${c.preview.local ? dim(' · stays on this computer') : ''}${c.cached ? green(' · the verdict is already cached: no call') : ''}`);
              console.log(dim(`≈ ${c.preview.estimate.inputTokens} tokens in, up to ${c.preview.estimate.maxOutputTokens} out${c.preview.estimate.priceKnown ? `, up to ${money(c.preview.estimate.maxCostUsd ?? 0)}` : ', no price set'} · masked: ${c.preview.redactionCount}`));
              for (const msg of c.preview.messages) console.log(`\n--- ${msg.role} ---\n${msg.content}`);
            }
            return;
          }
          const res = r.result!;
          console.log(`${res.passed ? green('✓') : red('✗')} ${res.message}`);
          if (res.explanation) console.log(dim(`  ${res.explanation.slice(0, 400)}`));
          const items = (res.metadata as { items?: Array<{ text: string; ok: boolean; evidence?: string; rating?: number }> } | undefined)?.items ?? [];
          for (const i of items.slice(0, 20)) console.log(`  ${i.ok ? green('✓') : red('✗')} ${i.text.slice(0, 120)}${i.evidence ? dim(`  ${i.evidence.slice(0, 100)}`) : ''}`);
          if (r.usage) console.log(dim(`judge: ${r.usage.calls} call(s), ${r.usage.inputTokens + r.usage.outputTokens} tokens, ${money(r.usage.costUsd)}${r.usage.cached ? ' (cached)' : ''}`));
          if (!res.passed) process.exitCode = EXIT.TEST_FAILURE;
        } finally {
          await ctx.dispose();
        }
      }),
    );

  rag
    .command('run')
    .description('run a saved RAG evaluation with chosen metrics and gates; --estimate prints the plan and cost and exits without a call. Exit 1 when a --min gate fails or a metric regresses against --baseline, 2 on a configuration error')
    .argument('<evaluation>', 'saved evaluation name or id')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('-e, --environment <name>', 'environment to use')
    .option('--target <name>', 'the RAG target (default: the evaluation’s)')
    .option('--metrics <list>', 'metric names replacing the evaluation’s evaluators (ids, aliases, Ragas names, recall@5 …)', collect, [])
    .option('--preset <id>', 'a metric preset (testpion rag presets)')
    .option('--judge <provider/model>', 'the judge of the judged metrics')
    .option('--judges <list>', 'a jury: several judges (provider/model,provider/model)', collect, [])
    .addOption(new Option('--aggregate <how>', 'how a jury combines').choices(['majority', 'mean', 'min']))
    .option('--swap', 'judge the documents in both orders; a disagreement is a tie')
    .option('--repeat <n>', 'judge n times (the cache is bypassed after the first) and report the flip rate')
    .option('--short-circuit', 'skip the judged answer metrics of a sample whose free retrieval metrics already failed')
    .option('--share-claims', 'split the answer into claims once and share them between faithfulness and answer-relevance')
    .option('--two-phase', 'collect the answers with the free metrics first, then judge them (a run followed by a rescore)')
    .option('--max-cost <usd>', 'stop judging once this much is spent; the rest is n/a')
    .option('--max-calls <n>', 'stop judging after this many model calls')
    .option('--limit <n>', 'only the first n dataset records')
    .option('-c, --concurrency <n>', 'parallel samples')
    .option('--retries <n>', 'retries per failing sample')
    .option('--estimate', 'print the judge calls, tokens and cost range and exit; no call is made')
    .option('--probe', 'with --estimate: ask the target one real question to size an answer')
    .option('--min <metric=value>', 'a gate: the mean of a metric must be at least this (repeat or comma-separate)', collect, [])
    .option('--baseline <run>', 'compare with an earlier run, metric by metric (a paired bootstrap decides what is real)')
    .option('--max-regression <n>', 'a drop in a metric’s mean that counts as a regression (default 0.05)', '0.05')
    .option('--junit <file>', 'write the JUnit report here')
    .option('--html <file>', 'write the HTML report here')
    .option('--report-json <file>', 'write the JSON report here')
    .option('-o, --out <dir>', 'output directory of the run')
    .option('-q, --quiet', 'only the summary')
    .option('--json', 'print { runId, summary, metrics, gates, comparison } as JSON')
    .action(async (ref: string, o: RunFlags) => {
      process.exitCode = await runCommand(ref, o);
    });

  rag
    .command('rescore')
    .description('score a finished run again with other metrics or another judge: the answers and contexts it captured are used, the RAG system is not called. A new run is recorded')
    .argument('<run>', 'run id')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('--metrics <list>', 'metric names (default: the ones the run had)', collect, [])
    .option('--preset <id>', 'a metric preset')
    .option('--judge <provider/model>')
    .option('--judges <list>', 'a jury', collect, [])
    .addOption(new Option('--aggregate <how>').choices(['majority', 'mean', 'min']))
    .option('--swap')
    .option('--repeat <n>')
    .option('--short-circuit')
    .option('--share-claims')
    .option('--max-cost <usd>')
    .option('--estimate', 'print the exact number of judge calls (and the cache hits) and exit')
    .option('--min <metric=value>', 'a gate on the new run', collect, [])
    .option('--junit <file>')
    .option('--html <file>')
    .option('--json', 'print as JSON')
    .action(async (runId: string, o: RescoreFlags) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        needWorkspace(ephemeral);
        const choices: RagRunChoices = { metrics: o.metrics, preset: o.preset, judge: o.judge, judges: o.judges, aggregate: o.aggregate, swap: o.swap, repeat: o.repeat ? Number(o.repeat) : undefined, shortCircuit: o.shortCircuit, shareClaims: o.shareClaims, maxJudgeCostUsd: o.maxCost ? Number(o.maxCost) : undefined };
        const evaluators = o.metrics.length || o.preset ? await config(() => chooseRagRun({ evaluators: [] } as never, choices).evaluators) : undefined;
        const judge = judgeSetupOf(await config(() => chooseRagRun({ evaluators: [], judge: {} } as never, choices)));
        const ctx = cliContext(store);
        try {
          if (o.estimate) {
            const names = evaluators ?? (await metricsOfRun(store, runId)).map((type) => ({ type }));
            const e = await config(() => estimateRescore(store, ctx, runId, names, judge));
            if (o.json) return printJson(e);
            return printEstimate(e);
          }
          const reports: ReportFormat[] = [...(o.junit ? ['junit' as const] : []), ...(o.html ? ['html' as const] : [])];
          const r = await config(() => rescoreRun(store, { runId, evaluators, judge, providers: ctx.services.providers, ragJudge: ctx.services.ragJudge!, reports }));
          const matrix = await buildMetricMatrix(runResults(store, r.runId), { runId: r.runId, limit: 1 });
          const gates = checkGates(matrix, parseGates(o.min));
          if (o.junit && r.reports.junit) copyFileSync(r.reports.junit, resolve(o.junit));
          if (o.html && r.reports.html) copyFileSync(r.reports.html, resolve(o.html));
          if (o.json) printJson({ runId: r.runId, rescoredFrom: runId, rescored: r.rescored, skipped: r.skipped, summary: r.summary, metrics: matrix.aggregates, failures: matrix.failures, gates });
          else {
            console.log(`${green('Re-scored')} ${r.rescored} samples of ${runId} → run ${bold(r.runId)}${r.skipped ? dim(` (${r.skipped} had no stored answer)`) : ''}${r.summary.judgeCostUsd ? dim(` · judge cost ${money(r.summary.judgeCostUsd)}`) : ''}`);
            printMatrix(matrix);
            for (const g of gates) console.log(`${g.passed ? green('✓') : red('✗')} gate ${g.why}`);
          }
          if (gates.some((g) => !g.passed)) process.exitCode = EXIT.TEST_FAILURE;
        } finally {
          await ctx.dispose();
        }
      }),
    );

  rag
    .command('compare')
    .description('compare a run with a baseline run, metric by metric (a seeded paired bootstrap says what is real); exit 1 on a regression')
    .argument('<run>', 'the run to judge')
    .requiredOption('-b, --baseline <run>', 'the run to compare with')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('--min-delta <n>', 'the change in a mean that counts (default 0.05)', '0.05')
    .option('--json', 'print as JSON')
    .action((runId: string, o: { baseline: string; workspace?: string; minDelta: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store, ephemeral) => {
        needWorkspace(ephemeral);
        const cmp = await compareMetricRuns(runResults(store, runId), runResults(store, o.baseline), { minDelta: Number(o.minDelta) });
        if (!cmp.samples.shared && !cmp.metrics.length) throw new CliError(`Neither ${runId} nor ${o.baseline} has scored RAG samples`, EXIT.CONFIG_ERROR);
        if (o.json) printJson(cmp);
        else {
          console.log(`${bold(runId)} against ${bold(o.baseline)} ${dim(`· ${cmp.samples.shared} samples in both`)}`);
          for (const m of cmp.metrics) {
            const mark = m.change === 'regressed' ? red('▼') : m.change === 'improved' ? green('▲') : dim('•');
            console.log(`  ${mark} ${m.key.padEnd(26)} ${String(m.baseline ?? '—').padStart(6)} → ${String(m.current ?? '—').padStart(6)}  ${m.delta !== undefined ? `${m.delta > 0 ? '+' : ''}${m.delta}` : m.change}${m.ci ? dim(`  [${m.ci[0]}, ${m.ci[1]}]${m.significant ? '' : ' not significant'}`) : ''}`);
          }
          console.log(cmp.regressions.length ? red(`${cmp.regressions.length} regression(s)`) : green('no regressions'));
        }
        if (cmp.regressions.length) process.exitCode = EXIT.TEST_FAILURE;
      }),
    );

  rag
    .command('connect')
    .description('save a RAG target from a preset (openai-compatible, langserve, llamaindex, haystack, dify, flowise …) or from a request file, without opening the app')
    .argument('<preset|file>', 'a preset id (testpion rag presets) or a YAML/JSON file of the request step')
    .requiredOption('--name <name>', 'the target’s name')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('--var <key=value...>', 'put a value into the request in place of {{key}} (the others stay variables of the environment)', (v: string, p: string[] = []) => [...p, v])
    .option('--protocol <protocol>', 'with a file: http, sse, websocket, grpc or mcp', 'http')
    .option('--answer <path>', 'JSONPath of the answer')
    .option('--contexts <path>', 'JSONPath of the list of retrieved contexts')
    .option('--text <path>', 'JSONPath of a context’s text (inside one context)')
    .option('--id <path>', 'JSONPath of a context’s id')
    .option('--score <path>', 'JSONPath of a context’s score')
    .option('--read-only', 'the endpoint only answers questions (a production environment may call it)')
    .option('--concurrency <n>', 'most calls at once')
    .option('--rpm <n>', 'most requests per minute')
    .option('--retries <n>', 'retries of a failed call')
    .option('--json', 'print as JSON')
    .action((from: string, o: { name: string; workspace?: string; var?: string[]; protocol: string; answer?: string; contexts?: string; text?: string; id?: string; score?: string; readOnly?: boolean; concurrency?: string; rpm?: string; retries?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        needWorkspace(ephemeral);
        const preset = findRagTargetPreset(from);
        let target: RagTarget;
        let note: string | undefined;
        if (preset) {
          target = { protocol: preset.protocol, step: JSON.parse(JSON.stringify(preset.step)), mapping: JSON.parse(JSON.stringify(preset.mapping)) };
          note = preset.note;
        } else {
          let step: unknown;
          try {
            step = parseYaml(readFileSync(resolve(from), 'utf8'));
          } catch (e) {
            throw new CliError(`"${from}" is not a preset (testpion rag presets) and cannot be read as a request file: ${(e as Error).message.split('\n')[0]}`, EXIT.CONFIG_ERROR);
          }
          if (!step || typeof step !== 'object' || Array.isArray(step)) throw new CliError(`${from} must hold a request: a mapping with type, url …`, EXIT.CONFIG_ERROR);
          target = { protocol: o.protocol as RagTarget['protocol'], step: step as Record<string, unknown>, mapping: { answer: '' } };
        }
        // values put into the request; the rest stay {{variables}}
        let text = JSON.stringify(target.step);
        for (const kv of o.var ?? []) {
          const i = kv.indexOf('=');
          if (i < 1) throw new CliError(`--var is key=value, not "${kv}"`, EXIT.CONFIG_ERROR);
          text = text.split(`{{${kv.slice(0, i)}}}`).join(kv.slice(i + 1).replace(/\\/g, '\\\\').replace(/"/g, '\\"'));
        }
        target.step = JSON.parse(text);
        if (o.answer) target.mapping.answer = o.answer;
        if (o.contexts) target.mapping.contexts = o.contexts.endsWith('[*]') ? o.contexts : `${o.contexts}[*]`;
        if (o.text || o.id || o.score) target.mapping.context = { ...target.mapping.context, ...(o.text ? { text: o.text } : {}), ...(o.id ? { id: o.id } : {}), ...(o.score ? { score: o.score } : {}) };
        if (o.readOnly) target.readOnly = true;
        if (o.concurrency || o.rpm || o.retries) target.limits = { ...(o.concurrency ? { concurrency: Number(o.concurrency) } : {}), ...(o.rpm ? { requestsPerMinute: Number(o.rpm) } : {}), ...(o.retries ? { retries: Number(o.retries) } : {}) };
        const saved = saveRagTarget(store, { name: o.name, target });
        if (o.json) return printJson({ ...saved, target, ...(note ? { note } : {}) });
        console.log(`${green('Saved')} the RAG target "${o.name}" (${saved.id}). Probe it: ${dim(`testpion rag probe "${o.name}" "your question"`)}`);
        if (note) console.log(yellow(note));
        const left = [...new Set(JSON.stringify(target.step).match(/\{\{(?!question)[\w.$-]+\}\}/g) ?? [])];
        if (left.length) console.log(dim(`Variables still to set in the environment: ${left.join(', ')}`));
      }),
    );

  const cache = rag.command('cache').description('the judge cache (a verdict is stored by the content hash of the exact prompt)');
  cache
    .command('clear')
    .description('empty the judge cache: the next run asks the judge again')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('--json', 'print as JSON')
    .action((o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        needWorkspace(ephemeral);
        const cleared = store.meta.clearJudgeCache();
        if (o.json) return printJson({ cleared });
        console.log(`${green('Cleared')} ${cleared} cached verdict${cleared === 1 ? '' : 's'}.`);
      }),
    );
}

interface RunFlags {
  workspace?: string;
  environment?: string;
  target?: string;
  metrics: string[];
  preset?: string;
  judge?: string;
  judges: string[];
  aggregate?: 'majority' | 'mean' | 'min';
  swap?: boolean;
  repeat?: string;
  shortCircuit?: boolean;
  shareClaims?: boolean;
  twoPhase?: boolean;
  maxCost?: string;
  maxCalls?: string;
  limit?: string;
  concurrency?: string;
  retries?: string;
  estimate?: boolean;
  probe?: boolean;
  min: string[];
  baseline?: string;
  maxRegression: string;
  junit?: string;
  html?: string;
  reportJson?: string;
  out?: string;
  quiet?: boolean;
  json?: boolean;
}
type RescoreFlags = Pick<RunFlags, 'workspace' | 'metrics' | 'preset' | 'judge' | 'judges' | 'aggregate' | 'swap' | 'repeat' | 'shortCircuit' | 'shareClaims' | 'maxCost' | 'estimate' | 'min' | 'junit' | 'html' | 'json'>;

async function runCommand(ref: string, o: RunFlags): Promise<number> {
  return withWorkspace(o.workspace, async (store, ephemeral) => {
    needWorkspace(ephemeral);
    const saved = await config(() => findSavedEvaluation(store, ref));
    if (saved.type !== 'rag') throw new CliError(`"${saved.name}" is not a RAG evaluation (use \`testpion eval run\`)`, EXIT.CONFIG_ERROR);
    const d = await config(() =>
      chooseRagRun(saved, {
        metrics: o.metrics,
        preset: o.preset,
        target: o.target,
        judge: o.judge,
        judges: o.judges,
        aggregate: o.aggregate,
        swap: o.swap,
        repeat: o.repeat ? Number(o.repeat) : undefined,
        shortCircuit: o.shortCircuit,
        shareClaims: o.shareClaims,
        maxJudgeCostUsd: o.maxCost ? Number(o.maxCost) : undefined,
        maxJudgeCalls: o.maxCalls ? Number(o.maxCalls) : undefined,
        limit: o.limit ? Number(o.limit) : undefined,
      }),
    );
    const gates = parseGates(o.min);
    if (o.estimate) {
      const ctx = cliContext(store, o.environment);
      try {
        const probe = o.probe && d.target ? async (question: string) => {
          const { id: _i, name: _n, ...target } = findRagTarget(store, d.target!);
          const p = await probeRagTarget(ctx, target as RagTarget, question);
          return { question, answer: p.sample.answer, contexts: p.sample.contexts };
        } : undefined;
        const e = await config(() => estimateRagEvaluation(store, ctx, d, { probe }));
        if (o.json) printJson(e);
        else printEstimate(e);
        return e.caps.exceeds.length || e.judgeProblem ? EXIT.CONFIG_ERROR : EXIT.SUCCESS;
      } finally {
        await ctx.dispose();
      }
    }
    const reports: ReportFormat[] = [...new Set<ReportFormat>(['json', ...(o.junit ? (['junit'] as const) : []), ...(o.html ? (['html'] as const) : [])])];
    const out = await config(() =>
      runRagEvaluation({
        store,
        makeContext: () => cliContext(store, o.environment),
        evaluation: d,
        concurrency: o.concurrency ? Number(o.concurrency) : undefined,
        retries: o.retries ? Number(o.retries) : undefined,
        twoPhase: o.twoPhase,
        reports,
        outDir: o.out ? resolve(o.out) : undefined,
        environment: o.environment,
        onPhase: (p) => !o.quiet && !o.json && console.log(dim(p === 'collect' ? 'Phase 1: asking your RAG system and scoring with the free metrics …' : p === 'judge' ? 'Phase 2: judging the collected answers …' : `Running ${d.name} …`)),
        onResult: (r) => {
          if (o.quiet || o.json) return;
          const bad = r.checks.filter((c) => !c.passed);
          const failure = (r.metadata?.rag as { failure?: { class: string } } | undefined)?.failure;
          console.log(`  ${r.status === 'passed' ? green('✓') : r.status === 'error' ? red('!') : red('✗')} ${r.name}${failure ? dim(`  [${failure.class}]`) : ''}${bad.length ? dim(`  ${bad.slice(0, 3).map((c) => c.name).join(', ')}`) : ''}`);
        },
      }),
    );
    if (o.junit && out.reports.junit) copyFileSync(out.reports.junit, resolve(o.junit));
    if (o.html && out.reports.html) copyFileSync(out.reports.html, resolve(o.html));
    if (o.reportJson && out.reports.json) copyFileSync(out.reports.json, resolve(o.reportJson));
    const matrix = await buildMetricMatrix(runResults(store, out.runId), { runId: out.runId, limit: 1 });
    const gateResults = checkGates(matrix, gates);
    const comparison = o.baseline ? await compareMetricRuns(runResults(store, out.runId), runResults(store, o.baseline), { minDelta: Number(o.maxRegression) }) : undefined;
    const s = out.summary;
    if (o.json) printJson({ runId: out.runId, collectRunId: out.collectRunId, summary: s, metrics: matrix.aggregates, columns: matrix.columns, failures: matrix.failures, gates: gateResults, ...(comparison ? { comparison } : {}), reports: out.reports });
    else {
      console.log(`\n${bold('Run')} ${out.runId} ${dim(`· ${s.total} samples · ${s.passed} passed, ${s.failed} failed, ${s.errors} errors`)}${s.judgeCostUsd ? dim(` · judge cost ${money(s.judgeCostUsd)}`) : ''}`);
      printMatrix(matrix);
      for (const g of gateResults) console.log(`${g.passed ? green('✓') : red('✗')} gate ${g.why}`);
      if (comparison) {
        console.log(`\n${bold('Against')} ${o.baseline} ${dim(`· ${comparison.samples.shared} samples in both`)}`);
        for (const m of comparison.metrics.filter((x) => x.change !== 'unchanged')) console.log(`  ${m.change === 'regressed' ? red('▼') : m.change === 'improved' ? green('▲') : dim('•')} ${m.key}: ${m.baseline ?? '—'} → ${m.current ?? '—'}${m.delta !== undefined ? ` (${m.delta > 0 ? '+' : ''}${m.delta})` : ''}`);
        if (!comparison.regressions.length) console.log(green('no regressions'));
      }
    }
    if (s.total === 0) throw new CliError('The evaluation has no dataset records.', EXIT.CONFIG_ERROR);
    if (gateResults.some((g) => !g.passed) || comparison?.regressions.length) return EXIT.TEST_FAILURE;
    // with gates the gates decide; without any, a failed sample fails the run, as `eval run` does
    return !Object.keys(gates).length && !comparison && s.failed + s.errors > 0 ? EXIT.TEST_FAILURE : EXIT.SUCCESS;
  });
}

