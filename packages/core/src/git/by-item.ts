import { KIND_INFO, KIND_IDS, itemRefUrl, kindByName, type ItemRef, type KindId } from '@testpion/shared';
import { ApsError } from '../errors.js';
import { gitStatus, type GitFile } from './git.js';
import { describeGitChanges, type SemanticChange } from './semantic.js';

/**
 * The workspace's uncommitted changes by item (planning/git-everything.md §4c, release A): one row per changed thing,
 * named the way the app names it ("MCP server Weather"), with its registry kind, what changed, its ItemRef and link, and
 * the file it is in (secondary: the file is what a commit takes). The same rows as the Git view; `testpion git status
 * --by-item --json` and the MCP tool `git_changes` return this.
 */
export interface GitItemRow {
  /** The registry kind of the item (`mcp-server`, `prompt`, `request`, `dataset` …); undefined for a file of no kind. */
  kind?: KindId;
  change: SemanticChange['change'];
  /** The item's name with its kind: "MCP server Weather", "Dataset users.csv", "Kinds API ▸ Pets ▸ List pets". */
  title: string;
  /** What changed, in words: "URL", "12 rows added", "headers (added X-Team)". Secret values are never in them. */
  details: string[];
  ref: ItemRef;
  /** The testpion://open link of the ref. */
  link: string;
  /** The file the item is in, and whether that file is staged. */
  file: string;
  staged: boolean;
}

export interface GitItemsResult {
  repository: boolean;
  branch?: string;
  ahead: number;
  behind: number;
  conflicted: boolean;
  items: GitItemRow[];
}

/** The kinds a `--kind` / `kind` filter names (ids or aliases); an unknown name is an error that lists the valid ones. */
export function gitKindFilter(names: readonly string[] | undefined): Set<KindId> | undefined {
  if (!names?.length) return undefined;
  const out = new Set<KindId>();
  for (const name of names) {
    const k = kindByName(name);
    if (!k) throw new ApsError('ValidationError', `Unknown kind "${name}"`, { suggestions: [`Use one of: ${KIND_IDS.filter((id) => KIND_INFO[id].capabilities.versioned === true).join(', ')}.`] });
    out.add(k.id);
    // a collection holds requests and folders: asking for the collection asks for what is in it
    if (k.id === 'collection') ['request', 'folder'].forEach((x) => out.add(x as KindId));
  }
  return out;
}

export async function gitChangesByItem(ws: string, opts: { kinds?: readonly string[] } = {}): Promise<GitItemsResult> {
  const filter = gitKindFilter(opts.kinds);
  const st = await gitStatus(ws);
  if (!st.repository) return { repository: false, ahead: 0, behind: 0, conflicted: false, items: [] };
  const files = new Map<string, GitFile>(st.files.map((f) => [f.path, f]));
  const changes = await describeGitChanges(ws, st.files);
  const items: GitItemRow[] = changes
    .filter((c) => !filter || (c.kindId && filter.has(c.kindId)))
    .map((c) => {
      const ref = c.ref ?? { kind: 'git-file' as const, path: c.file };
      return { kind: c.kindId, change: c.change, title: c.title, details: c.details, ref, link: itemRefUrl(ref), file: c.file, staged: !!files.get(c.file)?.staged };
    });
  return { repository: true, branch: st.branch, ahead: st.ahead, behind: st.behind, conflicted: st.conflicted, items };
}
