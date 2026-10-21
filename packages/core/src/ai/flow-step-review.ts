/**
 * What the model changed in a flow, step by step, against TestPion's own deterministic draft (B-12; the review of an
 * AI-generated flow shows it). Both are flow files; steps are matched by id, else by name, else by method and path
 * (the model may rename a step), and the difference of each pair is listed per field — name, order, what it waits
 * for, the request, the body, what it extracts, its checks — so a reviewer reads "added a 404 case, extracts orderId,
 * moved Get order after Update" instead of two YAML files.
 */
import { checkLabel } from '@testpion/shared';
import { parseYaml } from '../util/lazy-yaml.js';

export interface StepFieldChange {
  field: 'name' | 'order' | 'dependsOn' | 'request' | 'body' | 'extract' | 'checks' | 'scripts' | 'other';
  /** Lines that are new in the model's step (`orderId = $.id`, `status = 201`). */
  added?: string[];
  /** Lines the draft had that the step no longer has. */
  removed?: string[];
  /** Single values (a name, a URL, an order): before → after. */
  before?: string;
  after?: string;
}

export interface StepDiff {
  /** The step's id in the model's flow (the draft's for a removed step). */
  id: string;
  name: string;
  /** same: unchanged; changed: its fields differ; added: only the model has it; removed: only the draft has it. */
  status: 'same' | 'changed' | 'added' | 'removed';
  changes: StepFieldChange[];
}

type Step = Record<string, unknown>;

const stepsOf = (text: string): Step[] => {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  const list = Array.isArray(doc) ? doc : ((doc as { tests?: unknown[] } | null)?.tests ?? []);
  return (Array.isArray(list) ? list : []).filter((s): s is Step => !!s && typeof s === 'object' && !Array.isArray(s));
};

const str = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
const idOf = (s: Step, i: number): string => str(s.id) || str(s.name) || `step-${i + 1}`;
const reqOf = (s: Step): Step => (s.request && typeof s.request === 'object' ? (s.request as Step) : s);
const urlOf = (s: Step): string => str(reqOf(s).url ?? reqOf(s).endpoint);
const methodOf = (s: Step): string => str(reqOf(s).method ?? (reqOf(s).query ? 'POST' : 'GET')).toUpperCase();

/** `GET /orders/{{orderId}}`: the method and the path without the origin or the query, for matching a renamed step. */
function endpointKey(s: Step): string {
  const path = urlOf(s)
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
    .replace(/^\{\{[^}]+\}\}/, '')
    .replace(/[?#].*$/, '')
    .replace(/\{\{[^}]+\}\}/g, '{}')
    .replace(/\/\d+(?=\/|$)/g, '/{}');
  return `${methodOf(s)} ${path || '/'}`;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : v === undefined || v === null || v === '' ? [] : [str(v)]);
const checksOf = (s: Step): string[] => {
  const l: unknown[] = Array.isArray(s.assertions) ? s.assertions : Array.isArray(s.checks) ? s.checks : [];
  return l.map((c) => (c && typeof c === 'object' && typeof (c as { type?: unknown }).type === 'string' ? checkLabel(c as { type: string }) : str(c)));
};
const extractOf = (s: Step): string[] => Object.entries((s.extract && typeof s.extract === 'object' ? s.extract : {}) as Record<string, unknown>).map(([k, v]) => `${k} = ${str(v)}`);
const bodyOf = (s: Step): string => {
  const b = reqOf(s).body ?? reqOf(s).json;
  if (b && typeof b === 'object' && 'content' in b) return str((b as { content?: unknown }).content).replace(/\s+/g, ' ').trim();
  return str(b).replace(/\s+/g, ' ').trim();
};

const setDiff = (field: StepFieldChange['field'], before: string[], after: string[]): StepFieldChange | undefined => {
  const added = after.filter((x) => !before.includes(x));
  const removed = before.filter((x) => !after.includes(x));
  return added.length || removed.length ? { field, ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}) } : undefined;
};

/** The field differences of two steps that are the same step. */
function changesOf(draft: Step, ai: Step, order?: { before: number; after: number }): StepFieldChange[] {
  const out: StepFieldChange[] = [];
  if (str(draft.name) !== str(ai.name)) out.push({ field: 'name', before: str(draft.name), after: str(ai.name) });
  if (order && order.before !== order.after) out.push({ field: 'order', before: String(order.before + 1), after: String(order.after + 1) });
  const deps = setDiff('dependsOn', list(draft.dependsOn), list(ai.dependsOn));
  if (deps) out.push(deps);
  const du = `${methodOf(draft)} ${urlOf(draft)}`;
  const au = `${methodOf(ai)} ${urlOf(ai)}`;
  if (du !== au) out.push({ field: 'request', before: du, after: au });
  if (bodyOf(draft) !== bodyOf(ai)) out.push({ field: 'body', before: bodyOf(draft).slice(0, 400), after: bodyOf(ai).slice(0, 400) });
  const ex = setDiff('extract', extractOf(draft), extractOf(ai));
  if (ex) out.push(ex);
  const ch = setDiff('checks', checksOf(draft), checksOf(ai));
  if (ch) out.push(ch);
  if (str(draft.preRequestScript) !== str(ai.preRequestScript) || str(draft.testScript) !== str(ai.testScript)) out.push({ field: 'scripts', before: 'the saved scripts', after: 'different scripts' });
  const skip = new Set(['id', 'name', 'dependsOn', 'request', 'url', 'method', 'headers', 'body', 'json', 'params', 'auth', 'extract', 'assertions', 'checks', 'preRequestScript', 'testScript', 'type', 'endpoint', 'query']);
  const other = setDiff(
    'other',
    Object.keys(draft).filter((k) => !skip.has(k)),
    Object.keys(ai).filter((k) => !skip.has(k)),
  );
  if (other) out.push(other);
  return out;
}

/**
 * The step-by-step difference between the draft and the model's flow (both flow files as text). Steps only the model
 * has are `added` (error cases, extra reads), steps only the draft has `removed`; matched steps `same` or `changed`
 * with the fields that differ, in the model's order.
 */
export function diffFlowSteps(draftYaml: string, aiYaml: string): StepDiff[] {
  const draft = stepsOf(draftYaml);
  const ai = stepsOf(aiYaml);
  const taken = new Set<number>();
  const match = (by: (d: Step, i: number) => boolean, a: Step): number => {
    const j = draft.findIndex((d, i) => !taken.has(i) && by(d, i));
    if (j >= 0) taken.add(j);
    return j;
  };
  const pairs = ai.map((a, i) => {
    const id = idOf(a, i);
    // the id first; a renamed step by its name, then by what it calls
    let j = match((d, k) => idOf(d, k) === id, a);
    if (j < 0 && str(a.name)) j = match((d) => str(d.name) === str(a.name), a);
    if (j < 0) j = match((d) => endpointKey(d) === endpointKey(a), a);
    return { a, i, j };
  });
  // the draft's steps in the order the matched ones keep: a step whose position among the matched changed has moved
  const matched = pairs.filter((p) => p.j >= 0);
  const rankInDraft = new Map([...matched].sort((x, y) => x.j - y.j).map((p, r) => [p.i, r]));
  const rankInAi = new Map(matched.map((p, r) => [p.i, r]));
  const out: StepDiff[] = pairs.map(({ a, i, j }) => {
    const id = idOf(a, i);
    const name = str(a.name) || id;
    if (j < 0) return { id, name, status: 'added', changes: [] };
    const changes = changesOf(draft[j]!, a, { before: rankInDraft.get(i) ?? i, after: rankInAi.get(i) ?? i });
    return { id, name, status: changes.length ? 'changed' : 'same', changes };
  });
  draft.forEach((d, k) => {
    if (!taken.has(k)) out.push({ id: idOf(d, k), name: str(d.name) || idOf(d, k), status: 'removed', changes: [] });
  });
  return out;
}

/** One line for a summary: "2 steps changed, 1 added, 1 removed" (nothing: "the same steps as the draft"). */
export function flowDiffSummary(diff: StepDiff[]): string {
  const n = (s: StepDiff['status']) => diff.filter((d) => d.status === s).length;
  const parts = [
    n('changed') ? `${n('changed')} step${n('changed') === 1 ? '' : 's'} changed` : '',
    n('added') ? `${n('added')} added` : '',
    n('removed') ? `${n('removed')} removed` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'the same steps as the draft';
}
