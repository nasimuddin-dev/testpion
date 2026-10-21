/**
 * The trace of an agent run as the agent metrics read it (planning/rag-testing.md §2.3 type 10): the steps in order, from the
 * conversation transcript when the run was one (an assistant turn that called tools shows them as `tool_call` steps), else from
 * the single exchange (the question, the tool calls the system made, its answer). Deterministic and bounded.
 */
import type { CheckContext } from '../checks.js';
import type { RagToolCall } from './record.js';

export interface TraceStep {
  step: number;
  kind: 'user' | 'assistant' | 'tool_call' | 'tool_result';
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

const MAX_STEPS = 80;
const MAX_TEXT = 4000;

/** The tool calls the run made: the system's own trace (the target’s mapping), else the dataset’s list. */
export const callsOf = (ctx: CheckContext): RagToolCall[] => ctx.toolCalls ?? ctx.record?.toolCalls ?? [];

export function traceOf(ctx: CheckContext): TraceStep[] {
  const steps: TraceStep[] = [];
  const push = (s: Omit<TraceStep, 'step'>) => {
    if (steps.length < MAX_STEPS) steps.push({ step: steps.length + 1, ...s });
  };
  const turns = ctx.record?.turns;
  if (turns?.length) {
    for (const t of turns) {
      if (t.role === 'tool') push({ kind: 'tool_result', text: t.content.slice(0, MAX_TEXT) });
      else {
        if (t.content.trim()) push({ kind: t.role, text: t.content.slice(0, MAX_TEXT) });
        for (const c of t.toolCalls ?? []) push({ kind: 'tool_call', name: c.name, arguments: c.arguments });
      }
    }
    return steps;
  }
  if (ctx.question?.trim()) push({ kind: 'user', text: ctx.question.slice(0, MAX_TEXT) });
  for (const c of callsOf(ctx)) push({ kind: 'tool_call', name: c.name, arguments: c.arguments });
  if (ctx.text?.trim()) push({ kind: 'assistant', text: ctx.text.slice(0, MAX_TEXT) });
  return steps;
}

export const hasToolCalls = (steps: TraceStep[]) => steps.some((s) => s.kind === 'tool_call');
