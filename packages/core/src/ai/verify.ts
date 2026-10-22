/**
 * Verifiers (AIB-5): the engine checks what a model proposed before anyone relies on it, and says so with a badge on
 * each proposal item — parsed, linted, "7/7 checks pass on the last response", "the script's 4 tests pass", "the flow
 * ran 5/5 steps against a mock of the collection". A task names the verifiers that apply to it; new ones register
 * here (`registerVerifier`). A verifier never sends anything to a real server: scripts run in the QuickJS sandbox
 * without network, flows only against a local mock server built from the collection's saved examples.
 */
import { parseYaml, stringifyYaml } from '../util/lazy-yaml.js';
import { tryParseYaml } from '../util/yaml-doc.js';
import { checkLabel, namesSetByScripts, templatedText, templateVariables } from '@testpion/shared';
import type { CheckConfig, Collection } from '../model/types.js';
import type { ExecServices } from '../runner/execute.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { runChecks, validateSchema, checkTypes } from '../eval/checks.js';
import { runScript } from '../scripts/sandbox.js';
import { lintTestFile } from '../runner/test-schema.js';
import { loadTestsFromFile, isSuiteFile } from '../runner/loader.js';
import { normalizeError } from '../errors.js';
import type { ProposalItem, VerificationBadge } from './proposal.js';
import { explainYamlError } from './yaml-repair.js';
import { explainCheckProblem } from './flow-format.js';
import { sandboxResponse, scriptMisuseBadge } from './script-reference.js';
import type { AiRunDeps } from './tasks/run.js';

/** A response a proposal was made for (the one on screen, or the latest in the history). */
export interface StoredResponse {
  status?: number;
  headers?: Array<[string, string]>;
  body?: string;
  latencyMs?: number;
}

export interface VerifyContext {
  /** The response checks and scripts are evaluated against. */
  response?: StoredResponse;
  /** An earlier response to the same request: what passes now but not on it pins a value that changes. */
  previous?: StoredResponse;
  /** Variable names known in the workspace (never values): a flow may use them without extracting them. */
  variableNames?: string[];
  /** A collection with saved examples: flows are run against a mock of it (`flow-mock`). */
  collection?: Collection;
  /** Engine services for the mock run (`flow-mock`). */
  services?: ExecServices;
  /** A JSON Schema generated JSON must satisfy (`json`): e.g. an MCP tool's input schema. */
  schema?: Record<string, unknown>;
  signal?: AbortSignal;
  /** The open workspace: verifiers that read it (a spec the tests are checked against). */
  store?: WorkspaceStore;
  /** The task runner's own dependencies (models, settings, redactor): a verifier that prices or dry-runs a judge builds its judge host from them. */
  runDeps?: AiRunDeps;
  /** The task service, lent by the runner, for a verifier that builds a dry judge host (eval/rag takes only types from ai/tasks). */
  tasks?: { prepare: typeof import('./tasks/run.js').prepareAiTask; run: typeof import('./tasks/run.js').runAiTask };
}

export type Verifier = (item: ProposalItem, ctx: VerifyContext) => Promise<VerificationBadge | undefined> | VerificationBadge | undefined;

const verifiers = new Map<string, Verifier>(); // registry: the verifier kinds, registered at start-up

/** Add (or replace) a verifier a task can name. */
export function registerVerifier(name: string, v: Verifier): void {
  verifiers.set(name, v);
}

/**
 * Run the named verifiers on every item: each adds its badge; an item with a failing badge is unticked (the review
 * shows why). A verifier that throws gives a `skip` badge with the error, never a crash.
 */
export async function verifyItems(items: ProposalItem[], names: string[], ctx: VerifyContext): Promise<ProposalItem[]> {
  for (const item of items) {
    for (const n of names) {
      const v = verifiers.get(n);
      if (!v) continue;
      let badge: VerificationBadge | undefined;
      try {
        badge = await v(item, ctx);
      } catch (e) {
        badge = { verifier: n, status: 'skip', label: 'not checked', detail: normalizeError(e).message };
      }
      if (badge) item.verification.push(badge);
    }
    if (item.verification.some((b) => b.status === 'fail')) item.selected = false;
  }
  return items;
}

/** The failing badges of items, as problems a repair turn sends back to the model. */
export const verificationProblems = (items: ProposalItem[]): string[] =>
  items.flatMap((i) => i.verification.filter((b) => b.status === 'fail').map((b) => `${i.title}: ${b.label}${b.detail ? ` — ${b.detail}` : ''}`));

/* ------------------------------------------------------------------ built-in verifiers */

const parseBody = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** Values that change on every response: a check that pins one breaks on the next run. */
const UNSTABLE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|eyJ|\d{12,13}$)/i;
/** Fields whose values a server makes up (ids, times, tokens): pinning one is risky even when it passes twice. */
const GENERATED_FIELD = /(^|[.[\]'"])(id|uuid|guid|[a-z]+Id|[a-z]+_id|created\w*|updated\w*|modified\w*|\w*[tT]imestamp|\w*[tT]ime|\w*At|date|\w*[tT]oken|nonce|etag|requestId|traceId)['"\]]*$/;
const PINNING = /^(equals|eq|exact-match|json-path)$/i;

/** A check that pins a value the server makes up (a time, an id, a token): it breaks on the next response. */
export const pinsGeneratedValue = (c: CheckConfig): boolean =>
  PINNING.test(c.type) && c.path !== undefined && ((typeof c.expected === 'string' && UNSTABLE.test(c.expected)) || GENERATED_FIELD.test(String(c.path)));

const checkContext = (r: StoredResponse) => ({ testType: 'http' as const, status: r.status, headers: r.headers, body: parseBody(r.body), text: r.body ?? '', latencyMs: r.latencyMs });

/** A check's stable forms: the field is there, has the type, or (a time or an id) has its format. */
export function saferChecks(check: CheckConfig): CheckConfig[] {
  if (!PINNING.test(check.type) || !check.path) return [];
  const v = check.expected;
  const out: CheckConfig[] = [];
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) out.push({ type: 'regex', path: check.path, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}' });
  else if (typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
    out.push({ type: 'regex', path: check.path, pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });
  if (v !== undefined && v !== null) out.push({ type: 'type', path: check.path, expected: Array.isArray(v) ? 'array' : typeof v });
  out.push({ type: 'exists', path: check.path });
  return out;
}


/**
 * A check against the response it was written for, and the response before it when there is one: `fail` when it does
 * not pass on the current response, or passes on it but not on the previous one (it pins a value that changes);
 * `warn` when it pins a value that looks generated (a time, an id, a token). Both offer the safer forms.
 */
export async function verifyCheck(check: CheckConfig, response: StoredResponse | undefined, previous?: StoredResponse): Promise<VerificationBadge & { safer?: CheckConfig[] }> {
  if (!checkTypes().includes(check.type)) return { verifier: 'checks', status: 'fail', label: `unknown check type "${check.type}"`, detail: `Known: ${checkTypes().join(', ')}` };
  if (!response) return { verifier: 'checks', status: 'skip', label: 'no response to check against' };
  const [r] = await runChecks([check], checkContext(response));
  if (!r) return { verifier: 'checks', status: 'skip', label: 'not checked' };
  const safer = saferChecks(check);
  const generated = PINNING.test(check.type) && check.path !== undefined && ((typeof check.expected === 'string' && UNSTABLE.test(check.expected)) || GENERATED_FIELD.test(String(check.path)));
  // a pinned generated value that already differs: its safer forms are the fix
  if (!r.passed) return { verifier: 'checks', status: 'fail', label: 'fails on the current response', detail: r.message, ...(generated ? { safer } : {}) };
  if (previous && previous.body !== undefined) {
    const [p] = await runChecks([check], checkContext(previous));
    if (p && !p.passed && PINNING.test(check.type))
      return {
        verifier: 'checks',
        status: 'fail',
        label: 'passes now but failed on the previous response: the value changes',
        detail: `Previous response: ${p.message}. Prefer ${safer.map(checkLabel).join(' or ') || 'a check on the shape'}.`,
        safer,
      };
  }
  if (generated)
    return { verifier: 'checks', status: 'warn', label: 'passes, but pins a value that changes (a time, an id, a token)', detail: `Prefer ${safer.map(checkLabel).join(' or ')}.`, safer };
  return { verifier: 'checks', status: 'pass', label: previous ? 'passes on the current and the previous response' : 'passes on the current response' };
}

registerVerifier('checks', async (item, ctx) => {
  if (item.kind !== 'assertion') return undefined;
  const checks = (Array.isArray(item.data) ? item.data : [item.data]) as CheckConfig[];
  if (!checks.length || !checks.every((c) => c && typeof c === 'object' && typeof c.type === 'string'))
    return { verifier: 'checks', status: 'fail', label: 'not a check', detail: 'Each item needs a `type` (status, exists, equals, …).' };
  const bs = await Promise.all(checks.map((c) => verifyCheck(c, ctx.response, ctx.previous)));
  const worst = bs.find((b) => b.status === 'fail') ?? bs.find((b) => b.status === 'warn') ?? bs[0]!;
  // one check per item: its safer forms become the item's alternatives (the review can switch to one)
  if (checks.length === 1 && worst.safer?.length)
    item.alternatives = worst.safer.map((c) => ({ label: checkLabel(c), after: stringifyYaml([c]).trim(), data: c }));
  const { safer: _safer, ...badge } = worst;
  return badge;
});

/**
 * A tp script run once in the sandbox against the response (no network: tp.sendRequest is unavailable), and against the
 * previous response when there is one: a test that passes now but failed before depends on a value that changes.
 */
export async function verifyScript(code: string, response: StoredResponse | undefined, previous?: StoredResponse): Promise<VerificationBadge> {
  // the API as the sandbox has it: each misuse with what to write instead (that is what a repair turn sends back)
  const misuse = await scriptMisuseBadge('script', code);
  if (misuse) return misuse;
  // the response time is there only when the response it was written for has one (the editor's, History's); else the test cannot be proven
  if (response && response.latencyMs === undefined && /\bresponseTime\b|\bto\.have\.responseTime\b/.test(code))
    return { verifier: 'script', status: 'fail', label: 'reads the response time, which the response it was written for does not have', detail: 'Leave the timing out, or send the request again and generate the tests from that response.' };
  const run = (r: StoredResponse | undefined) =>
    runScript(code, { variables: {}, response: sandboxResponse(r) }, { timeoutMs: 3000, maxRequests: 0 });
  const out = await run(response);
  if (out.error) return { verifier: 'script', status: 'fail', label: 'the script throws', detail: out.error };
  const tests = out.tests.filter((t) => !t.skipped);
  if (!tests.length) return { verifier: 'script', status: 'warn', label: 'ran, but has no tp.test', detail: out.logs.slice(0, 3).join('\n') || undefined };
  if (!response) return { verifier: 'script', status: 'skip', label: `${tests.length} tests (no response to run them on)` };
  const failed = tests.filter((t) => !t.passed);
  if (failed.length)
    return {
      verifier: 'script',
      status: 'fail',
      label: `${failed.length} of ${tests.length} tests fail on the current response`,
      detail: failed
        .slice(0, 5)
        .map((t) => `${t.name}: ${t.message ?? 'failed'}`)
        .join('\n'),
    };
  if (previous && previous.body !== undefined) {
    const before = await run(previous);
    const flaky = before.tests.filter((t) => !t.skipped && !t.passed);
    if (before.error || flaky.length)
      return {
        verifier: 'script',
        status: 'fail',
        label: 'passes now but failed on the previous response: it depends on a value that changes',
        detail: before.error ?? flaky.map((t) => `${t.name}: ${t.message ?? 'failed'}`).join('\n'),
      };
  }
  return { verifier: 'script', status: 'pass', label: `${tests.length}/${tests.length} tests pass on the current${previous ? ' and the previous' : ''} response` };
}

registerVerifier('script', (item, ctx) => (item.kind === 'script' ? verifyScript(item.after, ctx.response, ctx.previous) : undefined));

/** A test or flow file: the loader reads it, and the lint (keys, check types, dependsOn, cycles) finds no error. */
export async function verifyTestFile(text: string, path = 'ai/generated.yaml'): Promise<VerificationBadge> {
  const problems = lintTestFile(text, { file: path, suite: isSuiteFile(path) });
  const errors = problems.filter((p) => p.severity === 'error');
  if (errors.length)
    return {
      verifier: 'test-file',
      status: 'fail',
      label: `${errors.length} lint error${errors.length === 1 ? '' : 's'}`,
      // the parser's words with their likely cause (an unquoted {{, a tab …): what a repair turn needs
      detail: errors
        .slice(0, 6)
        .map((p) => explainCheckProblem(explainYamlError(`line ${p.line}: ${p.message}`, text)))
        .join('\n'),
    };
  let n = 0;
  try {
    for await (const _ of loadTestsFromFile(path, text)) if (++n > 500) break;
  } catch (e) {
    return { verifier: 'test-file', status: 'fail', label: 'the test loader refuses it', detail: normalizeError(e).message };
  }
  if (!n) return { verifier: 'test-file', status: 'fail', label: 'no tests in it', detail: 'A test file needs `tests:` (a list of steps) or one test.' };
  const warnings = problems.filter((p) => p.severity === 'warning');
  return warnings.length
    ? {
        verifier: 'test-file',
        status: 'warn',
        label: `parsed · ${n} step${n === 1 ? '' : 's'} · ${warnings.length} lint warning${warnings.length === 1 ? '' : 's'}`,
        detail: warnings
          .slice(0, 6)
          .map((p) => `line ${p.line}: ${p.message}`)
          .join('\n'),
      }
    : { verifier: 'test-file', status: 'pass', label: `parsed · linted · ${n} step${n === 1 ? '' : 's'}` };
}

registerVerifier('test-file', (item) => (item.kind === 'file' || item.kind === 'flow' ? verifyTestFile(item.after, item.path) : undefined));

const DYNAMIC = /^\$|^(baseUrl|workspaceDir)$/;

/**
 * Every {{variable}} a flow uses is extracted by a step, set by a script or a `set` step, or a known variable name.
 * "Uses" is the one shared definition (`templatedText` + `templateVariables`): what is templated when a step is sent —
 * not its scripts (a visualizer's `{{#each items}}…{{/each}}`, `{{total}}`), not its description, never block syntax.
 */
export function flowVariableProblems(text: string, known: string[] = []): string[] {
  const parsed = tryParseYaml(text);
  if (!parsed.ok) return [];
  const doc = parsed.value;
  const steps = (Array.isArray(doc) ? doc : ((doc as { tests?: unknown[] })?.tests ?? [])) as Array<Record<string, unknown>>;
  const defined = new Set(known);
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== 'object') continue;
    for (const k of Object.keys((s.extract as Record<string, unknown>) ?? {})) defined.add(k);
    if (s.set && typeof s.set === 'object' && !Array.isArray(s.set)) for (const k of Object.keys(s.set)) defined.add(k);
    for (const n of namesSetByScripts(JSON.stringify(s))) defined.add(n);
  }
  return templateVariables(templatedText(doc))
    .filter((u) => !DYNAMIC.test(u) && !defined.has(u))
    .map((u) => `{{${u}}} is used but no step extracts it and no variable has that name`);
}

registerVerifier('flow-refs', (item, ctx) => {
  if (item.kind !== 'file' && item.kind !== 'flow') return undefined;
  const p = flowVariableProblems(item.after, ctx.variableNames);
  return p.length
    ? { verifier: 'flow-refs', status: 'warn', label: `${p.length} variable${p.length === 1 ? '' : 's'} not defined`, detail: p.slice(0, 8).join('\n') }
    : { verifier: 'flow-refs', status: 'pass', label: 'every variable is defined' };
});

/** A URL's origin (scheme and host, or a leading {{variable}}) replaced with the mock's: the request stays on this computer. */
const toMock = (url: string, base: string) => {
  const rest = url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '')
    .replace(/^\{\{[^}]+\}\}/, '');
  return base + (rest.startsWith('/') || rest.startsWith('?') || !rest ? rest : `/${rest}`);
};

/**
 * A flow made to run against a mock only: every HTTP / GraphQL step's URL points at the mock, auth is left out (an
 * OAuth token URL would be a real server; the mock checks no credentials), and so are scripts that send requests.
 * Steps of any other kind (gRPC, WebSocket, MCP, LLM …) cannot be served by it: `blocked` names them.
 */
export function pointFlowAtMock(text: string, base: string): { text: string; blocked: string[] } {
  const doc = parseYaml(text) as Record<string, unknown> | unknown[] | null;
  const blocked: string[] = [];
  const list = (Array.isArray(doc) ? doc : Array.isArray((doc as { tests?: unknown })?.tests) ? ((doc as { tests: Array<Record<string, unknown>> }).tests) : doc && typeof doc === 'object' ? [doc] : []) as Array<Record<string, unknown>>;
  const defaults = !Array.isArray(doc) && doc && typeof doc === 'object' ? ((doc as { defaults?: Record<string, unknown> }).defaults ?? undefined) : undefined;
  if (defaults) {
    delete defaults.auth;
    if (typeof defaults.url === 'string') defaults.url = toMock(defaults.url, base);
  }
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const type = String(s.type ?? defaults?.type ?? 'http');
    if (type !== 'http' && type !== 'graphql' && type !== 'delay' && type !== 'condition' && type !== 'script') {
      blocked.push(`${String(s.name ?? s.id ?? type)} (${type})`);
      continue;
    }
    const req = s.request && typeof s.request === 'object' ? (s.request as Record<string, unknown>) : s;
    for (const k of ['url', 'endpoint']) if (typeof req[k] === 'string') req[k] = toMock(req[k] as string, base);
    delete req.auth;
    delete s.auth;
    for (const k of ['preRequestScript', 'testScript']) if (typeof s[k] === 'string' && /sendRequest|fetch\s*\(/.test(s[k] as string)) delete s[k];
  }
  return { text: stringifyYaml(doc, { lineWidth: 0 }), blocked };
}

/**
 * A flow run against a mock server of the collection (its saved examples), every step pointed at the mock: proves the
 * steps, extracts and dependsOn hold together without touching a real server.
 */
export async function verifyFlowOnMock(text: string, collection: Collection, services: ExecServices, signal?: AbortSignal): Promise<VerificationBadge> {
  const [{ startMockServer, collectMockRoutes }, { runTests }] = await Promise.all([import('../mock/mock-server.js'), import('../runner/runner.js')]);
  if (!collectMockRoutes(collection).length)
    return { verifier: 'flow-mock', status: 'skip', label: `no mock: ${collection.name} has no saved example responses`, detail: 'Save an example of a response (the response viewer ▸ Save as example) and the flow can be tried on a mock.' };
  const server = await startMockServer(collection, { port: 0 });
  try {
    const pointed = pointFlowAtMock(text, server.url);
    if (pointed.blocked.length)
      return { verifier: 'flow-mock', status: 'skip', label: 'not run on a mock', detail: `A mock serves HTTP only; these steps would reach real servers: ${pointed.blocked.slice(0, 5).join(', ')}` };
    const tests = [];
    for await (const t of loadTestsFromFile('ai/mock-run.yaml', pointed.text)) tests.push(t);
    const vars = services.vars.clone();
    vars.set('baseUrl', server.url, 'runtime');
    const s = await runTests({ name: 'AI proposal on a mock', tests, services: { ...services, vars, production: undefined }, signal, traceMode: 'none', concurrency: 1, timeoutMs: 10_000 });
    const ok = s.passed;
    return s.failed + s.errors
      ? {
          verifier: 'flow-mock',
          status: 'warn',
          label: `${ok}/${s.total} steps pass on a mock of ${collection.name}`,
          detail: 'A mock answers with saved examples: a failing step may need an example, or a real run.',
        }
      : { verifier: 'flow-mock', status: 'pass', label: `${ok}/${s.total} steps pass on a mock of ${collection.name}` };
  } finally {
    await server.close();
  }
}

registerVerifier('flow-mock', (item, ctx) =>
  (item.kind === 'file' || item.kind === 'flow') && ctx.collection && ctx.services ? verifyFlowOnMock(item.after, ctx.collection, ctx.services, ctx.signal) : undefined,
);

registerVerifier('json', (item, ctx) => {
  if (item.language !== 'json') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(item.after);
  } catch (e) {
    return { verifier: 'json', status: 'fail', label: 'not valid JSON', detail: (e as Error).message };
  }
  if (!ctx.schema) return { verifier: 'json', status: 'pass', label: 'valid JSON' };
  const v = validateSchema(ctx.schema, value);
  return v.valid
    ? { verifier: 'json', status: 'pass', label: 'valid JSON · matches the schema' }
    : { verifier: 'json', status: 'fail', label: 'does not match the schema', detail: v.errors.slice(0, 6).join('\n') };
});

registerVerifier('yaml', (item) => {
  if (item.language !== 'yaml' || item.kind === 'file' || item.kind === 'flow') return undefined;
  try {
    parseYaml(item.after);
    return { verifier: 'yaml', status: 'pass', label: 'valid YAML' };
  } catch (e) {
    return { verifier: 'yaml', status: 'fail', label: 'not valid YAML', detail: explainYamlError((e as Error).message, item.after) };
  }
});
