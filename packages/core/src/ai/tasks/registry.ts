/**
 * The AI tasks (AIB-1): one definition per thing the AI features do — its id, title, prompt version, tier (small model
 * or large), the instruction (prompts.ts), what its context holds, what it outputs, how its answer becomes a proposal
 * and which verifiers check it. The app, the CLI (`testpion ai tasks|run`), the MCP server (`ai_list_tasks`,
 * `ai_run_task`) and a cloud host all read this one table.
 */
import { parseYaml, stringifyYaml as toYaml } from '../../util/lazy-yaml.js';
import { checkLabel, type ItemRef } from '@testpion/shared';
import type { CheckConfig, Collection } from '../../model/types.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import type { StoredResponse } from '../verify.js';
import type { AiPrivacy, AiTier } from '../ai-settings.js';
import { parseGeneratedRequest } from '../assist.js';
import type { ProposalFinding, ProposalItem } from '../proposal.js';
import { TASK_INSTRUCTIONS } from './prompts.js';
import { quoteTemplateValues } from '../yaml-repair.js';
import type { FormatKind } from '../flow-format.js';
import { describeTriage, prepareTriage, proposeTriage, TRIAGE_SCHEMA } from '../triage.js';
import { describeFlaky, FLAKY_SCHEMA, prepareFlaky, proposeFlaky } from '../flaky.js';
import { describeTidy, prepareTidyContext, proposeTidy, TIDY_PLAN_SCHEMA, TIDY_VERIFIERS } from '../tidy-import.js';
import { describeLeftovers, LEFTOVERS_PLAN_SCHEMA, LEFTOVERS_VERIFIERS, prepareLeftoversContext, proposeLeftovers } from '../import-leftovers.js';
import { describeSpecTests, prepareSpecContext, proposeSpecTests, SPEC_PLAN_SCHEMA, SPEC_TEST_VERIFIERS } from '../spec-tests.js';
import { prepareChecksItem, proposeChecksItems } from '../result-checks.js';
import { describeScript, prepareScriptContext, proposeScript, SCRIPT_PLAN_SCHEMA, SCRIPT_VERIFIERS } from '../write-script.js';
import { describeDrift, DRIFT_PLAN_SCHEMA, DRIFT_VERIFIERS, prepareDriftContext, proposeDrift } from '../contract-drift.js';
import { describeSecurity, prepareSecurityContext, proposeSecurity, SECURITY_PLAN_SCHEMA, SECURITY_VERIFIERS } from '../security-tests.js';
import { VERDICT_SCHEMA } from '../../eval/rag/judge-prompts.js';
import { NL_SEARCH_SCHEMA, validateNlSearch } from '../nl-search.js';
import { describeFlow, FLOW_PLAN_SCHEMA, FLOW_VERIFIERS, prepareFlowContext, proposeFlow } from '../flow-from-collection.js';

export type AiTaskOutput = { kind: 'markdown' } | { kind: 'code'; language: 'yaml' | 'json' | 'javascript' | 'graphql' | 'text' } | { kind: 'json'; schema: Record<string, unknown> };

/** What a task was asked: what the proposal function sees. */
export interface AiTaskInput {
  question?: string;
  context?: Record<string, unknown>;
  /** The workspace item it is about (a request, a run result, a flow …). */
  item?: ItemRef;
  /** Where a generated file goes (under tests/). */
  path?: string;
  /** Where a generated request goes (a collection or a folder). */
  target?: ItemRef;
  model: string;
  /** What the task's `prepare` read from the workspace for building the proposal: kept on this computer, never sent. */
  local?: unknown;
  /** A short name of what it is about ("Orders / Refunds"). */
  label?: string;
  /** "Prefer stable checks" is on for this call (the setting, or the caller's choice). */
  preferStable?: boolean;
}

/** What a task's own `prepare` reads from the workspace for an item (instead of the generic item context). */
export interface PreparedItem {
  label: string;
  /** Sent (after redaction, the privacy level and the budgets). */
  context: Record<string, unknown>;
  /** Kept on this computer for `propose` (the saved requests a flow is built from …). */
  local?: unknown;
  /** The collection flows are verified against (its mock). */
  collection?: Collection;
  /** Where a generated file goes when the caller names none. */
  path?: string;
  response?: StoredResponse;
  /** The response before it (a check that passes on `response` but not on it pins a value that changes). */
  previous?: StoredResponse;
}

/** A proposal item before ids, verification and selection are added. */
export type DraftItem = Omit<ProposalItem, 'id' | 'verification' | 'selected'> & { selected?: boolean };

export interface AiTaskDef {
  id: string;
  /** Bumped with every change to the instruction or the output format. */
  version: number;
  title: string;
  /** One line: what it does (CLI and MCP listings). */
  description: string;
  tier: AiTier;
  instruction: string;
  output: AiTaskOutput;
  /** What its context holds (for agents and the docs): the keys a caller passes. */
  context: string;
  /** Token budgets of named context sections (the rest share the task's budget). */
  sectionBudgets?: Record<string, number>;
  /** Total context budget in tokens (default 6000). */
  contextTokens?: number;
  /** Most output tokens (default 2000 small, 4000 large). */
  maxTokens?: number;
  /** The names (never values) of the variables in scope are added to the context. */
  variableNames?: boolean;
  /** Turns the answer into proposal items; a task without one answers only (an explanation). */
  propose?(answer: { text: string; code: string; value?: unknown }, input: AiTaskInput): DraftItem[] | { items: DraftItem[]; notes?: string[]; problems?: string[] };
  /** The verifiers (verify.ts) its items go through. */
  verifiers?: string[];
  /** Checks a JSON answer that proposes nothing (a search query): its problems go back to the model like a verifier's. */
  validate?(value: unknown): string[];
  /** Repair turns when verification fails (default 2; 0 for prose). */
  maxRepairs?: number;
  /** Makes a code answer safe before it is verified (an unquoted {{ in YAML quoted); what it fixed goes into the proposal's notes. */
  normalize?(code: string): { code: string; notes: string[] };
  /** The test-file format reference added to its instruction (flow-format.ts, made from the schema and the check registry): the whole format, or the checks alone. */
  format?: FormatKind | FormatKind[];
  /** The sampling temperature (default 0.2; a judge uses 0 so the same input gives the same verdict as often as the model allows). */
  temperature?: number;
  /** Other ids it answers to (`suggest-assertions` for generate-assertions). */
  aliases?: string[];
  /** `prepare` reads an item when one is given; the task also runs without one (the caller passes the context). */
  itemOptional?: boolean;
  /** It writes checks: "Prefer stable checks" (Settings, or the call's own choice) adds its sentence to the instruction. */
  stable?: boolean;
  /** Reads its own context for a workspace item (else the generic item context, item-context.ts). */
  prepare?(store: WorkspaceStore, item: ItemRef, o: { path?: string; privacy: AiPrivacy; context?: Record<string, unknown> }): Promise<PreparedItem> | PreparedItem;
  /** The summary, assumptions, notes and findings of a JSON task's proposal (what the review shows above the items). */
  describe?(value: unknown, items: ProposalItem[], input: AiTaskInput): { summary?: string; assumptions?: string[]; notes?: string[]; findings?: ProposalFinding[] };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'generated';

/** The file a generated test goes to: the caller's path, else tests/ai/<what it is about>.yaml. */
const filePath = (input: AiTaskInput, fallback: string) => (input.path ? input.path.replace(/^tests[\\/]/, '') : `ai/${slug(input.question || fallback)}.yaml`);

/** The checks of a YAML (or JSON) answer: a list, or `assertions:` / `checks:` of an object. */
export function checksOfAnswer(code: string): CheckConfig[] {
  let doc: unknown;
  try {
    doc = parseYaml(code);
  } catch (e) {
    throw new Error(`The checks are not valid YAML: ${(e as Error).message}`);
  }
  const list = Array.isArray(doc) ? doc : ((doc as { assertions?: unknown; checks?: unknown })?.assertions ?? (doc as { checks?: unknown })?.checks);
  if (!Array.isArray(list)) throw new Error('The answer is not a list of checks');
  return list.filter((c): c is CheckConfig => !!c && typeof c === 'object' && typeof (c as CheckConfig).type === 'string');
}

const requestOf = (input: AiTaskInput): ItemRef | undefined => (input.item?.kind === 'request' ? input.item : undefined);

const testFile =
  (fallback: string) =>
  (a: { code: string }, input: AiTaskInput): DraftItem[] => {
    const path = filePath(input, fallback);
    return [{ kind: 'flow', title: `tests/${path}`, path, after: a.code, language: 'yaml', target: { kind: 'flow', path } }];
  };

const textItem =
  (language: NonNullable<DraftItem['language']>, title: string) =>
  (a: { code: string }): DraftItem[] => [{ kind: 'text', title, after: a.code, language }];

const REQUEST_SCHEMA = {
  type: 'object',
  required: ['method', 'url'],
  properties: {
    name: { type: 'string', description: 'A short name' },
    method: { type: 'string', description: 'The HTTP method' },
    url: { type: 'string', description: 'The full URL; {{variables}} for hosts and secrets' },
    headers: { type: 'array', items: { type: 'object', required: ['key', 'value'], properties: { key: { type: 'string' }, value: { type: 'string' } } } },
    body: { description: 'A JSON value, a text, or null' },
  },
};

const CHECKS_SCHEMA = {
  type: 'object',
  required: ['checks'],
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { type: 'string', description: 'status, exists, equals, contains, regex, type, length, json-schema, latency, header' },
          path: { type: 'string', description: 'JSONPath into the body, e.g. $.items[0].id' },
          expected: { description: 'The expected value (status code, value, type name)' },
          pattern: { type: 'string', description: 'regex: the pattern' },
        },
      },
    },
  },
};

const TESTS_SCHEMA = {
  type: 'object',
  required: ['tests'],
  properties: {
    tests: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'code'],
        properties: {
          name: { type: 'string', description: 'What the test checks' },
          code: { type: 'string', description: 'The body of the test function: self-contained (reads tp.response itself), tp.* only' },
        },
      },
    },
  },
};

/** The checks of a JSON answer ({ checks: [...] } or a list). */
export function checksOfValue(v: unknown): CheckConfig[] {
  const list = Array.isArray(v) ? v : (v as { checks?: unknown; assertions?: unknown } | undefined)?.checks ?? (v as { assertions?: unknown } | undefined)?.assertions;
  if (!Array.isArray(list)) throw new Error('The answer has no `checks` list');
  return list
    .filter((c): c is CheckConfig => !!c && typeof c === 'object' && typeof (c as CheckConfig).type === 'string')
    .map((c) => Object.fromEntries(Object.entries(c).filter(([k, x]) => x !== undefined && x !== null && k !== 'why' && k !== 'reason')) as CheckConfig);
}

/** The tests of a JSON answer ({ tests: [{ name, code }] }). */
export function testsOfValue(v: unknown): Array<{ name: string; code: string }> {
  const list = (v as { tests?: unknown } | undefined)?.tests ?? v;
  if (!Array.isArray(list)) throw new Error('The answer has no `tests` list');
  return list
    .filter((t): t is { name: unknown; code: string } => !!t && typeof t === 'object' && typeof (t as { code?: unknown }).code === 'string' && !!(t as { code: string }).code.trim())
    .map((t, i) => ({ name: typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 120) : `Test ${i + 1}`, code: t.code }));
}

/** One self-contained tp.test (a test the model already wrapped stays as it is), labelled as AI-generated. */
export function tpTestScript(name: string, code: string, model: string): string {
  const body = code
    .split(/\r?\n/)
    // the sandbox only provides crypto-js and uuid: other imports could never run
    .filter((l) => !/^\s*import\s/.test(l) && !/\brequire\(\s*['"](?!crypto-js['"]|uuid['"])[^'"]*['"]\s*\)/.test(l))
    .join('\n')
    .trim();
  const wrapped = /^\s*(tp|pm)\.test\s*\(/.test(body) ? body : `tp.test(${JSON.stringify(name)}, () => {\n${body.replace(/^/gm, '  ')}\n});`;
  return `// AI-generated test (${model}): review it before relying on it.\n${wrapped}\n`;
}

/** Test and flow YAML from a model: values that start with {{ quoted (the mistake models make most). */
const yamlTemplates = (code: string) => {
  const r = quoteTemplateValues(code);
  return { code: r.text, notes: r.fixed ? [`Fixed ${r.fixed} unquoted template value${r.fixed === 1 ? '' : 's'}: a YAML value that starts with {{ must be in quotes.`] : [] };
};

const md = { kind: 'markdown' } as const;

const T = (id: string, d: Omit<AiTaskDef, 'id' | 'instruction' | 'version'> & { version?: number }): AiTaskDef => ({ id, version: d.version ?? 1, instruction: TASK_INSTRUCTIONS[id]!, ...d });

export const AI_TASKS: readonly AiTaskDef[] = [
  T('explain-error', {
    title: 'Explain an error',
    description: 'What went wrong, why, and how to fix it.',
    tier: 'small',
    output: md,
    context: 'error (a normalised error), and what was sent (request)',
  }),
  T('explain-response', {
    title: 'Explain a response',
    description: 'What an HTTP response means and how to fix the request.',
    tier: 'small',
    output: md,
    context: 'request (method, url), status, headers, body',
    sectionBudgets: { body: 3000 },
  }),
  T('explain-exchange', {
    title: 'Explain a captured exchange',
    description: 'One HTTP exchange the Debugger captured, in plain words.',
    tier: 'small',
    output: md,
    context: 'exchange (request, response, timings, client)',
  }),
  T('explain-timing', {
    title: 'Explain the timing of a request',
    description: 'Where the time of a request went and what to try.',
    tier: 'small',
    output: md,
    context: 'timing phases, connection reuse, certificate',
  }),
  T('explain-test-failure', {
    title: 'Explain a failed test',
    description: 'Why a test failed, whether the API or the test is wrong, and the change to make.',
    tier: 'small',
    output: md,
    context: 'test (name, type), checks (failed and passed, expected/actual), input, output',
  }),
  T('explain-test-history', {
    title: 'Explain a test history',
    description: 'Flaky, broken since when, or slowing down — and the likely cause.',
    tier: 'small',
    output: md,
    context: 'runs (newest first: status, latency, failed checks, environment), summary',
  }),
  T('explain-monitor', {
    title: 'Explain a failing monitor',
    description: 'What is wrong with a monitored API, since when, and what to do.',
    tier: 'small',
    output: md,
    context: 'monitor (schedule, limits), results, requests',
  }),
  T('explain-fuzz', {
    title: 'Explain fuzz findings',
    description: 'Groups API fuzzing findings by cause with the fix.',
    tier: 'small',
    output: md,
    context: 'findings (operation, request, status, kind)',
  }),
  T('explain-api-changes', {
    title: 'Explain API changes',
    description: 'Which clients break between two OpenAPI versions and how to stay compatible.',
    tier: 'large',
    output: md,
    context: 'breaking, other (changes), operations',
  }),
  T('fix-security', {
    title: 'Fix security findings',
    description: 'The risk and the exact TestPion fix for each kind of security finding.',
    tier: 'small',
    output: md,
    context: 'collection, findings (severity, category, where, message)',
  }),
  T('fix-openapi-lint', {
    title: 'Fix OpenAPI lint problems',
    description: 'Why each lint rule matters and the YAML change that fixes it.',
    tier: 'large',
    output: md,
    context: 'problems (rule, line, where, message), document',
    sectionBudgets: { problems: 2000 },
  }),
  T('analyze', { title: 'Analyse results', description: 'Patterns, regressions, bottlenecks and likely causes in results.', tier: 'small', output: md, context: 'results' }),
  T('analyze-load', { title: 'Analyse a load test', description: 'Bottleneck requests, errors under load, what to tune next.', tier: 'small', output: md, context: 'config, results, lastSeconds' }),
  T('triage-attention', {
    title: 'What to fix first',
    description: 'Orders what needs attention in a workspace and groups shared causes.',
    tier: 'small',
    output: md,
    context: 'items (severity, kind, message)',
  }),
  T('write-commit-message', {
    title: 'Write a commit message',
    description: 'A git commit message from the semantic changes of a workspace.',
    tier: 'small',
    output: { kind: 'code', language: 'text' },
    context: 'changes (requests, environments, files)',
    maxRepairs: 0,
    propose: textItem('text', 'Commit message'),
  }),
  T('generate-assertions', {
    version: 5,
    format: 'checks',
    aliases: ['suggest-assertions'],
    stable: true,
    itemOptional: true,
    title: 'Suggest assertions',
    description:
      'Checks for a response (status, fields, types) as JSON, each verified against the response it was written for (and the one before it): unstable values are flagged with a safer form; "Prefer stable checks" (a setting, or preferStable) asks for types and formats over literal ids and times. From a run result (run:<runId>:<resultId>) they are made for the response the run stored and join the request or the step of the test file that produced it.',
    tier: 'large',
    output: { kind: 'json', schema: CHECKS_SCHEMA },
    context: 'request (method, url), status, headers, body (the response the checks are for); item: request:<c>:<r> uses its latest response, run:<runId>:<resultId> the response a run stored for that result, history:<id> that exchange',
    sectionBudgets: { body: 3000 },
    verifiers: ['checks'],
    prepare: (store, item) => prepareChecksItem(store, item),
    propose: (a, input) => proposeChecksItems(checksOfValue(a.value), input, requestOf(input)),
  }),
  T('generate-pm-tests', {
    version: 4,
    format: 'script',
    aliases: ['generate-tests'],
    title: 'Write tp tests',
    description: 'tp.test checks for a response as JSON, one test per item, each run in the sandbox against the response (tp.* only, never pm.*).',
    tier: 'large',
    output: { kind: 'json', schema: TESTS_SCHEMA },
    context: 'request, response (status, headers, body); item: request:<c>:<r> uses its latest response',
    sectionBudgets: { response: 3000, body: 3000 },
    verifiers: ['script'],
    propose: (a, input) =>
      testsOfValue(a.value).map((t) => ({
        kind: 'script',
        title: t.name,
        after: tpTestScript(t.name, t.code, input.model),
        language: 'javascript',
        data: { phase: 'test', mode: 'append', name: t.name },
        ...(requestOf(input) ? { target: requestOf(input) } : {}),
      })),
  }),
  T('generate-test', {
    version: 3,
    format: 'flow',
    normalize: yamlTemplates,
    title: 'Write a test',
    description: 'A TestPion YAML test for a scenario, linted before it is offered.',
    tier: 'large',
    output: { kind: 'code', language: 'yaml' },
    context: 'the scenario (question) and what it is about',
    variableNames: true,
    verifiers: ['test-file', 'flow-refs', 'flow-mock'],
    propose: testFile('test'),
  }),
  T('design-flow', {
    version: 3,
    format: 'flow',
    normalize: yamlTemplates,
    title: 'Design an integration flow',
    description: 'A multi-step flow (extract, dependsOn, assertions) as one test file, linted and checked for undefined variables.',
    tier: 'large',
    output: { kind: 'code', language: 'yaml' },
    context: 'steps (the current flow, if any), requests (saved requests it may use)',
    variableNames: true,
    contextTokens: 8000,
    maxTokens: 6000,
    verifiers: ['test-file', 'flow-refs', 'flow-mock'],
    propose: testFile('flow'),
  }),
  T('flow-from-collection', {
    version: 2,
    format: 'checks',
    title: 'Integration flow',
    description:
      'An integration flow from a collection or folder: the deterministic draft improved (order, extracts, checks, error cases), each step a saved request by id; linted, variables checked, tried on a mock.',
    tier: 'large',
    output: { kind: 'json', schema: FLOW_PLAN_SCHEMA },
    context: 'item: collection:<id> or folder:<collectionId>:<folderId> (its requests, saved examples, the draft, matching OpenAPI operations, variable names)',
    variableNames: true,
    contextTokens: 12_000,
    sectionBudgets: { requests: 8000, draft: 1500, api: 1500 },
    maxTokens: 8000,
    verifiers: FLOW_VERIFIERS,
    prepare: (store, item, o) => prepareFlowContext(store, item, o),
    propose: proposeFlow,
    describe: describeFlow,
  }),
  T('tests-from-spec', {
    version: 1,
    title: 'Tests from a spec',
    description:
      "Tests for an OpenAPI document, driven by the gaps in the tests that exist (the gap report is deterministic): positive, negative, boundary and security cases as test files under tests/<api>/ — TestPion builds the deterministic ones from the document, the model adds ideas (what to change in the valid example and the status to expect); an operation the document does not have is dropped, the checks come from the document (status, openapi contract, a shallow JSON Schema), every test is validated against the document, and the proposal says the coverage before → after.",
    tier: 'large',
    output: { kind: 'json', schema: SPEC_PLAN_SCHEMA },
    context: 'item: spec:<path> (an API definition under specs/; its operations with limits and documented responses, the gaps in the existing tests, the draft); context.options {categories, operations, gapsOnly, includeDelete}',
    contextTokens: 12_000,
    sectionBudgets: { operations: 9000 },
    maxTokens: 8000,
    verifiers: SPEC_TEST_VERIFIERS,
    prepare: (store, item, o) => prepareSpecContext(store, item, o),
    propose: proposeSpecTests,
    describe: describeSpecTests,
  }),
  T('security-tests', {
    version: 1,
    title: 'Security tests',
    description:
      "OWASP API security tests for a collection or folder as one test file with deterministic verdicts: BOLA (a second user repeats the owner's request), broken authentication (no credentials, an invalid token), mass assignment (privileged fields added to a body) and function-level authorization (a lower-privilege user calls an owner's function). The model only proposes which saved requests to probe and which variables hold the principals' credentials; TestPion writes the steps from the saved requests and the verdicts are checks computed from the responses (a status that must be 401/403/404, a value that must not appear, a field that must not be echoed). Safe by design: read-only unless write or delete probes are asked for, paced, capped, refuses a production environment, nothing runs until the person runs the file.",
    tier: 'large',
    output: { kind: 'json', schema: SECURITY_PLAN_SCHEMA },
    context:
      'item: collection:<id> or folder:<collectionId>:<folderId> (its HTTP requests with auth type, header and query names, body shape and saved examples; the deterministic draft); context.options {probes, identities {owner, other}: variable names, includeWrite, includeDelete, rate, max, environment}',
    contextTokens: 12_000,
    sectionBudgets: { requests: 8000, draft: 1500 },
    maxTokens: 6000,
    variableNames: false,
    verifiers: SECURITY_VERIFIERS,
    prepare: (store, item, o) => prepareSecurityContext(store, item, o),
    propose: proposeSecurity,
    describe: describeSecurity,
  }),
  T('contract-drift', {
    version: 1,
    title: 'Contract drift explained',
    description:
      "An OpenAPI document compared with real traffic (History, a HAR file or a run's stored responses): TestPion finds the drift itself (an endpoint, status or content type the document lacks; a field it does not have; a type that differs; a required field that is missing; a null it forbids; an enum value outside it), the model explains the impact and says who is right and what to do per finding, and the fix is a reviewed proposal — a spec patch TestPion makes from what was observed (never written by the model), or a contract check pinned to the saved request. Every patch is verified against the same traffic: the drift must be gone, no other drift may appear, and the document must lint no worse.",
    tier: 'large',
    output: { kind: 'json', schema: DRIFT_PLAN_SCHEMA },
    context:
      'item: spec:<path> (an API definition under specs/); context.options.source {kind: history {limit, host, requestId} | har {path, text} | run {runId}} (default: History, newest 300). The context holds the findings, never the traffic',
    contextTokens: 12_000,
    sectionBudgets: { findings: 7000, schemas: 3000 },
    maxTokens: 6000,
    verifiers: DRIFT_VERIFIERS,
    prepare: (store, item, o) => prepareDriftContext(store, item, o),
    propose: proposeDrift,
    describe: describeDrift,
  }),
  T('write-script', {
    version: 1,
    format: 'script',
    itemOptional: true,
    title: 'Write a script',
    description:
      "A pre-request or post-response script from a description (or a script that threw, fixed with its error and logs), written for the tp.* script API as the sandbox has it (never pm.*) and run once in the sandbox before it is offered: the static check names every member that does not exist, the dry run says what it did (variables set, headers or URL changed, tests run) and a script that throws is repaired, not offered as ready.",
    tier: 'large',
    output: { kind: 'json', schema: SCRIPT_PLAN_SCHEMA },
    context:
      'question: what the script should do; context {phase: pre | test, script: the one on screen, error, logs, request {method, url, headers, body}, status, headers, body}; item: request:<c>:<r> reads its request and latest response; variable names are added',
    variableNames: true,
    sectionBudgets: { body: 3000, script: 3000 },
    maxTokens: 3000,
    verifiers: SCRIPT_VERIFIERS,
    prepare: (store, item, o) => prepareScriptContext(store, item, o),
    propose: proposeScript,
    describe: describeScript,
  }),
  T('explain-script', {
    version: 1,
    format: 'script',
    title: 'Explain a script',
    description: 'What a tp.* script does, which variables it reads and sets, and what would go wrong (members that do not exist, pm.* names, async code), with the fix for an error.',
    tier: 'small',
    output: md,
    context: 'script (the code), phase, error and logs (when it failed), the request and response it runs on',
    sectionBudgets: { script: 4000 },
  }),
  T('tidy-import', {
    version: 1,
    title: 'Tidy this import',
    description:
      "A freshly imported collection (Postman, curl, HAR, Insomnia, Bruno) tidied as separate reviewable changes: sensible names and folders, a host or token typed into many requests becomes a variable, a hard-coded id an earlier response returns is chained (a tp.* script sets the variable), tracking, static and duplicate requests are dropped, optionally a flow wiring the requests. TestPion finds the hosts, tokens, noise, duplicates and the chains a saved example confirms itself; the model names and groups. Every change is verified: the result is a valid collection and every remaining request sends exactly what it sent (variables resolved).",
    tier: 'large',
    output: { kind: 'json', schema: TIDY_PLAN_SCHEMA },
    context: 'item: collection:<id> (its requests with a saved example, the hosts, the findings TestPion made); context.options {flow, source}',
    contextTokens: 12_000,
    sectionBudgets: { requests: 8000, findings: 2000 },
    maxTokens: 8000,
    verifiers: TIDY_VERIFIERS,
    prepare: (store, item, o) => prepareTidyContext(store, item, o),
    propose: proposeTidy,
    describe: describeTidy,
  }),
  T('import-leftovers', {
    version: 1,
    format: 'script',
    aliases: ['import-cleanup'],
    title: 'Fix what the import left',
    description:
      "The scripts of an imported collection that still carry a // TODO(import) line (a call the converter found no tp.* equivalent for: pm.datasets, bru.getAuthMode, insomnia.parentFolders …), rewritten with TestPion's script API as a reviewable proposal: one item per script with a diff. TestPion finds the marked scripts itself; the model only rewrites them. Every script is checked statically (no pm.* / bru.* / members that do not exist), run once in the sandbox against the request's saved example response (else a stand-in), and refused when it throws; nothing is sent to the real API, nothing is applied until the person accepts, and applying is one undo step.",
    tier: 'large',
    output: { kind: 'json', schema: LEFTOVERS_PLAN_SCHEMA },
    context: 'item: collection:<id> or folder:<collectionId>:<folderId> (its scripts with a TODO(import) marker, each with the request, the marked lines and the saved response; at most 12 scripts)',
    contextTokens: 12_000,
    sectionBudgets: { leftovers: 9000 },
    maxTokens: 6000,
    variableNames: true,
    verifiers: LEFTOVERS_VERIFIERS,
    prepare: (store, item) => prepareLeftoversContext(store, item),
    propose: proposeLeftovers,
    describe: describeLeftovers,
  }),
  T('triage-run', {
    version: 2,
    format: ['checks', 'script'],
    title: 'Explain and fix failures',
    description:
      "A failed run's failures grouped by likely cause (one cause may explain many), each with evidence (the failing step, request and response, the failed check, what changed since the last passing run), a confidence and a fix — a check to change, an edit of the test, a variable to set, or none (the API regressed: a bug report) — verified against the failing and the last passing response before it is offered.",
    tier: 'large',
    output: { kind: 'json', schema: TRIAGE_SCHEMA },
    context: 'item: run:<runId> or run:last (its failures grouped: same check, status and endpoint; representatives with their evidence and last passing run)',
    contextTokens: 10_000,
    sectionBudgets: { groups: 9000 },
    maxTokens: 4000,
    verifiers: ['fix'],
    prepare: (store, item, o) => prepareTriage(store, item, o),
    propose: proposeTriage,
    describe: describeTriage,
  }),
  T('analyze-flaky', {
    version: 2,
    // the whole test-file format: a fix changes a step (until:, a check) and must stay valid YAML
    format: ['flow', 'script'],
    title: 'Why is this flaky?',
    description:
      "A flaky test's pass/fail history with the failing outputs: the pattern (timing, ordering, shared state, a time-dependent value, an external dependency, a rate limit, a data collision) with evidence, and a fix that makes it stable without hiding a failure (a wait with until:, a stable check, isolated data; a retry only as a last resort; never quarantine), verified; Attempt to fix applies it and runs the test again.",
    tier: 'large',
    output: { kind: 'json', schema: FLAKY_SCHEMA },
    context: 'item: test-case:<testId> (a flaky test as flaky_tests names it) or test:<path>[:<step>]',
    contextTokens: 8000,
    sectionBudgets: { history: 3000, samples: 3500 },
    maxTokens: 3000,
    verifiers: ['fix'],
    prepare: (store, item, o) => prepareFlaky(store, item, o),
    propose: proposeFlaky,
    describe: describeFlaky,
  }),
  T('suggest-coverage-tests', {
    version: 3,
    format: 'flow',
    normalize: yamlTemplates,
    title: 'Tests for coverage gaps',
    description: 'YAML tests for the operations and statuses the tests never reach.',
    tier: 'large',
    output: { kind: 'code', language: 'yaml' },
    context: 'api, gaps (operations, untestedStatuses)',
    variableNames: true,
    maxTokens: 6000,
    verifiers: ['test-file', 'flow-refs'],
    propose: testFile('coverage-gaps'),
  }),
  T('generate-request', {
    title: 'Write a request',
    description: 'One HTTP request from a description; variable names in scope, never values.',
    tier: 'small',
    output: { kind: 'json', schema: REQUEST_SCHEMA },
    context: 'the description (question); variable names are added',
    variableNames: true,
    propose: (a, input) => {
      const r = parseGeneratedRequest(JSON.stringify(a.value ?? {}));
      return [
        { kind: 'request', title: r.name ?? `${r.request.method} ${r.request.url}`, after: JSON.stringify(r, null, 2), language: 'json', data: r, ...(input.target ? { target: input.target } : {}) },
      ];
    },
  }),
  T('generate-query', {
    title: 'Write a GraphQL query',
    description: 'A GraphQL operation for the request using its schema.',
    tier: 'large',
    output: { kind: 'code', language: 'graphql' },
    context: 'schema (SDL or introspection), the request',
    sectionBudgets: { schema: 4000 },
    propose: textItem('graphql', 'GraphQL operation'),
  }),
  T('generate-args', {
    title: 'Write tool arguments',
    description: 'Example JSON arguments that satisfy an MCP tool input schema.',
    tier: 'small',
    output: { kind: 'code', language: 'json' },
    context: 'tool (name, description), schema (inputSchema)',
    verifiers: ['json'],
    propose: textItem('json', 'Arguments'),
  }),
  T('generate-mock-data', {
    title: 'Generate mock data',
    description: 'Realistic mock data for a description or schema.',
    tier: 'small',
    output: { kind: 'code', language: 'json' },
    context: 'description or schema',
    verifiers: ['json'],
    propose: textItem('json', 'Mock data'),
  }),
  T('design-toolset', {
    title: 'Design an MCP toolset',
    description: 'Tools for an agent as a TestPion MCP mock definition (YAML).',
    tier: 'large',
    output: { kind: 'code', language: 'yaml' },
    context: 'the job (question), existing tools',
    maxTokens: 6000,
    verifiers: ['yaml'],
    propose: textItem('yaml', 'MCP toolset'),
  }),
  T('rag-judge', {
    title: 'Judge a RAG answer',
    description:
      'One evaluation task of a RAG metric (the question holds the metric’s instruction): the answer is split into claims or statements and each gets a verdict with its evidence, as JSON. Used by the judged RAG metrics (rag-faithfulness, rag-answer-relevance); the verdicts are cached by content, counted in the usage ledger and limited by the AI caps.',
    tier: 'large',
    output: { kind: 'json', schema: VERDICT_SCHEMA },
    context: 'question (the user’s question), answer, contexts [{id, text}], reference (only what the metric needs)',
    temperature: 0,
    contextTokens: 24_000,
    maxTokens: 3000,
    maxRepairs: 2,
  }),
  T('nl-search', {
    title: 'Ask about history, runs and traces',
    description:
      'Translates a question ("failed payment calls last week over 2 s") into a validated search query over History, runs, test results and traces; TestPion runs the query itself. The model sees the question and the field names, never the data; the query is shown in plain words and as editable chips.',
    tier: 'small',
    output: { kind: 'json', schema: NL_SEARCH_SCHEMA },
    context: 'now (ISO time), scope (the sources asked in, optional); the question is the question',
    contextTokens: 1500,
    maxTokens: 800,
    maxRepairs: 2,
    validate: validateNlSearch,
  }),
  T('free', {
    title: 'Ask the assistant',
    description: 'A free question about API, protocol or AI testing, with the context of what is on screen.',
    tier: 'small',
    output: md,
    context: 'anything on screen (optional)',
  }),
];

const BY_ID = new Map(AI_TASKS.flatMap((t) => [[t.id, t] as const, ...(t.aliases ?? []).map((a) => [a, t] as const)]));

/** A task by id; an unknown id answers as a free question (the app's old behaviour) only when `lenient`. */
export function aiTask(id: string, o: { lenient?: boolean } = {}): AiTaskDef | undefined {
  return BY_ID.get(id) ?? (o.lenient ? BY_ID.get('free') : undefined);
}

/** The list agents and the CLI see: what each task does, its tier, output, context and whether it proposes changes. */
export function listAiTasks(): Array<{ id: string; aliases?: string[]; version: number; title: string; description: string; tier: AiTier; output: string; context: string; proposes: boolean; verifiers: string[] }> {
  return AI_TASKS.map((t) => ({
    id: t.id,
    ...(t.aliases?.length ? { aliases: t.aliases } : {}),
    version: t.version,
    title: t.title,
    description: t.description,
    tier: t.tier,
    output: t.output.kind === 'code' ? `code (${t.output.language})` : t.output.kind,
    context: t.context,
    proposes: !!t.propose,
    verifiers: t.verifiers ?? [],
  }));
}
