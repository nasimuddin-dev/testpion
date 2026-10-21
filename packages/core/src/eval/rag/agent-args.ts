/**
 * Judge comparison of tool-call arguments (`tool-call-accuracy` with `args: judge`, planning/rag-testing.md §2.6): the
 * arguments that are not equal as text are put to the judge in ONE call, which decides for each whether the actual value
 * means the same as the expected one ("2026-10-20" and "20 October 2026"; "NYC" and "New York City"). Equal arguments never
 * reach the judge.
 */
import type { CheckConfig, CheckResult } from '../../model/types.js';
import type { CheckContext } from '../checks.js';
import { assertJudgeUsable, guarded, judgePanel, panelOf, single, type Usage } from './judged-kit.js';
import type { JudgedMetric } from './judge-prompts.js';
import { result } from './metric-util.js';

export const ARGS_EQUIVALENT: JudgedMetric = {
  id: 'tool-call-accuracy',
  version: 'tool-args-equivalent-v1',
  what: 'Whether an argument of a tool call means the same as the expected argument.',
  instruction: [
    'Evaluation task: TOOL ARGUMENT EQUIVALENCE (version tool-args-equivalent-v1). Do the arguments mean the same?',
    '`pairs` lists tool arguments: { id, tool, argument, expected, actual }.',
    'Return one item per pair, in order: `text` is the pair id, `verdict` is true if `actual` means the same thing as `expected` for that argument (the same value in another format or wording: a date written another way, an abbreviation, a number as text, a different order of a list whose order does not matter), false if it is a different value, `reason` is one short phrase.',
    'Judge the value, not the style. A value that is more or less specific than the expected one is not the same.',
  ].join('\n'),
  inputs: ['pairs'],
  noun: 'arguments',
  labels: ['same', 'different'],
  empty: 'na',
};

interface ArgPair {
  id: string;
  tool: string;
  argument: string;
  expected: unknown;
  actual: unknown;
}

interface ArgVerdicts {
  verdicts: Array<{ id: string; same: boolean }>;
  usage: Usage;
  judge: unknown;
  version: string;
}

/** Asks the judge about the arguments that differ; a failed or missing judge is a failing result, not a guess. */
export async function judgeArguments(cfg: CheckConfig, ctx: CheckContext, pairs: ArgPair[]): Promise<ArgVerdicts | CheckResult> {
  const out = await guarded(cfg, ctx, ARGS_EQUIVALENT, async (host) => {
    const panel = single(panelOf(cfg, ctx, 1));
    assertJudgeUsable(host, panel.judge);
    const r = await judgePanel(host, ARGS_EQUIVALENT, { pairs }, panel);
    // the verdicts come back in the order asked; a missing one counts as different
    const verdicts = pairs.map((p, i) => ({ id: p.id, same: r.items[i]?.ok === true }));
    return result(cfg, true, 'judged', { metadata: { verdicts, usage: r.usage, judge: r.judge } });
  });
  const md = out.metadata as { verdicts?: ArgVerdicts['verdicts']; usage?: Usage; judge?: unknown } | undefined;
  if (!md?.verdicts) return out;
  return { verdicts: md.verdicts, usage: md.usage!, judge: md.judge, version: ARGS_EQUIVALENT.version };
}
