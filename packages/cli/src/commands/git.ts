/** `testpion git status|changes|diff|commit|log|branch|switch|pull|push` and `testpion merge-driver` (GIT-401, GIT-301). */
import { Command } from 'commander';
import {
  WorkspaceManager,
  changesMarkdown,
  describeGitChanges,
  describeRevChanges,
  findCommittableSecrets,
  gitBranches,
  gitCommit,
  gitDiff,
  gitLog,
  gitPull,
  gitPush,
  gitResolve,
  gitStatus,
  gitSwitch,
  runMergeDriver,
  type WorkspaceStore, gitConflictDetail, gitDeleteBranch, gitRenameBranch } from '@testpion/core';
import { EXIT, green, dim, bold, red, yellow, CliError, openWorkspace } from '../shared.js';

const MARK: Record<string, string> = { added: 'A', untracked: 'A', removed: 'D', deleted: 'D', changed: 'M', modified: 'M', renamed: 'R', conflicted: '!' };

/** Run with the workspace open; closes it afterwards. */
async function withStore<T>(ref: string | undefined, fn: (s: WorkspaceStore) => Promise<T>): Promise<T> {
  const { store } = openWorkspace(ref, undefined, new WorkspaceManager());
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

const out = (json: boolean, value: unknown, text: () => void) => (json ? console.log(JSON.stringify(value, null, 2)) : text());

export function registerGitCommands(git: Command, program: Command): void {
  const wsOpt = (c: Command) => c.option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)').option('--json', 'print as JSON');

  wsOpt(git.command('status').description('branch, ahead / behind the remote, and the changed files of the workspace')).action((o) =>
    withStore(o.workspace, async (s) => {
      const st = await gitStatus(s.root);
      if (!st.repository) throw new CliError(`${s.root} is not in a git repository: run  git init  there (then  testpion git setup)`, EXIT.CONFIG_ERROR);
      out(o.json, st, () => {
        console.log(`${bold(st.branch ?? '(detached)')}${st.upstream ? dim(` → ${st.upstream}`) : ''}${st.ahead ? ` ↑${st.ahead}` : ''}${st.behind ? ` ↓${st.behind}` : ''}`);
        if (!st.files.length) console.log(dim('Nothing changed since the last commit.'));
        for (const f of st.files) console.log(`  ${MARK[f.state] ?? '?'} ${f.path}${f.staged ? dim(' (staged)') : ''}`);
      });
    }),
  );

  wsOpt(git.command('changes').description('what changed since the last commit, by meaning: requests, folders and environment variables added, changed or removed')).action((o) =>
    withStore(o.workspace, async (s) => {
      const st = await gitStatus(s.root);
      const changes = await describeGitChanges(s.root, st.files);
      out(o.json, changes, () => {
        if (!changes.length) console.log(dim('Nothing changed since the last commit.'));
        for (const c of changes) console.log(`  ${MARK[c.change] ?? '?'} ${c.title}${c.details.length ? dim(`  ${c.details.join(', ')}`) : ''}`);
      });
    }),
  );

  git
    .command('diff')
    .description('the line diff of one file of the workspace (against the last commit)')
    .argument('<file>', 'path inside the workspace, e.g. collections/payments.json')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
    .option('--staged', 'the staged change')
    .action((file: string, o) =>
      withStore(o.workspace, async (s) => {
        process.stdout.write(await gitDiff(s.root, file, !!o.staged));
      }),
    );

  wsOpt(
    git
      .command('commit')
      .description('commit the workspace changes (or the staged ones); refuses when a secret is typed in (see git check) unless --allow-secrets')
      .requiredOption('-m, --message <text>', 'the commit message')
      .option('--staged', 'commit only what is staged')
      .option('--allow-secrets', 'commit even with secrets typed in')
      .option('--amend', 'replace the last commit (its message too)'),
  ).action((o) =>
    withStore(o.workspace, async (s) => {
      const secrets = findCommittableSecrets(s);
      if (secrets.length && !o.allowSecrets) {
        out(o.json, { committed: false, secrets }, () => {
          console.log(red(`Not committed: ${secrets.length} secret${secrets.length === 1 ? '' : 's'} typed in:`));
          for (const f of secrets) console.log(`  ${f.where} ${dim(`(${f.file})`)}`);
        });
        process.exitCode = EXIT.TEST_FAILURE;
        return;
      }
      const commit = await gitCommit(s.root, o.message, { paths: o.staged ? undefined : ['.'], amend: !!o.amend });
      out(o.json, { committed: true, commit }, () => console.log(green(`Committed ${commit.short} ${commit.subject}`)));
    }),
  );

  wsOpt(git.command('log').description('commits that changed the workspace (or one file), newest first').option('--file <path>', 'only commits that changed this file').option('-n, --limit <n>', 'how many', '20')).action((o) =>
    withStore(o.workspace, async (s) => {
      const log = await gitLog(s.root, { path: o.file, limit: Number(o.limit) });
      out(o.json, log, () => {
        for (const c of log) console.log(`${yellow(c.short)} ${c.subject} ${dim(`${c.author}, ${c.date.slice(0, 16).replace('T', ' ')}`)}`);
      });
    }),
  );

  wsOpt(
    git
      .command('branch')
      .description('list branches; -m renames the current branch, -d deletes a merged branch, -D deletes it anyway')
      .option('-m, --rename <newName>', 'rename the current branch')
      .option('-d, --delete <branch>', 'delete a local branch (refused when it has commits no other branch has)')
      .option('-D, --force-delete <branch>', 'delete a local branch even if it is not merged'),
  ).action((o) =>
    withStore(o.workspace, async (s) => {
      if (o.rename) {
        const current = (await gitBranches(s.root)).current;
        if (!current) throw new CliError('No current branch to rename (detached HEAD)', EXIT.CONFIG_ERROR);
        await gitRenameBranch(s.root, current, String(o.rename));
        return out(o.json, { renamed: current, to: o.rename }, () => console.log(green(`Renamed ${current} to ${o.rename}`)));
      }
      if (o.delete || o.forceDelete) {
        const name = String(o.delete ?? o.forceDelete);
        await gitDeleteBranch(s.root, name, !!o.forceDelete);
        return out(o.json, { deleted: name }, () => console.log(green(`Deleted ${name}`)));
      }
      const b = await gitBranches(s.root);
      out(o.json, b, () => {
        for (const l of b.local) console.log(`${l === b.current ? green('* ') : '  '}${l}`);
        for (const r of b.remote) console.log(dim(`  ${r}`));
      });
    }),
  );

  git
    .command('switch')
    .description('switch to a branch (with -c, create it)')
    .argument('<branch>')
    .option('-c, --create', 'create the branch')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
    .action((branch: string, o) =>
      withStore(o.workspace, async (s) => {
        await gitSwitch(s.root, branch, { create: !!o.create });
        console.log(green(`On ${branch}`));
      }),
    );

  wsOpt(git.command('pull').description('bring in the remote’s commits; exit 1 when it stopped on conflicts').option('--rebase', 'rebase instead of merge')).action((o) =>
    withStore(o.workspace, async (s) => {
      const r = await gitPull(s.root, { rebase: !!o.rebase });
      out(o.json, r, () => console.log(r.conflicted ? red('Conflicts: settle them in TestPion (Git view) or with  testpion git resolve <file> --ours|--theirs, then commit.') : green('Pulled: up to date with the remote.')));
      if (r.conflicted) process.exitCode = EXIT.TEST_FAILURE;
    }),
  );

  git
    .command('resolve')
    .description('settle a conflicted file: a collection keeps both sides\' changes and takes yours (--ours) or theirs (--theirs) only for requests changed on both; then commit')
    .argument('<file>', 'path inside the workspace, e.g. collections/payments.json')
    .option('--ours', 'keep your version of what conflicts')
    .option('--theirs', 'take their version of what conflicts')
    .option('--pick <key=side...>', 'a choice per conflict (keys from `testpion git conflicts`), e.g. item:r1=theirs item:r2=ours; the rest keep --ours/--theirs (default ours)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
    .action((file: string, o) =>
      withStore(o.workspace, async (s) => {
        const picks = ((o.pick as string[] | undefined) ?? []).map((kv) => {
          const i = kv.lastIndexOf('=');
          const side = kv.slice(i + 1);
          if (i <= 0 || (side !== 'ours' && side !== 'theirs')) throw new CliError(`--pick expects key=ours or key=theirs, got "${kv}"`, EXIT.CONFIG_ERROR);
          return [kv.slice(0, i), side] as const;
        });
        if (!picks.length && !!o.ours === !!o.theirs) throw new CliError('Choose --ours or --theirs (or --pick per conflict)', EXIT.CONFIG_ERROR);
        const side: 'ours' | 'theirs' = o.theirs ? 'theirs' : 'ours';
        if (picks.length) {
          // every conflict gets the default side unless picked
          const detail = await gitConflictDetail(s.root, file);
          const resolutions: Record<string, 'ours' | 'theirs'> = Object.fromEntries(detail.items.map((i) => [i.key, side]));
          for (const [k, v] of picks) {
            if (!(k in resolutions)) throw new CliError(`No conflict "${k}" in ${file}. Keys: ${Object.keys(resolutions).join(', ') || '(none)'}`, EXIT.CONFIG_ERROR);
            resolutions[k] = v;
          }
          await gitResolve(s.root, file, side, resolutions);
        } else await gitResolve(s.root, file, side);
        console.log(green(`Resolved ${file}`));
      }),
    );

  git
    .command('conflicts')
    .description('after a pull that stopped on conflicts: each conflict of a collection file, part by part (base, ours, theirs), with the key to --pick')
    .argument('[file]', 'one conflicted file (default: all)')
    .option('--json', 'machine-readable output (for scripts and AI agents)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
    .action((file: string | undefined, o) =>
      withStore(o.workspace, async (s) => {
        const st = await gitStatus(s.root);
        const files = st.files.filter((f) => f.state === 'conflicted' && (!file || f.path === file));
        const details = await Promise.all(files.map((f) => gitConflictDetail(s.root, f.path)));
        out(o.json, details, () => {
          if (!details.length) return console.log(green('No conflicts.'));
          for (const d of details) {
            console.log(bold(d.path) + (d.collection ? '' : dim('  (not a collection: --ours or --theirs takes the whole file)')));
            for (const i of d.items) {
              console.log(`  ${yellow(i.key)}  ${i.where} ${dim(`(${i.kind})`)}`);
              for (const p of i.parts.filter((x) => x.differs)) console.log(dim(`    ${p.part}: mine ${JSON.stringify(p.ours ?? '(deleted)')} · theirs ${JSON.stringify(p.theirs ?? '(deleted)')}`));
            }
          }
        });
      }),
    );

  wsOpt(git.command('push').description('send your commits to the remote (the first push of a branch sets its upstream)')).action((o) =>
    withStore(o.workspace, async (s) => {
      await gitPush(s.root);
      out(o.json, { pushed: true }, () => console.log(green('Pushed.')));
    }),
  );

  // the semantic diff between two commits: for reviews and CI (a pull-request comment with --markdown)
  program
    .command('diff')
    .description('what changed in the workspace between two commits, branches or tags, by meaning (requests, folders, environment variables, test files); without <to>: up to the working folder')
    .argument('<from>', 'commit, branch or tag, e.g. origin/main')
    .argument('[to]', 'commit, branch or tag (default: the working folder)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
    .option('--json', 'print as JSON')
    .option('--markdown', 'print a Markdown list (for a pull-request comment)')
    .action((from: string, to: string | undefined, o) =>
      withStore(o.workspace, async (s) => {
        const changes = await describeRevChanges(s.root, from, to);
        if (o.markdown) return console.log(changesMarkdown(changes));
        out(o.json, changes, () => {
          if (!changes.length) console.log(dim('No changes to the workspace.'));
          for (const c of changes) console.log(`  ${MARK[c.change] ?? '?'} ${c.title}${c.details.length ? dim(`  ${c.details.join(', ')}`) : ''}`);
        });
      }),
    );

  // git calls this as the merge driver of collection files (registered by `testpion git setup` in a repository)
  program
    .command('merge-driver', { hidden: true })
    .description('git merge driver for collection files: merges request by request (used by git, see git setup)')
    .argument('<base>')
    .argument('<ours>')
    .argument('<theirs>')
    .argument('[path]')
    .action((base: string, ours: string, theirs: string) => {
      process.exitCode = runMergeDriver(base, ours, theirs, (l: string) => console.error(l));
    });
}
