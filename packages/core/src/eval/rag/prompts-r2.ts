/**
 * The judge prompts of the second release of RAG metrics (planning/rag-testing.md §2.3): the retrieval judges that moved
 * onto the judge service, the claim passes for the reference and for the contexts, the holistic NVIDIA ratings, hallucination,
 * the category judges and the chunk verdicts of the claim-level family. All answer in the one verdict format (judge-prompts.ts
 * VERDICT_SCHEMA); a change to a wording is a new version, pinned by tests/ai/rag-judge-r2.test.ts.
 */
import type { JudgedMetric } from './judge-prompts.js';
import { rankedAveragePrecision } from './ir.js';

const metric = (m: JudgedMetric): JudgedMetric => m;

/** Rank-weighted average precision over the verdicts, in the order of the documents (the Ragas context precision formula). */
const averagePrecision: NonNullable<JudgedMetric['scorer']> = (items) => rankedAveragePrecision(items.map((i) => i.verdict));
/** The share of items whose verdict is false: contradicted documents / documents. */
const falseShare: NonNullable<JudgedMetric['scorer']> = (items) => (items.length ? items.filter((i) => !i.verdict).length / items.length : undefined);

/* ------------------------------------------------------------------ retrieval */

export const CONTEXT_PRECISION: JudgedMetric = metric({
  id: 'context-precision',
  version: 'context-precision-judge-v1',
  what: 'Which retrieved chunks are useful for the question, in rank order (the score is the rank-weighted average precision of the useful ones).',
  instruction: [
    'Evaluation task: CONTEXT PRECISION (version context-precision-judge-v1). Which of the retrieved documents are useful?',
    'Return one item per document of `contexts`, in the order given: `text` is the document id, `verdict` is true if the document is useful for arriving at the `reference` answer to `question` (it holds a fact the reference states or needs), false if it is not, `reason` is one short phrase.',
    'Judge each document on its own; a document that repeats another one is still useful if it holds the fact. If `reference` is missing, use `answer` as the target instead.',
  ].join('\n'),
  inputs: ['question', 'contexts', 'reference', 'answer'],
  noun: 'documents',
  labels: ['useful', 'not useful'],
  empty: 0,
  scorer: averagePrecision,
  rankAware: true,
});

export const CONTEXT_PRECISION_ONE: JudgedMetric = metric({
  ...CONTEXT_PRECISION,
  version: 'context-precision-judge-one-v1',
  what: 'Whether ONE retrieved chunk is useful for the question (Ragas asks this once per chunk).',
  instruction: [
    'Evaluation task: CONTEXT PRECISION, one document (version context-precision-judge-one-v1). Is the document useful?',
    'Return exactly one item for the only document in `contexts`: `text` is its id, `verdict` is true if it is useful for arriving at the `reference` answer to `question` (or at `answer` when there is no reference), false if not, `reason` is one short phrase.',
  ].join('\n'),
});

export const CONTEXT_UTILIZATION: JudgedMetric = metric({
  id: 'context-utilization',
  version: 'context-utilization-v1',
  what: 'Which retrieved chunks the answer actually used, in rank order (the score is the rank-weighted average precision of the used ones).',
  instruction: [
    'Evaluation task: CONTEXT UTILIZATION (version context-utilization-v1). Which retrieved documents did the answer use?',
    'Return one item per document of `contexts`, in the order given: `text` is the document id, `verdict` is true if the `answer` takes a fact from this document (or could only have been written with it), false if the answer does not use it, `reason` is one short phrase.',
    'Judge use, not truth: a document the answer ignores is false even if it is relevant to `question`.',
  ].join('\n'),
  inputs: ['question', 'contexts', 'answer'],
  noun: 'documents',
  labels: ['used', 'not used'],
  empty: 0,
  scorer: averagePrecision,
  rankAware: true,
});

export const CONTEXT_RECALL: JudgedMetric = metric({
  id: 'context-recall',
  version: 'context-recall-judge-v1',
  what: 'Which statements of the reference answer can be found in the retrieved documents.',
  instruction: [
    'Evaluation task: CONTEXT RECALL (version context-recall-judge-v1). Can each statement of the reference be attributed to the retrieved documents?',
    'Step 1. Split `reference` into statements: each one a single self-contained sentence-level assertion. Do not add statements the reference does not make.',
    'Step 2. For each statement set verdict true if at least one document in `contexts` states it or makes it follow directly, false if no document does.',
    'Step 3. Return one item per statement: `text` is the statement, `verdict` as decided, `reason` is the document id in square brackets with a short quote, or why nothing supports it.',
  ].join('\n'),
  inputs: ['question', 'reference', 'contexts'],
  noun: 'statements',
  labels: ['found', 'missing'],
  empty: 'na',
});

export const ENTITIES_OF_REFERENCE: JudgedMetric = metric({
  id: 'context-entity-recall',
  version: 'entities-reference-v1',
  what: 'The entities (people, places, organisations, dates, quantities, products) that a reference answer mentions.',
  instruction: [
    'Evaluation task: ENTITIES of the reference (version entities-reference-v1). List the entities in `reference`.',
    'Return one item per distinct entity: `text` is the entity exactly as written in the reference (a name, a date, a number with its unit, a product), `verdict` is always true, `reason` is an empty string.',
    'Do not list common nouns, pronouns or verbs. If there are no entities, return an empty `items` list.',
  ].join('\n'),
  inputs: ['reference'],
  noun: 'entities',
  labels: ['found', 'missing'],
  empty: 'na',
});

export const ENTITIES_OF_CONTEXTS: JudgedMetric = metric({
  ...ENTITIES_OF_REFERENCE,
  version: 'entities-contexts-v1',
  what: 'The entities that the retrieved documents mention.',
  instruction: [
    'Evaluation task: ENTITIES of the documents (version entities-contexts-v1). List the entities in `contexts`.',
    'Return one item per distinct entity: `text` is the entity exactly as written in a document (a name, a date, a number with its unit, a product), `verdict` is always true, `reason` is the id of the first document that mentions it in square brackets.',
    'Do not list common nouns, pronouns or verbs. If there are no entities, return an empty `items` list.',
  ].join('\n'),
  inputs: ['contexts'],
});

/* ------------------------------------------------------------------ claims of the reference and checks against it */

export const CLAIMS_OF_REFERENCE: JudgedMetric = metric({
  id: 'claims-reference',
  version: 'claims-reference-v1',
  what: 'The reference answer split into atomic factual claims (the pass shared by the factual-correctness and claim-level metrics).',
  instruction: [
    'Evaluation task: CLAIMS of the reference (version claims-reference-v1). Split the reference answer into atomic claims.',
    'Split `reference` into atomic claims: each one a single factual statement that can be true or false, rewritten so it makes sense alone (replace pronouns by what they refer to). Leave out greetings, hedges, opinions and questions. Do not add a claim the reference does not make.',
    'Return one item per claim: `text` is the claim, `verdict` is always true, `reason` is an empty string. If there are no factual claims, return an empty `items` list.',
  ].join('\n'),
  inputs: ['reference'],
  noun: 'claims',
  labels: ['found', 'dropped'],
  empty: 'na',
});

export const CLAIMS_VS_REFERENCE: JudgedMetric = metric({
  id: 'factual-correctness',
  version: 'claims-vs-reference-v1',
  what: 'Which claims of the answer the reference supports (the precision half of factual correctness).',
  instruction: [
    'Evaluation task: CLAIMS against the reference (version claims-vs-reference-v1). Does the reference support each claim of the answer?',
    '`claims` is the list of claims already split from the answer. Judge each one as it is; do not split or merge them.',
    'For each claim set verdict true only if `reference` states it or makes it follow directly. Set verdict false if the reference contradicts it, does not mention it, or supports only a part of it.',
    'Return one item per claim, in the order given: `text` is the claim, `verdict` as decided, `reason` is a short quote from the reference or why it is not supported.',
  ].join('\n'),
  inputs: ['claims', 'reference'],
  noun: 'claims',
  labels: ['in the reference', 'not in the reference'],
  empty: 'na',
});

export const REFERENCE_CLAIMS_VS_ANSWER: JudgedMetric = metric({
  id: 'factual-correctness',
  version: 'reference-claims-vs-answer-v1',
  what: 'Which claims of the reference the answer makes (the recall half of factual correctness).',
  instruction: [
    'Evaluation task: REFERENCE CLAIMS against the answer (version reference-claims-vs-answer-v1). Does the answer make each claim of the reference?',
    '`claims` is the list of claims already split from the reference. Judge each one as it is; do not split or merge them.',
    'For each claim set verdict true only if `answer` states it or makes it follow directly. Set verdict false if the answer contradicts it, leaves it out, or covers only a part of it.',
    'Return one item per claim, in the order given: `text` is the claim, `verdict` as decided, `reason` is a short quote from the answer or what is missing.',
  ].join('\n'),
  inputs: ['claims', 'answer'],
  noun: 'claims',
  labels: ['in the answer', 'missing from the answer'],
  empty: 'na',
});

export const REFERENCE_CLAIMS_IN_CONTEXTS: JudgedMetric = metric({
  id: 'claims-in-contexts',
  version: 'reference-claims-in-contexts-v1',
  what: 'Which claims of the reference the retrieved documents contain (what a perfect reader of the documents could answer).',
  instruction: [
    'Evaluation task: REFERENCE CLAIMS in the documents (version reference-claims-in-contexts-v1). Do the retrieved documents hold each claim of the reference?',
    '`claims` is the list of claims already split from the reference. Judge each one as it is; do not split or merge them.',
    'For each claim set verdict true only if at least one document in `contexts` states it or makes it follow directly. Set verdict false otherwise.',
    'Return one item per claim, in the order given: `text` is the claim, `verdict` as decided, `reason` is the document id in square brackets with a short quote, or why no document holds it.',
  ].join('\n'),
  inputs: ['claims', 'contexts'],
  noun: 'claims',
  labels: ['in the documents', 'not in the documents'],
  empty: 'na',
});

export const CHUNK_RELEVANCE: JudgedMetric = metric({
  id: 'chunk-relevance',
  version: 'chunk-relevance-v1',
  what: 'Which retrieved chunks are relevant: a chunk is relevant when it holds at least one claim of the reference.',
  instruction: [
    'Evaluation task: CHUNK RELEVANCE (version chunk-relevance-v1). Which retrieved documents hold at least one claim of the reference?',
    '`claims` is the list of claims split from the reference.',
    'Return one item per document of `contexts`, in the order given: `text` is the document id, `verdict` is true if the document states at least one of the claims (or makes it follow directly), false if it holds none, `reason` is the claim it holds, or why none.',
  ].join('\n'),
  inputs: ['claims', 'contexts'],
  noun: 'documents',
  labels: ['relevant', 'irrelevant'],
  empty: 0,
});

/* ------------------------------------------------------------------ whole-answer ratings (NVIDIA) */

const groundedness = (variant: 'a' | 'b', wording: string): JudgedMetric =>
  metric({
    id: 'response-groundedness',
    version: `response-groundedness-${variant}-v1`,
    what: 'How well the retrieved documents ground the whole answer, rated 0 to 2 by two prompts and averaged (NVIDIA ResponseGroundedness).',
    instruction: [
      `Evaluation task: RESPONSE GROUNDEDNESS, NVIDIA style (version response-groundedness-${variant}-v1). ${wording}`,
      'Rate the answer as a whole. Return exactly one item: `text` is "answer", `rating` is an integer 0, 1 or 2, `verdict` is true when the rating is 1 or more, `reason` is one short sentence.',
      'Ratings: 0 = the answer is not grounded in the documents at all. 1 = it is partly grounded: some of its content is in the documents and some is not. 2 = it is fully grounded: everything it states is in the documents.',
    ].join('\n'),
    inputs: ['answer', 'contexts'],
    noun: 'ratings',
    labels: ['grounded', 'not grounded'],
    empty: 0,
    rating: 2,
  });
export const RESPONSE_GROUNDEDNESS: readonly JudgedMetric[] = [
  groundedness('a', 'Is the answer grounded in the retrieved documents?'),
  groundedness('b', 'Judge as a strict grader: could every statement of the answer be checked against the retrieved documents?'),
];

const accuracy = (variant: 'a' | 'b', wording: string): JudgedMetric =>
  metric({
    id: 'answer-accuracy',
    version: `answer-accuracy-${variant}-v1`,
    what: 'How well the response agrees with the reference, rated 0, 2 or 4 (NVIDIA AnswerAccuracy).',
    instruction: [
      `Evaluation task: ANSWER ACCURACY, NVIDIA style (version answer-accuracy-${variant}-v1). ${wording}`,
      'Return exactly one item: `text` is "response", `rating` is 0, 2 or 4, `verdict` is true when the rating is 2 or 4, `reason` is one short sentence.',
      'Ratings: 0 = the response does not match the reference (it is wrong, off topic, or contradicts it). 2 = it partially matches (some of the reference is there, or it is right but incomplete). 4 = it fully matches (everything in the reference is there and nothing contradicts it).',
    ].join('\n'),
    inputs: ['question', 'response', 'reference'],
    noun: 'ratings',
    labels: ['matches', 'does not match'],
    empty: 0,
    rating: 4,
    ratingValues: [0, 2, 4],
  });
/** The second prompt is the first one asked with the response and the reference swapped (NVIDIA: the judge may favour the first text). */
export const ANSWER_ACCURACY: readonly JudgedMetric[] = [
  accuracy('a', 'How well does `response` agree with `reference` for `question`?'),
  accuracy('b', 'Judge as a strict grader. `response` is the text to rate and `reference` the text it is compared with; treat them symmetrically, as a reviewer who has not seen which one is the original.'),
];

/* ------------------------------------------------------------------ hallucination, correctness, completeness, factuality, citations */

export const HALLUCINATION: JudgedMetric = metric({
  id: 'hallucination',
  version: 'hallucination-v1',
  what: 'Which of the given ground-truth documents the answer contradicts (DeepEval Hallucination).',
  instruction: [
    'Evaluation task: HALLUCINATION (version hallucination-v1). Does the answer contradict the ground-truth documents?',
    'Return one item per document of `referenceContexts`, in the order given: `text` is the document id or its first words, `verdict` is true if the `answer` agrees with the document or does not speak to it, false if the answer says something that contradicts it, `reason` is the contradiction in one short sentence, or an empty string.',
    'Contradiction means a direct conflict of fact (a different number, date, name or yes/no). An answer that omits a fact, or adds a fact the document does not cover, does not contradict it.',
  ].join('\n'),
  inputs: ['answer', 'referenceContexts'],
  noun: 'documents',
  labels: ['agrees', 'contradicted'],
  empty: 'na',
  scorer: falseShare,
});

export const CORRECTNESS: JudgedMetric = metric({
  id: 'correctness',
  version: 'correctness-v1',
  what: 'Whether the answer is correct with respect to the reference answer (a binary verdict).',
  instruction: [
    'Evaluation task: CORRECTNESS (version correctness-v1). Is the answer correct compared with the reference answer?',
    'Return exactly one item: `text` is "answer", `verdict` is true if `answer` is accurate with respect to `reference` (extra accurate information is allowed), false if it conflicts with the reference on a fact or leaves out what the reference says is needed, `reason` is one short explanation written before you decide.',
  ].join('\n'),
  inputs: ['question', 'answer', 'reference'],
  noun: 'verdicts',
  labels: ['correct', 'incorrect'],
  empty: 0,
});

export const COMPLETENESS: JudgedMetric = metric({
  id: 'completeness',
  version: 'completeness-v1',
  what: 'How many parts of the question (or of the reference) the answer covers.',
  instruction: [
    'Evaluation task: COMPLETENESS (version completeness-v1). Does the answer address every part of what was asked?',
    'Step 1. Split `question` into the distinct things it asks for (if `reference` is present, use the distinct points of the reference instead).',
    'Step 2. For each part set verdict true if `answer` addresses it, false if it leaves it out.',
    'Step 3. Return one item per part: `text` is the part, `verdict` as decided, `reason` is where the answer covers it, or what is missing.',
  ].join('\n'),
  inputs: ['question', 'answer', 'reference'],
  noun: 'parts',
  labels: ['answered', 'missing'],
  empty: 'na',
});

export const FACTUALITY: JudgedMetric = metric({
  id: 'factuality',
  version: 'factuality-v1',
  what: 'How the answer relates to the reference, in five categories (OpenAI evals / promptfoo / Braintrust Factuality).',
  instruction: [
    'Evaluation task: FACTUALITY (version factuality-v1). Compare the factual content of `answer` with `reference` for `question`. Ignore differences in style, grammar or punctuation.',
    'Return exactly one item: `text` is the category letter, `rating` is the category as a number (A = 0, B = 1, C = 2, D = 3, E = 4), `verdict` is false only for D, `reason` is one short explanation.',
    'A: the answer is a subset of the reference and is fully consistent with it. B: the answer is a superset of the reference and is fully consistent with it. C: the answer contains the same details as the reference. D: the answer disagrees with the reference. E: the answer and the reference differ, but the differences do not matter from the point of view of factuality.',
  ].join('\n'),
  inputs: ['question', 'answer', 'reference'],
  noun: 'categories',
  labels: ['consistent', 'disagrees'],
  empty: 0,
  rating: 4,
  // Braintrust's scores; promptfoo passes A, B, C and E and fails D
  ratingScores: [0.4, 0.6, 1, 0, 1],
});

export const CITATION_ACCURACY: JudgedMetric = metric({
  id: 'citation-accuracy',
  version: 'citation-accuracy-v1',
  what: 'Whether each cited document supports the sentence that cites it.',
  instruction: [
    'Evaluation task: CITATION ACCURACY (version citation-accuracy-v1). Does each cited document support the sentence that cites it?',
    '`citations` lists the pairs found in the answer: the sentence and the id of the document it cites. Judge each pair with the text of that document from `contexts`.',
    'Return one item per pair, in the order given: `text` is the sentence, `verdict` is true if the cited document states it or makes it follow directly, false if it does not or the document is not among the contexts, `reason` is a short quote from the document, or why it does not support the sentence.',
  ].join('\n'),
  inputs: ['citations', 'contexts'],
  noun: 'citations',
  labels: ['supported', 'not supported'],
  empty: 'na',
});

export const RETRIEVAL_RELEVANCE: JudgedMetric = metric({
  id: 'retrieval-relevance',
  version: 'retrieval-relevance-v1',
  what: 'A relevant / not relevant label for each retrieved chunk (the labels the rank measures are computed from).',
  instruction: [
    'Evaluation task: RETRIEVAL RELEVANCE (version retrieval-relevance-v1). Is each retrieved document relevant to the question?',
    'Return one item per document of `contexts`, in the order given: `text` is the document id, `verdict` is true if the document helps answer `question`, false if it does not, `reason` is one short phrase written before the decision.',
    'Judge relevance to the question only, never whether the document is true.',
  ].join('\n'),
  inputs: ['question', 'contexts'],
  noun: 'documents',
  labels: ['relevant', 'not relevant'],
  empty: 0,
});

export const R2_PROMPTS: readonly JudgedMetric[] = [
  CONTEXT_PRECISION,
  CONTEXT_PRECISION_ONE,
  CONTEXT_UTILIZATION,
  CONTEXT_RECALL,
  ENTITIES_OF_REFERENCE,
  ENTITIES_OF_CONTEXTS,
  CLAIMS_OF_REFERENCE,
  CLAIMS_VS_REFERENCE,
  REFERENCE_CLAIMS_VS_ANSWER,
  REFERENCE_CLAIMS_IN_CONTEXTS,
  CHUNK_RELEVANCE,
  ...RESPONSE_GROUNDEDNESS,
  ...ANSWER_ACCURACY,
  HALLUCINATION,
  CORRECTNESS,
  COMPLETENESS,
  FACTUALITY,
  CITATION_ACCURACY,
  RETRIEVAL_RELEVANCE,
];
