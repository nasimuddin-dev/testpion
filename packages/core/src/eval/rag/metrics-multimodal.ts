/**
 * Multimodal faithfulness and relevance (planning/rag-testing.md §2.3 type 12, §4j): the judge looks at the pictures of the
 * sample (retrieved chunks that are images, and the question's own) together with the texts. Ragas parity: one verdict, 1 or 0
 * (`mode: binary`); `mode: claims` splits the answer into claims and names the picture or text that decides each.
 *
 * Pictures are sent AS DATA and only when the evaluation allows it (`allowImages`), at the AI privacy level that sends content,
 * to a judge that can see; any other case is "n/a" with the reason, never a score from a prompt that lost its pictures.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import { registerCheck, type CheckContext } from '../checks.js';
import { defaultImageSource, imageMeta, imageRefOf, loadImages, sampleImageRefs, toChatImages } from './images.js';
import { assertJudgeUsable, describe, guarded, judgeMeta, judgePanel, meets, na, needsField, panelOf, round3 } from './judged-kit.js';
import type { JudgedMetric } from './judge-prompts.js';
import { MULTIMODAL_FAITHFULNESS, MULTIMODAL_FAITHFULNESS_CLAIMS, MULTIMODAL_RELEVANCE } from './prompts-multimodal.js';
import { num, result } from './metric-util.js';

/** What the judge is shown of a sample with pictures: the texts by id, the pictures numbered in the order they are attached. */
function mmInput(ctx: CheckContext, images: ReturnType<typeof imageMeta>) {
  let n = 0;
  const contexts = (ctx.contexts ?? []).map((d) => {
    const img = imageRefOf(d);
    const isOnlyImage = img !== undefined && (!d.text.trim() || d.text.trim() === img);
    if (img) n++;
    return { id: d.id, text: isOnlyImage ? `[image ${n}]` : d.text + (img ? ` [image ${n}]` : '') };
  });
  return { contexts, images: images.map((i, k) => ({ n: k + 1, from: i.from, type: i.mime })) };
}

async function run(cfg: CheckConfig, ctx: CheckContext, m: JudgedMetric, o: { id: string; threshold: number; question: boolean }): Promise<CheckResult> {
  return guarded(cfg, ctx, m, async (host) => {
    if (!ctx.text.trim()) return na(cfg, m, 'the answer is empty');
    if (o.question && !ctx.question?.trim()) return needsField(cfg, o.id, 'the question', 'the dataset needs a "question" column.');
    // images cannot be redacted: sent only when the evaluation says so
    if (ctx.judge?.allowImages !== true) return na(cfg, m, 'this evaluation does not send images to the judge (turn on "Send images to the judge"; CLI --allow-images)', { metadata: { na: 'images-not-allowed', metric: m.id, promptVersion: m.version } });
    const refs = sampleImageRefs(ctx.question, ctx.record?.images, ctx.contexts);
    if (!refs.length) return na(cfg, m, 'the sample has no images: map the image of a context in the RAG target, or put image URLs, paths or data URIs in the contexts');
    const set = await loadImages(refs, ctx.services?.imageSource ?? defaultImageSource(ctx.workspaceRoot));
    if (set.problem) return na(cfg, m, set.problem, { metadata: { na: 'image-limit', metric: m.id, promptVersion: m.version } });
    const t = num(cfg.threshold, o.threshold);
    const panel = panelOf(cfg, ctx, t);
    const route = assertJudgeUsable(host, panel.judges?.[0] ?? panel.judge);
    if (!route.vision) return na(cfg, m, `the judge ${route.provider}/${route.model} cannot see images: choose a vision-capable judge (a local Ollama vision model works) or list the model in the provider’s visionModels`, { metadata: { na: 'judge-not-vision', metric: m.id, promptVersion: m.version } });
    const meta = imageMeta(set.images);
    const shown = mmInput(ctx, meta);
    const input = { ...(o.question ? { question: ctx.question } : {}), answer: ctx.text, ...shown, __images: toChatImages(set.images), __allowImages: true };
    const r = await judgePanel(host, m, input, panel);
    if (r.score === undefined) return na(cfg, m, 'the judge returned no verdict', { explanation: r.reasoning, metadata: judgeMeta(m, r, t) });
    const score = round3(r.score);
    const passed = meets(score, t, 'higher') && !r.panel?.swap?.tie;
    const extra = { promptVersion: m.version, images: meta, ...(set.omitted ? { imagesOmitted: set.omitted } : {}) };
    const note = set.omitted ? ` (${set.omitted} more image(s) over the limit of 16 were left out)` : '';
    return result(cfg, passed, `${describe(m, score, r, t, o.id)} · ${meta.length} image(s) sent as data${note}`, { source: 'ai-judge', score, explanation: r.reasoning, metadata: judgeMeta(m, r, t, extra) });
  });
}

registerCheck('multimodal-faithfulness', (cfg, ctx) => run(cfg, ctx, cfg.mode === 'claims' ? MULTIMODAL_FAITHFULNESS_CLAIMS : MULTIMODAL_FAITHFULNESS, { id: 'multimodal-faithfulness', threshold: cfg.mode === 'claims' ? 0.8 : 1, question: false }));
registerCheck('multimodal-relevance', (cfg, ctx) => run(cfg, ctx, MULTIMODAL_RELEVANCE, { id: 'multimodal-relevance', threshold: 1, question: true }));
