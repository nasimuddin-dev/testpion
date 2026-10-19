import { jsonPretty, markdownTable, outputFileName } from '@testpion/shared';
import type { OutputSpec } from './output-core';

/**
 * The reports about an API definition or a collection — OpenAPI lint, fuzzing, coverage, the security review and the
 * comparison of two versions — all download the same way: a Markdown document (to read, or to paste in a pull request)
 * or the data as JSON. The panel builds the document from what it shows; ApiReportBar puts the control in its bar.
 */
export interface ApiReport {
  kind: 'lint' | 'fuzz' | 'coverage' | 'security' | 'diff';
  /** The heading of the document and the base of the file name ("API lint · petstore.yaml"). */
  title: string;
  markdown: string;
  data: unknown;
}

const WHAT: Record<ApiReport['kind'], string> = { lint: 'lint report', fuzz: 'fuzzing report', coverage: 'coverage report', security: 'security review', diff: 'API comparison' };

export function apiReportSpec(r: ApiReport | undefined, kind: ApiReport['kind']): OutputSpec {
  if (!r) return { id: 'api.reports', what: WHAT[kind], name: `api-${kind}`, formats: [], empty: 'Nothing to download yet' };
  return {
    id: 'api.reports',
    what: WHAT[r.kind],
    name: outputFileName({ name: r.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || `api-${r.kind}`, ext: '' }),
    formats: [
      { key: 'md', format: 'md', label: 'Report (Markdown)', default: true, build: () => r.markdown },
      { key: 'json', format: 'json', label: 'Data (JSON)', build: () => jsonPretty(r.data) },
    ],
  };
}

const cell = (v: unknown) => String(v ?? '').replace(/\r?\n/g, ' ');

/** OpenAPI lint problems as a document. */
export function lintReport(spec: string, result: { problems: Array<{ rule: string; severity: string; message: string; where: string; line: number }>; counts: { error: number; warning: number; info: number }; operations: number }): ApiReport {
  const { counts } = result;
  return {
    kind: 'lint',
    title: `API lint · ${spec.replace(/^specs\//, '')}`,
    data: result,
    markdown: `# API lint: ${spec}\n\n${counts.error} errors, ${counts.warning} warnings, ${counts.info} notes in ${result.operations} operations.\n\n${
      result.problems.length ? markdownTable(['severity', 'rule', 'where', 'line', 'message'], result.problems.map((p) => [p.severity, p.rule, cell(p.where), p.line, cell(p.message)])) : 'No problems.\n'
    }`,
  };
}

/** The security review of a collection as a document. */
export function securityReport(name: string, findings: Array<{ severity: string; where: string; message: string; category?: string }>): ApiReport {
  return {
    kind: 'security',
    title: `Review · ${name}`,
    data: findings,
    markdown: `# Security review: ${name}\n\n${findings.length ? markdownTable(['severity', 'kind', 'where', 'finding'], findings.map((f) => [f.severity, f.category ?? 'security', cell(f.where), cell(f.message)])) : 'No findings.\n'}`,
  };
}

/** Two OpenAPI versions compared, as a document. */
export function diffReport(result: { operations: { old: number; new: number; added: number; removed: number }; breaking: Array<{ where: string; message: string }>; nonBreaking: Array<{ where: string; message: string }> }): ApiReport {
  const list = (items: Array<{ where: string; message: string }>) => items.map((c) => `- \`${c.where}\`: ${c.message}`).join('\n');
  return {
    kind: 'diff',
    title: 'OpenAPI comparison',
    data: result,
    markdown: `# OpenAPI comparison\n\n${result.operations.old} → ${result.operations.new} operations (${result.operations.added} added, ${result.operations.removed} removed).\n\n## Breaking changes (${result.breaking.length})\n\n${result.breaking.length ? list(result.breaking) : 'None.'}\n\n## Other changes (${result.nonBreaking.length})\n\n${result.nonBreaking.length ? list(result.nonBreaking) : 'None.'}\n`,
  };
}

/** A fuzzing report as a document: the counts, then each finding. */
export function fuzzReport(
  spec: string,
  report: { operations: number; cases: number; counts: Record<string, number>; results: Array<{ case: { operation: string; name: string; request: { method: string; url: string } }; status?: number; verdict: string; message: string }> },
): ApiReport {
  const findings = report.results.filter((r) => r.verdict !== 'ok' && r.verdict !== 'not-judged');
  return {
    kind: 'fuzz',
    title: `Fuzzing · ${spec.replace(/^specs\//, '')}`,
    data: { operations: report.operations, cases: report.cases, counts: report.counts, findings: findings.map((r) => ({ operation: r.case.operation, case: r.case.name, verdict: r.verdict, status: r.status, message: r.message, url: r.case.request.url })) },
    markdown: `# Fuzzing: ${spec}\n\n${report.cases} requests to ${report.operations} operations: ${report.counts['server-error'] ?? 0} server errors, ${report.counts['accepted-invalid'] ?? 0} invalid inputs accepted, ${report.counts['undocumented-status'] ?? 0} undocumented statuses.\n\n${
      findings.length ? markdownTable(['verdict', 'operation', 'case', 'status', 'message'], findings.map((r) => [r.verdict, cell(r.case.operation), cell(r.case.name), r.status ?? '', cell(r.message)])) : 'Nothing found.\n'
    }`,
  };
}
