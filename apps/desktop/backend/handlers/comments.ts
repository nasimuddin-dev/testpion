/** RPC handlers: comments for your team on an item (storage/comments.ts), signed with the git identity. */
import { userInfo } from 'node:os';
import { ApsError, mentionCandidates, addComment, deleteComment, gitIdentity, listComments, openCommentCounts, openCommentsByOwner, resolveComment, restoreComment, toItemRef } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export function commentsHandlers(be: Backend): Handlers {
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
    'comments.list': ({ ref }: { ref: unknown }) => listComments(be.ws, refOf(ref)),
    'comments.add': async ({ ref, text }: { ref: unknown; text: string }) => changed(addComment(be.ws, refOf(ref), text, await who())),
    'comments.resolve': async ({ ref, id, resolved }: { ref: unknown; id: string; resolved?: boolean }) => changed(resolveComment(be.ws, refOf(ref), id, await who(), resolved !== false)),
    'comments.delete': ({ ref, id }: { ref: unknown; id: string }) => (deleteComment(be.ws, refOf(ref), id), changed({ deleted: id })),
    'comments.restore': ({ ref, comment }: { ref: unknown; comment: Parameters<typeof restoreComment>[2] }) => changed(restoreComment(be.ws, refOf(ref), comment)),
    /** Every open comment with its item's owners (CODEOWNERS); `owner` keeps one team's. */
    // `forYou` on the comments that @mention this person (the git identity); `forMe` keeps those only
    'comments.open': async ({ owner, forMe }: { owner?: string; forMe?: boolean } = {}) => {
      const id = await gitIdentity(be.ws.root).catch(() => ({ name: undefined, email: undefined }));
      const all = await openCommentsByOwner(be.ws, owner, { name: id.name || userInfo().username, email: id.email });
      return forMe ? all.filter((c) => c.forYou) : all;
    },
    'comments.counts': () => openCommentCounts(be.ws),
    /** Who a comment can @mention: the people of the repository's history and the teams of CODEOWNERS. */
    'comments.people': () => mentionCandidates(be.ws),
  };
}
