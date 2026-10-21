/**
 * The AI task `rag-draft-metric` (planning/rag-testing.md §4d): from a description of what good looks like ("answers in the
 * clinic's tone, never promises a diagnosis"), a draft of a custom metric file with its examples, offered as a proposal the
 * person reviews. The verifier `metric-examples` checks it before anyone relies on it: the file must be valid, a rule or
 * script metric must agree with every example it was drafted with (they run for real: they cost nothing), and a judged
 * metric must build its prompt for each example (the real judge call is a deliberate step, "Run examples").
 */
import { stringifyYaml } from '../util/lazy-yaml.js';
import { CUSTOM_METRIC_KINDS, customMetricTemplate } from '@testpion/shared';
import { compileCustomMetric, runMetricExamples } from '../eval/rag/custom/compile.js';
import { parseCustomMetric } from '../eval/rag/custom/file.js';
import { dryHost } from '../eval/rag/judge.js';
import { registerVerifier } from './verify.js';
import type { DraftItem } from './tasks/registry.js';

const RULE_TYPES = ['regex', 'not-regex', 'contains', 'not-contains', 'length', 'json-schema', 'exists', 'equals', 'starts-with', 'refusal', 'not-refusal', 'no-leak'];

export const RAG_DRAFT_METRIC_INSTRUCTION = [
  'You write a custom metric for evaluating a retrieval-augmented generation (RAG) system, as one YAML file for the `metrics/` folder of a TestPion workspace.',
  'The question is the description of what good looks like, in the person\'s words. The context may hold `kind` (the kind they chose), `samples` (a few real rows of their dataset: question, answer, reference, contexts) and `existing` (the ids of the metrics they already have: do not reuse an id).',
  `Choose the simplest kind that fits: ${CUSTOM_METRIC_KINDS.map((k) => `${k.id} (${k.summary})`).join(' ')} Prefer rule when a regular expression, a length or a forbidden word decides it, and judge or checklist when a person would have to read the answer.`,
  'Keys: id (lower-case words joined by hyphens), version: 1, name, description (one sentence), kind, inputs (a list of question, answer, reference, contexts: only what the judge needs), threshold (0 to 1).',
  'judge: criteria (one clear criterion in words, written as what a GOOD answer is, so a pass is good), scale: binary (or [0, 5]), anchors: { pass: …, fail: … } when it helps, reference: free (or guided when the reference answer is the standard). checklist: items (3 to 8 specific yes/no criteria; { text, weight } for the ones that matter more). rule: rules (a list of { type, … } with these deterministic types only: ' +
    RULE_TYPES.join(', ') +
    ') and combine: all, any or weights. formula: expression over other metrics, written with underscores (0.5 * faithfulness + 0.5 * answer_relevance). embedding-set: good (answers that are right) and negatives. script: script (the body of a function of `sample` with question, answer, reference, contexts [{ id, text }]; it must `return { score: 0 to 1, reason: "…" }`; plain JavaScript, no network, no files).',
  'ALWAYS add examples: 4 to 8 of them, half that must pass and half that must fail, each { name, sample: { question, answer, reference?, contexts? }, expect: pass | fail }. Make the failing ones realistic mistakes of a RAG system, not nonsense. Take wording from the samples when they are given.',
  'Output only the YAML file, no prose and no code fence. Never put a secret, a key or a real person\'s data in it.',
].join('\n');

function idOf(code: string): string | undefined {
  return /^id:\s*["']?([a-z0-9][a-z0-9-]*)["']?\s*$/m.exec(code)?.[1];
}

/** The proposal of a draft: the file, offered as `metrics/<id>.yaml`. */
export function proposeMetricDraft(a: { code: string }): DraftItem[] {
  const id = idOf(a.code) ?? 'new-metric';
  return [{ kind: 'metric', title: `metrics/${id}.yaml`, path: `metrics/${id}.yaml`, after: a.code.endsWith('\n') ? a.code : `${a.code}\n`, language: 'yaml' }];
}

registerVerifier('metric-examples', async (item, ctx) => {
  if (item.kind !== 'metric') return undefined;
  const id = /^metrics\/(.+)\.ya?ml$/.exec(item.path ?? '')?.[1];
  const p = parseCustomMetric(item.after, { fileId: id });
  if (!p.metric) return { verifier: 'metric-examples', status: 'fail', label: 'not a valid metric file', detail: p.problems.filter((x) => x.level === 'error').map((x) => `${x.field ? `${x.field}: ` : ''}${x.message}`).join('; ') };
  const examples = p.metric.examples ?? [];
  if (!examples.length) return { verifier: 'metric-examples', status: 'warn', label: 'valid, but it has no examples', detail: 'Examples are the metric’s regression tests: add a few that must pass and a few that must fail.' };
  const passing = examples.filter((e) => e.expect === 'pass').length;
  const c = compileCustomMetric(p.metric);
  if (p.metric.kind === 'rule' || p.metric.kind === 'script') {
    const rs = await runMetricExamples(c, { signal: ctx.signal });
    const bad = rs.filter((r) => !r.ok);
    if (bad.length) return { verifier: 'metric-examples', status: 'fail', label: `agrees with ${rs.length - bad.length}/${rs.length} examples`, detail: bad.map((r) => `#${r.index + 1}${r.name ? ` “${r.name}”` : ''} should ${r.expect} but ${r.got === 'na' ? 'has no score' : `does ${r.got}`}: ${r.message}`).join(' | ') };
    return { verifier: 'metric-examples', status: 'pass', label: `agrees with all ${rs.length} examples`, detail: `${passing} must pass, ${rs.length - passing} must fail; checked by running them.` };
  }
  if (p.metric.kind === 'judge' || p.metric.kind === 'checklist') {
    const host = ctx.services?.ragJudge;
    if (!host) return { verifier: 'metric-examples', status: 'pass', label: `valid, ${examples.length} examples`, detail: 'A judged metric’s examples run with the judge when you press Run examples.' };
    const dry = dryHost(host);
    try {
      const rs = await runMetricExamples(c, { providers: ctx.services?.providers, ragJudge: dry, signal: ctx.signal });
      void rs;
      return { verifier: 'metric-examples', status: 'pass', label: `valid, ${examples.length} examples build their prompts`, detail: `${passing} must pass, ${examples.length - passing} must fail. Nothing was sent; Run examples asks the judge.` };
    } catch (e) {
      return { verifier: 'metric-examples', status: 'warn', label: 'valid, but the prompts could not be built', detail: (e as Error).message };
    }
  }
  return { verifier: 'metric-examples', status: 'pass', label: `valid, ${examples.length} examples`, detail: 'The examples run when you press Run examples.' };
});


