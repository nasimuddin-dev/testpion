/**
 * A simulated user for a conversation (planning/ai-research-2026-11-11.md N-1): instead of replaying scripted turns, a
 * model plays a user with a persona and a goal it does not reveal as a goal. It talks to the system under test until
 * the goal is met, it gives up, or the turn limit is reached.
 *
 * A dataset record asks for it with a `persona` column (a preset id below, or a description in words) or
 * `simulate: true`, together with what the user wants (`goal` / `expected_outcome`). `max_turns` limits the user's
 * messages (default 6, at most 30). The question of the record, when it has one, is the user's first message.
 *
 * The user is the registered AI task `simulate-user`, asked through the run's judge host: the same model choice, the
 * same redaction, usage ledger, caps and judge budget as a judged metric. There is no silent fallback: without a usable
 * model the sample fails with what to configure. Its messages are NOT cached: a simulation is a fresh conversation.
 */
import { ApsError } from '../../errors.js';
import { validateSchema } from '../checks.js';
import { assertJudgeUsable, type JudgeRef, type RagJudgeHost } from './judge.js';
import type { ConversationTurn, RagRecord } from './record.js';
import { SIMULATE_USER_SCHEMA } from './simulate-prompt.js';

export const SIMULATE_DEFAULT_TURNS = 6;
export const SIMULATE_MAX_TURNS = 30;

/** Ways of talking a user may have: the same goal asked by each shows how robust the system is. */
export const PERSONAS: ReadonlyArray<{ id: string; label: string; text: string }> = [
  { id: 'plain', label: 'Plain', text: 'A cooperative user who writes clear, complete sentences and answers what is asked.' },
  { id: 'terse', label: 'Terse', text: 'A user in a hurry who writes a few words at a time, leaves details out until asked, and never repeats what was already said.' },
  { id: 'confused', label: 'Confused', text: 'A user who is unsure of the right words, mixes up terms, and sometimes misunderstands an answer and asks about it again.' },
  { id: 'impatient', label: 'Impatient', text: 'A frustrated user who has little patience, complains when an answer is long or misses the point, and gives up after two unhelpful answers in a row.' },
  { id: 'wandering', label: 'Wandering', text: 'A talkative user who adds side remarks and one unrelated question along the way, but still wants the goal.' },
  { id: 'changing', label: 'Changes their mind', text: 'A user who corrects an earlier detail halfway through (a date, a name, a quantity) and expects the system to use the new one.' },
];

export interface SimulationSpec {
  /** The persona in words (a preset's text, or the record's own). */
  persona: string;
  /** The preset's id when the record named one. */
  personaId?: string;
  goal: string;
  maxTurns: number;
}

export type SimulationEnd = 'goal-met' | 'gave-up' | 'turn-limit';

/** What a result keeps of a simulation (beside the transcript). */
export interface SimulationOutcome {
  persona: string;
  personaId?: string;
  goal: string;
  ended: SimulationEnd;
  /** The simulated user's own reason for stopping (empty at the turn limit). */
  reason: string;
  userTurns: number;
  model?: string;
}

/** The simulation a record asks for, or undefined (a record with scripted turns is replayed, never simulated). */
export function simulationOf(vars: Record<string, unknown> | undefined, record: RagRecord | undefined): SimulationSpec | undefined {
  if (!vars || record?.turns?.length) return undefined;
  const raw = typeof vars.persona === 'string' ? vars.persona.trim() : '';
  const on = vars.simulate === true || /^(true|yes|1)$/i.test(String(vars.simulate ?? '').trim());
  if (!raw && !on) return undefined;
  const goal = record?.expectedOutcome?.trim();
  if (!goal) throw new ApsError('ValidationError', 'A simulated user needs a goal', { why: 'The record has a persona (or simulate: true) but no "goal" or "expected_outcome" column, so the simulated user would not know what it wants or when to stop.', suggestions: ['Add a "goal" column: what the user wants to achieve, in words.'] });
  const preset = raw ? PERSONAS.find((p) => p.id === raw.toLowerCase()) : PERSONAS[0];
  const n = Number(vars.max_turns ?? vars.maxTurns);
  const maxTurns = Number.isFinite(n) && n >= 1 ? Math.min(SIMULATE_MAX_TURNS, Math.floor(n)) : SIMULATE_DEFAULT_TURNS;
  return { persona: preset?.text ?? raw, ...(preset ? { personaId: preset.id } : {}), goal: goal.slice(0, 4000), maxTurns };
}

interface UserMove {
  status: 'continue' | 'goal-met' | 'gave-up';
  message: string;
  reason: string;
}

const transcriptText = (turns: ConversationTurn[]): string =>
  turns
    .filter((t) => t.role !== 'tool')
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.slice(0, 4000)}`)
    .join('\n');

/** Asks the simulated user for its next move (one model call, counted in the run's judge budget). */
export async function nextUserMove(host: RagJudgeHost, spec: SimulationSpec, turns: ConversationTurn[], o: { judge?: JudgeRef; signal?: AbortSignal } = {}): Promise<UserMove & { model: string }> {
  assertJudgeUsable(host, o.judge);
  const { maxCalls, maxCostUsd } = o.judge ?? {};
  if (maxCalls !== undefined && host.budget.calls >= maxCalls) throw new ApsError('ValidationError', `The judge budget is used up (${host.budget.calls} of ${maxCalls} model calls); the simulated user cannot continue`, { details: { budget: true } });
  if (maxCostUsd !== undefined && host.budget.costUsd >= maxCostUsd) throw new ApsError('ValidationError', `The judge budget is used up ($${host.budget.costUsd.toFixed(4)} of $${maxCostUsd}); the simulated user cannot continue`, { details: { budget: true } });
  const deps = { ...host.deps, signal: o.signal ?? host.deps.signal };
  const r = await host.tasks.run(deps, { task: 'simulate-user', context: { persona: spec.persona, goal: spec.goal, transcript: transcriptText(turns) }, provider: o.judge?.provider, model: o.judge?.model });
  host.budget.calls += r.calls;
  host.budget.inputTokens += r.usage.inputTokens;
  host.budget.outputTokens += r.usage.outputTokens;
  host.budget.costUsd += r.costUsd ?? 0;
  const problems = r.problems.length ? r.problems : r.value === undefined ? ['no JSON'] : validateSchema(SIMULATE_USER_SCHEMA as unknown as Record<string, unknown>, r.value).errors;
  const move = r.value as UserMove | undefined;
  if (!move || problems.length || (move.status === 'continue' && !move.message.trim()))
    throw new ApsError('ValidationError', `The simulated user (${r.provider}/${r.model}) did not answer in its format: ${problems.slice(0, 3).join('; ') || 'continue without a message'}`, { suggestions: ['Use a stronger model for the judge of this evaluation (the simulated user runs on it).'] });
  return { status: move.status, message: move.message.trim().slice(0, 8000), reason: String(move.reason ?? '').slice(0, 500), model: `${r.provider}/${r.model}` };
}

/**
 * The source of user messages of a simulated conversation, for `runConversation`: called with the transcript so far, it
 * gives the next message or undefined when the conversation is over. `outcome()` says how it ended.
 */
export function simulatedUser(host: RagJudgeHost | undefined, spec: SimulationSpec, o: { opening?: string; judge?: JudgeRef; signal?: AbortSignal } = {}): { next: (turns: ConversationTurn[]) => Promise<string | undefined>; outcome: () => SimulationOutcome } {
  if (!host) throw new ApsError('ConfigurationError', 'A simulated user needs a model, and this run has none', { suggestions: ['Choose the judge of the evaluation (the simulated user runs on it), or set up Settings ▸ AI Assistant.', 'For an offline test, name the mock provider as the judge.'] });
  let sent = 0;
  let ended: SimulationEnd | undefined;
  let reason = '';
  let model: string | undefined;
  return {
    next: async (turns) => {
      if (ended) return undefined;
      // the record's own question opens the conversation (no model call for it)
      if (!turns.length && o.opening?.trim()) {
        sent++;
        return o.opening.trim();
      }
      // at the limit nothing more is asked: the conversation is judged as it stands
      if (sent >= spec.maxTurns) {
        ended = 'turn-limit';
        return undefined;
      }
      const move = await nextUserMove(host, spec, turns, o);
      model = move.model;
      if (move.status !== 'continue') {
        ended = move.status;
        reason = move.reason;
        return undefined;
      }
      sent++;
      return move.message;
    },
    outcome: () => ({ persona: spec.persona, ...(spec.personaId ? { personaId: spec.personaId } : {}), goal: spec.goal, ended: ended ?? 'turn-limit', reason, userTurns: sent, ...(model ? { model } : {}) }),
  };
}
