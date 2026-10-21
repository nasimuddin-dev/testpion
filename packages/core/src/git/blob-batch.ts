import { runGit, runGitBytes } from './git.js';

/**
 * Many blobs through one git process each (review: performance, finding 1). `git show` and `git cat-file -s` cost a process
 * per file, about 90 ms each on Windows, so reading 300 changed files one by one took half a minute. `cat-file --batch-check`
 * says what every spec names (object id and size) in one process, and `cat-file --batch` hands over the blobs that are
 * wanted in another: two processes for any number of files.
 */

export interface GitBlobInfo {
  oid: string;
  size: number;
  type: string;
}

/** A spec git reads on one line of its batch input: a newline in a path cannot be said, so such a path is read the slow way. */
export const isBatchable = (spec: string): boolean => !/[\r\n]/.test(spec);

/** What each spec (`HEAD:path`, `:path`, an object id) names: its object id, type and size; a missing one is undefined. */
export async function gitBlobInfos(cwd: string, specs: readonly string[]): Promise<Map<string, GitBlobInfo | undefined>> {
  const out = new Map<string, GitBlobInfo | undefined>();
  const unique = [...new Set(specs)].filter(isBatchable);
  if (!unique.length) return out;
  // one answer line per input line, in the same order
  const lines = (await runGit(cwd, ['cat-file', '--batch-check'], { input: unique.join('\n') + '\n' })).split('\n');
  unique.forEach((spec, i) => {
    const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(lines[i] ?? '');
    out.set(spec, m ? { oid: m[1]!, type: m[2]!, size: Number(m[3]) } : undefined);
  });
  return out;
}

/** A batch holds at most this many bytes of blobs (git's output is held in memory: a huge library goes in several rounds). */
const ROUND_BYTES = 32 * 1024 * 1024;

/** The text of blobs by object id (UTF-8, as `git show` gives it). `sizes` says how big each is, to cut the work into rounds. */
export async function gitBlobTexts(cwd: string, oids: readonly string[], sizes: ReadonlyMap<string, number>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(oids)];
  let round: string[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!round.length) return;
    const wanted = round;
    round = [];
    bytes = 0;
    const buf = await runGitBytes(cwd, ['cat-file', '--batch'], { input: wanted.join('\n') + '\n' });
    let at = 0;
    for (const oid of wanted) {
      const eol = buf.indexOf(10, at);
      if (eol < 0) break;
      const m = /^[0-9a-f]+ \w+ (\d+)$/.exec(buf.toString('latin1', at, eol));
      if (!m) {
        at = eol + 1; // "<oid> missing"
        continue;
      }
      const size = Number(m[1]);
      out.set(oid, buf.toString('utf8', eol + 1, eol + 1 + size));
      at = eol + 1 + size + 1;
    }
  };
  for (const oid of unique) {
    const size = sizes.get(oid) ?? 0;
    if (size > ROUND_BYTES) continue; // too big to hold with the others (git show gave up on it too)
    if (round.length && bytes + size > ROUND_BYTES) await flush();
    round.push(oid);
    bytes += size;
  }
  await flush();
  return out;
}
