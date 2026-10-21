/**
 * `testpion git history|blame|restore|discard-item|stage-item|unstage-item|undo|stash` and the staged-content secret
 * check (release B of planning/git-everything.md): the same operations the app's Git view has, per item. The work is in
 * core (git/item-ops.ts, journal.ts, stash.ts, staged-secrets.ts); this module only reads the arguments and prints.
 */
import { Command } from 'commander';
import {
  discardItem,
  gitCommit,
  gitStage,
  gitStatus,
  gitUnstage,
  itemBlame,
  itemHistory,
  listJournal,
  requireRepo,
  resolveItemTarget,
  restoreItemVersion,
  scanStagedSecrets,
  commitVerdict,
  stageItem,
  stashApply,
  stashDrop,
  stashList,
  stashPush,
  stashShow,
  undoJournal,
  type ItemWriteResult,
  type PartChange,
  type SemanticChange,
  type StagedScan,
  type StagedSecret,
  type WorkspaceStore,
} from '@testpion/core';
import { EXIT, bold, dim, green, red, yellow, CliError, printJson, withWorkspace, JSON_OPTION } from '../shared.js';

const MARK: Record<string, string> = { added: 'A', untracked: 'A', removed: 'D', deleted: 'D', changed: 'M', modified: 'M', renamed: 'R', conflicted: '!' };
const out = (json: boolean, value: unknown, text: () => void) => (json ? printJson(value) : text());
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');
/** A value on one line, cut: parts can hold whole bodies. */
const short = (v: string | undefined, n = 60) => {
  if (v === undefined) return dim('(none)');
  const one = v.replace(/\s+/g, ' ').trim();
  return JSON.stringify(one.length > n ? `${one.slice(0, n - 1)}…` : one);
};
const partLine = (p: PartChange) => `    ${p.part}: ${short(p.before)} → ${short(p.after)}`;
const changeLine = (c: SemanticChange) => `  ${MARK[c.change] ?? '?'} ${c.title}${c.details.length ? dim(`  ${c.details.join(', ')}`) : ''}`;

/** `1` is the stash at that position; anything else is a hash (or a start of one). */
const stashRef = (r: string | undefined): { index?: number; hash?: string } => (r === undefined ? {} : /^\d{1,3}$/.test(r) ? { index: Number(r) } : { hash: r });

const printWrite = (r: ItemWriteResult, verbDone: string, verbWould: string) => {
  if (!r.changed) return console.log(dim(`${r.title}: nothing to change.`));
  console.log(`${r.applied ? green(verbDone) : yellow(verbWould)} ${bold(r.title)} ${dim(`(${r.action.replace('-', ' ')} in ${r.file})`)}`);
  for (const p of r.parts) console.log(partLine(p));
  if (r.applied && r.undoId) console.log(dim(`Undo with:  testpion git undo ${r.undoId}`));
  if (!r.applied) console.log(dim('Nothing was written (--dry-run).'));
};

/** Settle what a commit would publish: the findings of the staged scan, in words. */
function printStagedScan(scan: StagedScan) {
  const line = (f: StagedSecret) => `  ${f.item} ${dim(`(${f.file})`)}\n    ${f.message}`;
  if (scan.blocking.length) {
    console.log(red(`${scan.blocking.length} secret${scan.blocking.length === 1 ? '' : 's'} typed in (a commit is refused, --allow-secrets does not change that):`));
    for (const f of scan.blocking) console.log(line(f));
  }
  if (scan.confirm.length) {
    console.log(yellow(`${scan.confirm.length} probable secret${scan.confirm.length === 1 ? '' : 's'} (a commit needs --allow-secrets):`));
    for (const f of scan.confirm) console.log(line(f));
  }
  if (scan.allowed.length) console.log(dim(`${scan.allowed.length} value${scan.allowed.length === 1 ? ' is' : 's are'} allowed by .testpion/secrets-allow.json: ${scan.allowed.map((f) => `${f.item} ${f.field}`).join(', ')}`));
  if (scan.allowProblem) console.log(red(scan.allowProblem));
  for (const l of scan.large) console.log(l.level === 'refuse' ? red(`${l.file} is ${(l.bytes / 1048576).toFixed(0)} MB: a commit is refused (GitHub rejects 100 MB). Track it:  testpion git large --track ${l.file} --lfs   or   --reference`) : l.level === 'lfs' ? yellow(`${l.file} is ${(l.bytes / 1048576).toFixed(0)} MB: track it with Git LFS or by reference:  testpion git large --track ${l.file} --lfs   or   --reference`) : dim(`${l.file} is ${(l.bytes / 1048576).toFixed(1)} MB`));
  if (!scan.blocking.length && !scan.confirm.length) console.log(green(scan.staged.length ? 'No secrets in the staged files: safe to commit.' : 'Nothing is staged.'));
  if (scan.skipped.length) console.log(dim(`Not read (binary or very big): ${scan.skipped.join(', ')}`));
}

/** `testpion git check --staged`: the scan of the index. Exit 1 on any finding. */
export async function checkStaged(store: WorkspaceStore, json: boolean): Promise<void> {
  const scan = await scanStagedSecrets(store.root);
  out(json, scan, () => printStagedScan(scan));
  if (scan.blocking.length || scan.confirm.length || scan.large.some((l) => l.level === 'refuse')) process.exitCode = EXIT.TEST_FAILURE;
}

/**
 * `testpion git commit`: stage (unless --staged), scan what is staged, refuse on a high-confidence secret (never
 * overridden), ask for --allow-secrets on a probable one. A refused commit puts the index back as it was.
 */
export async function commitScanned(store: WorkspaceStore, o: { message: string; staged?: boolean; allowSecrets?: boolean; amend?: boolean; json?: boolean }): Promise<void> {
  const ws = store.root;
  await requireRepo(ws);
  const before = new Set((await gitStatus(ws)).files.filter((f) => f.staged).map((f) => f.path));
  if (!o.staged) await gitStage(ws, ['.']);
  const scan = await scanStagedSecrets(ws);
  const verdict = commitVerdict(scan, !!o.allowSecrets);
  if (!verdict.allowed) {
    // staged only for the scan: put the index back
    if (!o.staged) {
      const now = (await gitStatus(ws)).files.filter((f) => f.staged && !before.has(f.path)).map((f) => f.path);
      if (now.length) await gitUnstage(ws, now);
    }
    out(!!o.json, { committed: false, reason: verdict.reason, secrets: [...scan.blocking, ...scan.confirm] }, () => {
      console.log(red(verdict.reason === 'blocked' ? 'Not committed: a secret is typed in.' : verdict.reason === 'too-big' ? 'Not committed: a staged file is over 100 MB (the host would reject the push).' : 'Not committed: probable secrets need a yes.'));
      printStagedScan(scan);
    });
    process.exitCode = EXIT.TEST_FAILURE;
    return;
  }
  const commit = await gitCommit(ws, o.message, { amend: !!o.amend });
  out(!!o.json, { committed: true, commit }, () => console.log(green(`Committed ${commit.short} ${commit.subject}`)));
}

export function registerGitItemCommands(git: Command): void {
  const wsOpt = (c: Command) => c.option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)').option(...JSON_OPTION);
  const ITEM = 'the item: a link from the app (testpion://…), kind:id such as mcp-server:weather or environment:staging, or a file with the item id, mcp-servers.json#weather';
  const dry = (c: Command) => c.option('--dry-run', 'change nothing: print what would change');

  wsOpt(git.command('history').description('the versions of one item in git, newest first, with what each one changed').argument('<item>', ITEM).option('-n, --limit <n>', 'how many versions', '30')).action((item: string, o) =>
    withWorkspace(o.workspace, async (s) => {
      const h = await itemHistory(s.root, resolveItemTarget(s, item), Math.max(1, Number(o.limit) || 30));
      out(o.json, h, () => {
        console.log(bold(h.title) + dim(`  ${h.file}${h.itemId ? `#${h.itemId}` : ''}`));
        if (!h.versions.length) console.log(dim('No committed versions yet.'));
        for (const v of h.versions) console.log(`${yellow(v.commit.short)} ${v.commit.subject} ${dim(`${v.commit.author}, ${when(v.commit.date)}`)}\n    ${v.changed.join(', ')}`);
      });
    }),
  );

  wsOpt(git.command('blame').description('who last changed each field of one item, and when').argument('<item>', ITEM).option('-n, --limit <n>', 'how many versions to look through', '200')).action((item: string, o) =>
    withWorkspace(o.workspace, async (s) => {
      const b = await itemBlame(s.root, resolveItemTarget(s, item), Math.max(1, Number(o.limit) || 200));
      out(o.json, b, () => {
        console.log(bold(b.title) + dim(`  ${b.file}${b.itemId ? `#${b.itemId}` : ''}`));
        for (const f of b.fields)
          console.log(`  ${f.field.padEnd(16)} ${f.commit ? `${yellow(f.commit.short)} ${f.commit.author}, ${when(f.commit.date)}` : yellow('not committed yet')}  ${dim(short(f.value, 50))}`);
      });
    }),
  );

  dry(
    wsOpt(git.command('restore').description('write an older version of just this item back (the rest of its file stays); the change is left for you to commit').argument('<item>', ITEM).requiredOption('--rev <commit>', 'the commit whose version to put back (see git history)')),
  ).action((item: string, o) =>
    withWorkspace(o.workspace, async (s) => {
      const r = await restoreItemVersion(s.root, resolveItemTarget(s, item), String(o.rev), { dryRun: !!o.dryRun });
      out(o.json, r, () => printWrite(r, 'Restored', 'Would restore'));
    }),
  );

  dry(wsOpt(git.command('discard-item').description('throw away the uncommitted change of one item only (the rest of its file keeps its changes)').argument('<item>', ITEM))).action((item: string, o) =>
    withWorkspace(o.workspace, async (s) => {
      const r = await discardItem(s.root, resolveItemTarget(s, item), { dryRun: !!o.dryRun });
      out(o.json, r, () => printWrite(r, 'Discarded changes to', 'Would discard changes to'));
    }),
  );

  for (const unstage of [false, true]) {
    dry(
      wsOpt(
        git
          .command(unstage ? 'unstage-item' : 'stage-item')
          .description(`${unstage ? 'unstage' : 'stage'} the file an item is in (a file with several items goes as one file: the others that come along are named)`)
          .argument('<item>', ITEM),
      ),
    ).action((item: string, o) =>
      withWorkspace(o.workspace, async (s) => {
        const r = await stageItem(s.root, resolveItemTarget(s, item), { unstage, dryRun: !!o.dryRun });
        out(o.json, r, () => console.log(r.applied ? green(r.message) : r.message));
      }),
    );
  }

  wsOpt(git.command('undo').description('undo the last restore or discard (or the one with this id); --list shows what can be undone').argument('[id]', 'an id from --list (default: the newest)').option('--list', 'list the undoable operations')).action((id: string | undefined, o) =>
    withWorkspace(o.workspace, async (s) => {
      if (o.list) {
        const list = listJournal(s.root);
        return out(o.json, list, () => {
          if (!list.length) console.log(dim('Nothing to undo.'));
          for (const e of list) console.log(`${yellow(e.id)} ${e.title} ${dim(`${when(e.at)}, ${e.files.map((f) => f.file).join(', ')}`)}`);
        });
      }
      const e = undoJournal(s.root, id);
      out(o.json, e, () => console.log(green(`Undone: ${e.title}`)));
    }),
  );

  const stash = git.command('stash').description('set the workspace\'s uncommitted changes aside under a name, and put them back: push, list, show, apply, pop, drop');
  const ref = (c: Command) => c.argument('[stash]', 'its number in `stash list` (0 = newest) or its hash (default: the newest)');
  dry(wsOpt(stash.command('push').description('set every uncommitted change aside under a name; the workspace goes back to the last commit').requiredOption('-m, --message <name>', 'a name, e.g. "Before the pagination rewrite"'))).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      const r = await stashPush(s.root, String(o.message), { dryRun: !!o.dryRun });
      out(o.json, r, () => {
        console.log(`${r.applied ? green('Set aside') : yellow('Would set aside')} ${bold(r.name)} ${dim(`(${r.changes.length} change${r.changes.length === 1 ? '' : 's'})`)}`);
        for (const c of r.changes) console.log(changeLine(c));
        if (!r.applied) console.log(dim('Nothing was changed (--dry-run).'));
      });
    }),
  );
  wsOpt(stash.command('list').description('the stashes, newest first')).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      const list = await stashList(s.root);
      out(o.json, list, () => {
        if (!list.length) console.log(dim('No stashes.'));
        for (const e of list) console.log(`${yellow(String(e.index))}  ${e.name} ${dim(`${e.branch ? `on ${e.branch}, ` : ''}${when(e.date)}${e.ours ? '' : ', made outside TestPion'}  ${e.hash.slice(0, 7)}`)}`);
      });
    }),
  );
  ref(wsOpt(stash.command('show').description('what a stash holds, by item')))
    .action((r: string | undefined, o) =>
      withWorkspace(o.workspace, async (s) => {
        const d = await stashShow(s.root, stashRef(r));
        out(o.json, d, () => {
          console.log(bold(d.stash.name) + dim(`  ${when(d.stash.date)}`));
          for (const c of d.changes) console.log(changeLine(c));
          for (const f of d.newFiles) console.log(`  A ${f}`);
          if (!d.changes.length && !d.newFiles.length) console.log(dim('Nothing in it.'));
        });
      }),
    );
  for (const pop of [false, true]) {
    ref(wsOpt(stash.command(pop ? 'pop' : 'apply').description(pop ? 'put a stash back and remove it from the list' : 'put a stash back (it stays in the list)')))
      .action((r: string | undefined, o) =>
        withWorkspace(o.workspace, async (s) => {
          const res = await stashApply(s.root, stashRef(r), { pop });
          out(o.json, res, () => console.log(res.conflicted ? red(res.message) : green(res.message)));
          if (res.conflicted) process.exitCode = EXIT.TEST_FAILURE;
        }),
      );
  }
  ref(wsOpt(stash.command('drop').description('remove a stash for good')))
    .action((r: string | undefined, o) =>
      withWorkspace(o.workspace, async (s) => {
        const e = await stashDrop(s.root, stashRef(r));
        out(o.json, { dropped: e }, () => console.log(green(`Dropped "${e.name}"`)));
      }),
    );
}

/** The value of one `--pick` / `--edit` argument: `key=value`. */
export function splitKeyValue(kv: string, flag: string): [string, string] {
  const i = kv.indexOf('=');
  if (i <= 0) throw new CliError(`${flag} expects key=value, got "${kv}"`, EXIT.CONFIG_ERROR);
  return [kv.slice(0, i), kv.slice(i + 1)];
}
