/** What the app says about a dataset file (datasets/ in the workspace): its badge in lists and the YAML a test needs. */

/** The short badge of a dataset's format, as the sidebar and the tab show it. */
export function datasetBadge(format: string): { text: string; cls: string } {
  switch (format) {
    case 'csv':
      return { text: 'CSV', cls: 'text-ok' };
    case 'jsonl':
      return { text: 'JSONL', cls: 'text-warn' };
    case 'json':
      return { text: 'JSON', cls: 'text-warn' };
    // the dataset kind's own colour (styles.css --k-dataset); CSV and JSON keep the status tones they had
    case 'markdown':
      return { text: 'MD', cls: 'kind-dataset' };
    case 'sqlite':
      return { text: 'DB', cls: 'kind-dataset' };
    default:
      return { text: 'DATA', cls: 'text-muted' };
  }
}

/** The `dataset:` block of a YAML test that reads this file (a database needs its query). */
export function datasetYaml(name: string, query?: string): string {
  const lines = ['dataset:', `  path: datasets/${name}`];
  if (query) lines.push(`  query: ${/[:#'"]/.test(query) ? JSON.stringify(query) : query}`);
  return lines.join('\n') + '\n';
}
