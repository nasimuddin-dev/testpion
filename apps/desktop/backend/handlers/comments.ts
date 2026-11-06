/** RPC handlers: comments for your team on an item (storage/comments.ts), signed with the git identity. */
import { userInfo } from 'node:os';
import { ApsError, mentionCandidates, addComment, deleteComment, editComment, sameAuthor, gitIdentity, listComments, openCommentCounts, openCommentsByOwner, resolveComment, restoreComment, toItemRef } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export function commentsHandlers(be: Backend): Handlers {
  let people: { root: string; at: number; list: Awaited<ReturnType<typeof mentionCandidates>> } | undefined;
  const refOf = (v: unknown) => {
    const ref = toItemRef(v);
    if (!ref) throw new ApsError('ValidationError', 'ref is not an item reference');
    return ref;
  };
  /** Who signs: the git identity's name, else this computer's user name. */
  /** The rows' marks and Home read the counts again. */
  const changed = <T,>(r: T): T => (be.host.emit('comments.changed', {}), r);
  const who = async () => (await gitIdentity(be.ws.root).catch(() => ({ name: undefined }))).name || userInfo().username || 'someone';
  return {
    // `mine`: written by this person (the git identity): its author can change it
    'comments.list': async ({ ref }: { ref: unknown }) => {
      const me = await who();
      return listComments(be.ws, refOf(ref)).map((c) => (sameAuthor(c.by, me) ? { ...c, mine: true } : c));
    },
    'comments.edit': async ({ ref, id, text }: { ref: unknown; id: string; text: string }) => changed(editComment(be.ws, refOf(ref), id, text, await who())),
    'comments.add': async ({ ref, text, replyTo }: { ref: unknown; text: string; replyTo?: string }) => changed(addComment(be.ws, refOf(ref), text, await who(), { replyTo })),
    'comments.resolve': async ({ ref, id, resolved }: { ref: unknown; id: string; resolved?: boolean }) => changed(resolveComment(be.ws, refOf(ref), id, await who(), resolved !== false)),
    // (with its replies: `removed` is what Undo puts back)
    'comments.delete': ({ ref, id }: { ref: unknown; id: string }) => changed({ deleted: id, removed: deleteComment(be.ws, refOf(ref), id) }),
    'comments.restore': ({ ref, comment }: { ref: unknown; comment: Parameters<typeof restoreComment>[2] }) => changed(restoreComment(be.ws, refOf(ref), comment)),
    /** Every open comment with its item's owners (CODEOWNERS); `owner` keeps one team's. */
    // `forYou` on the comments that @mention this person (the git identity); `forMe` keeps those only
    'comments.open': async ({ owner, forMe }: { owner?: string; forMe?: boolean } = {}) => {
      const id = await gitIdentity(be.ws.root).catch(() => ({ name: undefined, email: undefined }));
      // the teams this person said they are in (Settings ▸ Git): a comment that mentions one is for them too
      const all = await openCommentsByOwner(be.ws, owner, { name: id.name || userInfo().username, email: id.email, teams: be.settings.git?.teams });
      return forMe ? all.filter((c) => c.forYou) : all;
    },
    'comments.counts': () => openCommentCounts(be.ws),
    /** Who a comment can @mention: the people of the repository's history and the teams of CODEOWNERS. */
    // (read again at most once a minute per workspace: every item's comments ask when they open)
    'comments.people': async () => {
      const now = Date.now();
      if (people && people.root === be.ws.root && now - people.at < 60_000) return people.list;
      const list = await mentionCandidates(be.ws);
      people = { root: be.ws.root, at: now, list };
      return list;
    },
  };
}
