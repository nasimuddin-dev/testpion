/**
 * Where a test is, by its id: the file under tests/ that defines it and the line of its name (a test-case link, a
 * flaky test, an attention item names a test only by id). Files whose name matches the id's `<file>:` prefix are read
 * first; a test with an `id:` of its own can be in any file, so the others follow. Suites are skipped.
 */
import { readFileSync } from 'node:fs';
import { stepLine } from '@testpion/shared';
import type { WorkspaceStore } from '../storage/workspace.js';
import { slugify } from '../util/ids.js';
import { isSuiteFile, loadTestsFromFile } from './loader.js';

export interface TestLocation {
  /** The file inside tests/, with forward slashes. */
  path: string;
  /** The test's id and name, and the 1-based line of its `name:` (when found). */
  id: string;
  name: string;
  line?: number;
}

export async function locateTest(store: WorkspaceStore, testId: string, opts: { maxFiles?: number } = {}): Promise<TestLocation | undefined> {
  if (!testId) return undefined;
  const files: string[] = [];
  const walk = (nodes: ReturnType<WorkspaceStore['testTree']>) => {
    for (const n of nodes) {
      if (n.kind === 'dir') walk(n.children ?? []);
      else if (/\.(ya?ml|json)$/i.test(n.path) && !isSuiteFile(n.path)) files.push(n.path);
    }
  };
  walk(store.testTree());
  const prefix = testId.includes(':') ? testId.slice(0, testId.indexOf(':')) : undefined;
  const slugOf = (p: string) => slugify(p.replace(/^.*\//, '').replace(/\.[^.]+$/, ''));
  // the file the id's prefix names, first
  files.sort((a, b) => Number(slugOf(b) === prefix) - Number(slugOf(a) === prefix));
  for (const path of files.slice(0, opts.maxFiles ?? 5000)) {
    const abs = store.safePath(path, store.path('tests'));
    try {
      for await (const t of loadTestsFromFile(abs)) {
        if ((t.id ?? t.name) !== testId) continue;
        return { path, id: testId, name: t.name, line: stepLine(readFileSync(abs, 'utf8'), t.name) };
      }
    } catch {
      // a file that does not load cannot define it
    }
  }
  return undefined;
}
