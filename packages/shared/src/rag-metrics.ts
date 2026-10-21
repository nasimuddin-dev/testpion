/**
 * Custom RAG metrics (planning/rag-testing.md §4d): a metric is a YAML file in the workspace's `metrics/` folder that
 * compiles to the same definition as a built-in metric, so the picker, the presets, the matrix, the gates and the monitors
 * treat it alike. These are the data the window edits and the engine (core eval/rag/custom) validates and runs; browser-safe.
 */

export type CustomMetricKind = 'judge' | 'checklist' | 'rule' | 'formula' | 'embedding-set' | 'script';

/** What a custom metric may see of the sample. */
export type CustomMetricInput = 'question' | 'answer' | 'reference' | 'contexts';

export interface CustomMetricExampleSample {
  question?: string;
  answer?: string;
  reference?: string;
  /** Retrieved chunks: texts, or { id, text }. */
  contexts?: Array<string | { id?: string; text: string }>;
  referenceContexts?: string[];
  referenceIds?: string[];
  /** Other fields of a dataset record (answerable, rubric, canaries …). */
  record?: Record<string, unknown>;
}

/** A sample with the verdict the metric must give it: the examples are the metric's regression tests. */
export interface CustomMetricExample {
  name?: string;
  sample: CustomMetricExampleSample;
  expect: 'pass' | 'fail';
}

export interface CustomMetricRule {
  /** A deterministic check type (regex, contains, not-contains, length, json-schema, exists, equals …) and its options. */
  type: string;
  [option: string]: unknown;
}

/** The file `metrics/<id>.yaml`. */
export interface CustomMetricFile {
  id: string;
  /** Bumped when the criteria, kind, scale or inputs change; stored with every score. */
  version?: number;
  name?: string;
  description?: string;
  kind: CustomMetricKind;
  inputs?: CustomMetricInput[];
  /** judge: binary (default), or a whole-number range `[min, max]`. */
  scale?: 'binary' | [number, number];
  /** judge: what a good answer is, in words. */
  criteria?: string;
  /** judge: a description of a passing / failing answer (binary), or of each score (scale). */
  anchors?: Record<string, string>;
  /** judge: `guided` shows the reference answer to the judge. */
  reference?: 'free' | 'guided';
  /** judge: ask n (odd) times and take the majority (binary only). */
  votes?: number;
  /** checklist: yes/no criteria, optionally weighted. */
  items?: Array<string | { text: string; weight?: number }>;
  /** rule: the checks, and how they combine (all, any, or the weighted share). */
  rules?: CustomMetricRule[];
  combine?: 'all' | 'any' | 'weights';
  /** formula: an expression over other metrics. */
  expression?: string;
  /** embedding-set: good (and bad) answers; the dataset's `good_answers` column is used when these are absent. */
  good?: string[];
  negatives?: string[];
  aggregate?: 'max' | 'mean';
  negativeMax?: number;
  embedder?: string;
  /** script: the body of a function of `sample` that returns { score, reason?, items? }. */
  script?: string;
  threshold?: number;
  direction?: 'higher' | 'lower';
  /** The judge of a judge / checklist metric; else the evaluation's. */
  judge?: { provider?: string; model?: string };
  examples?: CustomMetricExample[];
  /** Written by Calibrate (R4). */
  calibration?: Record<string, unknown>;
  /** Another metric file whose definition this one starts from. */
  extends?: string;
}

export const CUSTOM_METRIC_KINDS: ReadonlyArray<{ id: CustomMetricKind; label: string; summary: string; judged: boolean }> = [
  { id: 'judge', label: 'Judge', summary: 'A criterion in words, judged as pass/fail or on a scale. One judge call.', judged: true },
  { id: 'checklist', label: 'Checklist', summary: 'Several yes/no criteria, judged in one call and weighted. One judge call.', judged: true },
  { id: 'rule', label: 'Rules', summary: 'Deterministic checks (regex, length, JSON …) combined. No model.', judged: false },
  { id: 'formula', label: 'Formula', summary: 'An expression over other metrics: 0.5*faithfulness + 0.5*answer_relevance. Runs those metrics.', judged: false },
  { id: 'embedding-set', label: 'Embedding set', summary: 'Closeness to good answers (and distance from bad ones) by embedding. One embedding call.', judged: false },
  { id: 'script', label: 'Script', summary: 'A sandboxed function of the sample that returns a score. No network, no files.', judged: false },
];

export const CUSTOM_METRIC_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A starting file per kind (the editor's New, `testpion rag metric new`). */
export function customMetricTemplate(kind: CustomMetricKind, id: string): CustomMetricFile {
  const head = { id, version: 1, name: id, description: '' };
  switch (kind) {
    case 'judge':
      return { ...head, kind, inputs: ['question', 'answer'], scale: 'binary', criteria: 'The answer is polite, uses plain language and does not promise a diagnosis.', reference: 'free', threshold: 1, examples: [] };
    case 'checklist':
      return { ...head, kind, inputs: ['question', 'answer'], items: ['Mentions the opening hours', 'Is polite', { text: 'Gives the phone number', weight: 2 }], threshold: 0.8, examples: [] };
    case 'rule':
      return { ...head, kind, rules: [{ type: 'not-contains', expected: 'guarantee' }, { type: 'length', max: 600 }], combine: 'all', threshold: 1, examples: [] };
    case 'formula':
      return { ...head, kind, expression: '0.5 * faithfulness + 0.5 * answer_relevance', threshold: 0.7, examples: [] };
    case 'embedding-set':
      return { ...head, kind, good: ['The clinic opens at 8am on weekdays.'], negatives: [], aggregate: 'max', threshold: 0.8, examples: [] };
    case 'script':
      return { ...head, kind, script: "// sample: { question, answer, reference, contexts: [{ id, text }] }\nconst words = sample.answer.split(/\\s+/).filter(Boolean).length;\nreturn { score: words <= 80 ? 1 : 0, reason: words + ' words' };", threshold: 1, examples: [] };
  }
}
