import type { CollectionNode } from '../model/types.js';
import type { FindingSeverity, ImportDocument, ImportFinding } from './model.js';

/**
 * The compatibility report of an import: per item "imported fully", "imported with changes" or "not imported" and why.
 * It replaces the loose list of notes (which the older import result still carries, unchanged); it is what the preview and the
 * result dialog show, `testpion import --json` prints and MCP returns, and it is kept with the import so it can be
 * opened again.
 */

interface ReportGroup {
  code: string;
  title: string;
  severity: FindingSeverity;
  count: number;
}

export interface ImportReport {
  version: 1;
  format: string;
  tool?: string;
  fileCount: number;
  bytes: number;
  /** What the import creates. */
  counts: { collections: number; folders: number; requests: number; environments: number; specs: number; flows: number; libraryItems: number };
  /** Items = collections, folders, requests and environments: how many came over fully, with changes, and how many things were left out. */
  summary: { items: number; full: number; changed: number; notImported: number; valuesNeeded: number };
  scripts?: { converted: number; kept: number; todo: number };
  /** The findings grouped by code, most severe first. */
  groups: ReportGroup[];
  findings: ImportFinding[];
  /** More findings than the report lists (it keeps the first 2000). */
  truncated?: number;
}

const TITLES: Record<string, string> = {
  AUTH_UNSUPPORTED: 'Auth schemes TestPion does not have',
  AUTH_CHANGED: 'Auth changed',
  VALUE_NEEDED: 'Values to enter',
  SECRET_VALUES: 'Secret values',
  TEMPLATE_TAG: 'Template tags converted',
  TEMPLATE_TAG_UNSUPPORTED: 'Template tags left as text',
  SCRIPT_API: 'Script APIs without an equivalent',
  SCRIPT_BASE_ENVIRONMENT: 'Base environment in scripts',
  SCRIPT_PARSE_ERROR: 'Scripts that do not parse',
  SCRIPT_LIFT: 'Script settings moved to the request',
  TESTS_LIFTED: 'Tests lifted into assertions',
  TESTS_LIFTABLE: 'Tests that can become assertions',
  NOT_IMPORTED: 'Not imported',
  SETTING_DROPPED: 'Settings not imported',
  HEADERS_FLATTENED: 'Headers moved to requests',
  IDS_RENAMED: 'Ids renamed',
  NOTE: 'Other',
};
const findingTitle = (code: string): string => TITLES[code] ?? code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');

const SEVERITY_ORDER: Record<FindingSeverity, number> = { 'not-imported': 0, changed: 1, info: 2 };
const MAX_FINDINGS = 2000;

function countNodes(nodes: CollectionNode[], into: { folders: number; requests: number }): void {
  for (const n of nodes)
    if (n.kind === 'folder') {
      into.folders++;
      countNodes(n.items, into);
    } else into.requests++;
}

export function buildReport(doc: ImportDocument): ImportReport {
  const n = { folders: 0, requests: 0 };
  for (const c of doc.collections) countNodes(c.items, n);
  const saved = doc.savedItems && typeof doc.savedItems === 'object' ? Object.values(doc.savedItems as Record<string, unknown>).reduce<number>((s, v) => s + (Array.isArray(v) ? v.length : 0), 0) : 0;
  const specs = (doc.format === 'openapi' || doc.format === 'swagger' || doc.format === 'asyncapi' ? 1 : 0) + (doc.specFile ? 1 : 0);
  const counts = { collections: doc.collections.length, folders: n.folders, requests: n.requests, environments: doc.environments.length, specs, flows: doc.flows?.length ?? 0, libraryItems: saved };
  const items = counts.collections + counts.folders + counts.requests + counts.environments;
  const touched = new Set<string>();
  for (const f of doc.findings) if (f.severity !== 'info') touched.add(f.where.join(' / '));
  const changed = Math.min(items, touched.size);
  const groups = new Map<string, ReportGroup>();
  for (const f of doc.findings) {
    const g = groups.get(f.code) ?? { code: f.code, title: findingTitle(f.code), severity: f.severity, count: 0 };
    g.count++;
    // a group shows its most severe finding
    if (SEVERITY_ORDER[f.severity] < SEVERITY_ORDER[g.severity]) g.severity = f.severity;
    groups.set(f.code, g);
  }
  const scripts = doc.scripts ? { converted: doc.scripts.converted, kept: doc.scripts.unchanged.length, todo: doc.scripts.warnings?.length ?? 0 } : undefined;
  const findings = doc.findings.slice(0, MAX_FINDINGS);
  return {
    version: 1,
    format: doc.format,
    ...(doc.tool ? { tool: doc.tool } : {}),
    fileCount: doc.fileCount,
    bytes: doc.bytes,
    counts,
    summary: {
      items,
      full: items - changed,
      changed,
      notImported: doc.findings.filter((f) => f.severity === 'not-imported').length,
      valuesNeeded: doc.findings.filter((f) => f.code === 'VALUE_NEEDED').length,
    },
    ...(scripts ? { scripts } : {}),
    groups: [...groups.values()].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count),
    findings,
    ...(doc.findings.length > findings.length ? { truncated: doc.findings.length - findings.length } : {}),
  };
}

/** The message of a finding without the `"Item": ` prefix the notes carry (the report shows the item beside it). */
export const findingDetail = (f: ImportFinding): string => f.message.replace(/^(?:Folder |Environment )?"[^"]+":\s*/, '');

/** The report as Markdown (Download report, `--report report.md`). */
export function reportMarkdown(r: ImportReport): string {
  const out = [`# Import report: ${r.tool ?? r.format}`, ''];
  const c = r.counts;
  out.push(`${c.requests} request${c.requests === 1 ? '' : 's'} in ${c.folders} folder${c.folders === 1 ? '' : 's'}, ${c.collections} collection${c.collections === 1 ? '' : 's'}, ${c.environments} environment${c.environments === 1 ? '' : 's'}${c.specs ? `, ${c.specs} API definition${c.specs === 1 ? '' : 's'}` : ''}${c.flows ? `, ${c.flows} flow${c.flows === 1 ? '' : 's'}` : ''}.`);
  out.push('', `- Imported fully: ${r.summary.full} of ${r.summary.items}`, `- Imported with changes: ${r.summary.changed}`, `- Not imported: ${r.summary.notImported}`, `- Values to enter: ${r.summary.valuesNeeded}`);
  if (r.scripts) out.push(`- Scripts: ${r.scripts.converted} converted to tp.*, ${r.scripts.kept} kept as written, ${r.scripts.todo} marked TODO(import)`);
  for (const g of r.groups) {
    out.push('', `## ${g.title} (${g.count})`, '');
    for (const f of r.findings.filter((x) => x.code === g.code)) out.push(`- ${f.where.length ? `**${f.where.join(' / ')}**${f.field ? ` (${f.field})` : ''}: ` : ''}${findingDetail(f)}${f.suggestion ? ` _${f.suggestion}_` : ''}`);
  }
  if (r.truncated) out.push('', `(${r.truncated} more findings are not listed.)`);
  return out.join('\n') + '\n';
}
