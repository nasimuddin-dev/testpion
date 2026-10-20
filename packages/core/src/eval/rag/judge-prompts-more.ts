/**
 * More judged prompts (planning/rag-testing.md §2.3): the shared claim pass (`claims-v1`) and the metrics that read its
 * claims, the context-relevance family (statements, chunks, sentences, nvidia) and the reverse-question generator of Ragas'
 * `response_relevancy`. Every prompt is versioned and pinned by tests/ai/rag-judge.test.ts; a change to a wording is a new
 * version (it changes the cache key of every verdict and is stored with every score).
 */
import type { JudgedMetric } from './judge-prompts.js';

/** The shared pass: the answer's atomic claims, asked once per sample and read by every metric that judges claims. */
export const CLAIMS: JudgedMetric = {
  id: 'claims',
  version: 'claims-v1',
  what: 'The answer split into atomic factual claims (the pass shared by faithfulness and answer relevance, asked once per sample).',
  instruction: [
    'Evaluation task: CLAIMS (version claims-v1). Split the answer into atomic claims.',
    'Split `answer` into atomic claims: each one a single factual statement that can be true or false, rewritten so it makes sense alone (replace pronouns by what they refer to). Leave out greetings, hedges, opinions, questions and anything that is not a factual claim. Do not add a claim the answer does not make.',
    'Return one item per claim: `text` is the claim, `verdict` is always true, `reason` is an empty string.',
    'If the answer makes no factual claims, return an empty `items` list.',
  ].join('\n'),
  inputs: ['answer'],
  noun: 'claims',
  labels: ['found', 'dropped'],
  empty: 'na',
};

/** Faithfulness over claims that were already split (the verdict half of FAITHFULNESS). */
export const FAITHFULNESS_ON_CLAIMS: JudgedMetric = {
  id: 'faithfulness',
  version: 'faithfulness-claims-v1',
  what: 'The share of the answer’s claims that the retrieved documents support (claims split by the shared pass).',
  instruction: [
    'Evaluation task: FAITHFULNESS (version faithfulness-claims-v1). Is every claim backed by the retrieved documents?',
    '`claims` is the list of claims already split from the answer. Judge each one as it is; do not split or merge them.',
    'For each claim, set verdict true only if at least one document in `contexts` states it or makes it follow directly. Set verdict false if the documents contradict it, do not mention it, or support only a part of it.',
    'Return one item per claim, in the order given: `text` is the claim, `verdict` as decided, `reason` is a short quote from the deciding document with its id in square brackets, e.g. [doc-2] "opens at 8am", or a short explanation of why no document supports the claim.',
    'Do not use the question or your own knowledge to excuse a claim.',
  ].join('\n'),
  inputs: ['claims', 'contexts'],
  noun: 'claims',
  labels: ['supported', 'not supported'],
  empty: 'na',
};

/** Answer relevance over claims that were already split. */
export const ANSWER_RELEVANCE_ON_CLAIMS: JudgedMetric = {
  id: 'answer-relevance',
  version: 'answer-relevance-claims-v1',
  what: 'The share of the answer’s claims that are relevant to the question (claims split by the shared pass).',
  instruction: [
    'Evaluation task: ANSWER RELEVANCE (version answer-relevance-claims-v1). Does the answer address the question, claim by claim?',
    '`claims` is the list of claims already split from the answer. Judge each one as it is; do not split or merge them.',
    'For each claim, set verdict true if it helps answer `question` (it answers it, gives a needed detail, or a qualification the question needs). Set verdict false if it is off topic, answers a different question, or is filler that adds nothing for this question. Whether the claim is true does not matter here.',
    'Return one item per claim, in the order given: `text` is the claim, `verdict` as decided, `reason` is one short sentence saying how it relates to the question.',
  ].join('\n'),
  inputs: ['question', 'claims'],
  noun: 'claims',
  labels: ['relevant', 'not relevant'],
  empty: 'na',
};

/* ------------------------------------------------------------------ context relevance */

export const CONTEXT_RELEVANCE_STATEMENTS: JudgedMetric = {
  id: 'context-relevance',
  version: 'context-relevance-statements-v1',
  what: 'The share of the retrieved text (split into statements) that is relevant to the question (DeepEval ContextualRelevancy).',
  instruction: [
    'Evaluation task: CONTEXT RELEVANCE by statements (version context-relevance-statements-v1). How much of what was retrieved is relevant to the question?',
    'Step 1. Split every document of `contexts` into statements: each one a single self-contained sentence-level assertion. Do not add statements the documents do not make.',
    'Step 2. For each statement set verdict true if it is relevant to answering `question`, false if it is irrelevant to it.',
    'Step 3. Return one item per statement: `text` is the statement, `verdict` as decided, `reason` is the document id in square brackets and one short phrase saying why it is or is not relevant, e.g. [doc-2] gives the opening hours.',
    'Judge relevance to the question only, never whether the statement is true. If no document has any statement, return an empty `items` list.',
  ].join('\n'),
  inputs: ['question', 'contexts'],
  noun: 'statements',
  labels: ['relevant', 'irrelevant'],
  empty: 0,
};

export const CONTEXT_RELEVANCE_SENTENCES: JudgedMetric = {
  id: 'context-relevance',
  version: 'context-relevance-sentences-v1',
  what: 'The share of the retrieved sentences that are needed to answer the question (promptfoo context-relevance).',
  instruction: [
    'Evaluation task: CONTEXT RELEVANCE by sentences (version context-relevance-sentences-v1). Which of the retrieved sentences are needed to answer the question?',
    'Step 1. Split every document of `contexts` into its sentences, keeping their words.',
    'Step 2. For each sentence set verdict true only if it is needed to answer `question` (the answer cannot be given completely without it). Set verdict false if it is background, repeats another sentence or has nothing to do with the question.',
    'Step 3. Return one item per sentence: `text` is the sentence, `verdict` as decided, `reason` is the document id in square brackets and one short phrase.',
    'If no document has any sentence, return an empty `items` list.',
  ].join('\n'),
  inputs: ['question', 'contexts'],
  noun: 'sentences',
  labels: ['needed', 'not needed'],
  empty: 0,
};

export const CONTEXT_RELEVANCE_CHUNKS: JudgedMetric = {
  id: 'context-relevance',
  version: 'context-relevance-chunks-v1',
  what: 'How relevant each retrieved chunk is to the question, rated 0 to 3 and averaged (TruLens context relevance).',
  instruction: [
    'Evaluation task: CONTEXT RELEVANCE by chunks (version context-relevance-chunks-v1). Rate how relevant each retrieved document is to the question.',
    'Return one item per document of `contexts`, in order: `text` is the document id, `rating` is an integer from 0 to 3, `verdict` is true when the rating is 1 or more, `reason` is one short sentence.',
    'Ratings: 0 = irrelevant, nothing in it helps with the question. 1 = slightly relevant, on the topic but does not help answer. 2 = relevant, has part of what the answer needs. 3 = highly relevant, has what is needed to answer.',
    'Rate relevance to the question only, never whether the document is true.',
  ].join('\n'),
  inputs: ['question', 'contexts'],
  noun: 'documents',
  labels: ['relevant', 'irrelevant'],
  empty: 0,
  rating: 3,
};

/** The two NVIDIA prompts: each rates the whole retrieved text 0, 1 or 2; the score is their average over 2. */
const nvidia = (variant: 'a' | 'b', wording: string): JudgedMetric => ({
  id: 'context-relevance',
  version: `context-relevance-nvidia-${variant}-v1`,
  what: 'How relevant the retrieved text is to the question, rated 0 to 2 by two prompts and averaged (NVIDIA ContextRelevance).',
  instruction: [
    `Evaluation task: CONTEXT RELEVANCE, NVIDIA style (version context-relevance-nvidia-${variant}-v1). ${wording}`,
    'Rate the retrieved text as a whole. Return exactly one item: `text` is the question, `rating` is an integer 0, 1 or 2, `verdict` is true when the rating is 1 or more, `reason` is one short sentence.',
    'Ratings: 0 = the retrieved text is not relevant to the question at all. 1 = it is partially relevant: it has some of what the question needs. 2 = it is fully relevant: it has everything the question needs.',
  ].join('\n'),
  inputs: ['question', 'contexts'],
  noun: 'ratings',
  labels: ['relevant', 'irrelevant'],
  empty: 0,
  rating: 2,
});
export const CONTEXT_RELEVANCE_NVIDIA: readonly JudgedMetric[] = [
  nvidia('a', 'Is the retrieved text relevant for answering the user question?'),
  nvidia('b', 'Judge as a strict grader: could a person answer the user question using only the retrieved text?'),
];

/* ------------------------------------------------------------------ Ragas response_relevancy */

export const REVERSE_QUESTIONS: JudgedMetric = {
  id: 'answer-relevance',
  version: 'answer-relevance-questions-v1',
  what: 'Questions that the answer would directly answer (Ragas response_relevancy asks 3, then compares them with the real question).',
  instruction: [
    'Evaluation task: REVERSE QUESTIONS (version answer-relevance-questions-v1). Generate the questions the answer replies to.',
    'Write exactly 3 different questions, each one that `answer` would be a direct reply to, phrased the way a user would ask it.',
    'Return one item per question: `text` is the question, `verdict` is false when the answer is evasive or noncommittal (it says it does not know, refuses or gives no information), true otherwise, `reason` is an empty string.',
  ].join('\n'),
  inputs: ['answer'],
  noun: 'questions',
  labels: ['generated', 'noncommittal'],
  empty: 0,
};
