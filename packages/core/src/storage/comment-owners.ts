/**
 * Open comments by team: several teams in one workspace read "Your team is asking" per team. Each open comment carries the
 * owners CODEOWNERS names for the file of the item it is on (none without the file), and one team's comments are those
 * whose owners include it. Home, `testpion item comment open --owner` and the RPC `comments.open` read them here.
 */
import { mentionsIn, mentionsPerson } from '@testpion/shared';
import { ownersOf, workspaceCodeowners } from '../git/owners.js';
import { toRepoPath } from '../git/git.js';
import { sameOwner } from './attention.js';
import { openComments, type OpenComment } from './comments.js';
import { itemInfo } from './item-info.js';
import type { WorkspaceStore } from './workspace.js';

export interface OwnedComment extends OpenComment {
  /** The teams of the item's file (CODEOWNERS); empty when no rule names it or there is no file. */
  owners: string[];
  /** The people and teams the comment @mentions (`@Ana`, `@org/payments`). */
  mentions: string[];
  /** It @mentions the person asking (their git name or e-mail), or a team they named. */
  forYou?: boolean;
}

/** Every open comment with its item's owners, newest first; with `owner`, one team's only. */
export async function openCommentsByOwner(store: WorkspaceStore, owner?: string, me?: { name?: string; email?: string; teams?: string[] }): Promise<OwnedComment[]> {
  const open = openComments(store);
  const co = await workspaceCodeowners(store.root).catch(() => undefined);
  const out = open.map((c): OwnedComment => {
    let file: string | undefined;
    try {
      file = itemInfo(store, c.ref).file;
    } catch {
      file = undefined;
    }
    const mentions = mentionsIn(c.text);
    const forYou = !!me && (mentionsPerson(mentions, me) || mentions.some((m) => me.teams?.some((t) => sameOwner(t, m))));
    return { ...c, owners: co && file ? ownersOf(co.rules, toRepoPath(co.repo, store.root, file)) : [], mentions, ...(forYou ? { forYou } : {}) };
  });
  return owner?.trim() ? out.filter((c) => c.owners.some((o) => sameOwner(o, owner))) : out;
}
