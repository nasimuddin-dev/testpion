import { readFileSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { BoundedMap } from '../util/collections.js';
import { walkTestFiles } from './suite-file.js';

/** The most files a scanner remembers (the answer for 20,000 test files is kept; the oldest go first beyond that). */
const SCANNED_FILES_MAX = 20_000;

/**
 * Finds something in every test file under a folder (a `webhook:` or `expose:` block) and remembers what each file said,
 * by its size and modification time: a second scan stats the files and reads only those that changed. It has no runner
 * imports, so the loader and the lint can use it.
 */
export class TestFileScanner<T> {
  private cache = new BoundedMap<string, { key: string; rel: string; value: T }>(SCANNED_FILES_MAX);

  /** `read` answers for one file's text, given its path inside the folder (forward slashes) and its absolute path. */
  constructor(private readonly read: (text: string, rel: string, abs: string) => T) {}

  /** What every test file under `dir` says, in path order. A file that cannot be read is left out. */
  *scan(dir: string, o: { suites?: boolean } = {}): Generator<{ abs: string; rel: string; value: T }> {
    for (const abs of walkTestFiles(dir, o)) {
      let key: string;
      try {
        const st = statSync(abs);
        key = `${st.size}:${st.mtimeMs}`;
      } catch {
        continue;
      }
      const rel = relative(dir, abs).split(sep).join('/');
      let hit = this.cache.get(abs);
      if (!hit || hit.key !== key || hit.rel !== rel) {
        let text: string;
        try {
          text = readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        hit = { key, rel, value: this.read(text, rel, abs) };
        this.cache.delete(abs);
        this.cache.set(abs, hit);
      }
      yield { abs, rel, value: hit.value };
    }
  }

  /** Forgets what the files said (tests, and a folder that was replaced). */
  clear(): void {
    this.cache.clear();
  }
}
