import { userInfo } from 'node:os';
import { toItemRef } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import { gitIdentity } from '../../git/git.js';
import { addComment, listComments, resolveComment } from '../../storage/comments.js';
import { resolveItemRef } from '../../storage/item-refs.js';
import { openCommentsByOwner } from '../../storage/comment-owners.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';

/**
 * Comments for the team on an item (storage/comments.ts): what the Info panel and `testpion item comment` do, for an agent.
 * A read-only server keeps the tool for reading (`open`, `list`) and lists it as one that changes nothing.
 */
export function commentTools({ store, readOnly }: { store: WorkspaceStore; readOnly?: boolean }): Tool[] {
  const refOf = (v: unknown) => {
    const ref = toItemRef(v);
    if (!ref) throw new ApsError('ValidationError', 'ref is not an item reference (an ItemRef object, as list tools return them)');
    return ref;
  };
  // a new comment is for an item that is there: one on a mistyped ref would never be seen
  const existing = (v: unknown) => {
    const r = resolveItemRef(store, refOf(v));
    if (!r.ok) throw new ApsError('ValidationError', `${r.message}: no comment was added`, { suggestions: ['Pass the `ref` a list tool or `resolve_ref` returned for the item.'] });
    return r.ref;
  };
  const who = async () => (await gitIdentity(store.root).catch(() => ({ name: undefined }))).name || userInfo().username || 'agent';
  return [
    {
      name: 'team_comments',
      write: !readOnly,
      description: `Comments the team leaves on an item (a request, a test file, an evaluation, a monitor …), kept under comments/ and carried by git. \`action\` open: every open comment of the workspace, newest first, with its \`ref\`; list: the thread of \`ref\`${readOnly ? '.' : '; add: `text` on `ref`, signed with the git identity (with \`id\`: a reply to that comment); resolve: comment `id` of `ref` settled.'}`,
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: readOnly ? ['open', 'list'] : ['open', 'list', 'add', 'resolve'] },
          ref: { type: 'object', description: 'An ItemRef' },
          owner: str('open: only what this CODEOWNERS owner owns'),
          ...(readOnly ? {} : { text: str('At most 2000 characters'), id: str('Comment id') }),
        },
        required: ['action'],
      },
      ...(readOnly
        ? {
            doc: {
              when: 'Use it to read what the team still asks about an item (`open`), or one thread (`list`).',
              whenNot: 'This server is read-only: it cannot add or resolve a comment. For the workspace note or secrets to fill in, use `what_needs_attention`.',
              example: { action: 'open' },
              narrow: 'Use `list` with one `ref` instead of `open`.',
            },
          }
        : {}),
      run: async (a) => {
        const action = String(a.action);
        if (action === 'open') return openCommentsByOwner(store, typeof a.owner === 'string' ? a.owner : undefined);
        if (action === 'list') return listComments(store, refOf(a.ref));
        if (readOnly && (action === 'add' || action === 'resolve')) throw new ApsError('ValidationError', 'This server is read-only: it cannot add or resolve a comment');
        if (action === 'add') return addComment(store, existing(a.ref), String(a.text ?? ''), await who(), { replyTo: typeof a.id === 'string' && a.id ? a.id : undefined });
        if (action === 'resolve') return resolveComment(store, refOf(a.ref), String(a.id ?? ''), await who());
        throw new ApsError('ValidationError', `action is ${readOnly ? 'open or list' : 'open, list, add or resolve'}`);
      },
    },
  ];
}
