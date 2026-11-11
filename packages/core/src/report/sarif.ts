/**
 * A run as SARIF 2.1.0 (planning/ai-research-2026-11-11.md N-3): the format code-scanning views read (GitHub code
 * scanning, Azure DevOps, GitLab, SonarQube), so a failed safety check shows where the team already looks at findings.
 * Every failed check is one result; its rule is the check's type. A check that tests a risk of the OWASP Top 10 for LLM
 * applications (2025) carries the category, and the run says per category how many tests covered it and how many failed.
 *
 * The mapping is by what a check measures, and deliberately small: a check that only loosely relates to a category is
 * left unmapped, so the table never claims coverage a run does not have.
 */
import type { CheckResult, RunSummary, TestResult } from '../model/types.js';
import { atomicWrite } from '../storage/fsutil.js';

export interface OwaspCategory {
  id: string;
  name: string;
}

export const OWASP_LLM_2025: readonly OwaspCategory[] = [
  { id: 'LLM01:2025', name: 'Prompt Injection' },
  { id: 'LLM02:2025', name: 'Sensitive Information Disclosure' },
  { id: 'LLM03:2025', name: 'Supply Chain' },
  { id: 'LLM04:2025', name: 'Data and Model Poisoning' },
  { id: 'LLM05:2025', name: 'Improper Output Handling' },
  { id: 'LLM06:2025', name: 'Excessive Agency' },
  { id: 'LLM07:2025', name: 'System Prompt Leakage' },
  { id: 'LLM08:2025', name: 'Vector and Embedding Weaknesses' },
  { id: 'LLM09:2025', name: 'Misinformation' },
  { id: 'LLM10:2025', name: 'Unbounded Consumption' },
];

/** The check types that test a category. */
const BY_CHECK: Record<string, string> = {
  'prompt-injection-resistance': 'LLM01:2025',
  'jailbreak-resistance': 'LLM01:2025',
  'attack-resisted': 'LLM01:2025',
  'pii-leakage': 'LLM02:2025',
  'no-leak': 'LLM02:2025',
  'json-schema': 'LLM05:2025',
  'tool-args-valid': 'LLM05:2025',
  'tool-not-called': 'LLM06:2025',
  'allowed-tools': 'LLM06:2025',
  'tool-sequence': 'LLM06:2025',
  faithfulness: 'LLM09:2025',
  groundedness: 'LLM09:2025',
  hallucination: 'LLM09:2025',
  'answer-correctness': 'LLM09:2025',
  tokens: 'LLM10:2025',
  cost: 'LLM10:2025',
};
/** The kinds of a safety probe (`probe` of a record) that test a category whatever the check. */
const BY_PROBE: Record<string, string> = { jailbreak: 'LLM01:2025', injection: 'LLM01:2025', 'multi-turn': 'LLM01:2025', 'indirect-injection': 'LLM01:2025', pii: 'LLM02:2025', 'system-prompt': 'LLM07:2025' };

const probeOf = (r: TestResult): string | undefined => (r.metadata as { rag?: { record?: { probe?: string } } } | undefined)?.rag?.record?.probe;

/** The OWASP category a check of a result tests, if any. */
export function owaspOf(check: Pick<CheckResult, 'type'>, result?: TestResult): OwaspCategory | undefined {
  const id = BY_CHECK[check.type] ?? BY_CHECK[check.type.replace(/^rag-/, '')] ?? (result ? BY_PROBE[probeOf(result) ?? ''] : undefined);
  return id ? OWASP_LLM_2025.find((c) => c.id === id) : undefined;
}

export interface OwaspCoverage extends OwaspCategory {
  /** Tests with at least one check of this category. */
  tests: number;
  /** Of those, the tests where such a check failed. */
  failed: number;
}

/** Counts, per category, the tests that covered it and the ones that failed there. Categories no test covered say 0. */
export class OwaspTally {
  private rows = new Map(OWASP_LLM_2025.map((c) => [c.id, { ...c, tests: 0, failed: 0 }]));
  add(r: TestResult): void {
    const seen = new Map<string, boolean>();
    for (const c of r.checks) {
      const cat = owaspOf(c, r);
      if (cat) seen.set(cat.id, (seen.get(cat.id) ?? false) || !c.passed);
    }
    for (const [id, failed] of seen) {
      const row = this.rows.get(id)!;
      row.tests++;
      if (failed) row.failed++;
    }
  }
  coverage(): OwaspCoverage[] {
    return [...this.rows.values()];
  }
}

const uriOf = (file: string) => file.replace(/\\/g, '/').replace(/^\/+/, '');

/** Writes the run as a SARIF 2.1.0 log: one result per failed check (and per test that ended in an error). */
export async function writeSarifReport(path: string, summary: RunSummary, results: AsyncIterable<TestResult>, o: { version?: string } = {}): Promise<void> {
  const rules = new Map<string, { id: string; name: string; owasp?: OwaspCategory }>();
  const out: unknown[] = [];
  const tally = new OwaspTally();
  for await (const r of results) {
    tally.add(r);
    const location = r.file ? [{ physicalLocation: { artifactLocation: { uri: uriOf(r.file) } }, logicalLocations: [{ name: r.name, kind: 'test' }] }] : [{ logicalLocations: [{ name: r.name, kind: 'test' }] }];
    if (r.status === 'error') {
      rules.set('test-error', { id: 'test-error', name: 'The test could not run' });
      out.push({ ruleId: 'test-error', level: 'error', message: { text: `${r.name}: ${r.error?.message ?? 'error'}`.slice(0, 2000) }, locations: location, partialFingerprints: { test: r.id } });
      continue;
    }
    if (r.status !== 'failed') continue;
    for (const c of r.checks) {
      if (c.passed) continue;
      const owasp = owaspOf(c, r);
      if (!rules.has(c.type)) rules.set(c.type, { id: c.type, name: c.type, ...(owasp ? { owasp } : {}) });
      out.push({
        ruleId: c.type,
        level: 'error',
        message: { text: `${r.name}: ${c.name ?? c.type}: ${c.message ?? 'failed'}`.slice(0, 2000) },
        locations: location,
        partialFingerprints: { test: r.id, check: c.name ?? c.type },
        properties: { test: r.name, ...(c.score !== undefined ? { score: c.score } : {}), ...(owasp ? { owasp: `${owasp.id} ${owasp.name}`, tags: ['security', owasp.id] } : {}), ...(r.model ? { model: r.model } : {}) },
      });
    }
  }
  const log = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'TestPion',
            ...(o.version ? { version: o.version } : {}),
            rules: [...rules.values()].map((x) => ({
              id: x.id,
              name: x.name,
              shortDescription: { text: x.owasp ? `${x.name} (${x.owasp.id} ${x.owasp.name})` : x.name },
              ...(x.owasp ? { helpUri: 'https://genai.owasp.org/llm-top-10/', properties: { tags: ['security', x.owasp.id], owasp: `${x.owasp.id} ${x.owasp.name}` } } : {}),
            })),
          },
        },
        automationDetails: { id: `testpion/${summary.name}` },
        results: out,
        properties: { run: summary.name, total: summary.total, passed: summary.passed, failed: summary.failed, errors: summary.errors, ...(summary.environment ? { environment: summary.environment } : {}), owaspLlmTop10: tally.coverage() },
      },
    ],
  };
  atomicWrite(path, JSON.stringify(log, null, 2) + String.fromCharCode(10));
}
