/**
 * What the bundle adapter of the `metric` kind asks of a custom metric file (metrics/<id>.yaml): that it is a YAML map of a
 * metric of this id (a half-written metric is carried too: the metric editor shows what is wrong with it, and it is
 * `not usable` until fixed), and what to look at before a metric runs. The adapter itself is the file adapter of items-files.ts.
 */
import { CUSTOM_METRIC_ID, CUSTOM_METRIC_KINDS, isRecord } from '@testpion/shared';
import { parseYaml } from '../util/lazy-yaml.js';
import { parseCustomMetric } from '../eval/rag/custom/file.js';

const idOf = (path: string) => /^metrics\/(.+)\.ya?ml$/i.exec(path)?.[1] ?? '';

/** Why the incoming file is not a metric of this workspace; undefined when it is. */
export function customMetricFileProblem(path: string, data: Buffer): string | undefined {
  const id = idOf(path);
  if (!CUSTOM_METRIC_ID.test(id)) return `"${id.slice(0, 60)}" is not a metric id: lower-case letters, digits and hyphens, starting with a letter or digit`;
  if (data.length > 128 * 1024) return 'a metric file is at most 128 KB';
  let doc: unknown;
  try {
    doc = parseYaml(data.toString('utf8'));
  } catch (e) {
    return `it is not YAML: ${(e as Error).message.split('\n')[0]}`;
  }
  if (!isRecord(doc)) return 'a metric file is a map: id, kind, … keys';
  if (doc.id !== undefined && doc.id !== id) return `its id is "${String(doc.id).slice(0, 60)}", the file name says "${id}"`;
  if (doc.kind !== undefined && !CUSTOM_METRIC_KINDS.some((k) => k.id === doc.kind)) return `"${String(doc.kind).slice(0, 40)}" is not a kind of metric (${CUSTOM_METRIC_KINDS.map((k) => k.id).join(', ')})`;
  return undefined;
}

/** What to look at before the metric runs: a script metric is code, a judge metric sends the sample to the judge, a file with errors is not usable. */
export function customMetricReview(path: string, data: Buffer): string[] {
  const id = idOf(path);
  const p = parseCustomMetric(data.toString('utf8'), { fileId: id });
  const out: string[] = [];
  const errors = p.problems.filter((x) => x.level === 'error');
  if (errors.length) out.push(`Metric "${id}" has a problem and is not usable until it is fixed: ${errors[0]!.field ? `${errors[0]!.field}: ` : ''}${errors[0]!.message}`);
  const kind = p.metric?.kind;
  if (kind === 'script') out.push(`Metric "${id}" is a script: it runs when a sample is scored (nothing runs on import)`);
  else if (kind === 'judge' || kind === 'checklist') out.push(`Metric "${id}" asks a judge model about each sample it scores (nothing is sent on import)`);
  return out;
}
