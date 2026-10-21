/**
 * The passes of the claim-based metrics (planning/rag-testing.md §2.3, types 3 and 4), asked once per sample and shared:
 * the answer split into claims, the reference split into claims, and the verdicts of those claims against the reference, the
 * answer and the retrieved documents. Factual correctness, answer correctness, the RAGChecker family and noise sensitivity
 * all read them. A pass is remembered for the sample (the same check context), so selecting five claim metrics costs the
 * passes once; the judge cache makes a later run free as well. The first metric to read a pass is charged for its calls.
 */
import type { CheckConfig } from '../../model/types.js';
import type { CheckContext } from '../checks.js';
import { CLAIMS } from './judge-prompts-more.js';
import { FAITHFULNESS_ON_CLAIMS } from './judge-prompts-more.js';
import type { JudgedMetric } from './judge-prompts.js';
import { addUsage, judgePanel, noUsage, panelOf, round3, single, type JudgeHost, type PanelItem, type PanelOptions, type Usage } from './judged-kit.js';
import { CHUNK_RELEVANCE, CLAIMS_OF_REFERENCE, CLAIMS_VS_REFERENCE, REFERENCE_CLAIMS_IN_CONTEXTS, REFERENCE_CLAIMS_VS_ANSWER } from './prompts-r2.js';

export interface Pass {
  /** The claims (or documents) the verdicts are about, in order. */
  texts: string[];
  /** One verdict per text; a text the judge did not return a verdict for is false. */
  flags: boolean[];
  items: PanelItem[];
  usage: Usage;
  redactions: number;
  judge: { provider: string; model: string; metric: string; promptVersion: string };
  reasoning: string;
  /** A verdict pass asked of a jury: each judge's share of "yes" and how often the judges agreed claim by claim. */
  jury?: { judges: Array<{ provider: string; model: string; score: number; passed: boolean }>; aggregate: string; agreement: number };
}

/** What a metric needs to ask a pass: the host, the sample and the judge options. */
export interface PassEnv {
  host: JudgeHost;
  ctx: CheckContext;
  panel: PanelOptions;
  /** The metric asking: the first one to read a pass is charged for it. */
  reader: string;
}

const memo = new WeakMap<object, Map<string, { promise: Promise<Pass>; charged: boolean }>>();

async function remembered(env: PassEnv, key: string, run: () => Promise<Pass>): Promise<Pass> {
  let m = memo.get(env.ctx);
  if (!m) memo.set(env.ctx, (m = new Map()));
  let hit = m.get(key);
  if (!hit) {
    hit = { promise: run(), charged: false };
    m.set(key, hit);
  }
  const pass = await hit.promise;
  if (hit.charged) return { ...pass, usage: { ...noUsage(), cached: true } };
  hit.charged = true;
  return pass;
}

/** The first judge only, once: used for the extraction of claims (a jury votes on the verdicts about them, see verdicts). */
const ask = async (env: PassEnv, m: JudgedMetric, input: Record<string, unknown>, panel: PanelOptions, texts: (r: Awaited<ReturnType<typeof judgePanel>>) => string[]): Promise<Pass> => {
  const r = await judgePanel(env.host, m, input, panel);
  const items = r.items;
  return { texts: texts(r), flags: items.map((i) => i.ok), items, usage: r.usage, redactions: r.redactionCount, judge: r.judge, reasoning: r.reasoning };
};

/** A dry run answers with no claims; a stand-in lets the prompts that depend on them show what they would send. */
const placeholder = (env: PassEnv, p: Pass, text: string): Pass => (env.host.dry && !p.texts.length ? { ...p, texts: [text] } : p);

export const answerClaims = (env: PassEnv): Promise<Pass> =>
  remembered(env, 'answer-claims', async () => placeholder(env, await ask(env, CLAIMS, { answer: env.ctx.text }, single(env.panel), (r) => r.items.map((i) => i.text)), '(a claim of the answer)'));

export const referenceClaims = (env: PassEnv, reference: string): Promise<Pass> =>
  remembered(env, 'reference-claims', async () => placeholder(env, await ask(env, CLAIMS_OF_REFERENCE, { reference }, single(env.panel), (r) => r.items.map((i) => i.text)), '(a claim of the reference)'));

/** Verdicts for `texts` (claims, or documents) under a prompt that reads them as `claims` next to the other fields. */
async function verdicts(env: PassEnv, key: string, m: JudgedMetric, input: Record<string, unknown>, texts: string[]): Promise<Pass> {
  return remembered(env, key, async () => {
    if (!texts.length) return { texts, flags: [], items: [], usage: noUsage(), redactions: 0, judge: { provider: '', model: '', metric: m.id, promptVersion: m.version }, reasoning: '' };
    const judges = env.panel.judges ?? [];
    // the judge answers in the order it was given; a missing verdict is a "no"
    const flagsOf = (p: Pass) => texts.map((_, i) => p.items[i]?.ok === true);
    if (judges.length < 2) {
      const p = await ask(env, m, input, single(env.panel), () => texts);
      return { ...p, texts, flags: flagsOf(p) };
    }
    // a jury votes claim by claim; the extraction of the claims stays with the first judge
    const parts = await Promise.all(judges.map((j) => ask(env, m, input, single({ ...env.panel, judges: [j] }), () => texts)));
    const votes = parts.map(flagsOf);
    const how = env.panel.aggregate ?? 'majority';
    const count = (i: number) => votes.filter((v) => v[i]).length;
    // majority: more than half say yes (a tie goes to "no"); mean: half or more; min: every judge says yes
    const flags = texts.map((_, i) => (how === 'min' ? count(i) === votes.length : how === 'mean' ? count(i) * 2 >= votes.length : count(i) * 2 > votes.length));
    const first = parts[0]!;
    const items = first.items.map((it, i) => ({ ...it, ok: flags[i] ?? false, evidence: `${count(i)} of ${votes.length} judges: ${it.evidence}`.slice(0, 300) }));
    const jury = parts.map((p, i) => ({ provider: p.judge.provider, model: p.judge.model, score: round3(votes[i]!.filter(Boolean).length / Math.max(1, texts.length)), passed: votes[i]!.length > 0 && votes[i]!.every(Boolean) }));
    const usage = parts.reduce<Usage>((a, p) => addUsage(a, p.usage), noUsage());
    return { texts, flags, items, usage, redactions: Math.max(...parts.map((p) => p.redactions)), judge: first.judge, reasoning: first.reasoning, jury: { judges: jury, aggregate: how, agreement: round3(texts.length ? texts.filter((_, i) => count(i) === 0 || count(i) === votes.length).length / texts.length : 1) } };
  });
}

/** Each claim of the answer: does the reference state it? */
export const answerVsReference = (env: PassEnv, claims: string[], reference: string) => verdicts(env, `a-vs-ref:${claims.join('')}`, CLAIMS_VS_REFERENCE, { claims, reference }, claims);
/** Each claim of the reference: does the answer make it? */
export const referenceVsAnswer = (env: PassEnv, claims: string[], answer: string) => verdicts(env, `ref-vs-a:${claims.join('')}`, REFERENCE_CLAIMS_VS_ANSWER, { claims, answer }, claims);
/** Each claim of the answer: do these documents support it? (`which` names the subset in the key.) */
export const answerVsContexts = (env: PassEnv, which: string, claims: string[], contexts: Array<{ id: string; text: string }>) => verdicts(env, `a-vs-ctx:${which}:${claims.join('')}`, FAITHFULNESS_ON_CLAIMS, { claims, contexts }, claims);
/** Each claim of the reference: do the documents hold it? */
export const referenceVsContexts = (env: PassEnv, claims: string[], contexts: Array<{ id: string; text: string }>) => verdicts(env, `ref-vs-ctx:${claims.join('')}`, REFERENCE_CLAIMS_IN_CONTEXTS, { claims, contexts }, claims);
/** Each document: does it hold at least one claim of the reference? */
export const chunkRelevance = (env: PassEnv, claims: string[], contexts: Array<{ id: string; text: string }>) => verdicts(env, `chunk-rel:${claims.join('')}`, CHUNK_RELEVANCE, { claims, contexts }, contexts.map((c) => c.id));

export const envOf = (cfg: CheckConfig, ctx: CheckContext, host: JudgeHost, threshold: number, direction: 'higher' | 'lower', reader: string): PassEnv => ({ host, ctx, panel: panelOf(cfg, ctx, threshold, direction), reader });

export { addUsage };
