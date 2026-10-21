/**
 * "Make an example of this" (the Calibrate panel, `testpion rag metric example`, MCP `rag_make_metric_example`): the sample a
 * person labelled and the judge got wrong becomes one `examples:` entry of the custom metric's file, with the verdict the
 * person gave as what the metric must come out with. The metric then has a regression test for exactly the case it missed
 * (`rag metric validate --examples` runs it), and a judge prompt that is edited to fix it cannot quietly break it again.
 * The file is edited as text, so its comments and layout stay; the entry is written as a one-line YAML flow map.
 */
import { ApsError } from '../errors.js';
import { parseCustomMetric } from '../eval/rag/custom/file.js';
import { readLabels, recordOfResult } from '../eval/rag/calibrate/labels.js';
import { resolveMetric } from '../eval/rag/metric-registry.js';
import { readMetricFile, writeMetricFile } from '../storage/metric-files.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { defaultLabelsName } from './rag-calibrate.js';
import { runResults } from './run-results.js';

export interface MakeExampleInput {
  /** `custom/<id>` or the bare id of a metric file. */
  metric: string;
  run: string;
  /** A result id of the run, or its dataset record id. */
  result: string;
  /** What the metric must say about this sample; default: the person's label of it. */
  expect?: 'pass' | 'fail';
  name?: string;
  labels?: string;
}

export interface MadeExample {
  file: string;
  index: number;
  expect: 'pass' | 'fail';
  examples: number;
  sample: Record<string, unknown>;
}

const MAX_EXAMPLES = 50;
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : undefined);

/** The text with one more entry in its `examples:` list (the key is added when the file has none). */
export function appendExample(text: string, entry: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => /^examples:/.test(l));
  const item = `  - ${entry}`;
  if (at < 0) return `${text.replace(/\s*$/, '')}${eol}examples:${eol}${item}${eol}`;
  const head = lines[at]!;
  if (/^examples:\s*(\[\s*\])?\s*(#.*)?$/.test(head)) {
    const empty = /\[\s*\]/.test(head);
    let end = at + 1;
    if (!empty) while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]!) || /^-/.test(lines[end]!))) end++;
    let ins = empty ? at + 1 : end;
    while (ins > at + 1 && lines[ins - 1]!.trim() === '') ins--;
    if (empty) lines[at] = head.replace(/\s*\[\s*\]/, '');
    lines.splice(ins, 0, item);
    return lines.join(eol);
  }
  throw new ApsError('ValidationError', 'The examples of this file are written on one line: add the example by hand, or put the list on separate lines first');
}

export async function makeExample(store: WorkspaceStore, i: MakeExampleInput): Promise<MadeExample> {
  const id = i.metric.replace(/^custom\//, '');
  const file = readMetricFile(store, id);
  if (!file) {
    const builtin = resolveMetric(i.metric);
    throw new ApsError('ValidationError', builtin ? `${i.metric} is a built-in metric: it has no examples to add to` : `No metric file metrics/${id}.yaml`, {
      suggestions: builtin ? ['Copy it into a custom metric (`testpion rag metric new`) to give it examples and a pass mark of its own.'] : ['`testpion rag metric list` shows the custom metrics.'],
    });
  }
  const { rag, resultId } = await firstResult(store, i.run, i.result);
  const record = recordOfResult(resultId);
  let expectWord = i.expect;
  if (!expectWord) {
    const labelled = readLabels(store, i.labels ?? defaultLabelsName(store, i.run)).labels.find((l) => l.record === record && (l.metric === `custom/${id}` || l.metric === id));
    if (!labelled) throw new ApsError('ValidationError', `Say what ${i.metric} must come out with for this sample (expect: pass or fail), or label it first`, { suggestions: ['`testpion rag label <run> --result <id> --metric custom/<id> --pass|--fail`'] });
    expectWord = labelled.label;
  }
  if (expectWord !== 'pass' && expectWord !== 'fail') throw new ApsError('ValidationError', 'expect is pass or fail');
  const turns = (rag.record as { turns?: Array<{ role: string; content: string }> } | undefined)?.turns;
  const sample: Record<string, unknown> = {
    ...(clip(rag.query, 2000) ? { question: clip(rag.query, 2000) } : {}),
    answer: clip(rag.sample?.answer, 4000) ?? '',
    ...(clip(rag.reference, 2000) ? { reference: clip(rag.reference, 2000) } : {}),
    ...(rag.sample?.contexts?.length ? { contexts: rag.sample.contexts.slice(0, 6).map((d, n) => ({ id: d.id ?? `doc-${n + 1}`, text: clip(d.text, 1500) ?? '' })) } : {}),
    ...(turns?.length ? { record: { turns: turns.slice(-12).map((t) => ({ role: t.role, content: clip(t.content, 600) ?? '' })) } } : {}),
  };
  const before = parseCustomMetric(file.text, { fileId: id });
  if (!before.metric) throw new ApsError('ValidationError', `metrics/${id}.yaml has errors: fix them first`, { suggestions: before.problems.filter((p) => p.level === 'error').slice(0, 3).map((p) => p.message) });
  const existing = before.metric.examples ?? [];
  if (existing.length >= MAX_EXAMPLES) throw new ApsError('ValidationError', `A metric has at most ${MAX_EXAMPLES} examples`);
  const same = existing.findIndex((e) => e.sample.question === sample.question && e.sample.answer === sample.answer);
  if (same >= 0) throw new ApsError('ValidationError', `This sample is already example ${same + 1} of ${i.metric}`);
  const name = (i.name ?? `from ${i.run}: ${record}`).slice(0, 120);
  const text = appendExample(file.text, JSON.stringify({ name, expect: expectWord, sample }));
  const after = parseCustomMetric(text, { fileId: id });
  if (!after.metric) throw new ApsError('ValidationError', 'The example does not fit the file', { suggestions: after.problems.filter((p) => p.level === 'error').slice(0, 3).map((p) => p.message) });
  writeMetricFile(store, id, text);
  return { file: `metrics/${id}.yaml`, index: existing.length, expect: expectWord, examples: existing.length + 1, sample };
}

async function firstResult(store: WorkspaceStore, run: string, result: string) {
  for await (const r of runResults(store, run)) {
    if (r.id !== result && recordOfResult(r.id) !== result) continue;
    const rag = (r.metadata?.rag ?? {}) as { query?: string; reference?: string; sample?: { answer?: string; contexts?: Array<{ id?: string; text?: string }> }; record?: unknown };
    return { rag, resultId: r.id };
  }
  throw new ApsError('ValidationError', `Run ${run} has no result "${result}"`, { suggestions: ['`testpion rag matrix <run> --format json` lists the result ids.'] });
}

