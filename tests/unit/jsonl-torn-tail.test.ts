import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendBoundedLine, endWithNewline } from '../../packages/core/src/util/jsonl-append.js';
import { tempDir } from '../helpers.js';

// A torn last line (a crash mid-write) must not swallow the next record (review 2026-10-27, robustness 3.x).
const tmp = tempDir('tp-torn-');
afterAll(() => tmp.cleanup());
const records = (f: string) =>
  readFileSync(f, 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l)] : [];
      } catch {
        return [];
      }
    });

describe('torn tail of a JSON-lines file', () => {
  it('the first append after a torn line starts a new line: both the earlier record and the new one parse', () => {
    const f = join(tmp.dir, 'a.jsonl');
    writeFileSync(f, '{"a":1}\n{"b":');
    appendBoundedLine(f, '{"c":3}', 100, (file, text) => writeFileSync(file, text));
    expect(records(f)).toEqual([{ a: 1 }, { c: 3 }]);
  });

  it('a clean file and an empty or missing file are left alone', () => {
    const f = join(tmp.dir, 'b.jsonl');
    endWithNewline(f); // missing
    writeFileSync(f, '');
    endWithNewline(f);
    expect(readFileSync(f, 'utf8')).toBe('');
    writeFileSync(f, '{"a":1}\n');
    endWithNewline(f);
    expect(readFileSync(f, 'utf8')).toBe('{"a":1}\n');
  });
});
