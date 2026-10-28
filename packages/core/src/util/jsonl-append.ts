import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { BoundedMap } from './collections.js';

/** Lines each bounded file is known to hold (this process's appends only; the first append to a file counts it once). */
const known = new BoundedMap<string, number>(256);

/**
 * A file whose last line was cut short (a crash mid-write, no trailing newline) would glue the next record onto the fragment: one
 * invalid line, and the new record lost with it. Ends the fragment with a newline first (a reader skips the fragment on its own).
 */
export function endWithNewline(file: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] !== 10) appendFileSync(file, '\n');
  } catch {
    /* no file yet: nothing to repair */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Appends one line to a JSON-lines file that keeps its newest `keep` records: the file is compacted (`rewrite` gets the newest
 * `keep` lines, joined) when it holds more than twice that. The lines are counted once per file and process, not read and split
 * after every append (a record cost a read of the whole file).
 */
export function appendBoundedLine(file: string, line: string, keep: number, rewrite: (file: string, text: string) => void): void {
  mkdirSync(dirname(file), { recursive: true });
  if (!known.has(file)) endWithNewline(file); // the first append of this process: the file may end in a torn line
  appendFileSync(file, line + '\n');
  let n = known.get(file);
  if (n === undefined) {
    n = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim()).length;
  } else n++;
  if (n > keep * 2) {
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    if (lines.length > keep * 2) {
      rewrite(file, lines.slice(-keep).join('\n') + '\n');
      n = keep;
    } else n = lines.length;
  }
  known.set(file, n);
}
