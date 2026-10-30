/**
 * AI quality (AU-21) is one rail item over two views: `ai` (Start, Try a prompt, Compare, Bots with sources, Models and keys)
 * and `evaluations` (Checks). The old view ids stay as aliases of its tabs; the rail item opens the one used last.
 */
export type AiView = 'ai' | 'evaluations';

let last: AiView = 'ai';

export const rememberAiView = (v: AiView): void => void (last = v);
export const lastAiView = (): AiView => last;

/** The rail item both views belong to. */
export const AI_QUALITY = 'aiquality';
/** The rail item Bots with sources (R-1): bots, questions, metrics, and the evaluations of type rag under Checks. */
export const BOTS_WITH_SOURCES = 'rag';

/** What the evaluations view shows right now: the Checks of AI quality, or the Checks of Bots with sources (an evaluation of type rag). */
export type EvalHost = 'ai' | 'rag';
let host: EvalHost = 'ai';
export const rememberEvalHost = (h: EvalHost): void => void (host = h);
export const evalHost = (): EvalHost => host;

/** The NAV entry a view is shown as: AI Lab and Evaluations are AI quality, unless Evaluations shows a bot with sources. */
export const navIdOf = (v: string): string => (v === 'evaluations' && host === 'rag' ? BOTS_WITH_SOURCES : isAiView(v) ? AI_QUALITY : v);
export const isAiView = (v: string): v is AiView => v === 'ai' || v === 'evaluations';
