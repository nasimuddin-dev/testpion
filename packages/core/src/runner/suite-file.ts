import { readdirSync, type Dirent } from 'node:fs';
import { extname, join } from 'node:path';

export function isSuiteFile(p: string): boolean {
  return /\.suite\.(ya?ml|json)$/i.test(p);
}

/** The extensions of a test file or suite. */
export const TEST_EXT = new Set(['.yaml', '.yml', '.json']);

/** The entries of a folder worth walking, in name order (hidden entries and node_modules left out); none when it cannot be read. */
export function visibleEntries(entries: Dirent[]): Dirent[] {
  return entries.filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules').sort((a, b) => a.name.localeCompare(b.name));
}

/** Every test file (and suite, unless `suites: false`) under a folder, in path order. */
export function* walkTestFiles(dir: string, o: { suites?: boolean } = {}): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of visibleEntries(entries)) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkTestFiles(p, o);
    else if (TEST_EXT.has(extname(e.name).toLowerCase()) && (o.suites !== false || !isSuiteFile(e.name))) yield p;
  }
}
