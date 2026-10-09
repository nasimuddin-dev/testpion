import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { ApsError, isSuiteFile, loadSuite, loadTestsFromFile, normalizeTest, parseYaml } from '@testpion/core';

/** The tests listed by a preview: the first ones of the file. */
export const PREVIEW_MAX_TESTS = 500;
/** YAML up to this size is parsed whole (about 200 ms at worst in the main process); larger files are cut after the 500th test. */
export const PREVIEW_YAML_WHOLE_BYTES = 256 * 1024;
/** JSON parses fast; past this it is refused. */
export const PREVIEW_JSON_MAX_BYTES = 8 * 1024 * 1024;
/** Nothing larger is read at all. */
export const PREVIEW_MAX_BYTES = 32 * 1024 * 1024;

export interface TestPreviewItem {
  id?: string;
  name: string;
  type: string;
  tags?: string[];
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function tooLarge(rel: string, size: number, why: string): ApsError {
  return new ApsError('ValidationError', `${rel} is ${mb(size)}: too large to preview (${why})`, {
    suggestions: ['Open the file in the editor, or run it: runs read it without the preview.', 'Split a very large test file, or keep the cases in a dataset (CSV, JSON Lines).'],
  });
}

/**
 * The start of a large YAML test file, up to its 500th test, so the preview never parses (or blocks on) the whole file:
 * a `tests:` list (with its `defaults:` block wherever it is) or a top-level list. Undefined for another shape.
 */
export function yamlPrefix(text: string, max = PREVIEW_MAX_TESTS): string | undefined {
  const lines = text.split(/\r?\n/);
  const testsAt = lines.findIndex((l) => /^tests:\s*(#.*)?$/.test(l));
  const topList = testsAt < 0 && lines.some((l) => /^-( |$)/.test(l));
  if (testsAt < 0 && !topList) return undefined;
  let indent: string | undefined = topList ? '' : undefined;
  let count = 0;
  let end = lines.length;
  for (let i = testsAt + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (indent === undefined) {
      const m = /^(\s*)-( |$)/.exec(l);
      if (m) indent = m[1]!;
      else if (/^\S/.test(l) && !l.startsWith('#')) return undefined;
      else continue;
    }
    // a top-level key after the list ends it
    if (!topList && /^[^\s#-]/.test(l)) {
      end = i;
      break;
    }
    if (l.startsWith(`${indent}-`) && /^-( |$)/.test(l.slice(indent.length)) && ++count > max) {
      end = i;
      break;
    }
  }
  let prefix = lines.slice(0, end).join('\n');
  // `defaults:` after the list still applies to its tests
  const defaultsAt = lines.findIndex((l, i) => i >= end && /^defaults:\s*(#.*)?$/.test(l));
  if (defaultsAt >= 0) {
    let stop = defaultsAt + 1;
    while (stop < lines.length && !/^[^\s#]/.test(lines[stop]!)) stop++;
    prefix += `\n${lines.slice(defaultsAt, stop).join('\n')}`;
  }
  return prefix;
}

/** The tests of a test file (the first 500) or its suite, read so that no file blocks the main process. */
export async function previewTests(abs: string, rel: string): Promise<{ suite?: unknown; tests: TestPreviewItem[] }> {
  const size = await stat(abs).then(
    (s) => (s.isFile() ? s.size : undefined),
    () => undefined,
  );
  if (size === undefined) throw new ApsError('ValidationError', `There is no test file ${rel}`);
  if (size > PREVIEW_MAX_BYTES) throw tooLarge(rel, size, `the limit is ${mb(PREVIEW_MAX_BYTES)}`);
  const json = extname(abs).toLowerCase() === '.json';
  if (json && size > PREVIEW_JSON_MAX_BYTES) throw tooLarge(rel, size, `the limit for JSON is ${mb(PREVIEW_JSON_MAX_BYTES)}`);
  if (isSuiteFile(abs)) {
    if (!json && size > PREVIEW_YAML_WHOLE_BYTES) throw tooLarge(rel, size, `a suite file is read whole; the limit is ${PREVIEW_YAML_WHOLE_BYTES / 1024} KB`);
    return { suite: await loadSuite(abs), tests: [] };
  }
  const out: TestPreviewItem[] = [];
  if (json || size <= PREVIEW_YAML_WHOLE_BYTES) {
    for await (const t of loadTestsFromFile(abs)) {
      out.push({ id: t.id, name: t.name, type: t.type, tags: t.tags });
      if (out.length >= PREVIEW_MAX_TESTS) break;
    }
    return { tests: out };
  }
  // a large YAML file: only its first 500 tests are parsed
  const prefix = yamlPrefix(await readFile(abs, 'utf8'));
  if (prefix === undefined || prefix.length > PREVIEW_YAML_WHOLE_BYTES) throw tooLarge(rel, size, `its first ${PREVIEW_MAX_TESTS} tests are over ${PREVIEW_YAML_WHOLE_BYTES / 1024} KB of YAML`);
  let data: unknown;
  try {
    data = parseYaml(prefix);
  } catch (e) {
    throw new ApsError('ConfigurationError', `Could not parse ${rel}: ${(e as Error).message}`);
  }
  const doc = data as { tests?: unknown[]; defaults?: Record<string, unknown> } | unknown[] | null;
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.tests) ? doc.tests : [];
  const defaults = (!Array.isArray(doc) && doc?.defaults) || {};
  list.slice(0, PREVIEW_MAX_TESTS).forEach((raw, i) => {
    const t = normalizeTest({ ...defaults, ...(raw as Record<string, unknown>) }, abs, i);
    out.push({ id: t.id, name: t.name, type: t.type, tags: t.tags });
  });
  return { tests: out };
}
