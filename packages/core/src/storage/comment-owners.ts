/**
 * Open comments by team: several teams in one workspace read "Your team is asking" per team. Each open comment carries the
 * owners CODEOWNERS names for the file of the item it is on (none without the file), and one team's comments are those
 * whose owners include it. Home, `testpion item comment open --owner` and the RPC `comments.open` read them here.
 */
import { mentionsIn, mentionsPerson } from '@testpion/shared';
import { ownersOf, workspaceCodeowners } from '../git/owners.js';
import { gitLog, toRepoPath } from '../git/git.js';
import { sameOwner } from './attention.js';
import { openComments, sameAuthor, type OpenComment } from './comments.js';
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

/** Someone a comment can @mention: a person of the repository's history, or a team of CODEOWNERS. */
export interface MentionCandidate {
  /** What to write after the @ (`AnaLee`, `org/payments`). */
  handle: string;
  /** How to show it (`Ana Lee`, `@org/payments`). */
  label: string;
  kind: 'person' | 'team';
}

/**
 * Who a comment can mention: the authors of the workspace's last commits (most recent first) and the teams CODEOWNERS
 * names. Nothing without git. The comment box suggests them as an @word is typed.
 */
export async function mentionCandidates(store: Pick<WorkspaceStore, 'root'>): Promise<MentionCandidate[]> {
  const out: MentionCandidate[] = [];
  const seen = new Set<string>();
  const add = (c: MentionCandidate) => {
    const k = c.handle.toLowerCase();
    if (c.handle && !seen.has(k)) (seen.add(k), out.push(c));
  };
  for (const c of await gitLog(store.root, { limit: 300 }).catch(() => [])) if (c.author?.trim()) add({ handle: c.author.replace(/\s+/g, ''), label: c.author.trim(), kind: 'person' });
  const co = await workspaceCodeowners(store.root).catch(() => undefined);
  for (const r of co?.rules ?? []) for (const o of r.owners) if (o.startsWith('@')) add({ handle: o.slice(1), label: o, kind: 'team' });
  return out;
}

/** Every open comment with its item's owners, newest first; with `owner`, one team's only. */
export async function openCommentsByOwner(store: WorkspaceStore, owner?: string, me?: { name?: string; email?: string; teams?: string[] }): Promise<OwnedComment[]> {
  const open = openComments(store);
  const co = await workspaceCodeowners(store.root).catch(() => undefined);
  // a reply to a comment this person wrote is for them too (its comment is open while the reply is, so it is here)
  const byId = new Map(open.map((c) => [c.id, c]));
  const same = sameAuthor;
  const answersMe = (c: (typeof open)[number]) => !!me && !!c.replyTo && same(byId.get(c.replyTo)?.by, me.name) && !same(c.by, me.name);
  const out = open.map((c): OwnedComment => {
    let file: string | undefined;
    try {
      file = itemInfo(store, c.ref).file;
    } catch {
      file = undefined;
    }
    const mentions = mentionsIn(c.text);
    const forYou = !!me && (mentionsPerson(mentions, me) || mentions.some((m) => me.teams?.some((t) => sameOwner(t, m))) || answersMe(c));
    return { ...c, owners: co && file ? ownersOf(co.rules, toRepoPath(co.repo, store.root, file)) : [], mentions, ...(forYou ? { forYou } : {}) };
  });
  return owner?.trim() ? out.filter((c) => c.owners.some((o) => sameOwner(o, owner))) : out;
}
