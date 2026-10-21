/**
 * The contract every tool of the TestPion MCP server keeps, in one place instead of in each tool:
 *
 * - **Descriptions** read the same way: what it does, when to use it, when not (and what instead), one example call.
 * - **Parameter names**: an id parameter is `snake_case` (`run_id`); the old `camelCase` name (`runId`) is still
 *   accepted, so callers written before keep working.
 * - **Pagination**: a tool that lists takes `limit` and `cursor` and says `nextCursor` when there is more. The text
 *   result stays the list itself (as before); the paging details are in the structured result and in a note.
 * - **Size**: tools that can return a lot take `response_format` (`concise`, the default, or `detailed`); every result
 *   is capped, and a cut says what was cut and how to ask for less or more.
 * - **Confirmation**: a tool that deletes or overwrites does nothing without `confirm: true` (or the user's yes, asked
 *   through MCP elicitation when the client supports it); without it the result says what it would do.
 * - **Output schemas** for the run, send and check tools, so clients can read their results as data.
 */
import { ApsError } from '../errors.js';
import type { Tool, ToolDoc } from './tool.js';

/* ------------------------------------------------------------------ which tools */

/**
 * Tools whose result is a list (or holds one in `field`). The wrapper pages it; a tool with its own `limit` is asked
 * for enough rows to fill the page (within its own maximum).
 */
export const LIST_TOOLS: Record<string, { field?: string }> = {
  list_collections: {},
  list_requests: {},
  list_environments: {},
  list_certificates: {},
  list_monitors: {},
  list_tests: {},
  list_evaluations: {},
  list_datasets: {},
  list_mcp_servers: {},
  list_flows: {},
  llm_usage: {},
  mcp_tool_usage: {},
  unused_variables: {},
  variable_usages: {},
  flaky_tests: {},
  what_needs_attention: {},
  recent_failures: {},
  history_list: {},
  request_history: {},
  monitor_results: {},
  monitor_requests: {},
  load_history: {},
  score_trend: {},
  search_workspace: {},
  git_log: {},
  git_diff: {},
  git_changes: { field: 'items' },
  git_history: { field: 'versions' },
  flow_runs: {},
  test_history: { field: 'runs' },
  debugger_exchanges: { field: 'exchanges' },
  list_kinds: { field: 'kinds' },
};

/** Tools that can return a lot (bodies, results of a run, documents): they take `response_format`. */
export const BIG_TOOLS = new Set([
  'send_request',
  'get_request',
  'collection_docs',
  'grpc_call',
  'graphql_operation',
  'realtime_exchange',
  'mcp_call_tool',
  'run_collection',
  'run_tests',
  'run_evaluation',
  'run_monitor',
  'run_breakdown',
  'compare_runs',
  'eval_compare',
  'eval_matrix',
  'load_test',
  'flow_data_run',
  'flow_env_matrix',
  'flow_scale_result',
  'flow_graph',
  'flow_runs',
  'test_history',
  'debugger_exchange',
  'debugger_exchanges',
  'openapi_outline',
  'openapi_lint',
  'openapi_diff',
  'api_coverage',
  'security_review',
  'read_dataset',
  'git_diff',
  'workspace_activity',
  'list_requests',
  'list_tests',
]);

type Args = Record<string, unknown>;
const q = (v: unknown) => JSON.stringify(String(v ?? ''));

/**
 * Tools that delete or overwrite: `when` (default: always) says whether this call does; `describe` says what it would
 * do; `preview` is the same call in the tool's own dry-run mode, run to show the details without changing anything.
 */
export const CONFIRM_TOOLS: Record<string, { when?(a: Args): boolean; describe(a: Args): string; preview?(a: Args): Args }> = {
  rag_save_custom_metric: { when: (a) => a.overwrite === true, describe: (a) => `replace the custom metric file metrics/${String(a.id ?? '')}.yaml with the new text (git brings the old one back)` },
  save_output: { when: (a) => typeof a.save_to === 'string' && !!a.save_to, describe: (a) => `write the ${String(a.surface ?? 'output')} output to the new file ${q(a.save_to)} (only under exports/ or .local/exports/, never over a file)` },
  export_bundle: { describe: (a) => `write a bundle file${typeof a.out === 'string' && a.out ? ` to ${q(a.out)}` : ' under .local/exports/'} (only under exports/ or .local/exports/, never over a file)` },
  export_traces: { describe: (a) => `send the ${typeof a.limit === 'number' ? a.limit : 50} newest traces (redacted) to ${q(a.endpoint)}, with the headers you named (variables in them are resolved)` },
  import_definition: { when: (a) => a.update !== false, describe: () => 'import the definition into the workspace, updating a collection that is already there when it matches (undo_definition_import takes it back)' },
  undo_definition_import: { describe: (a) => `undo the definition import ${q(a.id)}: its collections, environments and API definitions go to Recently deleted and its flow files are removed` },
  security_tests_run: { describe: (a) => `send the probes of tests/${String(a.path ?? '')} to the target of the environment ${q(a.environment)} (they are attacks: malformed and hostile requests)` },
  delete_request: { describe: (a) => `delete the request ${q(a.request)} of the collection ${q(a.collection)} (it goes to no trash: git or a backup brings it back)` },
  import_bundle_apply: { describe: (a) => `import the previewed bundle ${q(a.plan_id)} into the workspace (${a.on_conflict === 'replace' ? 'items that are already here are replaced' : a.on_conflict === 'skip' ? 'items that are already here are kept' : 'items that are already here are kept and the incoming ones renamed'}; undo_import takes it back)` },
  undo_import: { when: (a) => typeof a.import_id === 'string' && !!a.import_id, describe: (a) => `undo the import ${q(a.import_id)}: items it made are removed, items it replaced come back` },
  delete_item: { describe: (a) => `delete ${typeof a.ref === 'string' ? q(a.ref) : JSON.stringify(a.ref ?? '')} to Recently deleted (restore_item puts it back for 30 days)` },
  flow_remove_step: { describe: (a) => `remove the step ${q(a.id)} from tests/${String(a.file ?? '')} (steps that wait for it lose that dependency)` },
  git_resolve: { describe: (a) => `overwrite the conflicted file ${q(a.path)} with ${a.side ? `"${String(a.side)}"` : 'the chosen sides'} (the other side's changes in it are dropped)` },
  git_sync: { describe: () => 'pull (merging the remote changes into the workspace files) and push the local commits' },
  git_restore_item: {
    when: (a) => a.dryRun !== true,
    describe: (a) => `write the version of ${typeof a.ref === 'string' ? q(a.ref) : a.file ? q(a.file) : 'the item'} from commit ${q(a.rev)} over its current content (the change stays uncommitted; git_undo takes it back)`,
    preview: (a) => ({ ...a, dryRun: true }),
  },
  git_discard_item: {
    when: (a) => a.dryRun !== true,
    describe: (a) => `throw away the uncommitted change of ${typeof a.ref === 'string' ? q(a.ref) : a.file ? q(a.file) : 'the item'} (git_undo takes it back)`,
    preview: (a) => ({ ...a, dryRun: true }),
  },
  git_fix_setup: {
    when: (a) => a.dryRun !== true,
    describe: (a) => `fix the git setup of the workspace: write .gitignore and .gitattributes, rewrite existing files into the stable format${a.hook === true ? ', install the pre-commit secret check' : ''}${a.untrack === true ? ', remove ignored files from git' : ''} (git_undo takes the files back)`,
    preview: (a) => ({ ...a, dryRun: true }),
  },
  git_track_large: {
    when: (a) => a.dryRun !== true,
    describe: (a) => `take ${q(a.file)} out of plain git by ${a.mode === 'lfs' ? 'Git LFS (a rule in .gitattributes)' : 'reference (a .ref file is committed, the data file is git-ignored)'} (git_undo takes the files back)`,
    preview: (a) => ({ ...a, dryRun: true }),
  },
  git_share_session: {
    when: (a) => !!a.name && a.dryRun !== true,
    describe: (a) => (a.unshare === true ? `delete the shared copy of the session ${q(a.name)} from debugger/shared/` : `copy the session ${q(a.name)}, masked, to debugger/shared/ where git tracks it`),
    preview: (a) => (a.unshare === true ? { ...a, unshare: false, name: undefined } : { ...a, dryRun: true }),
  },
  git_codeowners: { when: (a) => a.write === true, describe: () => 'write .github/CODEOWNERS (never over an existing one)', preview: (a) => ({ ...a, write: false }) },
  git_undo: { when: (a) => a.list !== true, describe: (a) => `undo ${a.id ? `the operation ${q(a.id)}` : 'the last restore or discard'}: its files go back as they were before it` },
  git_stash: {
    when: (a) => ['push', 'apply', 'pop', 'drop'].includes(String(a.action)) && !(a.action === 'push' && a.dryRun === true),
    describe: (a) =>
      a.action === 'push'
        ? `set every uncommitted change of the workspace aside as ${q(a.name)} (the workspace goes back to the last commit)`
        : a.action === 'drop'
          ? 'remove the stash for good'
          : `put the stash back into the workspace files${a.action === 'pop' ? ' and remove it from the list' : ''}`,
    preview: (a) => (a.action === 'push' ? { ...a, dryRun: true } : { action: 'show', ...(a.index !== undefined ? { index: a.index } : {}), ...(a.hash ? { hash: a.hash } : {}) }),
  },
  collection_tidy: { describe: (a) => `tidy the collection ${q(a.collection)}: remove duplicate requests, empty folders and unused variables as asked (requests and variables are deleted)` },
  rename_variable: { describe: (a) => `rename the variable ${q(a.from)} to ${q(a.to)} everywhere it is defined or used (environments, collections, test files)` },
  replace_in_collection: {
    when: (a) => a.apply === true,
    describe: (a) => `replace ${q(a.find)} with ${q(a.replace)} in the collection ${q(a.collection)}`,
    preview: (a) => ({ ...a, apply: false }),
  },
  move_variables_to_environments: {
    when: (a) => a.dryRun !== true,
    describe: (a) => `move collection variables of ${q(a.collection)} into the environments (removed from the collection)`,
    preview: (a) => ({ ...a, dryRun: true }),
  },
  write_test_file: { when: (a) => a.overwrite === true, describe: (a) => `overwrite tests/${String(a.path ?? '')} when it exists` },
  generate_tests: { when: (a) => a.overwrite === true, describe: () => 'overwrite generated test files that already exist' },
  generate_flows: { when: (a) => a.overwrite === true, describe: () => 'overwrite generated flow files that already exist' },
  generate_dataset: { when: (a) => a.overwrite === true, describe: (a) => `overwrite the dataset ${q(a.name)} when it exists` },
  set_request_checks: { when: (a) => a.mode === 'replace', describe: (a) => `replace every check of the request ${q(a.request)} in ${q(a.collection)}` },
  flow_webhook_set: { when: (a) => a.remove === true, describe: (a) => `remove the webhook of tests/${String(a.file ?? '')}` },
  debugger_rules: { when: (a) => a.action === 'remove' || a.action === 'clear', describe: (a) => (a.action === 'clear' ? 'remove every Debugger rule' : `remove the Debugger rule ${q(a.id)}`) },
  debugger_session: { when: (a) => a.action === 'open' && a.append !== true, describe: (a) => `replace the captured exchanges with the session file ${q(a.path)}` },
  ai_apply_proposal: { when: (a) => a.dryRun !== true, describe: (a) => `apply the AI proposal ${q(a.id)}${Array.isArray(a.items) ? ` (items ${a.items.join(', ')})` : ''}: write its test files and change the requests it names`, preview: (a) => ({ ...a, dryRun: true }) },
  ai_undo_proposal: { describe: (a) => `undo the AI proposal ${q(a.id)}: put back the files and requests it replaced` },
  ai_attempt_fix: { describe: (a) => `apply the flaky-test fix ${q(a.id)} (change the test) and run the test ${typeof a.times === 'number' ? a.times : 5} times (its requests are sent)` },
  agents_init: {
    when: (a) => a.force === true,
    describe: () => 'repair broken testpion markers in the agent files (the text between stray markers is replaced)',
    preview: (a) => ({ ...a, dryRun: true }),
  },
};

/* ------------------------------------------------------------------ output schemas */

const num = { type: 'number' };
const resultSummary = {
  type: 'object',
  properties: { name: { type: 'string' }, status: { type: 'string' }, latencyMs: num, error: { type: 'string' }, failedChecks: { type: 'array', items: { type: 'string' } } },
  required: ['name', 'status'],
};
const runShape = (extra: Record<string, unknown> = {}) => ({
  type: 'object',
  properties: {
    runId: { type: 'string' },
    environment: { type: ['string', 'null'] },
    total: num,
    passed: num,
    failed: num,
    errors: num,
    skipped: num,
    durationMs: num,
    results: { type: 'array', items: resultSummary },
    ...extra,
  },
  required: ['total', 'passed', 'failed', 'results'],
});

/** The structured results of the run, send and check tools (permissive: fields may be added, never taken away). */
export const OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  run_tests: runShape(),
  run_evaluation: runShape({ scores: { type: 'object' } }),
  run_collection: runShape(),
  run_monitor: {
    type: 'object',
    properties: { name: { type: 'string' }, environment: { type: ['string', 'null'] }, failures: { type: 'array', items: resultSummary } },
    required: ['name', 'failures'],
  },
  send_request: {
    type: 'object',
    properties: {
      status: { type: ['number', 'string'] },
      statusText: { type: 'string' },
      durationMs: num,
      latencyMs: num,
      url: { type: 'string' },
      headers: { type: 'object' },
      body: { type: 'string' },
      output: { type: 'string' },
      failedChecks: { type: 'array', items: { type: 'string' } },
    },
    required: ['status'],
  },
  compare_runs: {
    type: 'object',
    properties: { passed: { type: 'boolean' }, regressions: { type: 'array' }, improvements: { type: 'array' }, summary: { type: 'array' } },
    required: ['passed', 'regressions'],
  },
  eval_compare: {
    type: 'object',
    properties: { passed: { type: 'boolean' }, cases: num, counts: { type: 'object' }, regressions: { type: 'array' }, improvements: { type: 'array' } },
    required: ['passed', 'counts', 'regressions'],
  },
  lint_tests: { type: 'object', properties: { files: num, problems: { type: ['number', 'array'] }, results: { type: 'array' } }, required: ['problems'] },
  set_request_checks: { type: 'object', properties: { collection: { type: 'string' }, request: { type: 'string' }, checks: { type: 'array' } }, required: ['checks'] },
};

/* ------------------------------------------------------------------ size */

export type ResponseFormat = 'concise' | 'detailed';
/** How much of a result is kept: strings, lists, and the whole result's JSON. */
const LIMITS: Record<ResponseFormat, { string: number; items: number; total: number; text: number }> = {
  concise: { string: 2_000, items: 50, total: 60_000, text: 20_000 },
  detailed: { string: 20_000, items: 500, total: 400_000, text: 200_000 },
};

interface Cut {
  path: string;
  shown: number;
  total: number;
  unit: 'items' | 'characters';
}

function shape(v: unknown, lim: { string: number; items: number }, path: string, cuts: Cut[], depth = 0): unknown {
  if (typeof v === 'string') {
    if (v.length <= lim.string) return v;
    cuts.push({ path: path || '(result)', shown: lim.string, total: v.length, unit: 'characters' });
    return `${v.slice(0, lim.string)}… [${v.length - lim.string} more characters]`;
  }
  if (!v || typeof v !== 'object' || depth > 40) return v;
  if (Array.isArray(v)) {
    const kept = v.length > lim.items ? v.slice(0, lim.items) : v;
    if (kept !== v) cuts.push({ path: path || '(result)', shown: lim.items, total: v.length, unit: 'items' });
    return kept.map((x, i) => shape(x, lim, `${path}[${i}]`, cuts, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = shape(x, lim, path ? `${path}.${k}` : k, cuts, depth + 1);
  return out;
}

const size = (v: unknown) => (typeof v === 'string' ? v.length : (JSON.stringify(v)?.length ?? 0));

/**
 * A result within the limits of `format`: long strings and lists cut (each cut named), then tighter until the whole
 * fits. Returns the result and the cuts (empty when nothing was cut).
 */
export function fitResult(value: unknown, format: ResponseFormat): { value: unknown; cuts: Cut[] } {
  const lim = LIMITS[format];
  if (typeof value === 'string') {
    if (value.length <= lim.text) return { value, cuts: [] };
    return { value: `${value.slice(0, lim.text)}… [${value.length - lim.text} more characters]`, cuts: [{ path: '(result)', shown: lim.text, total: value.length, unit: 'characters' }] };
  }
  let l = { string: lim.string, items: lim.items };
  for (let round = 0; ; round++) {
    const cuts: Cut[] = [];
    const v = shape(value, l, '', cuts);
    if (size(v) <= lim.total || round >= 6) return { value: v, cuts };
    l = { string: Math.max(200, Math.floor(l.string / 2)), items: Math.max(5, Math.floor(l.items / 2)) };
  }
}

/* ------------------------------------------------------------------ cursors */

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

export function encodeCursor(tool: string, offset: number): string {
  return Buffer.from(JSON.stringify({ t: tool, o: offset })).toString('base64url');
}

export function decodeCursor(tool: string, cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  try {
    const c = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')) as { t?: unknown; o?: unknown };
    if (c.t === tool && Number.isInteger(c.o) && (c.o as number) >= 0) return c.o as number;
  } catch {
    /* below */
  }
  throw new ApsError('ValidationError', `Not a cursor of ${tool}: pass the nextCursor this tool returned, or leave cursor out to start at the beginning`);
}

/* ------------------------------------------------------------------ the contract */

/** What a contract call answers: the value (text content), the structured content and notes for the agent. */
export interface ContractResult {
  readonly [CONTRACT]: true;
  value: unknown;
  structured?: Record<string, unknown>;
  notes: string[];
}
export const CONTRACT = Symbol('testpion.tool-contract');
export const isContractResult = (v: unknown): v is ContractResult => !!v && typeof v === 'object' && (v as Record<symbol, unknown>)[CONTRACT] === true;

/** `runId` → `run_id`: the snake_case name of a camelCase id parameter, or undefined when it is not one. */
export function snakeIdName(name: string): string | undefined {
  return /^[a-z][a-zA-Z0-9]*Id$/.test(name) ? name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : undefined;
}

/** Asks the user to confirm (MCP elicitation): true, false, or undefined when the client cannot be asked. */
export type Confirmer = (message: string) => Promise<boolean | undefined>;

const prop = (description: string, type = 'string', extra: Record<string, unknown> = {}) => ({ type, description, ...extra });

/** The description as the agent reads it: what, when, when not, an example, then what the contract adds. */
export function composeDescription(t: Tool, doc: ToolDoc | undefined): string {
  const parts = [t.description.trim()];
  if (doc) parts.push(`\nWhen to use: ${doc.when}\nWhen not: ${doc.whenNot}\nExample: ${JSON.stringify(doc.example)}`);
  const notes: string[] = [];
  if (LIST_TOOLS[t.name]) notes.push(`Pages: \`limit\` (default ${DEFAULT_PAGE}, at most ${MAX_PAGE}) and \`cursor\` (the \`nextCursor\` of the page before).`);
  if (BIG_TOOLS.has(t.name)) notes.push('`response_format`: "concise" (default: long texts and lists cut, each cut named) or "detailed".');
  if (CONFIRM_TOOLS[t.name]) notes.push('Deletes or overwrites: without `confirm: true` it changes nothing and says what it would do. Ask the user first.');
  if (notes.length) parts.push(notes.join(' '));
  return parts.join('\n');
}

/**
 * Every tool with the contract applied (see the top of this file). `docs` holds each fixed tool's doc (a tool may bring
 * its own); `confirmer` asks the user when a call needs confirmation and the client supports it.
 */
export function withToolContract(tools: Tool[], o: { docs: Record<string, ToolDoc>; confirmer?: () => Confirmer | undefined }): Tool[] {
  return tools.map((t) => {
    const list = LIST_TOOLS[t.name];
    const big = BIG_TOOLS.has(t.name);
    const confirm = CONFIRM_TOOLS[t.name];
    const ownLimit = Object.hasOwn(t.inputSchema.properties, 'limit');
    // id parameters in snake_case; the old names stay accepted (not listed)
    const aliases: Array<[string, string]> = [];
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(t.inputSchema.properties)) {
      const snake = snakeIdName(k);
      if (snake && !Object.hasOwn(t.inputSchema.properties, snake)) {
        aliases.push([snake, k]);
        properties[snake] = v;
      } else properties[k] = v;
    }
    if (list) {
      properties.cursor = prop('Where the page starts: the `nextCursor` of the page before (leave out for the first page)');
      properties.limit = prop(`Items per page (default ${DEFAULT_PAGE}, at most ${MAX_PAGE})`, 'number');
    }
    if (big) properties.response_format = prop('"concise" (default: long texts and lists cut) or "detailed" (everything, within a size cap)', 'string', { enum: ['concise', 'detailed'] });
    if (confirm) properties.confirm = prop('true to go ahead (ask the user first); without it nothing changes and the result says what would', 'boolean');
    const required = t.inputSchema.required?.map((r) => aliases.find(([, k]) => k === r)?.[0] ?? r);
    const doc = t.doc ?? o.docs[t.name];
    return {
      ...t,
      description: composeDescription(t, doc),
      inputSchema: { ...t.inputSchema, properties, ...(required ? { required } : {}) },
      ...(OUTPUT_SCHEMAS[t.name] || t.outputSchema ? { outputSchema: t.outputSchema ?? OUTPUT_SCHEMAS[t.name] } : {}),
      run: async (raw: Args) => {
        const args: Args = { ...(raw ?? {}) };
        for (const [snake, old] of aliases)
          if (args[snake] !== undefined) {
            args[old] = args[snake];
            delete args[snake];
          }
        const format: ResponseFormat = args.response_format === 'detailed' ? 'detailed' : 'concise';
        if (args.response_format !== undefined && args.response_format !== 'concise' && args.response_format !== 'detailed')
          throw new ApsError('ValidationError', 'response_format is "concise" or "detailed"');
        delete args.response_format;
        const confirmed = args.confirm === true;
        delete args.confirm;
        if (confirm && (confirm.when?.(args) ?? true) && !confirmed) {
          const what = confirm.describe(args);
          const ask = o.confirmer?.();
          const yes = ask ? await ask(`${t.name} will ${what}. Go ahead?`) : undefined;
          if (yes !== true) {
            let preview: unknown;
            if (confirm.preview) {
              try {
                preview = await t.run(confirm.preview(args));
              } catch (e) {
                preview = { error: e instanceof Error ? e.message : String(e) };
              }
            }
            const value = {
              confirmationRequired: true,
              changed: false,
              wouldDo: what,
              ...(preview !== undefined ? { preview: fitResult(preview, 'concise').value } : {}),
              hint: yes === false ? 'The user said no: nothing was changed.' : `Nothing was changed. Ask the user, then call ${t.name} again with the same arguments and confirm: true.`,
            };
            return contract(value, value, []);
          }
        }
        // a page of a list: the tool is asked for enough rows (its own limit, when it has one), the page is cut out
        let offset = 0;
        let pageSize = 0;
        if (list) {
          offset = decodeCursor(t.name, args.cursor);
          delete args.cursor;
          const asked = args.limit === undefined || args.limit === null || args.limit === '' ? DEFAULT_PAGE : Number(args.limit);
          if (!Number.isFinite(asked) || asked < 1) throw new ApsError('ValidationError', `limit is a number from 1 to ${MAX_PAGE}`);
          pageSize = Math.min(MAX_PAGE, Math.floor(asked));
          if (ownLimit) args.limit = offset + pageSize + 1;
          else delete args.limit;
        }
        const out = await t.run(args);
        const notes: string[] = [];
        let value: unknown = out;
        let structured: Record<string, unknown> | undefined;
        if (list) {
          const arr = Array.isArray(out) ? out : list.field && out && typeof out === 'object' && Array.isArray((out as Args)[list.field]) ? ((out as Args)[list.field] as unknown[]) : undefined;
          if (arr) {
            const page = arr.slice(offset, offset + pageSize);
            const more = arr.length > offset + pageSize;
            const nextCursor = more ? encodeCursor(t.name, offset + pageSize) : undefined;
            // a tool that cut the list itself (its own limit) does not know the total
            const total = ownLimit && more ? undefined : arr.length;
            const paging = { ...(total !== undefined ? { total } : {}), ...(nextCursor ? { nextCursor } : {}) };
            if (Array.isArray(out)) {
              value = page;
              structured = { items: page, ...paging };
            } else {
              value = { ...(out as Args), [list.field!]: page, ...paging };
            }
            if (more)
              notes.push(`Showing ${offset + 1}–${offset + page.length}${total !== undefined ? ` of ${total}` : ''}. Next page: call ${t.name} again with cursor: ${JSON.stringify(nextCursor)}.`);
          }
        }
        const fit = fitResult(value, big ? format : 'detailed');
        if (fit.cuts.length) {
          const what = fit.cuts
            .slice(0, 5)
            .map((c) => `${c.path} (${c.shown} of ${c.total} ${c.unit})`)
            .join(', ');
          const how = [big && format === 'concise' ? 'response_format: "detailed" for more' : '', doc?.narrow ? `narrow: ${doc.narrow}` : '', list ? 'a smaller `limit`' : '']
            .filter(Boolean)
            .join('; ');
          notes.push(`Truncated — ${what}${fit.cuts.length > 5 ? ` and ${fit.cuts.length - 5} more` : ''}. ${how ? `To see more or less: ${how}.` : ''}`.trim());
          value = fit.value;
          if (structured) structured = { ...structured, items: value };
          else if (value && typeof value === 'object' && !Array.isArray(value)) value = { ...(value as Args), truncated: fit.cuts.slice(0, 20) };
        }
        return contract(value, structured, notes);
      },
    };
  });
}

function contract(value: unknown, structured: Record<string, unknown> | undefined, notes: string[]): ContractResult {
  return { [CONTRACT]: true, value, ...(structured ? { structured } : {}), notes } as ContractResult;
}

/** The MCP tool result of a contract call: the value as text, the notes as more text, the structured content. */
export function contractCallResult(r: ContractResult): { isError?: true; content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> } {
  const notes = r.notes.map((text) => ({ type: 'text' as const, text }));
  if (typeof r.value === 'string') return { content: [{ type: 'text', text: r.value }, ...notes] };
  const structured = r.structured ?? (Array.isArray(r.value) ? { items: r.value } : r.value && typeof r.value === 'object' ? (r.value as Record<string, unknown>) : { value: r.value });
  // a result that says so (a flow with a failed step), or a call that waits for the user's confirmation (it did
  // nothing), is an error result: the agent does not take it for done
  const isError = structured.isError === true || structured.confirmationRequired === true;
  return { ...(isError ? { isError: true as const } : {}), content: [{ type: 'text', text: JSON.stringify(r.value, null, 2) }, ...notes], structuredContent: structured };
}

/** A confirmer that asks the user through MCP elicitation, when the connected client supports it. */
export function elicitationConfirmer(server: unknown): Confirmer {
  const s = server as { getClientCapabilities?(): { elicitation?: unknown } | undefined; elicitInput?(p: unknown): Promise<{ action: string; content?: Record<string, unknown> }> };
  return async (message) => {
    if (!s.getClientCapabilities?.()?.elicitation || typeof s.elicitInput !== 'function') return undefined;
    const r = await s.elicitInput({ message, requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Go ahead', description: message } }, required: ['confirm'] } });
    return r.action === 'accept' ? r.content?.confirm === true : false;
  };
}
