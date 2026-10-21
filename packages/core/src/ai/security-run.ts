/**
 * Running security tests (AI-8): the executor judges, not the model. A generated security file (security-tests.ts) is an
 * ordinary test file; this runs it with the rails a security test needs and turns each step's checks into a verdict:
 *
 *   finding       a check failed: the API accepted what it must refuse (the other user read the object, a request
 *                 without credentials succeeded, a privileged field came back)
 *   pass          every check held
 *   inconclusive  the step did not run its check: the owner's setup request failed (so nothing was proven), a
 *                 dependency was skipped, or the request errored (a network failure)
 *
 * Rails: a production environment is refused unless the caller allows it; steps run one at a time (concurrency 1) and
 * the file's own `pace:` rate limit applies (a faster `rate` can only be asked for the whole run, never faster than 50 a
 * second); only the file under tests/ the caller names is run.
 */
import { ApsError } from '../errors.js';
import type { TestResult } from '../model/types.js';
import type { ExecServices } from '../runner/execute.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { parseYaml } from '../util/lazy-yaml.js';
import { assertNotProduction, SECURITY_CATALOGUE, SECURITY_PROBES, type SecurityProbe } from './security-tests.js';

type SecurityVerdict = 'pass' | 'finding' | 'inconclusive';

export interface SecurityStepVerdict {
  step: string;
  name: string;
  probe?: SecurityProbe;
  owasp?: string;
  verdict: SecurityVerdict;
  /** The checks that failed (a finding) or why the step proved nothing. */
  detail: string[];
  status?: number;
  latencyMs?: number;
}

export interface SecurityRunReport {
  file: string;
  environment?: string;
  summary: { steps: number; pass: number; findings: number; inconclusive: number };
  /** Findings first, then inconclusive, then passes. */
  verdicts: SecurityStepVerdict[];
  ms: number;
}

/** The probe a step belongs to: its id is `sec-<n>-<kind>[-role]`. */
const probeOf = (id: string): SecurityProbe | undefined => SECURITY_PROBES.find((k) => new RegExp(`^sec-\\d+-${k}(-|$)`).test(id));

/** A step result as a verdict (see the module comment). */
function verdictOf(r: TestResult): SecurityStepVerdict {
  const id = r.id.replace(/@\d+(#\d+)?$/, '');
  const probe = probeOf(id);
  const status = (r.metadata as { status?: unknown } | undefined)?.status;
  const base = { step: id, name: r.name, ...(probe ? { probe, owasp: SECURITY_CATALOGUE[probe].owasp } : {}), ...(typeof status === 'number' ? { status } : {}), ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}) };
  if (r.status === 'passed') return { ...base, verdict: 'pass', detail: [] };
  if (r.status === 'failed') return { ...base, verdict: 'finding', detail: r.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.message}`) };
  const why = r.status === 'skipped' ? String((r.metadata as { reason?: unknown } | undefined)?.reason ?? 'skipped') : (r.error?.message ?? 'the request did not complete');
  return { ...base, verdict: 'inconclusive', detail: [r.status === 'skipped' ? `not run: ${why}` : `error: ${why}`] };
}

/**
 * Run a security test file (see the module comment). `servicesFor` is the host's engine context for the environment (the
 * CLI's and the desktop backend's own); the production check happens first, before anything is sent.
 */
export async function runSecurityTests(o: {
  store: WorkspaceStore;
  /** The file under tests/ (`security/orders.yaml`). */
  path: string;
  environment?: string;
  allowProduction?: boolean;
  servicesFor(environment?: string): Promise<{ services: ExecServices; dispose(): Promise<void> | void }>;
  signal?: AbortSignal;
}): Promise<SecurityRunReport> {
  const started = Date.now();
  const rel = o.path.replace(/^tests[\\/]/, '').replace(/\\/g, '/');
  assertNotProduction(o.store, o.environment, o.allowProduction);
  let text: string;
  try {
    text = o.store.readTestFile(rel);
  } catch {
    throw new ApsError('ConfigurationError', `tests/${rel} does not exist`, { suggestions: ['Generate the security tests first (testpion security generate --apply), then run the file it wrote.'] });
  }
  // only a security file runs here: its steps are the generated probes
  const doc = parseYaml(text) as { tests?: Array<{ id?: unknown }> } | null;
  const tests = Array.isArray(doc?.tests) ? doc!.tests! : [];
  if (!tests.length || !tests.every((t) => typeof t?.id === 'string' && /^sec-\d+-/.test(t.id)))
    throw new ApsError('ValidationError', `tests/${rel} is not a generated security test file`, { suggestions: ['Run other test files with testpion test; this runs the files testpion security generate writes (steps named sec-<n>-<kind>).'] });
  const [{ runTests }, { streamTests }] = await Promise.all([import('../runner/runner.js'), import('../runner/loader.js')]);
  const { services, dispose } = await o.servicesFor(o.environment);
  const results: TestResult[] = [];
  try {
    await runTests({
      name: `Security tests: ${rel}`,
      tests: streamTests([rel], o.store.path('tests')),
      services,
      signal: o.signal,
      concurrency: 1,
      traceMode: 'none',
      environment: o.environment,
      onEvent: ((e: { type: string; result?: TestResult }) => {
        if (e.type === 'test-end' && e.result) results.push(e.result);
      }) as never,
    });
  } finally {
    await dispose();
  }
  const order: Record<SecurityVerdict, number> = { finding: 0, inconclusive: 1, pass: 2 };
  const verdicts = results.map(verdictOf).sort((a, b) => order[a.verdict] - order[b.verdict]);
  return {
    file: `tests/${rel}`,
    ...(o.environment ? { environment: o.environment } : {}),
    summary: { steps: verdicts.length, pass: verdicts.filter((v) => v.verdict === 'pass').length, findings: verdicts.filter((v) => v.verdict === 'finding').length, inconclusive: verdicts.filter((v) => v.verdict === 'inconclusive').length },
    verdicts,
    ms: Date.now() - started,
  };
}

/** A report as Markdown (the CLI and MCP print it; findings first). */
export function securityReportMarkdown(r: SecurityRunReport): string {
  const lines = [`# Security tests: ${r.file}${r.environment ? ` (${r.environment})` : ''}`, '', `${r.summary.steps} steps: ${r.summary.findings} findings, ${r.summary.pass} passed, ${r.summary.inconclusive} inconclusive.`, ''];
  for (const v of r.verdicts) {
    const mark = v.verdict === 'finding' ? 'FINDING' : v.verdict === 'pass' ? 'pass' : 'inconclusive';
    lines.push(`- **${mark}** ${v.owasp ? `${v.owasp} ` : ''}${v.name}${v.status !== undefined ? ` (status ${v.status})` : ''}`);
    for (const d of v.detail) lines.push(`  - ${d}`);
  }
  return lines.join('\n');
}
