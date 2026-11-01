import type { Command } from 'commander';
import { userInfo } from 'node:os';
import { addComment, deleteComment, gitIdentity, listComments, openComments, parseItemRef, resolveComment, type ItemRef } from '@testpion/core';
import { EXIT, bold, dim, green, CliError, printJson, withWorkspace, WORKSPACE_OPTION, JSON_RESULT_OPTION } from '../shared.js';

/** An item by its reference text (`request:<collection>/<request>`, `test:tests/smoke.yaml`, a testpion:// link …). */
function refArg(text: string): ItemRef {
  const ref = parseItemRef(text);
  if (!ref) throw new CliError(`"${text}" is not an item reference. Examples: request:<collectionId>:<requestId>, test:tests/smoke.yaml, saved:evaluations:<id>, monitor:<id>.`, EXIT.CONFIG_ERROR);
  return ref;
}

/** A ref as a person reads it in a list: `request:payments:create-invoice`, `test:tests/smoke.yaml`. */
function refText(ref: ItemRef): string {
  const r = ref as unknown as Record<string, string | undefined>;
  const ids = Object.entries(r).filter(([k, v]) => k !== 'kind' && typeof v === 'string' && v).map(([, v]) => v);
  return [ref.kind, ...ids].join(':');
}

/** `testpion item comment …`: comments for your team on an item, kept in the workspace under comments/ (git carries them). Registered after `item`, whose group it joins. */
export function registerCommentCommand(program: Command): void {
  const item = program.commands.find((c) => c.name() === 'item') ?? program.command('item');
  const cmd = item.command('comment').description('comments for your team on an item (a request, a test file, an evaluation, a monitor …), kept in the workspace under comments/ so git carries them: list, add, resolve, delete; `open` lists every open comment of the workspace');
  const who = async (root: string) => (await gitIdentity(root).catch(() => ({ name: undefined }))).name || userInfo().username || 'someone';
  const line = (c: { by: string; at: string; text: string; resolvedAt?: string; id: string }) => `${c.resolvedAt ? green('✓ ') : ''}${bold(c.by)} ${dim(c.at.slice(0, 16).replace('T', ' '))} ${dim(c.id)}\n  ${c.text}`;

  cmd
    .command('list')
    .description('the comments on an item, oldest first')
    .argument('<item>', 'the item: request:<collectionId>:<requestId>, folder:<collectionId>:<folderId>, test:tests/x.yaml, flow:tests/x.flow.yaml, saved:<library>:<id>, monitor:<id>, spec:specs/x.yaml, or a testpion:// link')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action(async (item: string, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const comments = listComments(store, refArg(item));
        if (o.json) return printJson({ item, comments });
        if (!comments.length) return console.log(dim('No comments. Add one with `testpion item comment add <item> "text"`.'));
        for (const c of comments) console.log(line(c));
      }),
    );

  cmd
    .command('add')
    .description('add a comment, signed with your git identity (else this computer’s user name)')
    .argument('<item>', 'the item (see `item comment list`)')
    .argument('<text>', 'the comment; "-" reads it from standard input')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action(async (item: string, text: string, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store) => {
        const body = text === '-' ? await new Promise<string>((r) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => r(s)); }) : text;
        let c;
        try {
          c = addComment(store, refArg(item), body, await who(store.root));
        } catch (e) {
          throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
        }
        if (o.json) return printJson({ item, comment: c });
        console.log(`${green('Added')} ${dim(c.id)} by ${c.by}. Commit comments/ so your team sees it.`);
      }),
    );

  cmd
    .command('resolve')
    .description('mark a comment settled (--reopen undoes it)')
    .argument('<item>', 'the item')
    .argument('<id>', 'the comment id (from `item comment list`)')
    .option('--reopen', 'open it again')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action(async (item: string, id: string, o: { reopen?: boolean; workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, async (store) => {
        let c;
        try {
          c = resolveComment(store, refArg(item), id, await who(store.root), !o.reopen);
        } catch (e) {
          throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
        }
        if (o.json) return printJson({ item, comment: c });
        console.log(o.reopen ? `Reopened ${dim(id)}.` : `${green('Resolved')} ${dim(id)}.`);
      }),
    );

  cmd
    .command('delete')
    .description('remove a comment for good')
    .argument('<item>', 'the item')
    .argument('<id>', 'the comment id')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action(async (item: string, id: string, o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        try {
          deleteComment(store, refArg(item), id);
        } catch (e) {
          throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
        }
        if (o.json) return printJson({ item, deleted: id });
        console.log(`Deleted ${dim(id)}.`);
      }),
    );

  cmd
    .command('open')
    .description('every open comment of the workspace, newest first: what your team is still asking')
    .option(...WORKSPACE_OPTION)
    .option('--markdown', 'print a Markdown list (to post to a chat or a pull request)')
    .option(...JSON_RESULT_OPTION)
    .action(async (o: { workspace?: string; json?: boolean; markdown?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const open = openComments(store);
        if (o.json) return printJson({ open });
        if (o.markdown) return console.log(open.length ? ['**Open comments from the team**', ...open.map((c) => `- **${c.by}** on \`${refText(c.ref)}\` (${c.at.slice(0, 10)}): ${c.text.replace(/\s+/g, ' ')}`)].join('\n') : 'No open comments.');
        if (!open.length) return console.log(dim('No open comments.'));
        for (const c of open) console.log(`${bold(c.by)} ${dim(c.at.slice(0, 16).replace('T', ' '))} on ${refText(c.ref)}\n  ${c.text}`);
      }),
    );
}
