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
/** The NAV entry a view is shown as: AI Lab and Evaluations are AI quality. */
export const navIdOf = (v: string): string => (isAiView(v) ? AI_QUALITY : v);
export const isAiView = (v: string): v is AiView => v === 'ai' || v === 'evaluations';
