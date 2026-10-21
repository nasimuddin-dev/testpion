/**
 * Fixes as proposal items (AI-2 triage, AI-5 flaky analysis): what a model proposes for a failing or flaky test, turned
 * into concrete, reviewable changes of where the test is defined — a check of a saved request replaced, a test file's
 * step changed (its checks, or keys like `until:` / `retries:`), a script edited (an exact find → replace), a variable
 * of the run's environment set — or, when the test is right and the API is not, a bug report to copy. Each item carries
 * what it is verified against (`data.fix`): the failing response and the last passing one of the results it fixes.
 *
 * The `fix` verifier proves an item before it is offered: a changed check must pass on the failing response, is checked
 * against the last passing response (a check that would have failed there follows an API change: said, not hidden) and
 * against made-up responses (a check that passes on anything is refused); a patched test file must lint; an edited
 * script must pass in the sandbox; a variable must be one the failing steps miss, and never a secret.
 */
import { checkLabel, type ItemRef } from '@testpion/shared';
import type { CheckConfig } from '../model/types.js';
import { checkTypes, runChecks } from '../eval/checks.js';
import { explainCheckProblem } from './flow-format.js';
import { applyFlowEdit } from '../runner/flow-edit.js';
import { runScript } from '../scripts/sandbox.js';
import { maskSensitiveText } from '../util/redact.js';
import { normalizeError } from '../errors.js';
import { stringifyYaml } from '../util/lazy-yaml.js';
import type { ProposalItem, VerificationBadge } from './proposal.js';
import type { DraftItem } from './tasks/registry.js';
import { pinsGeneratedValue, registerVerifier, saferChecks, verifyTestFile, type StoredResponse } from './verify.js';
import { exists, query } from '../util/jsonpath.js';
import { loadScriptApi, sandboxResponse, scriptApiProblems } from './script-reference.js';
import { stepOfResult, type FailureSource } from './run-evidence.js';

/** What a model proposes for one cause (the JSON answer's `fix`). */
export interface FixSpec {
  type: 'check' | 'edit' | 'step' | 'variable' | 'none';
  /**
   * check: which failing check — `result` (a failing result's id) and `checkIndex` (its place in the test's list, as
   * the context's failingChecksAsWritten gives it) — and the check to use instead (`replacement`). A reference cannot
   * mismatch the way a quoted text can; `check` / `newCheck` (the check as quoted, and the new one) are still read.
   */
  result?: string;
  checkIndex?: number;
  replacement?: CheckConfig;
  check?: CheckConfig;
  newCheck?: CheckConfig;
  /** edit: exact text of the test (a test file, or a saved request's script) and what replaces it. */
  find?: string;
  replace?: string;
  /** step: keys to set on the failing step of a test file (until, retries, timeoutMs …; null removes one). */
  set?: Record<string, unknown>;
  /** variable: a variable of the run's environment the failing steps miss, and its (non-secret) value. */
  name?: string;
  value?: string;
  /** none: what to do (the API regressed, a token expired …). */
  note?: string;
}

/** One place a fix applies to, with the results it fixes and the responses it is checked against. */
export interface FixTarget {
  source: FailureSource;
  /** The step of a test file. */
  step?: string;
  resultIds: string[];
  /** The source's failing checks (by their place in its list). */
  failedAssertions: Array<{ index: number; check: CheckConfig }>;
  verifyOn: VerifyCase[];
  unresolvedVariables: string[];
  /** The request it sent (for a bug report). */
  request?: { method?: string; url?: string };
}

interface VerifyCase {
  resultId: string;
  failing?: StoredResponse;
  lastPassing?: StoredResponse;
}

/** What the `fix` verifier reads from an item (kept in `data.fix`). */
export interface FixCheckData {
  changes?: Array<{ step?: string; index: number; was: CheckConfig; check: CheckConfig }>;
  script?: string;
  variable?: { key: string; value: string; unresolved: string[] };
  evidence?: { changed: boolean; label: string };
  verifyOn: VerifyCase[];
  /** The file or script text the item was made from: applying refuses when it changed since. */
  base?: string;
  /** Said even when the item verifies (a retry: the failure can come back). */
  caution?: string;
  /** TestPion made it from the evidence (a stale expected value), not the model. */
  engine?: boolean;
}

const sameCheck = (a: unknown, b: unknown): boolean => {
  const norm = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(norm)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .filter(([, x]) => x !== undefined && x !== null)
              .sort(([x], [y]) => x.localeCompare(y))
              .map(([k, x]) => [k, norm(x)]),
          )
        : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

/** A check a model wrote, cleaned (no reasons, no empty values) and with a type. */
function cleanCheck(v: unknown): CheckConfig | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof (v as CheckConfig).type !== 'string') return undefined;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, x]) => x !== undefined && x !== null && k !== 'why' && k !== 'reason')) as CheckConfig;
}

/**
 * Which of the source's checks the model means: the one at `index` (its place in the list, from the evidence), else
 * the same check, else the failing one of the same type and subject, else the only failing one.
 */
function locateCheck(target: FixTarget, configs: CheckConfig[], was: CheckConfig | undefined, index?: number): { index: number; check: CheckConfig } | undefined {
  if (typeof index === 'number' && Number.isInteger(index) && configs[index] && typeof configs[index]!.type === 'string') return { index, check: configs[index]! };
  if (was) {
    const i = configs.findIndex((c) => sameCheck(c, was));
    if (i >= 0) return { index: i, check: configs[i]! };
    const f = target.failedAssertions.find((a) => a.check.type === was.type && (a.check.path ?? '') === (was.path ?? ''));
    if (f) return f;
  }
  return target.failedAssertions.length === 1 ? target.failedAssertions[0] : undefined;
}

const requestRef = (s: Extract<FailureSource, { kind: 'request' }>): ItemRef => ({ kind: 'request', collectionId: s.collectionId, requestId: s.requestId });

/** The checks of a step of a test file (by its id or name). */
function stepChecks(text: string, path: string, step: string): CheckConfig[] {
  const st = stepOfResult(text, path, { id: step, name: step })?.step;
  return (Array.isArray(st?.assertions) ? st.assertions : Array.isArray(st?.checks) ? st.checks : []) as CheckConfig[];
}

/** A changed test file as a proposal item (the fix to verify rides in `data`). */
function testFileItem(finding: string, path: string, what: string, before: string, after: string, fix: FixCheckData): DraftItem {
  return { kind: 'file', finding, title: `tests/${path}: ${what}`, path, target: { kind: 'test', path }, before, after, language: 'yaml', data: { fix } };
}

/**
 * The items of one fix for its targets (see the module comment): one item per saved request or test file, `finding`
 * naming the cause it fixes. What could not be made is said in `notes`.
 */

export function fixItems(fix: FixSpec, targets: FixTarget[], o: { finding: string; title: string; environment?: string; caution?: string; engine?: boolean }): { items: DraftItem[]; notes: string[] } {
  const items: DraftItem[] = [];
  const notes: string[] = [];
  const verifyOn = (ts: FixTarget[]) => ts.flatMap((t) => t.verifyOn).slice(0, 6);
  // one item per place: targets of the same file or request together
  const bySource = new Map<string, FixTarget[]>();
  for (const t of targets) bySource.set(t.source.key, [...(bySource.get(t.source.key) ?? []), t]);
  const name = (s: FailureSource) => (s.kind === 'request' ? `"${s.name}"` : `tests/${s.path}`);

  if (fix.type === 'check') {
    const to = cleanCheck(fix.replacement ?? fix.newCheck);
    if (!to) return { items, notes: [`${o.title}: the new check (replacement) has no type, so no change is offered.`] };
    // a fix that names its failing result applies where that result's test is defined
    const named = typeof fix.result === 'string' ? targets.filter((t) => t.verifyOn.some((v) => v.resultId === fix.result) || t.resultIds.includes(fix.result!)) : [];
    const chosen = new Map<string, FixTarget[]>();
    for (const t of named.length ? named : targets) chosen.set(t.source.key, [...(chosen.get(t.source.key) ?? []), t]);
    for (const [, ts] of chosen) {
      const s = ts[0]!.source;
      if (s.kind === 'request') {
        const at = locateCheck(ts[0]!, s.assertions, cleanCheck(fix.check), fix.checkIndex);
        if (!at) {
          notes.push(
            `${o.title}: ${name(s)} has no check ${typeof fix.checkIndex === 'number' ? `at checkIndex ${fix.checkIndex}` : `like ${fix.check ? checkLabel(fix.check) : 'the failing one'}`}; nothing changed there.`,
          );
          continue;
        }
        const next = s.assertions.map((c, i) => (i === at.index ? to : c));
        items.push({
          kind: 'assertion',
          finding: o.finding,
          title: `${s.name}: ${checkLabel(at.check)} → ${checkLabel(to)}`,
          target: requestRef(s),
          before: stringifyYaml(s.assertions).trim(),
          after: stringifyYaml(next).trim(),
          language: 'yaml',
          data: {
            replace: { index: at.index, was: at.check },
            check: to,
            fix: { changes: [{ index: at.index, was: at.check, check: to }], verifyOn: verifyOn(ts), ...(o.engine ? { engine: true } : {}) } satisfies FixCheckData,
          },
        });
      } else {
        let text = s.text;
        const changes: NonNullable<FixCheckData['changes']> = [];
        for (const t of ts) {
          if (!t.step) continue;
          const configs = stepChecks(text, s.path, t.step);
          const at = locateCheck(t, configs, cleanCheck(fix.check), fix.checkIndex);
          if (!at) continue;
          try {
            text = applyFlowEdit(text, { op: 'updateStep', id: t.step, set: { assertions: configs.map((c, i) => (i === at.index ? to : c)) } }).text;
            changes.push({ step: t.step, index: at.index, was: at.check, check: to });
          } catch (e) {
            notes.push(`${o.title}: ${name(s)} step ${t.step}: ${normalizeError(e).message}`);
          }
        }
        if (!changes.length) {
          notes.push(
            `${o.title}: ${name(s)} has no check ${typeof fix.checkIndex === 'number' ? `at checkIndex ${fix.checkIndex}` : `like ${fix.check ? checkLabel(fix.check) : 'the failing one'}`}; nothing changed there.`,
          );
          continue;
        }
        items.push(testFileItem(o.finding, s.path, `${checkLabel(changes[0]!.was)} → ${checkLabel(to)}`, s.text, text, { changes, verifyOn: verifyOn(ts), base: s.text, ...(o.engine ? { engine: true } : {}) }));
      }
    }
    return { items, notes };
  }

  if (fix.type === 'edit' || fix.type === 'step') {
    for (const [, ts] of bySource) {
      const s = ts[0]!.source;
      if (fix.type === 'step') {
        if (s.kind !== 'test' || !fix.set || typeof fix.set !== 'object') {
          notes.push(`${o.title}: a step change applies to a test file's step; ${name(s)} is ${s.kind === 'request' ? 'a saved request' : 'not one'}.`);
          continue;
        }
        let text = s.text;
        const steps = [...new Set(ts.map((t) => t.step).filter((x): x is string => !!x))];
        try {
          for (const st of steps) text = applyFlowEdit(text, { op: 'updateStep', id: st, set: fix.set }).text;
        } catch (e) {
          notes.push(`${o.title}: ${name(s)}: ${normalizeError(e).message}`);
          continue;
        }
        if (text === s.text) continue;
        items.push(testFileItem(o.finding, s.path, `${Object.keys(fix.set).join(', ')} on ${steps.join(', ')}`, s.text, text, { verifyOn: verifyOn(ts), base: s.text, ...(o.caution ? { caution: o.caution } : {}) }));
        continue;
      }
      const find = typeof fix.find === 'string' ? fix.find : '';
      const replace = typeof fix.replace === 'string' ? fix.replace : '';
      const text = s.kind === 'request' ? (s.testScript ?? '') : s.text;
      const at = find ? text.indexOf(find) : -1;
      if (!find || at < 0 || text.indexOf(find, at + 1) >= 0) {
        notes.push(`${o.title}: the text to change ${!find ? 'is missing' : at < 0 ? `is not in ${name(s)}` : `is in ${name(s)} more than once`}; nothing changed there.`);
        continue;
      }
      const after = text.slice(0, at) + replace + text.slice(at + find.length);
      if (s.kind === 'request')
        items.push({
          kind: 'script',
          finding: o.finding,
          title: `${s.name}: edit the test script`,
          target: requestRef(s),
          before: text,
          after,
          language: 'javascript',
          data: { phase: 'test', fix: { script: after, verifyOn: verifyOn(ts), base: text } satisfies FixCheckData },
        });
      else
        items.push(testFileItem(o.finding, s.path, 'edit', text, after, { verifyOn: verifyOn(ts), base: text }));
    }
    return { items, notes };
  }

  if (fix.type === 'variable') {
    const key = String(fix.name ?? '').replace(/^\{\{\s*|\s*\}\}$/g, '');
    if (!key || typeof fix.value !== 'string') return { items, notes: [`${o.title}: a variable fix needs a name and a value.`] };
    if (!o.environment) return { items, notes: [`${o.title}: the run used no environment, so {{${key}}} is not set by this proposal; add it to an environment yourself.`] };
    const unresolved = [...new Set(targets.flatMap((t) => t.unresolvedVariables))];
    items.push({
      kind: 'variable',
      finding: o.finding,
      title: `Set {{${key}}} in ${o.environment}`,
      before: unresolved.includes(key) ? `${key}: (not set)` : `${key}: (its current value)`,
      after: `${key}: ${fix.value}`,
      language: 'text',
      data: { environment: o.environment, key, value: fix.value, fix: { variable: { key, value: fix.value, unresolved }, verifyOn: verifyOn(targets) } satisfies FixCheckData },
    });
    return { items, notes };
  }

  // no change to the test: what to do, and for an API that regressed a bug report with the evidence
  return { items, notes };
}

/** The stable form of a check (exists / type / a format) when it would pin a value the server makes up. */
const stableForm = (c: CheckConfig): CheckConfig => (pinsGeneratedValue(c) ? (saferChecks(c)[0] ?? c) : c);

/**
 * TestPion's own update of a stale expected value ("AI to understand, deterministic to decide"): the failing check
 * (equals, json-path or status) with the value the failing response has now — or its stable form when that value is
 * made up by the server. None when the response is an error the test is right about (5xx, 401, 403), when the value is
 * not a plain value, or when the check failed on the last passing response too (then it is not a change).
 */
export function staleCheckUpdate(check: CheckConfig, failing: StoredResponse | undefined, lastPassing?: StoredResponse): CheckConfig | undefined {
  const st = failing?.status;
  if (!failing || typeof st !== 'number' || st >= 500 || st === 401 || st === 403) return undefined;
  if (check.type === 'status' || check.type === 'http-status') return Number(check.expected) === st ? undefined : { ...check, expected: st };
  if (!/^(equals|eq|json-path)$/i.test(check.type) || typeof check.path !== 'string' || failing.body === undefined) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(failing.body);
  } catch {
    return undefined;
  }
  if (!exists(body, check.path)) return undefined;
  const now = query(body, check.path);
  if (now === null || now === undefined || typeof now === 'object' || now === check.expected) return undefined;
  if (lastPassing?.body !== undefined) {
    try {
      const before = JSON.parse(lastPassing.body) as unknown;
      // the check never held: the value is not what changed
      if (!exists(before, check.path) || JSON.stringify(query(before, check.path)) !== JSON.stringify(check.expected)) return undefined;
    } catch {
      /* not JSON before: nothing to compare with */
    }
  }
  return stableForm({ ...check, expected: now });
}

/** A bug report for an API that regressed (Markdown, credentials masked): the request, what was expected, what changed. */
export function bugReport(o: {
  title: string;
  explanation?: string;
  target: FixTarget;
  check?: string;
  message?: string;
  status?: number | string;
  changed?: string;
  runId: string;
  lastPassing?: { runId: string; startedAt: string };
}): string {
  const req = o.target.request;
  const lines = [
    `## ${o.title}`,
    '',
    req?.url ? `**Request:** \`${req.method ?? 'GET'} ${req.url}\`` : '',
    o.check ? `**Expected:** ${o.check}${o.message ? ` — ${o.message}` : ''}` : '',
    o.status !== undefined ? `**Got:** status ${o.status}` : '',
    o.lastPassing ? `**Last passed:** run ${o.lastPassing.runId} (${o.lastPassing.startedAt})${o.changed ? `; since then: ${o.changed}` : ''}` : '**Last passed:** no earlier passing run of this test',
    `**Failing run:** ${o.runId}`,
    o.explanation ? `\n${o.explanation}` : '',
  ].filter(Boolean);
  return maskSensitiveText(lines.join('\n'));
}

/* ------------------------------------------------------------------ the `fix` verifier */

/** Responses made up to catch a check that holds for anything: no body, an empty object, an error page. */
const JUNK: StoredResponse[] = [
  { status: 500, headers: [], body: '{}' },
  { status: 200, headers: [['content-type', 'text/plain']], body: '' },
  { status: 404, headers: [['content-type', 'text/html']], body: '<html>Not Found</html>' },
];

const ctxOf = (r: StoredResponse) => {
  let body: unknown = r.body;
  try {
    body = r.body === undefined ? undefined : JSON.parse(r.body);
  } catch {
    /* text */
  }
  return { testType: 'http' as const, status: r.status, headers: r.headers, body, text: r.body ?? '', latencyMs: r.latencyMs };
};

const passes = async (c: CheckConfig, r: StoredResponse) => (await runChecks([c], ctxOf(r)))[0]?.passed === true;

/** Whether a check can be judged on a stored response: a body check needs the body. */
const judgeable = (c: CheckConfig, r: StoredResponse | undefined): r is StoredResponse => !!r && (r.body !== undefined || /^(status|http-status|header|latency|response-time)$/.test(c.type));

/** A changed check against the failing responses, the last passing ones and the made-up ones (see the module comment). */
export async function verifyCheckChange(check: CheckConfig, cases: VerifyCase[]): Promise<VerificationBadge> {
  // a check of a type the runner does not have: the repair turn gets the right shape and the allowed types
  if (!checkTypes().includes(check.type))
    return { verifier: 'fix', status: 'fail', label: 'not a check TestPion has', detail: explainCheckProblem(`Unknown check type "${check.type}": ${checkTypes().join(', ')}`) };
  const failing = cases.filter((c) => judgeable(check, c.failing));
  if (!failing.length) return { verifier: 'fix', status: 'skip', label: 'no stored response to check it against', detail: 'The run kept no body for these results (run with traces to keep them).' };
  const still = [];
  for (const c of failing) if (!(await passes(check, c.failing!))) still.push(c.resultId);
  if (still.length)
    return { verifier: 'fix', status: 'fail', label: `still fails on the failing response${still.length > 1 ? 's' : ''}`, detail: `${checkLabel(check)} fails on ${still.slice(0, 5).join(', ')}` };
  let anything = true;
  for (const j of JUNK) if (!(await passes(check, j))) anything = false;
  if (anything) return { verifier: 'fix', status: 'fail', label: 'accepts any response', detail: `${checkLabel(check)} passes even on an empty or error response: it would hide real failures.` };
  const passing = cases.filter((c) => judgeable(check, c.lastPassing));
  const broke = [];
  for (const c of passing) if (!(await passes(check, c.lastPassing!))) broke.push(c.resultId);
  if (broke.length)
    return {
      verifier: 'fix',
      status: 'warn',
      label: 'passes now; it would have failed on the last passing run: it follows an API change',
      detail: 'Accept it only if the change in the API is intended (else the API regressed: keep the check and report it).',
    };
  return { verifier: 'fix', status: 'pass', label: passing.length ? 'passes on the failing response and on the last passing one' : 'passes on the failing response; no earlier pass to compare with' };
}

/** An edited script: no misuse of the API, its tests pass on the failing response (and are compared with the last passing one). */
async function verifyScriptChange(code: string, cases: VerifyCase[]): Promise<VerificationBadge> {
  const misuse = scriptApiProblems(code, await loadScriptApi());
  if (misuse.length) return { verifier: 'fix', status: 'fail', label: 'misuses the tp.* script API', detail: misuse.slice(0, 5).join('\n') };
  const run = (r: StoredResponse) => runScript(code, { variables: {}, response: sandboxResponse(r) }, { timeoutMs: 3000, maxRequests: 0 });
  const failing = cases.filter((c) => c.failing?.body !== undefined);
  if (!failing.length) return { verifier: 'fix', status: 'skip', label: 'no stored response to run the script on' };
  for (const c of failing) {
    const out = await run(c.failing!);
    const bad = out.tests.filter((t) => !t.skipped && !t.passed);
    if (out.error || bad.length)
      return { verifier: 'fix', status: 'fail', label: 'the script still fails on the failing response', detail: out.error ?? bad.map((t) => `${t.name}: ${t.message ?? 'failed'}`).join('\n') };
  }
  for (const c of cases.filter((x) => x.lastPassing?.body !== undefined)) {
    const out = await run(c.lastPassing!);
    if (out.error || out.tests.some((t) => !t.skipped && !t.passed))
      return {
        verifier: 'fix',
        status: 'warn',
        label: 'passes now; it would have failed on the last passing run: it follows an API change',
        detail: 'Accept it only if the change in the API is intended.',
      };
  }
  return { verifier: 'fix', status: 'pass', label: 'its tests pass on the failing response' };
}

/** A variable fix: one the failing steps miss, never a secret. */
function verifyVariable(v: NonNullable<FixCheckData['variable']>): VerificationBadge {
  if (/(token|secret|password|passwd|api[-_]?key|auth|credential|cookie|session)/i.test(v.key) || maskSensitiveText(v.value) !== v.value)
    return {
      verifier: 'fix',
      status: 'fail',
      label: 'looks like a secret: set it yourself',
      detail: 'TestPion never takes a credential from a model; refresh or enter it in the environment (a secret variable).',
    };
  if (v.unresolved.includes(v.key)) return { verifier: 'fix', status: 'pass', label: `resolves {{${v.key}}}, which the failing steps could not resolve` };
  return { verifier: 'fix', status: 'warn', label: `the failing steps did not miss {{${v.key}}}: this changes the value they use` };
}

/** The `fix` verifier (see the module comment). */
async function verifyFixItem(item: ProposalItem): Promise<VerificationBadge | undefined> {
  const f = (item.data as { fix?: FixCheckData } | undefined)?.fix;
  if (!f) return undefined;
  if (f.evidence) return { verifier: 'fix', status: f.evidence.changed ? 'pass' : 'warn', label: f.evidence.label };
  if (f.variable) return verifyVariable(f.variable);
  if (item.kind === 'file' || item.kind === 'flow') {
    const lint = await verifyTestFile(item.after, item.path);
    if (lint.status === 'fail') return { ...lint, verifier: 'fix' };
  }
  if (f.script !== undefined) return verifyScriptChange(item.after, f.verifyOn);
  const badges: VerificationBadge[] = [];
  for (const c of f.changes ?? []) badges.push(await verifyCheckChange(c.check, f.verifyOn));
  if (f.caution) badges.push({ verifier: 'fix', status: 'warn', label: f.caution });
  const worst = badges.find((b) => b.status === 'fail') ?? badges.find((b) => b.status === 'warn') ?? badges.find((b) => b.status === 'skip') ?? badges[0];
  return worst ?? { verifier: 'fix', status: 'pass', label: 'parsed · linted' };
}

registerVerifier('fix', (item) => verifyFixItem(item));
