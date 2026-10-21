import { parseYaml } from './lazy-yaml.js';

/** YAML text parsed without throwing: `ok: false` when it does not parse (an empty document is `ok` with a null value). */
export function tryParseYaml(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: parseYaml(text) };
  } catch {
    return { ok: false };
  }
}

/** The steps of a test file's parsed document: the list itself, its `tests:`, or the one test a single-test file is. */
export function testStepsOf(doc: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(doc) ? doc : Array.isArray((doc as { tests?: unknown } | null)?.tests) ? (doc as { tests: unknown[] }).tests : doc && typeof doc === 'object' ? [doc] : []) as Array<Record<string, unknown>>;
}
