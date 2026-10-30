/**
 * What your team changed lately, by meaning: the commits other people made to this workspace in the last days, each with the items it
 * changed in words ("Payments ▸ Create invoice: URL, headers"), newest first. It is the Home card "Your team's changes", `testpion git
 * activity` and the RPC `git.teamActivity`. It reads history only (log and the same item-by-item diff the Git view uses): nothing is written.
 */
import { runGit } from './git.js';
import { describeRevChanges, type SemanticChange } from './semantic.js';

/** git's empty tree: the "parent" of a first commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface TeamChange {
  change: SemanticChange['change'];
  /** "Payments ▸ Create invoice", "environment Staging". */
  title: string;
  /** "URL", "2 headers" … */
  details: string[];
  kind: SemanticChange['kind'];
  ref?: SemanticChange['ref'];
}

export interface TeamCommit {
  hash: string;
  short: string;
  author: string;
  date: string;
  subject: string;
  /** The first changes of the commit, by meaning (at most 6). */
  changes: TeamChange[];
  /** How many more changed beyond those listed. */
  more: number;
}

export interface TeamActivity {
  /** The git identity of this computer (user.email), whose commits are left out. */
  me?: string;
  days: number;
  commits: TeamCommit[];
  /** One sentence: "3 commits by 2 people in the last 14 days." */
  text: string;
}

const MAX_CHANGES = 6;

/** The commits others made to the workspace in the last `days` days (default 14), newest first, at most `limit` (default 8). */
export async function teamActivity(ws: string, o: { days?: number; limit?: number } = {}): Promise<TeamActivity> {
  const days = Math.min(Math.max(1, Math.floor(o.days ?? 14)), 365);
  const limit = Math.min(Math.max(1, Math.floor(o.limit ?? 8)), 50);
  const me = (await runGit(ws, ['config', '--get', 'user.email']).catch(() => '')).trim().toLowerCase() || undefined;
  let log = '';
  try {
    log = await runGit(ws, ['log', `--since=${days}.days.ago`, '--no-merges', `--max-count=${limit * 4}`, '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e', '--', '.']);
  } catch {
    // no commits yet, or not a repository
  }
  const rows = log
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, short, author, email, date, subject] = r.split('\x1f');
      return { hash: hash!, short: short!, author: author!, email: (email ?? '').toLowerCase(), date: date!, subject: subject ?? '' };
    })
    .filter((c) => !me || c.email !== me)
    .slice(0, limit);
  const commits: TeamCommit[] = [];
  for (const c of rows) {
    let changes: SemanticChange[] = [];
    try {
      const hasParent = (await runGit(ws, ['rev-parse', '--verify', '--quiet', `${c.hash}^`]).catch(() => '')).trim() !== '';
      changes = await describeRevChanges(ws, hasParent ? `${c.hash}^` : EMPTY_TREE, c.hash);
    } catch {
      // a commit whose diff cannot be read is still listed, without its changes
    }
    commits.push({
      hash: c.hash,
      short: c.short,
      author: c.author,
      date: c.date,
      subject: c.subject,
      changes: changes.slice(0, MAX_CHANGES).map((x) => ({ change: x.change, title: x.title, details: x.details, kind: x.kind, ...(x.ref ? { ref: x.ref } : {}) })),
      more: Math.max(0, changes.length - MAX_CHANGES),
    });
  }
  const people = new Set(commits.map((c) => c.author));
  const text = commits.length
    ? `${commits.length} commit${commits.length === 1 ? '' : 's'} by ${people.size} ${people.size === 1 ? 'person' : 'people'} in the last ${days} days.`
    : `Nobody else has changed this workspace in the last ${days} days.`;
  return { ...(me ? { me } : {}), days, commits, text };
}
