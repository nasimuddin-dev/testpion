import { jsonPretty, markdownTable, objectsToCsv, outputFileName, type OutputSurfaceId } from '@testpion/shared';
import type { OutputSpec } from './output-core';

/**
 * A table the window holds in full (small: a screen of rows) as CSV, Markdown or JSON — the same three formats for every
 * table-shaped output that is built in the window (an environment matrix, a comparison of two environments, a monitor's
 * runs on screen). Bigger tables are sources the backend streams (a data run, an evaluation matrix, History).
 */
export function tableOutputSpec(o: { id: OutputSurfaceId; what: string; name: string; title?: string; columns: string[]; rows: unknown[][]; empty?: string; markdown?: string }): OutputSpec {
  const objects = () => o.rows.map((r) => Object.fromEntries(o.columns.map((c, i) => [c, r[i]])));
  return {
    id: o.id,
    what: o.what,
    name: outputFileName({ name: o.name, ext: '' }),
    formats: [
      { key: 'csv', format: 'csv', default: true, build: () => objectsToCsv(objects(), { columns: o.columns }) },
      { key: 'md', format: 'md', build: () => o.markdown ?? `# ${o.title ?? o.what}\n\n${markdownTable(o.columns, o.rows)}` },
      { key: 'json', format: 'json', build: () => jsonPretty(objects()) },
    ],
    empty: o.rows.length ? o.empty : (o.empty ?? 'Nothing to download'),
  };
}
