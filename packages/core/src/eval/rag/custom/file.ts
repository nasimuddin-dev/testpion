/**
 * Reading and checking a custom metric file (planning/rag-testing.md §4d). Everything here is static: it never runs the
 * metric, a script or a judge. A file is fine to save with warnings; an error means it cannot be registered. The `hash`
 * covers exactly what changes a score (the kind, the inputs, the criteria, the rules, the expression, the script …) and
 * not the name, the description, the examples or the calibration, so a result can say "scored by v3 · changed since".
 */
import { createHash } from 'node:crypto';
import { parseYaml } from '../../../util/lazy-yaml.js';
import { CUSTOM_METRIC_ID, CUSTOM_METRIC_KINDS, isRecord, type CustomMetricFile, type CustomMetricKind } from '@testpion/shared';
import { checkTypes } from '../../checks.js';
import { dagProblems } from '../dag.js';
import { resolveMetric } from '../metric-registry.js';
import { parseFormula } from './formula.js';

export interface MetricProblem {
  level: 'error' | 'warning';
  message: string;
  /** The key the problem is about (`criteria`, `items`, `rules[1]`). */
  field?: string;
}

export const MAX_FILE_BYTES = 128 * 1024;
const KNOWN_KEYS = new Set(['id', 'version', 'name', 'description', 'kind', 'inputs', 'scale', 'criteria', 'anchors', 'reference', 'votes', 'items', 'rules', 'combine', 'expression', 'good', 'negatives', 'aggregate', 'negativeMax', 'embedder', 'script', 'tree', 'threshold', 'direction', 'judge', 'examples', 'calibration', 'extends']);
const INPUTS = ['question', 'answer', 'reference', 'contexts', 'conversation'];

const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Rule types that need a model or a database: a `rule` metric is deterministic. */
export function ruleTypeProblem(type: string): string | undefined {
  if (!checkTypes().includes(type)) {
    const r = resolveMetric(type);
    if (!r) return `"${type}" is not a check type`;
  }
  const def = resolveMetric(type)?.def;
  if (def && (def.kind === 'judged' || def.kind === 'sql' || def.kind === 'embedding')) return `"${type}" needs a model or a database; a rule metric is deterministic (use a judge or formula metric instead)`;
  if (def?.custom) return `"${type}" is a custom metric; reference it from a formula metric`;
  return undefined;
}

/** The checks of a file, field by field. `fileId` is the file's name without `.yaml` (it must equal the id). */
export function validateCustomMetric(raw: unknown, o: { fileId?: string; known?: Set<string> } = {}): MetricProblem[] {
  const out: MetricProblem[] = [];
  const err = (message: string, field?: string) => out.push({ level: 'error', message, field });
  const warn = (message: string, field?: string) => out.push({ level: 'warning', message, field });
  if (!isRecord(raw)) return [{ level: 'error', message: 'A metric file is a map: id, kind, … keys.' }];
  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.has(k)) warn(`"${k}" is not read by any kind of metric (a typo?)`, k);
  const id = raw.id;
  if (!str(id) || !CUSTOM_METRIC_ID.test(id)) err('id must be lower-case letters, digits and hyphens (up to 63 characters), starting with a letter or digit.', 'id');
  else {
    if (o.fileId && id !== o.fileId) err(`id "${id}" must equal the file name "${o.fileId}.yaml".`, 'id');
    const builtin = resolveMetric(id);
    if (builtin && !builtin.def.custom) err(`"${id}" is a built-in metric name; metrics of this workspace are called custom/${id}, but the id itself must not clash with a built-in one.`, 'id');
  }
  const kind = raw.kind as CustomMetricKind;
  if (!CUSTOM_METRIC_KINDS.some((k) => k.id === kind)) {
    err(`kind must be one of ${CUSTOM_METRIC_KINDS.map((k) => k.id).join(', ')}.`, 'kind');
    return out;
  }
  if (raw.version !== undefined && !(Number.isInteger(raw.version) && (raw.version as number) >= 1)) err('version is a whole number from 1.', 'version');
  if (raw.threshold !== undefined && !(typeof raw.threshold === 'number' && Number.isFinite(raw.threshold))) err('threshold is a number.', 'threshold');
  if (raw.direction !== undefined && raw.direction !== 'higher' && raw.direction !== 'lower') err('direction is higher or lower.', 'direction');
  if (raw.inputs !== undefined) {
    if (!Array.isArray(raw.inputs) || raw.inputs.some((i) => !INPUTS.includes(String(i)))) err(`inputs is a list of ${INPUTS.join(', ')}.`, 'inputs');
  }
  if (raw.judge !== undefined && !(isRecord(raw.judge) && (raw.judge.provider === undefined || str(raw.judge.provider)))) err('judge is { provider, model }.', 'judge');

  const needs = (field: string, ok: boolean, message: string) => !ok && err(message, field);
  if (kind === 'judge') {
    needs('criteria', str(raw.criteria), 'A judge metric needs criteria: what a good answer is, in words.');
    if (str(raw.criteria) && raw.criteria.length > 4000) err('criteria is longer than 4,000 characters.', 'criteria');
    const sc = raw.scale;
    if (sc !== undefined && sc !== 'binary' && !(Array.isArray(sc) && sc.length === 2 && sc.every((n) => Number.isInteger(n)) && (sc[1] as number) > (sc[0] as number) && (sc[1] as number) - (sc[0] as number) <= 20)) err('scale is "binary" or two whole numbers [min, max] at most 20 apart.', 'scale');
    if (raw.anchors !== undefined && !(isRecord(raw.anchors) && Object.values(raw.anchors).every((v) => typeof v === 'string'))) err('anchors is a map of text (pass / fail, or a description per score).', 'anchors');
    if (raw.reference !== undefined && raw.reference !== 'free' && raw.reference !== 'guided') err('reference is free or guided.', 'reference');
    if (raw.votes !== undefined && !(Number.isInteger(raw.votes) && (raw.votes as number) >= 1 && (raw.votes as number) <= 9 && (raw.votes as number) % 2 === 1)) err('votes is an odd number from 1 to 9.', 'votes');
    if (raw.votes !== undefined && (raw.votes as number) > 1 && raw.scale !== undefined && raw.scale !== 'binary') warn('votes only applies to a binary (pass/fail) metric.', 'votes');
  } else if (kind === 'checklist') {
    const items = raw.items;
    if (!Array.isArray(items) || !items.length) err('A checklist needs items: a list of yes/no criteria.', 'items');
    else {
      if (items.length > 30) err('A checklist has at most 30 items.', 'items');
      let total = 0;
      items.forEach((it, i) => {
        const text = typeof it === 'string' ? it : isRecord(it) ? it.text : undefined;
        if (!str(text)) err('Each item is text, or { text, weight }.', `items[${i}]`);
        const w = isRecord(it) ? it.weight : undefined;
        if (w !== undefined && !(typeof w === 'number' && Number.isFinite(w) && w >= 0)) err('weight is a number from 0.', `items[${i}]`);
        total += typeof w === 'number' ? w : 1;
      });
      if (!total) err('The weights add up to 0.', 'items');
    }
  } else if (kind === 'rule') {
    const rules = raw.rules;
    if (!Array.isArray(rules) || !rules.length) err('A rule metric needs rules: a list of checks ({ type: regex, pattern: … }).', 'rules');
    else {
      if (rules.length > 30) err('A rule metric has at most 30 rules.', 'rules');
      rules.forEach((r, i) => {
        if (!isRecord(r) || !str(r.type)) return err('Each rule is a check: { type, … }.', `rules[${i}]`);
        const p = ruleTypeProblem(r.type);
        if (p) err(p, `rules[${i}]`);
      });
    }
    if (raw.combine !== undefined && !['all', 'any', 'weights'].includes(String(raw.combine))) err('combine is all, any or weights.', 'combine');
  } else if (kind === 'formula') {
    const f = parseFormula(String(raw.expression ?? ''));
    for (const p of f.problems) err(p, 'expression');
    for (const ref of f.refs) {
      const r = resolveMetric(ref);
      const sibling = o.known && (o.known.has(ref.startsWith('custom/') ? ref.slice(7) : ref) || o.known.has(ref.replace(/_/g, '-')));
      if (!r && sibling) continue;
      if (!r) err(`"${ref}" is not a metric (use its id with underscores, an alias or a Ragas name; \`custom/name\` in backticks for a custom one).`, 'expression');
      else if (r.def.id === `custom/${String(id)}`) err('A formula cannot read itself.', 'expression');
    }
  } else if (kind === 'embedding-set') {
    for (const k of ['good', 'negatives'] as const) if (raw[k] !== undefined && !(Array.isArray(raw[k]) && (raw[k] as unknown[]).every(str))) err(`${k} is a list of texts.`, k);
    if (!(Array.isArray(raw.good) && raw.good.length)) warn('No good answers: the dataset must have a "good_answers" column (or a reference answer) for this metric to score.', 'good');
    if (raw.aggregate !== undefined && raw.aggregate !== 'max' && raw.aggregate !== 'mean') err('aggregate is max or mean.', 'aggregate');
    if (raw.negativeMax !== undefined && !(typeof raw.negativeMax === 'number' && raw.negativeMax >= 0 && raw.negativeMax <= 1)) err('negativeMax is a number from 0 to 1.', 'negativeMax');
  } else if (kind === 'dag') {
    // the tree is the built-in dag metric's own: every reference exists, no cycles, not deeper than 12, a leaf from 0 to 10
    for (const p of dagProblems(raw.tree)) err(`The tree: ${p}.`, 'tree');
    if (isRecord(raw.tree) && isRecord(raw.tree.nodes))
      for (const [nodeId, node] of Object.entries(raw.tree.nodes)) {
        const check = isRecord(node) && node.type === 'rule' && isRecord(node.check) ? node.check : undefined;
        const bad = check && typeof check.type === 'string' ? ruleTypeProblem(check.type) : undefined;
        if (bad) err(`The tree: node "${nodeId}" (rule): ${bad}.`, 'tree');
      }
    if (isRecord(raw.tree) && isRecord(raw.tree.nodes) && Object.values(raw.tree.nodes).every((n) => isRecord(n) && n.type === 'rule')) warn('Every node is a rule: this tree needs no model; a rule metric would say the same.', 'tree');
  } else if (kind === 'script') {
    needs('script', str(raw.script), 'A script metric needs a script: the body of a function of `sample` that returns { score }.');
    if (str(raw.script) && raw.script.length > 20_000) err('The script is longer than 20,000 characters.', 'script');
    if (str(raw.script) && !/\breturn\b/.test(raw.script)) warn('The script never says `return`: it must return { score, reason }.', 'script');
  }
  if (raw.examples !== undefined) {
    if (!Array.isArray(raw.examples)) err('examples is a list of { sample, expect }.', 'examples');
    else {
      if (raw.examples.length > 50) err('A metric has at most 50 examples.', 'examples');
      raw.examples.forEach((e, i) => {
        if (!isRecord(e) || !isRecord(e.sample) || (e.expect !== 'pass' && e.expect !== 'fail')) err('Each example is { sample: {…}, expect: pass | fail }.', `examples[${i}]`);
      });
    }
  }
  return out;
}

/** What the metric computes, in a stable form: the same hash means the same scores for the same samples. */
export function scoringHash(f: CustomMetricFile): string {
  const keys = ['kind', 'inputs', 'scale', 'criteria', 'anchors', 'reference', 'votes', 'items', 'rules', 'combine', 'expression', 'good', 'negatives', 'aggregate', 'negativeMax', 'embedder', 'script', 'tree', 'threshold', 'direction', 'judge'] as const;
  const picked: Record<string, unknown> = {};
  for (const k of keys) if ((f as unknown as Record<string, unknown>)[k] !== undefined) picked[k] = (f as unknown as Record<string, unknown>)[k];
  const canon = JSON.stringify(picked, (_k, v) => (isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));
  return createHash('sha256').update(canon).digest('hex').slice(0, 12);
}

export interface ParsedMetricFile {
  metric?: CustomMetricFile;
  problems: MetricProblem[];
}

/** YAML text to a checked metric: `metric` is set when there is no error. */
export function parseCustomMetric(text: string, o: { fileId?: string; known?: Set<string> } = {}): ParsedMetricFile {
  if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) return { problems: [{ level: 'error', message: `The file is larger than ${MAX_FILE_BYTES / 1024} KB.` }] };
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return { problems: [{ level: 'error', message: `Not valid YAML: ${(e as Error).message.split('\n')[0]}` }] };
  }
  const problems = validateCustomMetric(raw, o);
  if (problems.some((p) => p.level === 'error')) return { problems };
  const f = raw as CustomMetricFile;
  return { metric: { ...f, version: f.version ?? 1 }, problems };
}
