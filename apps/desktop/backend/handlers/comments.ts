/** RPC handlers: comments for your team on an item (storage/comments.ts), signed with the git identity. */
import { userInfo } from 'node:os';
import { ApsError, addComment, deleteComment, gitIdentity, listComments, openCommentCounts, openComments, resolveComment, restoreComment, toItemRef } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

export function commentsHandlers(be: Backend): Handlers {
  const refOf = (v: unknown) => {
    const ref = toItemRef(v);
    if (!ref) throw new ApsError('ValidationError', 'ref is not an item reference');
    return ref;
  };
  /** Who signs: the git identity's name, else this computer's user name. */
  const who = async () => (await gitIdentity(be.ws.root).catch(() => ({ name: undefined }))).name || userInfo().username || 'someone';
  return {
    'comments.list': ({ ref }: { ref: unknown }) => listComments(be.ws, refOf(ref)),
    'comments.add': async ({ ref, text }: { ref: unknown; text: string }) => addComment(be.ws, refOf(ref), text, await who()),
    'comments.resolve': async ({ ref, id, resolved }: { ref: unknown; id: string; resolved?: boolean }) => resolveComment(be.ws, refOf(ref), id, await who(), resolved !== false),
    'comments.delete': ({ ref, id }: { ref: unknown; id: string }) => (deleteComment(be.ws, refOf(ref), id), { deleted: id }),
    'comments.restore': ({ ref, comment }: { ref: unknown; comment: Parameters<typeof restoreComment>[2] }) => restoreComment(be.ws, refOf(ref), comment),
    'comments.open': () => openComments(be.ws),
    'comments.counts': () => openCommentCounts(be.ws),
  };
}
