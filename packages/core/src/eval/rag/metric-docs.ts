/**
 * `docs/ai-testing/rag-metrics.md`, written from the registry: every metric with what it measures, the formula, a worked
 * example, what it reads, its direction and pass mark, the names it answers to (older check names, DeepEval, NVIDIA, Ragas),
 * the prompts it sends and the cost in judge calls. The page is never edited by hand: `node scripts/gen-rag-metrics-doc.mjs`
 * rewrites it and tests/unit/rag-metrics-doc.test.ts fails when it is out of date.
 */
import { FAILURE_CLASSES } from './failure.js';
import { METRIC_PRESETS } from './catalogue-presets.js';
import { INPUT_LABELS, METRIC_GROUPS, metricCatalogue, type MetricDef } from './metric-registry.js';

const KIND_LABEL: Record<MetricDef['kind'], string> = { deterministic: 'no model', judged: 'judge model', embedding: 'embedding model', sql: 'SQL' };

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function section(m: MetricDef): string {
  const names = [...m.aliases, ...(m.ragas?.names ?? []).filter((n) => n !== m.id && !m.aliases.includes(n))];
  const opts = Object.entries(m.options ?? {}).map(([k, o]) => `\`${k}\`${o.values ? ` (${o.values.join(' | ')})` : ` (${o.type})`}${o.default !== undefined ? `, default \`${o.default}\`` : ''}: ${o.description}`);
  const lines = [
    `### ${m.name} {#${m.id.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}}`,
    '',
    `\`${m.id}\` · ${KIND_LABEL[m.kind]} · ${m.direction === 'higher' ? 'higher is better' : 'lower is better'}${m.threshold !== undefined ? ` · passes at ${m.threshold}` : ''} · ${m.calls === '0' ? 'no judge calls' : `judge calls: ${m.calls}`}`,
    '',
    m.what,
    '',
    `**How.** ${m.how}`,
    '',
    `**Example.** ${m.example}`,
    '',
    `**Reads.** ${m.requires.length ? m.requires.map((i) => INPUT_LABELS[i]).join('; ') : 'nothing from the dataset'}${m.optional?.length ? `; also, when present: ${m.optional.map((i) => INPUT_LABELS[i]).join('; ')}` : ''}.`,
  ];
  if (opts.length) lines.push('', '**Options.**', '', ...opts.map((o) => `- ${o}`));
  if (names.length) lines.push('', `**Also called.** ${names.map((n) => `\`${n}\``).join(', ')}`);
  if (m.ragas?.differs) lines.push('', `**Ragas.** ${m.ragas.differs}`);
  if (m.ragas?.options) lines.push('', `**Ragas options.** A Ragas name (or the \`ragas:\` prefix) sets ${Object.entries(m.ragas.options).map(([k, v]) => `\`${k}: ${String(v)}\``).join(', ')}.`);
  if (m.prompts?.length) lines.push('', `**Prompts.** ${m.prompts.map((p) => `\`${p}\``).join(', ')}${m.shares ? ` (claims shared through \`${m.shares}\`)` : ''}`);
  return lines.join('\n');
}

export function ragMetricsMarkdown(): string {
  const all = metricCatalogue();
  const out = [
    '# RAG metrics',
    '',
    '<!-- Generated from the metric registry by `node scripts/gen-rag-metrics-doc.mjs`. Do not edit by hand. -->',
    '',
    `TestPion has ${all.length} RAG metrics. Each one can be chosen in an evaluation, tried on one sample first, gated in CI (\`--min faithfulness=0.8\`) and read in the samples × metrics matrix. A metric that needs a model says so, and no judged metric ever runs without a judge you chose. [Testing a RAG system](./rag.md) shows how to use them.`,
    '',
    '| Metric | Kind | Higher is better | Reads | Judge calls |',
    '|---|---|---|---|---|',
    ...all.map((m) => `| [\`${m.id}\`](#${m.id.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}) | ${KIND_LABEL[m.kind]} | ${m.direction === 'higher' ? 'yes' : 'no (lower)'} | ${cell(m.requires.map((i) => i.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ') || '—')} | ${m.calls === '0' ? '0' : cell(m.calls)} |`),
    '',
    '## How names work',
    '',
    'Every metric answers to its id, to the older check names (`groundedness`, `answer-correctness` …) and to the names other tools give it. `LLMContextRecall`, `context_recall` and `context-recall` are the same metric; `recall@5` is `recall@k` with `k: 5`; a name from Ragas (`response_relevancy`) also applies the options that give Ragas’ own definition. The `ragas:` prefix applies those options to any metric (`ragas:answer-relevance`). A name works wherever a metric is named: `assertions` and `evaluators` in a test, `--metrics`, `--min`, the MCP tools.',
    '',
    '## Presets',
    '',
    ...METRIC_PRESETS.map((p) => `- **${p.name}** (\`${p.id}\`): ${p.description}`),
    '',
    '## Why a sample scored low',
    '',
    'Every failing sample gets a class from fixed rules over its metric results, so the matrix can be filtered by cause.',
    '',
    ...FAILURE_CLASSES.map((f) => `- **${f.label}** (\`${f.id}\`): ${f.meaning}`),
  ];
  for (const g of METRIC_GROUPS) {
    const ms = all.filter((m) => m.group === g.id);
    if (ms.length) out.push('', `## ${g.label}`, '', ...ms.flatMap((m) => [section(m), '']));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
