/**
 * The AI actions of the node menus, as data (B-15, planning/ai-features.md AIB-10): ONE table that every right-click
 * "… with AI" item comes from. A view never writes an AI item of its own: it says it can do the action (`on`), and the
 * menu builder (node-menu.ts) takes the item — its label, icon, group, the kinds it applies to — from here. The same table
 * names the AI task each one runs and its CLI and MCP equivalents (the docs table and `testpion kinds --json` print them),
 * and Settings ▸ AI assistant ▸ "Hide all AI actions" removes every item that comes from it in one place.
 *
 * Adding an AI menu item is adding a row here (and its LABEL text); a test lists every row against the AI tasks, the CLI,
 * the MCP tools, the item kinds' `ai` capability and the window's views.
 */
import type { Capability } from './item-kinds.js';
import type { MenuGroup, MenuLabelKey, NodeKind } from './node-menu.js';

/** Every AI task by id (packages/core/src/ai/tasks/registry.ts holds the definitions): a task is named by this union everywhere, so a typo is a compile error. */
export const AI_TASK_IDS = [
  'explain-error', 'explain-response', 'explain-exchange', 'explain-timing', 'explain-test-failure', 'explain-test-history', 'explain-monitor',
  'explain-fuzz', 'explain-api-changes', 'fix-security', 'fix-openapi-lint', 'analyze', 'analyze-load', 'triage-attention', 'write-commit-message',
  'generate-assertions', 'generate-pm-tests', 'generate-test', 'design-flow', 'flow-from-collection', 'tests-from-spec', 'security-tests',
  'contract-drift', 'write-script', 'explain-script', 'tidy-import', 'import-leftovers', 'triage-run', 'analyze-flaky', 'suggest-coverage-tests',
  'generate-request', 'generate-query', 'generate-args', 'generate-mock-data', 'design-toolset', 'rag-judge', 'rag-suggest-mapping',
  'rag-explain-sample', 'rag-draft-metric', 'nl-search', 'free',
] as const;
export type AiTaskId = (typeof AI_TASK_IDS)[number];

export interface AiActionDef {
  /** The menu action id: what a view's `on` names. */
  id: string;
  /** The LABEL key of its text (apps/desktop/src/lib/vocabulary.ts). */
  label: MenuLabelKey;
  /** A lucide icon name (the window maps it). */
  icon: string;
  group: MenuGroup;
  /** The AI task it runs (packages/core/src/ai/tasks/registry.ts). */
  task: AiTaskId;
  /** Every item kind with this capability has it (flow: collections and folders) … */
  cap?: Capability;
  /** … or only these node kinds. */
  kinds?: readonly NodeKind[];
  /** The same thing from a terminal and from an agent. */
  cli: string;
  mcp: string;
  /** One line for the docs table. */
  text: string;
}

export const AI_ACTIONS = [
  {
    id: 'flow',
    label: 'generateFlow',
    icon: 'sparkles',
    group: 'tools',
    task: 'flow-from-collection',
    cap: 'flow',
    cli: 'testpion flow generate',
    mcp: 'flow_generate',
    text: 'An integration flow from the saved requests of a collection or folder, with TestPion’s draft improved and every step shown against it.',
  },
  {
    id: 'securityTests',
    label: 'generateSecurityTests',
    icon: 'sparkles',
    group: 'tools',
    task: 'security-tests',
    kinds: ['collection', 'folder'],
    cli: 'testpion security generate',
    mcp: 'security_tests_generate',
    text: 'OWASP API security tests (BOLA, broken authentication, mass assignment, function-level authorization) with verdicts computed from the responses.',
  },
  {
    id: 'tidyImport',
    label: 'tidyImport',
    icon: 'sparkles',
    group: 'tools',
    task: 'tidy-import',
    kinds: ['collection'],
    cli: 'testpion tidy --ai',
    mcp: 'tidy_import',
    text: 'Names, folders, variables and chained ids for a fresh import, as separate reviewable changes.',
  },
  {
    id: 'generateSpecTests',
    label: 'generateSpecTests',
    icon: 'sparkles',
    group: 'tools',
    task: 'tests-from-spec',
    kinds: ['spec'],
    cli: 'testpion generate tests',
    mcp: 'spec_tests_generate',
    text: 'Tests for the gaps in what is tested of an API definition: positive, negative, boundary and security cases.',
  },
  {
    id: 'driftReport',
    label: 'checkTraffic',
    icon: 'sparkles',
    group: 'tools',
    task: 'contract-drift',
    kinds: ['spec'],
    cli: 'testpion openapi-drift --ai',
    mcp: 'contract_drift',
    text: 'Real traffic compared with the definition: the drift explained and the spec patch or contract check proposed, verified against the same traffic.',
  },
  {
    id: 'suggestChecks',
    label: 'suggestChecks',
    icon: 'sparkles',
    group: 'tools',
    task: 'generate-assertions',
    kinds: ['request'],
    cli: 'testpion ai run generate-assertions --item request:<c>:<r>',
    mcp: 'ai_run_task',
    text: 'Checks for the latest response of a saved request, each run against it (and the one before) before it is offered.',
  },
  {
    id: 'triage',
    label: 'triageWithAi',
    icon: 'sparkles',
    group: 'tools',
    task: 'triage-run',
    kinds: ['run'],
    cli: 'testpion ai triage',
    mcp: 'ai_triage_run',
    text: 'A failed run’s failures grouped by cause, each with evidence and a fix verified against the failing and the last passing response.',
  },
  {
    id: 'analyzeFlaky',
    label: 'whyFlaky',
    icon: 'sparkles',
    group: 'tools',
    task: 'analyze-flaky',
    kinds: ['test-case'],
    cli: 'testpion ai run analyze-flaky',
    mcp: 'ai_analyze_flaky',
    text: 'Why a test passes and fails without a change, and a fix that does not hide a failure (Attempt to fix runs it again).',
  },
  // not a tree node's menu: the script editors' "Script with AI" menu (Pre-request / Post-response; the window builds it with aiMenuItems)
  {
    id: 'writeScript',
    label: 'writeScriptAi',
    icon: 'sparkles',
    group: 'tools',
    task: 'write-script',
    cli: 'testpion ai script',
    mcp: 'write_script',
    text: 'A pre-request or post-response script from a description, written for the tp.* script API (never pm.*) and run once in the sandbox before it is offered.',
  },
  {
    id: 'fixScript',
    label: 'fixScriptAi',
    icon: 'sparkles',
    group: 'tools',
    task: 'write-script',
    cli: 'testpion ai script --script <file> --error <text>',
    mcp: 'write_script',
    text: 'The script on screen fixed from what went wrong (its error and logs), changed as little as possible and run in the sandbox.',
  },
  {
    id: 'explainScript',
    label: 'explainScriptAi',
    icon: 'sparkles',
    group: 'tools',
    task: 'explain-script',
    cli: 'testpion ai run explain-script',
    mcp: 'ai_run_task',
    text: 'What the script does step by step, which variables it reads and sets, and what would go wrong.',
  },
  // not a tree node's menu: the ⋯ menu of a row of the Problems list (the window builds it with aiMenuItems)
  {
    id: 'askProblem',
    label: 'askAi',
    icon: 'sparkles',
    group: 'tools',
    task: 'triage-attention',
    cli: 'testpion ai run triage-attention',
    mcp: 'ai_run_task',
    text: 'What to do about one problem of the Problems list, with its message and what it names (never values).',
  },
] as const satisfies readonly AiActionDef[];

export type AiActionId = (typeof AI_ACTIONS)[number]['id'];

const BY_ID = new Map<string, AiActionDef>(AI_ACTIONS.map((a) => [a.id, a]));

/** An AI action by its menu action id. */
export const aiActionOf = (id: string): AiActionDef | undefined => BY_ID.get(id);
