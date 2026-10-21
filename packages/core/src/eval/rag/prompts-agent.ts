/**
 * The judge prompts of the agent and tool-use metrics (planning/rag-testing.md §2.3 type 10). The judge reads the trace of
 * the run as `trace`: a list of steps `{ step, kind, ... }` where `kind` is `user` (what was asked), `assistant` (what the
 * system said), `tool_call` (a tool it called, with `name` and `arguments`) or `tool_result`. Same verdict format as every
 * judged metric; a change to a wording is a new version, pinned by tests/ai/rag-judge-r3.test.ts.
 */
import type { JudgedMetric } from './judge-prompts.js';

const TRACE_NOTE = 'The run is `trace`: its steps in order, each { step, kind (user, assistant, tool_call or tool_result), and its text, or the tool call’s name and arguments }.';

/** Ragas AgentGoalAccuracy, step 1: what the user wanted and where the run ended. */
export const GOAL_INFER: JudgedMetric = {
  id: 'goal-accuracy',
  version: 'goal-infer-v1',
  what: 'The goal the user had and the state the run ended in.',
  instruction: [
    'Evaluation task: INFER THE GOAL (version goal-infer-v1). What did the user want, and where did the run end?',
    TRACE_NOTE,
    'Return exactly two items. Item 1: `text` is "goal", `verdict` is true, `reason` is the goal the user wanted to achieve, in one sentence, taken from what they asked. Item 2: `text` is "end state", `verdict` is true, `reason` is where the run ended, in one or two sentences: what was done, what the system said last, and anything it could not do.',
    'Describe only what the trace shows. Do not judge here.',
  ].join('\n'),
  inputs: ['trace'],
  noun: 'facts',
  labels: ['found', 'found'],
  empty: 'na',
};

/** Ragas AgentGoalAccuracy, step 2: the end state against the goal (inferred) or the expected outcome (reference). */
export const goalCompare = (withReference: boolean): JudgedMetric => ({
  id: 'goal-accuracy',
  version: withReference ? 'goal-compare-reference-v1' : 'goal-compare-v1',
  what: withReference ? 'Whether the end state of the run matches the expected outcome.' : 'Whether the end state of the run achieves the goal the user had.',
  instruction: [
    withReference ? 'Evaluation task: GOAL ACCURACY WITH REFERENCE (version goal-compare-reference-v1). Does the end state match the expected outcome?' : 'Evaluation task: GOAL ACCURACY (version goal-compare-v1). Does the end state achieve the user’s goal?',
    withReference ? '`endState` is where the run ended. `expectedOutcome` is what should have happened (written by the dataset’s author).' : '`goal` is what the user wanted. `endState` is where the run ended.',
    withReference ? 'Return exactly one item: `text` is "verdict", `verdict` is true if `endState` achieves the `expectedOutcome` (the same result; different wording is fine), false if it falls short of it, differs from it, or the run stopped without achieving it, `reason` is one or two sentences saying why.' : 'Return exactly one item: `text` is "verdict", `verdict` is true if `endState` shows the `goal` was achieved, false if it was only partly achieved, not achieved, or the system said it could not do it, `reason` is one or two sentences saying why.',
  ].join('\n'),
  inputs: withReference ? ['endState', 'expectedOutcome'] : ['goal', 'endState'],
  noun: 'verdicts',
  labels: ['achieved', 'not achieved'],
  empty: 0,
});

/** DeepEval ArgumentCorrectness: judged, no reference. */
export const ARGUMENT_CORRECTNESS: JudgedMetric = {
  id: 'argument-correctness',
  version: 'argument-correctness-v1',
  what: 'For each tool call: are its arguments right for what the user asked?',
  instruction: [
    'Evaluation task: ARGUMENT CORRECTNESS (version argument-correctness-v1). Did the system call its tools with the right arguments?',
    TRACE_NOTE,
    'Return one item per tool_call step, in order: `text` is the tool name with the step number, `verdict` is true if its `arguments` are what the user’s request needs (the right values, from the request or from earlier results, nothing invented, nothing missing that the request gave), false otherwise, `reason` names the argument that is wrong or confirms they fit.',
    'If the trace has no tool calls, return an empty `items` list.',
  ].join('\n'),
  inputs: ['trace'],
  noun: 'tool calls',
  labels: ['right arguments', 'wrong arguments'],
  empty: 'na',
};

/** Phoenix tool selection / invocation / response handling. */
export const toolSelection = (aspect: 'selection' | 'invocation' | 'handling'): JudgedMetric => {
  const task = {
    selection: 'Was each tool the right one to call at that point for what the user needed?',
    invocation: 'Was each tool called correctly: all required arguments present, well-formed, with sensible values?',
    handling: 'Did the system use each tool result correctly in what it did or said next, without ignoring or misreading it?',
  }[aspect];
  return {
    id: 'tool-selection',
    version: `tool-selection-${aspect}-v1`,
    what: task,
    instruction: [`Evaluation task: TOOL ${aspect.toUpperCase()} (version tool-selection-${aspect}-v1). ${task}`, TRACE_NOTE, 'Return one item per tool_call step, in order: `text` is the tool name with the step number, `verdict` true if yes, false if not, `reason` is one short sentence. If the trace has no tool calls, return an empty `items` list.'].join('\n'),
    inputs: ['trace'],
    noun: 'tool calls',
    labels: ['right', 'wrong'],
    empty: 'na',
  };
};

const tenPoint = (id: string, version: string, what: string, task: string, rule: string, extra: string[] = []): JudgedMetric => ({
  id,
  version,
  what,
  instruction: [`Evaluation task: ${task} (version ${version}).`, TRACE_NOTE, ...extra, rule].join('\n'),
  inputs: ['trace'],
  noun: 'ratings',
  labels: ['high', 'low'],
  empty: 0,
  rating: 10,
  ratingMin: 0,
});

/** DeepEval TaskCompletion: how fully the task the user set was completed. */
export const TASK_COMPLETION = tenPoint(
  'task-completion',
  'task-completion-v1',
  'How fully the run completed the task the user set.',
  'TASK COMPLETION',
  'Return exactly one item: `text` is "rating", `rating` is a whole number from 0 (nothing of the task was done) to 10 (the task was fully completed as asked), `verdict` is true if the rating is 6 or more, `reason` is one or two sentences naming what was done and what was not.',
  ['First work out the task from what the user asked, then decide how fully the run completed it.'],
);

/** DeepEval StepEfficiency: no step that was not needed. */
export const STEP_EFFICIENCY = tenPoint(
  'step-efficiency',
  'step-efficiency-v1',
  'Whether the run took only the steps it needed (no repeated, redundant or pointless tool calls).',
  'STEP EFFICIENCY',
  'Return exactly one item: `text` is "rating", `rating` is a whole number from 0 (mostly wasted steps) to 10 (every step was needed and none repeated), `verdict` is true if the rating is 6 or more, `reason` names the steps that were not needed.',
  ['Judge the path, not the result: a run that reaches the goal by a long way round scores lower than one that goes straight to it.'],
);

/** DeepEval PlanAdherence: the steps followed the plan the system stated. */
export const PLAN_ADHERENCE = tenPoint(
  'plan-adherence',
  'plan-adherence-v1',
  'Whether the run followed the plan the system stated.',
  'PLAN ADHERENCE',
  'Return exactly one item. If the system never stated a plan (an explicit list of steps it intends to take), `text` is "no plan", `rating` is 10, `verdict` is true. Otherwise `text` is "rating", `rating` is a whole number from 0 (the steps ignore the plan) to 10 (every step follows the plan, in order), `verdict` is true if the rating is 6 or more, and `reason` names where the run left the plan.',
);

/** DeepEval PlanQuality: the plan itself was good for the task. */
export const PLAN_QUALITY = tenPoint(
  'plan-quality',
  'plan-quality-v1',
  'Whether the plan the system stated is a good plan for the task.',
  'PLAN QUALITY',
  'Return exactly one item. If the system never stated a plan, `text` is "no plan", `rating` is 10, `verdict` is true. Otherwise `text` is "rating", `rating` is a whole number from 0 (a plan that could not reach the goal) to 10 (a complete, ordered plan that reaches it with no unnecessary step), `verdict` is true if the rating is 6 or more, and `reason` names what is missing or wrong in the plan.',
);

/** DeepEval MCP Use: the right MCP primitives, with good arguments, from those available. */
export const MCP_USE = tenPoint(
  'mcp-use',
  'mcp-use-v1',
  'Whether the run used the right MCP tools of those available, with good arguments.',
  'MCP USE',
  'Return exactly one item: `text` is "rating", `rating` is a whole number from 0 (the wrong tools, or arguments that could not work) to 10 (the best available tools, with correct arguments, and no tool a different one would have served better), `verdict` is true if the rating is 6 or more, `reason` names the best tool that was missed or the argument that was wrong.',
  ['`availableTools` lists the tools the MCP servers offered (name and description), when it is given. Judge the choice against that list.'],
);

/** DeepEval MCPTaskCompletion: each interaction was satisfied. */
export const MCP_TASK_COMPLETION: JudgedMetric = {
  id: 'mcp-task-completion',
  version: 'mcp-task-completion-v1',
  what: 'The share of the user’s requests that the run satisfied using the MCP tools.',
  instruction: [
    'Evaluation task: MCP TASK COMPLETION (version mcp-task-completion-v1). Did the run satisfy each thing the user asked, using the tools?',
    TRACE_NOTE,
    'Return one item per request the USER made, in order: `text` is the request, `verdict` is true if the run satisfied it (the tool calls and answers do what was asked), false if not, `reason` names the step that decides it.',
    'If the user made no request, return an empty `items` list.',
  ].join('\n'),
  inputs: ['trace'],
  noun: 'requests',
  labels: ['satisfied', 'not satisfied'],
  empty: 'na',
};

export const AGENT_PROMPTS: readonly JudgedMetric[] = [GOAL_INFER, goalCompare(false), goalCompare(true), ARGUMENT_CORRECTNESS, toolSelection('selection'), toolSelection('invocation'), toolSelection('handling'), TASK_COMPLETION, STEP_EFFICIENCY, PLAN_ADHERENCE, PLAN_QUALITY, MCP_USE, MCP_TASK_COMPLETION];
