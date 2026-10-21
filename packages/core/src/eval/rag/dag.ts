/**
 * The `dag` metric (DeepEval DAG, planning/rag-testing.md §2.3 7.7): a decision tree of judgements. Each node is one small
 * question; only the branch the answers lead to is asked, and a leaf holds the score (0 to 10, divided by 10). Four kinds of
 * node: `binary` (a yes/no judgement), `choice` (pick one labelled option), `task` (write something down that later nodes
 * may read) and `rule` (a deterministic check: no model). The tree is checked when it loads: every reference exists, there
 * are no cycles, it is not deeper than 12 nodes. The same tree is the `dag` kind of a custom metric.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck, runChecks, type CheckContext } from '../checks.js';
import { contextsInput, referenceText } from './judged-kit.js';
import { addUsage, assertJudgeUsable, guarded, judgePanel, meets, na, needsField, noUsage, panelOf, round3, single, type Usage } from './judged-kit.js';
import { dagBinary, dagChoice, dagTask } from './prompts-extra.js';
import { num, result } from './metric-util.js';
import { listOf } from './lists.js';

type DagBranch = string | { score: number; reason?: string };
type DagNode =
  | { type: 'binary'; question: string; yes: DagBranch; no: DagBranch }
  | { type: 'choice'; question: string; options: Record<string, DagBranch> }
  | { type: 'task'; instruction: string; next: DagBranch }
  | { type: 'rule'; check: { type: string; [option: string]: unknown }; yes: DagBranch; no: DagBranch };

interface DagSpec {
  root: string;
  nodes: Record<string, DagNode>;
}

const DAG_LIMITS = { nodes: 40, depth: 12, options: 8 } as const;

const isLeaf = (b: unknown): b is { score: number; reason?: string } => !!b && typeof b === 'object' && typeof (b as { score?: unknown }).score === 'number';

/** The nodes a node leads to (references; leaves are not nodes). */
const refsOf = (n: DagNode): string[] => {
  const branches: DagBranch[] = n.type === 'binary' || n.type === 'rule' ? [n.yes, n.no] : n.type === 'choice' ? Object.values(n.options) : [n.next];
  return branches.filter((b): b is string => typeof b === 'string');
};

/** Everything wrong with a tree, in words (empty: the tree can run). */
export function dagProblems(spec: unknown): string[] {
  const out: string[] = [];
  if (!spec || typeof spec !== 'object') return ['the tree is empty: give { root, nodes }'];
  const s = spec as Partial<DagSpec>;
  if (!s.nodes || typeof s.nodes !== 'object' || !Object.keys(s.nodes).length) return ['the tree has no nodes'];
  const nodes = s.nodes;
  const ids = Object.keys(nodes);
  if (ids.length > DAG_LIMITS.nodes) out.push(`the tree has ${ids.length} nodes; at most ${DAG_LIMITS.nodes}`);
  if (typeof s.root !== 'string' || !nodes[s.root]) out.push(`root "${String(s.root)}" is not a node`);
  for (const id of ids) {
    const n = nodes[id] as DagNode;
    const where = `node "${id}"`;
    if (!n || typeof n !== 'object') {
      out.push(`${where} is not an object`);
      continue;
    }
    if (n.type === 'binary' || n.type === 'rule') {
      if (n.type === 'binary' && !(typeof n.question === 'string' && n.question.trim())) out.push(`${where} (binary) needs a "question"`);
      if (n.type === 'rule' && !(n.check && typeof n.check.type === 'string')) out.push(`${where} (rule) needs a "check" with a type`);
      for (const k of ['yes', 'no'] as const) if (n[k] === undefined) out.push(`${where} needs "${k}": a node id or { score }`);
    } else if (n.type === 'choice') {
      const labels = Object.keys(n.options ?? {});
      if (!(typeof n.question === 'string' && n.question.trim())) out.push(`${where} (choice) needs a "question"`);
      if (labels.length < 2 || labels.length > DAG_LIMITS.options) out.push(`${where} (choice) needs 2 to ${DAG_LIMITS.options} options`);
    } else if (n.type === 'task') {
      if (!(typeof n.instruction === 'string' && n.instruction.trim())) out.push(`${where} (task) needs an "instruction"`);
      if (n.next === undefined) out.push(`${where} needs "next": a node id or { score }`);
    } else out.push(`${where} has an unknown type "${String((n as { type?: unknown }).type)}" (binary, choice, task or rule)`);
    const branches: DagBranch[] = n.type === 'binary' || n.type === 'rule' ? [n.yes, n.no] : n.type === 'choice' ? Object.values(n.options ?? {}) : n.type === 'task' ? [n.next] : [];
    for (const b of branches) {
      if (b === undefined) continue;
      if (typeof b === 'string') {
        if (!nodes[b]) out.push(`${where} leads to "${b}", which is not a node`);
      } else if (!isLeaf(b) || b.score < 0 || b.score > 10) out.push(`${where} has a leaf whose score is not a number from 0 to 10`);
    }
  }
  if (out.length) return out;
  // cycles and depth: a depth-first walk from the root
  const walk = (id: string, stack: string[]): void => {
    if (stack.includes(id)) {
      out.push(`the tree has a cycle: ${[...stack.slice(stack.indexOf(id)), id].join(' → ')}`);
      return;
    }
    if (stack.length + 1 > DAG_LIMITS.depth) {
      out.push(`the tree is deeper than ${DAG_LIMITS.depth} nodes`);
      return;
    }
    for (const r of refsOf(nodes[id] as DagNode)) if (!out.length) walk(r, [...stack, id]);
  };
  walk(s.root!, []);
  return out;
}

/** The most judge calls one sample can cost: the most judged nodes (not rules) on any path from the root. */
export function dagMaxJudgeCalls(spec: DagSpec): number {
  const memo = new Map<string, number>();
  const calls = (id: string): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    memo.set(id, 0);
    const n = spec.nodes[id];
    if (!n) return 0;
    const below = Math.max(0, ...refsOf(n).map(calls));
    const v = below + (n.type === 'rule' ? 0 : 1);
    memo.set(id, v);
    return v;
  };
  return calls(spec.root);
}

/** The kinds of node a tree uses that ask a judge (for the prompts a metric lists). */
export const dagJudgedKinds = (spec: DagSpec): Array<'binary' | 'choice' | 'task'> => [...new Set(Object.values(spec.nodes).map((n) => n.type).filter((t): t is 'binary' | 'choice' | 'task' => t !== 'rule'))];

const textOf = (v: unknown) => (typeof v === 'string' ? v : '');

/** Reads the tree from a check (an object, or JSON text). */
export function dagOf(v: unknown): DagSpec | string[] {
  let spec = v;
  if (typeof v === 'string') {
    try {
      spec = JSON.parse(v);
    } catch {
      return ['the tree is not valid JSON'];
    }
  }
  const problems = dagProblems(spec);
  return problems.length ? problems : (spec as DagSpec);
}

interface Step {
  node: string;
  text: string;
  ok: boolean;
  evidence: string;
}

/** Walks the tree for one sample; returns the leaf's score (0 to 10) with the path taken. */
async function runDag(spec: DagSpec, cfg: CheckConfig, ctx: CheckContext): Promise<{ score: number; steps: Step[]; usage: Usage; reasoning: string; judge?: unknown }> {
  const steps: Step[] = [];
  let usage = noUsage();
  let judge: unknown;
  const notes: string[] = [];
  const host = ctx.services?.ragJudge;
  const t = num(cfg.threshold, 0.5);
  const inputs = new Set(listOf(cfg.inputs) ?? ['question']);
  const sample = () => ({
    ...(inputs.has('question') ? { question: ctx.question ?? '' } : {}),
    answer: ctx.text,
    ...(inputs.has('reference') ? { reference: referenceText(cfg, ctx) ?? '' } : {}),
    ...(inputs.has('contexts') ? { contexts: contextsInput(ctx) } : {}),
    ...(notes.length ? { notes } : {}),
  });
  let at: string | DagBranch = spec.root;
  let hops = 0;
  while (typeof at === 'string') {
    if (++hops > DAG_LIMITS.depth) throw new Error('the tree is deeper than its limit');
    const id: string = at;
    const node = spec.nodes[id] as DagNode;
    let next: DagBranch;
    if (node.type === 'rule') {
      const [r] = await runChecks([node.check as CheckConfig], ctx);
      steps.push({ node: id, text: `rule ${node.check.type}`, ok: !!r?.passed, evidence: r?.message ?? '' });
      next = r?.passed ? node.yes : node.no;
    } else {
      if (!host) throw new Error('the tree has a judged node and no judge model is available here');
      assertJudgeUsable(host, panelOf(cfg, ctx, t).judge);
      if (node.type === 'binary') {
        const r = await judgePanel(host, dagBinary(node.question), sample(), { ...panelOf(cfg, ctx, t), threshold: 0.5 });
        usage = addUsage(usage, r.usage);
        judge ??= r.judge;
        const yes = r.score !== undefined && r.score >= 0.5;
        steps.push({ node: id, text: node.question, ok: yes, evidence: r.items[0]?.evidence ?? r.reasoning });
        next = yes ? node.yes : node.no;
      } else if (node.type === 'choice') {
        const labels = Object.keys(node.options);
        const m = dagChoice(node.question, labels);
        const r = await judgePanel(host, m, sample(), single(panelOf(cfg, ctx, t)));
        usage = addUsage(usage, r.usage);
        judge ??= r.judge;
        const n = r.items[0]?.rating;
        const label = n !== undefined ? labels[n - 1] : undefined;
        if (!label) throw new Error(`the judge did not choose an option at node "${id}"`);
        steps.push({ node: id, text: node.question, ok: true, evidence: `${label}: ${r.items[0]?.evidence ?? ''}` });
        next = node.options[label]!;
      } else {
        const r = await judgePanel(host, dagTask(node.instruction), sample(), single(panelOf(cfg, ctx, t)));
        usage = addUsage(usage, r.usage);
        judge ??= r.judge;
        const out = r.items[0]?.evidence ?? '';
        notes.push(`${id}: ${out}`);
        steps.push({ node: id, text: node.instruction, ok: true, evidence: out });
        next = node.next;
      }
    }
    at = next;
  }
  const leaf = at as { score: number; reason?: string };
  steps.push({ node: '(leaf)', text: `score ${leaf.score} of 10`, ok: leaf.score >= 5, evidence: leaf.reason ?? '' });
  return { score: leaf.score, steps, usage, reasoning: steps.map((s) => `${s.node}: ${textOf(s.evidence).slice(0, 120)}`).join(' → '), judge };
}

registerCheck('dag', async (cfg, ctx) => {
  const spec = dagOf(cfg.tree ?? cfg.dag);
  if (Array.isArray(spec)) return result(cfg, false, `dag has a problem: ${spec[0]}${spec.length > 1 ? ` (and ${spec.length - 1} more)` : ''}`, { source: 'ai-judge', explanation: spec.join('; ') });
  if (!ctx.text.trim()) return na(cfg, { id: 'dag', version: 'dag-v1' }, 'the answer is empty');
  const judgedNodes = Object.values(spec.nodes).some((n) => n.type !== 'rule');
  if (judgedNodes && new Set(listOf(cfg.inputs) ?? ['question']).has('question') && !ctx.question?.trim()) return needsField(cfg, 'dag', 'the question', 'the dataset needs a "question" column, or set "inputs: [answer]" on the check.');
  const m = { id: 'dag', version: 'dag-v1' };
  const body = async (): Promise<CheckResult> => {
    const t = num(cfg.threshold, 0.5);
    const r = await runDag(spec, cfg, ctx);
    const score = round3(r.score / 10);
    const path = r.steps.filter((s) => s.node !== '(leaf)').map((s) => s.node);
    return result(cfg, meets(score, t, 'higher'), `dag ${score}: ${path.join(' → ')} (threshold ${t})`, {
      source: 'ai-judge',
      score,
      explanation: r.reasoning,
      metadata: {
        metric: 'dag',
        promptVersion: m.version,
        threshold: t,
        path,
        items: r.steps.map((s) => ({ text: `${s.node}: ${s.text}`.slice(0, 300), ok: s.ok, evidence: s.evidence.slice(0, 300) })),
        itemLabels: ['yes / done', 'no'],
        ...(r.judge ? judgeMetaLite(r) : {}),
      },
    });
  };
  // a tree of rules only needs no judge; one with a judged node needs the judge service (and says so when it is missing)
  if (!judgedNodes) return body();
  return guarded(cfg, ctx, m, body);
});

const judgeMetaLite = (r: { usage: Usage; judge?: unknown }) => ({ judge: { ...(r.judge as object), cached: r.usage.cached }, judgeUsage: { calls: r.usage.calls, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUsd: r.usage.costUsd, cached: r.usage.cached } });
