/**
 * Running a conversation against a RAG target (planning/rag-testing.md §4a "Multi-turn"): a dataset record with `turns`
 * is replayed turn by turn in ONE lane (turns of one conversation never run in parallel; the evaluation's concurrency is
 * across conversations). Each user message is sent as the question; the system's answer (and what it retrieved, the tools
 * it called) becomes the assistant turn, and the next request carries the conversation as the target's mapping says:
 *
 *  - `stateless-history` (default): the request template uses `{{history}}` (the earlier messages as `[{role, content}]`),
 *    `{{messages}}` (the same plus the current message, ready for an OpenAI-style body) or `{{historyText}}` ("User: …");
 *  - `server-session`: the mapping reads the conversation id from each response (`conversationId`), and the next request
 *    uses `{{conversationId}}` (empty on the first turn).
 *
 * The transcript, with the system's own answers, is what the conversational metrics judge; the last turn's answer and
 * contexts are the sample the single-turn metrics score (and `per-turn:<metric>` scores every turn).
 */
import type { RagTarget, RagToolCallRef } from '@testpion/shared';
import type { VariableScope } from '../../vars/variables.js';
import { callTarget, type TargetCall, type TargetRunner } from './run-target.js';
import type { ConversationTurn } from './record.js';

export const MAX_USER_TURNS = 30;

/** The user messages of a record's turns: what to send, in order. */
export const userMessages = (turns: ConversationTurn[] | undefined): string[] => (turns ?? []).filter((t) => t.role === 'user' && t.content.trim()).map((t) => t.content).slice(0, MAX_USER_TURNS);

/** The history variables of a request: the messages before the current user message. */
export function historyVars(history: ConversationTurn[], current: string, conversationId: string, turn: number): Record<string, unknown> {
  const plain = history.filter((t) => t.role !== 'tool').map((t) => ({ role: t.role, content: t.content }));
  return {
    history: plain,
    historyJson: JSON.stringify(plain),
    historyText: plain.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n'),
    messages: [...plain, { role: 'user', content: current }],
    conversationId,
    turn,
  };
}

export interface ConversationRun {
  /** The whole conversation: each user message and the system's answer to it. */
  turns: ConversationTurn[];
  calls: TargetCall[];
  /** The tool calls of every turn, in order. */
  toolCalls: RagToolCallRef[];
  /** The last server-side conversation id the system returned. */
  conversationId?: string;
  latencyMs: number;
}

/** Replays `messages` against the target; a turn that fails stops the conversation with the turn named. */
export async function runConversation(target: RagTarget, messages: string[], scope: VariableScope, run: TargetRunner, extraVars: Record<string, unknown> = {}): Promise<ConversationRun> {
  const turns: ConversationTurn[] = [];
  const calls: TargetCall[] = [];
  const toolCalls: RagToolCallRef[] = [];
  let conversationId = '';
  let latencyMs = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    let call: TargetCall;
    try {
      call = await callTarget(target, msg, scope, run, { ...extraVars, ...historyVars(turns, msg, conversationId, i + 1) });
    } catch (e) {
      const err = e as Error & { message: string };
      err.message = `turn ${i + 1} of ${messages.length} ("${msg.slice(0, 60)}"): ${err.message}`;
      throw err;
    }
    calls.push(call);
    latencyMs += call.latencyMs;
    if (call.sample.conversationId) conversationId = call.sample.conversationId;
    turns.push({ role: 'user', content: msg });
    for (const tc of call.sample.toolCalls ?? []) toolCalls.push(tc);
    turns.push({
      role: 'assistant',
      content: call.sample.answer,
      ...(call.sample.toolCalls?.length ? { toolCalls: call.sample.toolCalls } : {}),
      ...(call.sample.contexts.length ? { contexts: call.sample.contexts.slice(0, 20).map((d) => ({ id: d.id, text: d.text.slice(0, 8000), ...(d.score !== undefined ? { score: d.score } : {}) })) } : {}),
    });
  }
  return { turns, calls, toolCalls, ...(conversationId ? { conversationId } : {}), latencyMs };
}

/** The (user, assistant) pairs of a transcript: what per-turn metrics score one by one. */
export function turnPairs(turns: ConversationTurn[] | undefined): Array<{ index: number; question: string; answer: string; turn: ConversationTurn }> {
  const out: Array<{ index: number; question: string; answer: string; turn: ConversationTurn }> = [];
  let lastUser = '';
  (turns ?? []).forEach((t) => {
    if (t.role === 'user') lastUser = t.content;
    else if (t.role === 'assistant') out.push({ index: out.length + 1, question: lastUser, answer: t.content, turn: t });
  });
  return out;
}
