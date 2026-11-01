import { userInfo } from 'node:os';
import { toItemRef } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import { gitIdentity } from '../../git/git.js';
import { addComment, listComments, openComments, resolveComment } from '../../storage/comments.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { str, type Tool } from '../tool.js';

/** Comments for the team on an item (storage/comments.ts): what the Info panel and `testpion item comment` do, for an agent. */
export function commentTools({ store }: { store: WorkspaceStore }): Tool[] {
  const refOf = (v: unknown) => {
    const ref = toItemRef(v);
    if (!ref) throw new ApsError('ValidationError', 'ref is not an item reference (an ItemRef object, as list tools return them)');
    return ref;
  };
  const who = async () => (await gitIdentity(store.root).catch(() => ({ name: undefined }))).name || userInfo().username || 'agent';
  return [
    {
      name: 'team_comments',
      write: true,
      description:
        'Comments the team leaves on an item (a request, a test file, an evaluation, a monitor …), kept under comments/ and carried by git. `action` open: every open comment of the workspace, newest first, with its `ref`; list: the thread of `ref`; add: `text` on `ref`, signed with the git identity; resolve: comment `id` of `ref` settled.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'list', 'add', 'resolve'] },
          ref: { type: 'object', description: 'The item (list, add, resolve): an ItemRef' },
          text: str('The comment (add), at most 2000 characters'),
          id: str('The comment id (resolve)'),
        },
        required: ['action'],
      },
      run: async (a) => {
        const action = String(a.action);
        if (action === 'open') return openComments(store);
        const ref = refOf(a.ref);
        if (action === 'list') return listComments(store, ref);
        if (action === 'add') return addComment(store, ref, String(a.text ?? ''), await who());
        if (action === 'resolve') return resolveComment(store, ref, String(a.id ?? ''), await who());
        throw new ApsError('ValidationError', 'action is open, list, add or resolve');
      },
    },
  ];
}
