import type { Command } from 'commander';
import { userInfo } from 'node:os';
import { WorkspaceManager, addComment, deleteComment, gitIdentity, itemInfo, listComments, openCommentsByOwner, ownershipOf, parseItemRef, resolveComment, resolveItemRef, tenantOf, type ItemRef, type WorkspaceStore } from '@testpion/core';
import { EXIT, bold, dim, green, CliError, printJson, withWorkspace, WORKSPACE_OPTION, JSON_RESULT_OPTION } from '../shared.js';

/** An item by its reference text (`request:<collection>/<request>`, `test:tests/smoke.yaml`, a testpion:// link …). */
function refArg(text: string): ItemRef {
  const ref = parseItemRef(text);
  if (!ref) throw new CliError(`"${text}" is not an item reference. Examples: request:<collectionId>:<requestId>, test:tests/smoke.yaml, saved:evaluations:<id>, monitor:<id>.`, EXIT.CONFIG_ERROR);
  return ref;
}

/** Comments and owners are kept in a workspace: without one (the scratch workspace a command gets outside any) there is nothing to read and nowhere to keep a comment. */
const inWorkspace = <T>(ref: string | undefined, fn: (store: WorkspaceStore) => T | Promise<T>): Promise<T> =>
  withWorkspace(ref, (store, ephemeral) => {
    if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
    return fn(store);
  });

/** The item a new comment is for: it has to be there (a comment on a mistyped ref would never be seen). */
function existingRef(store: WorkspaceStore, text: string): ItemRef {
  const ref = refArg(text);
  const r = resolveItemRef(store, ref);
  if (!r.ok) throw Object.assign(new CliError(`${r.message}: no comment was added.`, EXIT.CONFIG_ERROR), { hint: 'Refs look like request:<collectionId>:<requestId> or test:tests/smoke.yaml; `testpion collections --json` and `testpion requests <collection> --json` list the ids.' });
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
      inWorkspace(o.workspace, (store) => {
        const comments = listComments(store, refArg(item));
        if (o.json) return printJson({ item, comments });
        if (!comments.length) return console.log(dim('No comments. Add one with `testpion item comment add <item> "text"`.'));
        // a reply under the comment it answers
        const ids = new Set(comments.map((x) => x.id));
        for (const c of comments.filter((x) => !x.replyTo || !ids.has(x.replyTo))) {
          console.log(line(c));
          for (const r of comments.filter((x) => x.replyTo === c.id)) console.log(line(r).replace(/^/gm, '    '));
        }
      }),
    );

  cmd
    .command('add')
    .description('add a comment, signed with your git identity (else this computer’s user name)')
    .argument('<item>', 'the item (see `item comment list`)')
    .argument('<text>', 'the comment; "-" reads it from standard input')
    .option('--reply-to <id>', 'a reply to this comment (from `item comment list`): shown under it, settled with it')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action(async (item: string, text: string, o: { replyTo?: string; workspace?: string; json?: boolean }) =>
      inWorkspace(o.workspace, async (store) => {
        const ref = existingRef(store, item);
        const body = text === '-' ? await new Promise<string>((r) => { let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => r(s)); }) : text;
        let c;
        try {
          c = addComment(store, ref, body, await who(store.root), { replyTo: o.replyTo });
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
      inWorkspace(o.workspace, async (store) => {
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
      inWorkspace(o.workspace, (store) => {
        try {
          deleteComment(store, refArg(item), id); // (with its replies)
        } catch (e) {
          throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
        }
        if (o.json) return printJson({ item, deleted: id });
        console.log(`Deleted ${dim(id)}.`);
      }),
    );

  item
    .command('owners')
    .description("who owns an item in a workspace several teams share: the owners the repository's CODEOWNERS names for its file, and who last changed the file in git")
    .argument('<item>', 'the item (see `item comment list`)')
    .option(...WORKSPACE_OPTION)
    .option(...JSON_RESULT_OPTION)
    .action(async (ref: string, o: { workspace?: string; json?: boolean }) =>
      inWorkspace(o.workspace, async (store) => {
        const info = itemInfo(store, refArg(ref));
        if (!info.file) {
          if (o.json) return printJson({ item: ref, label: info.label, file: null, owners: [] });
          return console.log(dim(`${info.label} is not kept in a file of the workspace: nobody owns it in CODEOWNERS.`));
        }
        const own = await ownershipOf(store.root, info.file);
        const tenant = tenantOf(store, [{ ref: refArg(ref) }])[0];
        if (o.json) return printJson({ item: ref, label: info.label, ...own, ...(tenant ? { tenant } : {}) });
        console.log(`${bold(info.label)}  ${dim(own.file)}${tenant ? dim(`  tenant ${tenant}`) : ''}`);
        console.log(own.owners.length ? `Owned by ${own.owners.join(' ')} (CODEOWNERS)` : dim('No CODEOWNERS rule names its file.'));
        console.log(own.lastChange ? `Last changed by ${own.lastChange.author} on ${own.lastChange.date.slice(0, 10)}: ${own.lastChange.subject} (${own.lastChange.short})` : dim('Not committed yet.'));
      }),
    );

  cmd
    .command('open')
    .description('every open comment of the workspace, newest first: what your team is still asking')
    .option(...WORKSPACE_OPTION)
    .option('--markdown', 'print a Markdown list (to post to a chat or a pull request)')
    .option('--owner <team>', 'only the comments on items this team owns (as CODEOWNERS names it; the @ is optional)')
    .option('--for-me', 'only the comments that @mention you (your git name or e-mail) or a team you name with --team')
    .option('--team <team>', 'with --for-me: also the comments that @mention this team (repeatable; default: Settings ▸ Git ▸ Your teams)', (v: string, all: string[] = []) => [...all, v])
    .option(...JSON_RESULT_OPTION)
    .action(async (o: { workspace?: string; json?: boolean; markdown?: boolean; owner?: string; forMe?: boolean; team?: string[] }) =>
      inWorkspace(o.workspace, async (store) => {
        // who is asking: the git identity of the workspace's repository (the name its comments are signed with)
        const id = await gitIdentity(store.root).catch(() => ({ name: undefined, email: undefined }));
        // (your teams: --team, else Settings ▸ Git ▸ Your teams)
        const teams = o.team?.length ? o.team : new WorkspaceManager().loadSettings().git?.teams;
        const all = await openCommentsByOwner(store, o.owner, { name: id.name || userInfo().username, email: id.email, teams });
        const open = o.forMe ? all.filter((c) => c.forYou) : all;
        if (o.json) return printJson({ open });
        if (o.markdown) return console.log(open.length ? ['**Open comments from the team**', ...open.map((c) => `- **${c.by}** on \`${refText(c.ref)}\` (${c.at.slice(0, 10)}): ${c.text.replace(/\s+/g, ' ')}`)].join('\n') : 'No open comments.');
        if (!open.length) return console.log(dim(o.forMe ? 'No open comment mentions you.' : o.owner ? `No open comments on what ${o.owner} owns.` : 'No open comments.'));
        for (const c of open) console.log(`${bold(c.by)} ${dim(c.at.slice(0, 16).replace('T', ' '))} on ${refText(c.ref)}${c.owners.length ? dim(`  (${c.owners.join(' ')})`) : ''}\n  ${c.text}`);
      }),
    );
}
