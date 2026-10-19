import { KIND_INFO, kindOfPath, type KindId } from '@testpion/shared';
import type { GitFile, SemanticChange } from '../views/GitView';

/**
 * The Git view lists what changed by the item's name, not by its file: "MCP server Weather: URL" rather than
 * `mcp-servers.json`. A file stays the unit of Stage and Discard (a commit takes files), so a changed file is one group:
 * a file with one named item is that item's row; a file with several is a header (its kind, or the collection's name)
 * with the items under it. The path is secondary text.
 */
export interface ChangeGroup {
  file: GitFile;
  /** The named changes in the file (a change that only repeats the path is not named). */
  items: SemanticChange[];
  /** The one item of a file that has exactly one: its row is the group's row. */
  single?: SemanticChange;
  /** What the group's row says when it is not a single item: "Collection Kinds API", "MCP servers". */
  label: string;
  /** The kind of the thing the file holds (for the icon). */
  kindId?: KindId;
}

const named = (c: SemanticChange, file: string) => c.title !== file;

export function groupChanges(files: readonly GitFile[], changes: readonly SemanticChange[]): ChangeGroup[] {
  const byFile = new Map<string, SemanticChange[]>();
  for (const c of changes) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  return files.map((file) => {
    const items = (byFile.get(file.path) ?? []).filter((c) => named(c, file.path));
    const at = kindOfPath(file.path, { raw: true })?.kind;
    const kindId = items.length === 1 ? (items[0]!.kindId ?? at) : (at ?? items[0]?.kindId);
    if (items.length === 1) return { file, items, single: items[0], label: items[0]!.title, kindId };
    const first = items.map((c) => c.title.split(' ▸ ')[0]!);
    const shared = first.length > 1 && first.every((x) => x === first[0]) ? first[0] : undefined;
    // a collection or a flow: its name; a list (MCP servers, prompts): the kind's plural
    const label = !items.length ? file.path : shared ? `${at && at !== 'test' ? KIND_INFO[at].label : 'Test file'} ${shared}` : at ? KIND_INFO[at].plural : file.path;
    return { file, items, label, kindId };
  });
}

/** The changes by item as Markdown (the down arrow of the Changes list): one line per item, grouped by nothing, no file paths. */
export function changesByItemMarkdown(changes: readonly SemanticChange[]): string {
  if (!changes.length) return '_No changes to the TestPion workspace._\n';
  const mark: Record<string, string> = { added: 'Added', removed: 'Removed', changed: 'Changed', renamed: 'Renamed', conflicted: 'Conflict' };
  return changes.map((c) => `- **${c.title}** (${mark[c.change] ?? c.change})${c.details.length ? `: ${c.details.join(', ')}` : ''}`).join('\n') + '\n';
}
