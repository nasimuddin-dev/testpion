import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BoundedMap } from './collections.js';

/** Lines each bounded file is known to hold (this process's appends only; the first append to a file counts it once). */
const known = new BoundedMap<string, number>(256);

/**
 * Appends one line to a JSON-lines file that keeps its newest `keep` records: the file is compacted (`rewrite` gets the newest
 * `keep` lines, joined) when it holds more than twice that. The lines are counted once per file and process, not read and split
 * after every append (a record cost a read of the whole file).
 */
export function appendBoundedLine(file: string, line: string, keep: number, rewrite: (file: string, text: string) => void): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, line + '\n');
  let n = known.get(file);
  if (n === undefined) {
    n = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  } else n++;
  if (n > keep * 2) {
    const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length > keep * 2) {
      rewrite(file, lines.slice(-keep).join('\n') + '\n');
      n = keep;
    } else n = lines.length;
  }
  known.set(file, n);
}
