/**
 * The claim-level family (planning/rag-testing.md §2.3, type 4; RAGChecker's metrics and Ragas' noise sensitivity). One
 * extraction splits the answer and the reference into claims, and a few verdict passes check those claims against the
 * reference, the answer and the retrieved documents (claim-passes.ts). Every metric below is arithmetic over those passes, so
 * choosing all eleven costs the passes once, not eleven times:
 *
 *   A = the answer's claims, R = the reference's claims, C = the retrieved chunks;
 *   a claim of A is "right" when the reference states it; a chunk is "relevant" when it holds a claim of R.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { checkFn, registerCheck, type CheckContext } from '../checks.js';
import { answerClaims, answerVsContexts, answerVsReference, chunkRelevance, envOf, referenceClaims, referenceVsAnswer, referenceVsContexts, type Pass, type PassEnv } from './claim-passes.js';
import { addUsage, assertJudgeUsable, contextsInput, guarded, needContexts, needsField, noUsage, referenceText, round3, type Usage } from './judged-kit.js';
import { na } from './judged-kit.js';
import { num, result } from './metric-util.js';

interface Computed {
  /** undefined: not computable, `why` says so. */
  value?: number;
  why?: string;
  items?: Array<{ text: string; ok: boolean; evidence: string }>;
  labels?: [string, string];
  passes: Pass[];
  /** Sub-scores to keep with the result. */
  extra?: Record<string, number>;
}

interface Spec {
  id: string;
  threshold?: number;
  direction: 'higher' | 'lower';
  needs: Array<'answer' | 'reference' | 'contexts'>;
  compute(env: PassEnv, input: { reference: string; docs: Array<{ id: string; text: string }>; answer: string }): Promise<Computed>;
}

const share = (flags: boolean[], pick: (f: boolean, i: number) => boolean = (f) => f) => (flags.length ? flags.filter(pick).length / flags.length : 0);

const itemsOf = (p: Pass, ok: (i: number) => boolean, evidence: (i: number) => string) => p.texts.map((t, i) => ({ text: t, ok: ok(i), evidence: evidence(i) }));

const SPECS: Spec[] = [
  {
    id: 'claim-precision',
    threshold: 0.7,
    direction: 'higher',
    needs: ['answer', 'reference'],
    async compute(env, { reference }) {
      const a = await answerClaims(env);
      if (!a.texts.length) return { why: 'the answer makes no factual claims', passes: [a] };
      const v = await answerVsReference(env, a.texts, reference);
      return { value: share(v.flags), items: itemsOf(v, (i) => v.flags[i]!, (i) => v.items[i]?.evidence ?? ''), labels: ['in the reference', 'not in the reference'], passes: [a, v] };
    },
  },
  {
    id: 'claim-recall',
    threshold: 0.7,
    direction: 'higher',
    needs: ['answer', 'reference'],
    async compute(env, { reference, answer }) {
      const r = await referenceClaims(env, reference);
      if (!r.texts.length) return { why: 'the reference makes no factual claims', passes: [r] };
      const v = await referenceVsAnswer(env, r.texts, answer);
      return { value: share(v.flags), items: itemsOf(v, (i) => v.flags[i]!, (i) => v.items[i]?.evidence ?? ''), labels: ['in the answer', 'missing'], passes: [r, v] };
    },
  },
  {
    id: 'claim-f1',
    threshold: 0.7,
    direction: 'higher',
    needs: ['answer', 'reference'],
    async compute(env, { reference, answer }) {
      const [a, r] = await Promise.all([answerClaims(env), referenceClaims(env, reference)]);
      if (!r.texts.length) return { why: 'the reference makes no factual claims', passes: [a, r] };
      const [pv, rv] = await Promise.all([a.texts.length ? answerVsReference(env, a.texts, reference) : Promise.resolve(undefined), referenceVsAnswer(env, r.texts, answer)]);
      const p = pv ? share(pv.flags) : 0;
      const rc = share(rv.flags);
      return { value: p + rc ? (2 * p * rc) / (p + rc) : 0, extra: { precision: round3(p), recall: round3(rc) }, passes: [a, r, ...(pv ? [pv] : []), rv] };
    },
  },
  {
    id: 'retriever-claim-recall',
    threshold: 0.8,
    direction: 'higher',
    needs: ['reference', 'contexts'],
    async compute(env, { reference, docs }) {
      const r = await referenceClaims(env, reference);
      if (!r.texts.length) return { why: 'the reference makes no factual claims', passes: [r] };
      const v = await referenceVsContexts(env, r.texts, docs);
      return { value: share(v.flags), items: itemsOf(v, (i) => v.flags[i]!, (i) => v.items[i]?.evidence ?? ''), labels: ['in the documents', 'not retrieved'], passes: [r, v] };
    },
  },
  {
    id: 'retriever-context-precision',
    threshold: 0.5,
    direction: 'higher',
    needs: ['reference', 'contexts'],
    async compute(env, { reference, docs }) {
      const r = await referenceClaims(env, reference);
      if (!r.texts.length) return { why: 'the reference makes no factual claims', passes: [r] };
      const c = await chunkRelevance(env, r.texts, docs);
      return { value: share(c.flags), items: docs.map((d, i) => ({ text: d.id, ok: c.flags[i] === true, evidence: c.items[i]?.evidence ?? '' })), labels: ['relevant', 'irrelevant'], passes: [r, c] };
    },
  },
  {
    id: 'context-utilization-claims',
    threshold: 0.6,
    direction: 'higher',
    needs: ['answer', 'reference', 'contexts'],
    async compute(env, { reference, docs, answer }) {
      const r = await referenceClaims(env, reference);
      if (!r.texts.length) return { why: 'the reference makes no factual claims', passes: [r] };
      const [inC, inA] = await Promise.all([referenceVsContexts(env, r.texts, docs), referenceVsAnswer(env, r.texts, answer)]);
      const held = r.texts.map((_, i) => inC.flags[i]!);
      const heldCount = held.filter(Boolean).length;
      if (!heldCount) return { why: 'no claim of the reference is in the retrieved documents', passes: [r, inC, inA] };
      const used = r.texts.map((_, i) => held[i]! && inA.flags[i]!);
      return { value: used.filter(Boolean).length / heldCount, items: r.texts.map((t, i) => ({ text: t, ok: used[i]!, evidence: held[i] ? (inA.flags[i] ? 'in the documents and in the answer' : 'in the documents, left out of the answer') : 'not in the documents' })), labels: ['used', 'not used'], passes: [r, inC, inA] };
    },
  },
  {
    id: 'claim-faithfulness',
    threshold: 0.8,
    direction: 'higher',
    needs: ['answer', 'contexts'],
    async compute(env, { docs }) {
      const a = await answerClaims(env);
      if (!a.texts.length) return { why: 'the answer makes no factual claims', passes: [a] };
      const v = await answerVsContexts(env, 'all', a.texts, docs);
      return { value: share(v.flags), items: itemsOf(v, (i) => v.flags[i]!, (i) => v.items[i]?.evidence ?? ''), labels: ['in the documents', 'not in the documents'], passes: [a, v] };
    },
  },
  {
    id: 'claim-hallucination',
    threshold: 0.2,
    direction: 'lower',
    needs: ['answer', 'reference', 'contexts'],
    async compute(env, { reference, docs }) {
      const a = await answerClaims(env);
      if (!a.texts.length) return { why: 'the answer makes no factual claims', passes: [a] };
      const [inRef, inCtx] = await Promise.all([answerVsReference(env, a.texts, reference), answerVsContexts(env, 'all', a.texts, docs)]);
      const made = a.texts.map((_, i) => !inRef.flags[i]! && !inCtx.flags[i]!);
      return { value: share(made), items: a.texts.map((t, i) => ({ text: t, ok: !made[i], evidence: made[i] ? 'in neither the reference nor the documents' : inRef.flags[i] ? 'in the reference' : 'in the documents' })), labels: ['grounded', 'made up'], passes: [a, inRef, inCtx] };
    },
  },
  {
    id: 'self-knowledge',
    direction: 'higher',
    needs: ['answer', 'reference', 'contexts'],
    async compute(env, { reference, docs }) {
      const a = await answerClaims(env);
      if (!a.texts.length) return { why: 'the answer makes no factual claims', passes: [a] };
      const [inRef, inCtx] = await Promise.all([answerVsReference(env, a.texts, reference), answerVsContexts(env, 'all', a.texts, docs)]);
      const own = a.texts.map((_, i) => inRef.flags[i]! && !inCtx.flags[i]!);
      return { value: share(own), items: a.texts.map((t, i) => ({ text: t, ok: own[i]!, evidence: own[i] ? 'right, but not from the documents' : inCtx.flags[i] ? 'from the documents' : 'not right' })), labels: ['from the model’s own knowledge', 'other'], passes: [a, inRef, inCtx] };
    },
  },
];

/** Noise sensitivity (Ragas): the answer’s wrong claims that a chunk of the given kind supports, over all the answer’s claims. */
const noise = (which: 'relevant' | 'irrelevant'): Spec => ({
  id: `noise-sensitivity-${which}`,
  threshold: which === 'relevant' ? 0.25 : 0.1,
  direction: 'lower',
  needs: ['answer', 'reference', 'contexts'],
  async compute(env, { reference, docs }) {
    const [a, r] = await Promise.all([answerClaims(env), referenceClaims(env, reference)]);
    if (!a.texts.length) return { why: 'the answer makes no factual claims', passes: [a, r] };
    if (!r.texts.length) return { why: 'the reference makes no factual claims', passes: [a, r] };
    const [inRef, rel] = await Promise.all([answerVsReference(env, a.texts, reference), chunkRelevance(env, r.texts, docs)]);
    const subset = docs.filter((_, i) => (which === 'relevant' ? rel.flags[i] === true : rel.flags[i] !== true));
    const supported = subset.length ? await answerVsContexts(env, which, a.texts, subset) : undefined;
    const noisy = a.texts.map((_, i) => !inRef.flags[i]! && supported?.flags[i] === true);
    return {
      value: share(noisy),
      items: a.texts.map((t, i) => ({ text: t, ok: !noisy[i], evidence: noisy[i] ? `wrong, and a ${which} chunk supports it` : inRef.flags[i] ? 'right' : 'wrong, but no ' + which + ' chunk supports it' })),
      labels: ['fine', 'misled by noise'],
      extra: { relevantChunks: rel.flags.filter(Boolean).length, chunks: docs.length },
      passes: [a, r, inRef, rel, ...(supported ? [supported] : [])],
    };
  },
});

function claimCheck(spec: Spec) {
  return (cfg: CheckConfig, ctx: CheckContext): Promise<CheckResult> =>
    guarded(cfg, ctx, { id: spec.id, version: `${spec.id}-v1` }, async (host) => {
      const reference = referenceText(cfg, ctx) ?? '';
      const docs = contextsInput(ctx);
      for (const n of spec.needs) {
        if (n === 'reference' && !reference) return needsField(cfg, spec.id, 'a reference answer', 'add a "reference" column to the dataset (or set "expected" on the check).');
        if (n === 'contexts' && !docs.length) return needContexts(cfg, spec.id);
        if (n === 'answer' && !ctx.text.trim()) return na(cfg, { id: spec.id, version: `${spec.id}-v1` }, 'the answer is empty');
      }
      const t = num(cfg.threshold, spec.threshold ?? 0);
      const env = envOf(cfg, ctx, host, t, spec.direction, spec.id);
      assertJudgeUsable(host, env.panel.judges?.[0] ?? env.panel.judge);
      const c = await spec.compute(env, { reference, docs, answer: ctx.text });
      const usage = c.passes.reduce<Usage>((a, p) => addUsage(a, p.usage), noUsage());
      const judge = c.passes.find((p) => p.judge.provider)?.judge ?? c.passes[0]?.judge;
      const jury = c.passes.find((p) => p.jury)?.jury;
      const meta = { metric: spec.id, promptVersion: `${spec.id}-v1`, judgeUsage: usage, ...(jury ? { panel: { judges: jury.judges, aggregate: jury.aggregate, agreement: jury.agreement } } : {}), ...(judge ? { judge: { ...judge, cached: usage.cached } } : {}), threshold: t, shared: c.passes.length ? 'claim-passes' : undefined, ...(c.items ? { items: c.items.map((i) => ({ ...i, evidence: i.evidence.slice(0, 300) })), itemLabels: c.labels ?? ['yes', 'no'] } : {}), ...(c.extra ? { subScores: c.extra } : {}) };
      if (c.value === undefined) return na(cfg, { id: spec.id, version: `${spec.id}-v1` }, c.why ?? 'nothing to compute', { metadata: meta });
      const score = round3(c.value);
      const passed = spec.threshold === undefined ? true : spec.direction === 'lower' ? score <= t : score >= t;
      return result(cfg, passed, `${spec.id} ${score}${c.items ? `: ${c.items.filter((i) => i.ok).length} of ${c.items.length} ${c.labels?.[0] ?? 'yes'}` : ''}${spec.threshold === undefined ? '' : ` (${spec.direction === 'lower' ? 'at most' : 'threshold'} ${t})`}`, { source: 'ai-judge', score, metadata: meta });
    });
}

const CLAIM_SPECS: readonly Spec[] = [...SPECS, noise('relevant'), noise('irrelevant')];
for (const s of CLAIM_SPECS) {
  const run = claimCheck(s);
  // Ragas' one `noise_sensitivity` takes `mode: relevant | irrelevant`: either id answers to either mode
  registerCheck(
    s.id,
    s.id.startsWith('noise-sensitivity-')
      ? (cfg, ctx) => {
          const to = cfg.mode === 'relevant' || cfg.mode === 'irrelevant' ? `noise-sensitivity-${cfg.mode}` : s.id;
          return to === s.id ? run(cfg, ctx) : checkFn(to)!(cfg, ctx);
        }
      : run,
  );
}
