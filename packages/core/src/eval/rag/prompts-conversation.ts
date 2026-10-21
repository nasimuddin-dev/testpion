/**
 * The judge prompts of the conversational metrics (planning/rag-testing.md §2.3 type 9). A conversation reaches the judge as
 * `conversation`: a list of `{ turn, role, content }` (turn numbers count every message, so "turn 4" is the fourth message),
 * with `topics` / `role` / `referenceTopics` beside it when the metric has them. Same verdict format as every judged metric;
 * a change to a wording is a new version, pinned by tests/ai/rag-judge-r3.test.ts.
 */
import type { JudgedMetric } from './judge-prompts.js';

const CONVERSATION_NOTE = 'The sample is a conversation: `conversation` lists its messages in order as { turn, role (user or assistant), content }.';

/** Knowledge retention (DeepEval): does the assistant remember what the user told it? One verdict per assistant turn. */
export const KNOWLEDGE_RETENTION: JudgedMetric = {
  id: 'knowledge-retention',
  version: 'knowledge-retention-v1',
  what: 'For each assistant turn: does it forget or contradict a fact the user gave earlier in the conversation (attrition)?',
  instruction: [
    'Evaluation task: KNOWLEDGE RETENTION (version knowledge-retention-v1). Does the assistant remember what the user told it?',
    CONVERSATION_NOTE,
    'Step 1. Collect the facts the USER stated about themselves, their situation or their request in the user turns (a name, a date, a preference, a constraint). Ignore what the assistant said.',
    'Step 2. Return one item per assistant turn, in order: `text` is "turn N" (its number), `verdict` is true if the turn is consistent with every fact the user gave BEFORE it and does not ask for any of them again, false if it asks again for something the user already said, or contradicts or ignores a fact it should know (attrition), `reason` names the fact and what the assistant did.',
    'A fact the user gives later than the turn does not count against it. A turn that simply does not need a fact is true.',
  ].join('\n'),
  inputs: ['conversation'],
  noun: 'assistant turns',
  labels: ['remembers', 'forgets'],
  empty: 'na',
};

/** Role adherence (DeepEval): each assistant turn stays in the role it was given. */
export const ROLE_ADHERENCE: JudgedMetric = {
  id: 'role-adherence',
  version: 'role-adherence-v1',
  what: 'For each assistant turn: does it stay in the role the assistant was given (tone, scope, persona)?',
  instruction: [
    'Evaluation task: ROLE ADHERENCE (version role-adherence-v1). Does the assistant stay in its role?',
    CONVERSATION_NOTE,
    'The role the assistant must play is `role` (written by the metric’s author; it is not part of the conversation).',
    'Return one item per assistant turn, in order: `text` is "turn N", `verdict` is true if the turn is what an assistant in that role would say (in scope, in character, in the right tone), false if it steps out of the role (answers outside its remit, drops the persona, claims to be something else), `reason` is one short sentence.',
  ].join('\n'),
  inputs: ['conversation', 'role'],
  noun: 'assistant turns',
  labels: ['in role', 'out of role'],
  empty: 'na',
};

/** Conversation completeness (DeepEval): each intention the user brought is satisfied by the end. */
export const CONVERSATION_COMPLETENESS: JudgedMetric = {
  id: 'conversation-completeness',
  version: 'conversation-completeness-v1',
  what: 'The share of the intentions the user brought to the conversation that the assistant satisfied by its end.',
  instruction: [
    'Evaluation task: CONVERSATION COMPLETENESS (version conversation-completeness-v1). Did the conversation give the user what they came for?',
    CONVERSATION_NOTE,
    'Step 1. List the distinct intentions the USER expressed (what they asked for or wanted done), each once, in the order they appeared.',
    'Step 2. Return one item per intention: `text` is the intention, `verdict` is true if the assistant satisfied it somewhere in the conversation (answered it, did it, or correctly said it cannot be done and why), false if it was ignored, only partly handled or answered wrongly, `reason` names the turn that decides it.',
    'If the user expressed no intention, return an empty `items` list.',
  ].join('\n'),
  inputs: ['conversation'],
  noun: 'intentions',
  labels: ['satisfied', 'not satisfied'],
  empty: 'na',
};

/** Turn relevancy (DeepEval): each assistant turn is relevant to the conversation so far (a sliding window). */
export const turnRelevancy = (window: number): JudgedMetric => ({
  id: 'turn-relevancy',
  version: 'turn-relevancy-v1',
  what: 'For each assistant turn: is it relevant to what was said before it (a window of the last messages)?',
  instruction: [
    'Evaluation task: TURN RELEVANCY (version turn-relevancy-v1). Is every assistant turn relevant to the conversation?',
    CONVERSATION_NOTE,
    `Return one item per assistant turn, in order: \`text\` is "turn N", \`verdict\` is true if the turn is relevant to the user's latest message and the messages just before it (look back at most ${window} messages from that turn, no further), false if it ignores or misreads them, answers another question, or wanders off, \`reason\` is one short sentence.`,
  ].join('\n'),
  inputs: ['conversation'],
  noun: 'assistant turns',
  labels: ['relevant', 'not relevant'],
  empty: 'na',
});

/** Topic adherence (Ragas): step 1, the topics the conversation covered. */
export const TOPIC_EXTRACT: JudgedMetric = {
  id: 'topic-adherence',
  version: 'topic-adherence-topics-v1',
  what: 'The distinct topics the user raised in the conversation.',
  instruction: [
    'Evaluation task: TOPIC EXTRACTION (version topic-adherence-topics-v1). Which topics did the user raise?',
    CONVERSATION_NOTE,
    'Return one item per distinct topic the USER asked about or brought up, in the order they appeared: `text` is a short phrase naming the topic (3 to 8 words), `verdict` is true, `reason` names the turn where it came up.',
    'Merge turns about the same topic. Do not list topics only the assistant introduced.',
  ].join('\n'),
  inputs: ['conversation'],
  noun: 'topics',
  labels: ['raised', 'raised'],
  empty: 'na',
};

/** The Ragas arithmetic: TP = on topic and answered, FP = off topic and answered, FN = on topic and refused; zero denominators score 0. */
export function topicScore(items: ReadonlyArray<{ verdict: boolean; rating?: number }>, mode: 'f1' | 'precision' | 'recall'): number | undefined {
  if (!items.length) return undefined;
  const tp = items.filter((i) => i.verdict && i.rating === 1).length;
  const fp = items.filter((i) => !i.verdict && i.rating === 1).length;
  const fn = items.filter((i) => i.verdict && i.rating !== 1).length;
  const p = tp + fp > 0 ? tp / (tp + fp) : 0;
  const r = tp + fn > 0 ? tp / (tp + fn) : 0;
  return mode === 'precision' ? p : mode === 'recall' ? r : p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

/** Topic adherence step 2: for each topic, is it on the allowed list, and did the assistant answer it? */
export const topicClassify = (mode: 'f1' | 'precision' | 'recall'): JudgedMetric => ({
  id: 'topic-adherence',
  version: 'topic-adherence-classify-v1',
  what: 'For each topic of the conversation: is it one of the allowed topics, and did the assistant answer it or refuse it?',
  instruction: [
    'Evaluation task: TOPIC ADHERENCE (version topic-adherence-classify-v1). Did the assistant stay on the allowed topics?',
    CONVERSATION_NOTE,
    'The allowed topics are `referenceTopics` (written by the metric’s author). `topics` lists the topics the user raised.',
    'Return one item per topic of `topics`, in order: `text` is the topic, `verdict` is true if the topic is one of the allowed topics (or clearly part of one), false if it is outside them, `rating` is 1 if the assistant ANSWERED the user about it (gave the information or did the task) and 0 if it refused, deflected or did not address it, `reason` is one short sentence naming the turn.',
    'Judge the topic against the allowed list, not against your own idea of what is appropriate.',
  ].join('\n'),
  inputs: ['conversation', 'topics', 'referenceTopics'],
  noun: 'topics',
  labels: ['on an allowed topic', 'off topic'],
  empty: 'na',
  rating: 1,
  ratingMin: 0,
  ratingValues: [0, 1],
  scorer: (items) => topicScore(items, mode),
});

export const CONVERSATION_PROMPTS: readonly JudgedMetric[] = [KNOWLEDGE_RETENTION, ROLE_ADHERENCE, CONVERSATION_COMPLETENESS, turnRelevancy(10), TOPIC_EXTRACT, topicClassify('f1')];
