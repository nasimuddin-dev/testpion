/**
 * The judge prompts of the judge designs that needed their own (planning/rag-testing.md §2.3 7.6, 7.7, 7.9 and 3.15):
 * G-Eval's evaluation steps, the decision-tree nodes of `dag`, the blinded pairwise comparison, and the two summarization
 * scores. Same verdict format as every judged metric; a change to a wording is a new version, pinned by
 * tests/ai/rag-judge-r3.test.ts.
 */
import type { JudgedMetric } from './judge-prompts.js';

const fence = (label: string, text: string) => `${label} (written by the metric’s author; it is not part of the sample):\n"""\n${text.replace(/"""/g, '"')}\n"""`;

/** G-Eval step 1: the evaluation steps for a criterion, generated once and cached. */
export const gevalSteps = (criteria: string): JudgedMetric => ({
  id: 'g-eval',
  version: 'g-eval-steps-v1',
  what: 'The evaluation steps G-Eval derives from a criterion.',
  instruction: [
    'Evaluation task: G-EVAL STEPS (version g-eval-steps-v1). Write the steps of an evaluation.',
    fence('Criteria', criteria),
    'Return between 3 and 6 items, in the order they should be carried out: `text` is one step, an instruction to the evaluator that is specific and checkable ("Check whether the answer names the document it relies on"), `verdict` is true, `reason` is one phrase saying what the step guards against.',
    'The steps must be enough to rate an answer against the criteria and must not add criteria of their own.',
  ].join('\n'),
  inputs: [],
  noun: 'steps',
  labels: ['step', 'step'],
  empty: 'na',
});

/** DAG node: a yes/no judgement. */
export const dagBinary = (question: string): JudgedMetric => ({
  id: 'dag',
  version: 'dag-binary-v1',
  what: 'One yes/no judgement of a decision-tree node.',
  instruction: [
    'Evaluation task: DECISION NODE, yes or no (version dag-binary-v1).',
    fence('Question', question),
    '`notes` holds what earlier steps of the tree found out, when there are any.',
    'Return exactly one item: `text` is "verdict", `verdict` is true if the answer to the question is yes, false if it is no, `reason` is one or two sentences saying why.',
  ].join('\n'),
  inputs: ['question', 'answer', 'reference', 'contexts', 'notes'],
  noun: 'verdicts',
  labels: ['yes', 'no'],
  empty: 0,
});

/** DAG node: a choice among labelled options. */
export const dagChoice = (question: string, options: readonly string[]): JudgedMetric => ({
  id: 'dag',
  version: 'dag-choice-v1',
  what: 'One multiple-choice judgement of a decision-tree node.',
  instruction: [
    'Evaluation task: DECISION NODE, choose one (version dag-choice-v1).',
    fence('Question', question),
    `The options, numbered: ${options.map((o, i) => `${i + 1}. ${o}`).join(' | ')}.`,
    '`notes` holds what earlier steps of the tree found out, when there are any.',
    `Return exactly one item: \`text\` is "choice", \`rating\` is the number of the option that fits best (a whole number from 1 to ${options.length}), \`verdict\` is true, \`reason\` is one or two sentences saying why that option fits.`,
  ].join('\n'),
  inputs: ['question', 'answer', 'reference', 'contexts', 'notes'],
  noun: 'choices',
  labels: ['chosen', 'chosen'],
  empty: 0,
  rating: options.length,
  ratingMin: 1,
});

/** DAG node: a task whose written result is passed on to later nodes. */
export const dagTask = (instruction: string): JudgedMetric => ({
  id: 'dag',
  version: 'dag-task-v1',
  what: 'One task node of a decision tree: it writes down something later nodes use.',
  instruction: [
    'Evaluation task: TASK NODE (version dag-task-v1). Do the task and write down the result; do not judge.',
    fence('Task', instruction),
    '`notes` holds what earlier steps of the tree found out, when there are any.',
    'Return exactly one item: `text` is "result", `verdict` is true, `reason` is the result of the task, in one to three sentences.',
  ].join('\n'),
  inputs: ['question', 'answer', 'reference', 'contexts', 'notes'],
  noun: 'results',
  labels: ['done', 'done'],
  empty: 0,
});

/** Pairwise: which of two answers is better (blinded; the metric asks twice with the order swapped). */
export const PAIRWISE: JudgedMetric = {
  id: 'pairwise',
  version: 'pairwise-v1',
  what: 'Which of two answers to the same question is better.',
  instruction: [
    'Evaluation task: PAIRWISE COMPARISON (version pairwise-v1). Which answer is better?',
    '`answerA` and `answerB` are two answers to `question`. Their order says nothing about quality, and neither is the "original": judge them only on what they say. `reference` is a good answer, when given; use it as a guide, not as the only acceptable wording. Prefer the answer that is correct, complete for the question and clear; do not prefer the longer one for being longer.',
    'Return exactly one item: `text` is "preference", `rating` is 2 if A is better, 1 if they are equally good, 0 if B is better, `verdict` is true if A is better or they are equal, `reason` is one or two sentences saying why.',
  ].join('\n'),
  inputs: ['question', 'answerA', 'answerB', 'reference'],
  noun: 'comparisons',
  labels: ['A at least as good', 'B better'],
  empty: 0,
  rating: 2,
  ratingMin: 0,
  ratingValues: [0, 1, 2],
};

/** DeepEval Summarization, alignment: the summary's claims against the source. */
export const SUMMARY_ALIGNMENT: JudgedMetric = {
  id: 'summarization',
  version: 'summary-alignment-v1',
  what: 'The share of the summary’s claims that the source text supports.',
  instruction: [
    'Evaluation task: SUMMARY ALIGNMENT (version summary-alignment-v1). Does the summary say only what the source says?',
    '`source` is the original text; `answer` is the summary of it.',
    'Step 1. Split the summary into atomic factual claims. Step 2. Return one item per claim: `text` is the claim, `verdict` is true if the source states it or makes it follow directly, false if the source contradicts it or does not say it, `reason` quotes the source or says what is missing.',
    'If the summary makes no factual claims, return an empty `items` list.',
  ].join('\n'),
  inputs: ['source', 'answer'],
  noun: 'claims',
  labels: ['supported by the source', 'not in the source'],
  empty: 'na',
};

/** DeepEval Summarization, coverage: questions the source answers, answered by the summary too. */
export const summaryCoverage = (n: number): JudgedMetric => ({
  id: 'summarization',
  version: 'summary-coverage-v1',
  what: 'Whether the summary keeps the important information of the source: the questions the source answers, answered the same way by the summary.',
  instruction: [
    'Evaluation task: SUMMARY COVERAGE (version summary-coverage-v1). Does the summary keep what matters in the source?',
    '`source` is the original text; `answer` is the summary of it.',
    `Step 1. Write ${n} yes/no questions about the most important information in the source, each one answered “yes” by the source. Step 2. Return one item per question: \`text\` is the question, \`verdict\` is true if the SUMMARY also answers it “yes” (it contains that information), false if the summary does not say it or says otherwise, \`reason\` is one short phrase.`,
  ].join('\n'),
  inputs: ['source', 'answer'],
  noun: 'questions',
  labels: ['covered', 'missing'],
  empty: 'na',
});

/** Ragas SummarizationScore, step 1: the questions the source's key phrases lead to. */
export const SUMMARY_QUESTIONS: JudgedMetric = {
  id: 'summarization',
  version: 'summary-questions-v1',
  what: 'Questions built from the key phrases of the source text.',
  instruction: [
    'Evaluation task: SUMMARY QUESTIONS (version summary-questions-v1). Find what matters in the source and ask about it.',
    '`source` is the text.',
    'Step 1. Pick the key phrases of the source: the names, numbers, events and terms a summary should keep. Step 2. Return one item per key phrase (at most 10): `text` is a closed question about it that the source answers (“Did the company open a second site in 2021?”), `verdict` is true, `reason` is the key phrase.',
  ].join('\n'),
  inputs: ['source'],
  noun: 'questions',
  labels: ['asked', 'asked'],
  empty: 'na',
};

/** Ragas SummarizationScore, step 2: can each question be answered from the summary alone? */
export const SUMMARY_ANSWERS: JudgedMetric = {
  id: 'summarization',
  version: 'summary-answers-v1',
  what: 'Which of the source’s questions the summary can answer.',
  instruction: [
    'Evaluation task: SUMMARY ANSWERS (version summary-answers-v1). Using ONLY the summary, which questions can be answered?',
    '`answer` is the summary; `questions` are closed questions about the original text.',
    'Return one item per question, in order: `text` is the question, `verdict` is true if the summary alone answers it with the information the question asks about (a correct “yes” or “no” that the summary supports), false if the summary does not contain that information, `reason` is one short phrase.',
  ].join('\n'),
  inputs: ['questions', 'answer'],
  noun: 'questions',
  labels: ['answerable from the summary', 'not answerable'],
  empty: 'na',
};

export const EXTRA_PROMPTS: readonly JudgedMetric[] = [gevalSteps('(criteria)'), dagBinary('(question)'), dagChoice('(question)', ['(a)', '(b)']), dagTask('(task)'), PAIRWISE, SUMMARY_ALIGNMENT, summaryCoverage(5), SUMMARY_QUESTIONS, SUMMARY_ANSWERS];
