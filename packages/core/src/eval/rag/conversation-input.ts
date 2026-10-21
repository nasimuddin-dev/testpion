/** A conversation as the judge reads it: every message numbered (turn 1 is the first message), tool results left out. */
import type { ConversationTurn } from './record.js';

export interface ConversationMessage {
  turn: number;
  role: 'user' | 'assistant';
  content: string;
}

export function conversationInput(turns: ConversationTurn[] | undefined): ConversationMessage[] {
  const out: ConversationMessage[] = [];
  for (const t of turns ?? []) {
    if (t.role === 'tool') continue;
    // an assistant message that only called tools is shown as the calls it made, so the judge sees that it acted
    const content = t.content.trim() || (t.toolCalls?.length ? `[called ${t.toolCalls.map((c) => c.name).join(', ')}]` : '');
    if (content) out.push({ turn: out.length + 1, role: t.role, content });
  }
  return out;
}

export const assistantTurns = (c: ConversationMessage[]) => c.filter((m) => m.role === 'assistant');
