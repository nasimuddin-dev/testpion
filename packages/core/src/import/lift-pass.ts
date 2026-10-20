import type { CheckConfig, CollectionNode } from '../model/types.js';
import { liftTests } from '../scripts/convert/lift-tests.js';
import type { ImportDocument } from './model.js';

/**
 * "Lift simple tests into assertions" for an import document (the converter in scripts/convert/lift-tests.ts decides
 * which tests are simple). `apply: false` only counts them: the report says "N simple tests can be lifted" and the
 * Import dialog / `--lift-tests` / MCP `lift_tests` do it. Request test scripts only: a folder's test runs for each request.
 */
export function liftDocumentTests(doc: ImportDocument, apply: boolean): number {
  let total = 0;
  const same = (a: CheckConfig, b: CheckConfig) => JSON.stringify({ ...a, name: undefined }) === JSON.stringify({ ...b, name: undefined });
  const walk = (nodes: CollectionNode[]): CollectionNode[] =>
    nodes.map((n) => {
      if (n.kind === 'folder') return { ...n, items: walk(n.items) };
      if (!n.testScript?.trim()) return n;
      const r = liftTests(n.testScript, apply);
      total += r.lifted;
      if (!apply || !r.lifted) return n;
      const assertions = [...(n.assertions ?? [])];
      for (const a of r.assertions) if (!assertions.some((x) => same(x, a))) assertions.push(a);
      const { testScript: _old, ...rest } = n;
      return { ...rest, ...(r.code.trim() ? { testScript: r.code } : {}), assertions } as CollectionNode;
    });
  doc.collections = doc.collections.map((c) => ({ ...c, items: walk(c.items) }));
  if (total && apply) doc.findings.push({ code: 'TESTS_LIFTED', severity: 'info', where: [], message: `${total} simple test${total === 1 ? '' : 's'} became assertion${total === 1 ? '' : 's'} (the request's Tests tab shows them; the rest of each script is kept)` });
  else if (total) doc.findings.push({ code: 'TESTS_LIFTABLE', severity: 'info', where: [], message: `${total} simple test${total === 1 ? '' : 's'} (status, response time, headers, JSON fields) can be lifted into assertions`, suggestion: 'Import with "Lift simple tests into assertions" (--lift-tests) or run Tidy up', reportOnly: true });
  return total;
}
