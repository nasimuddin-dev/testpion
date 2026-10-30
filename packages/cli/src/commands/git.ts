/** `testpion git status|changes|diff|commit|log|branch|switch|pull|push|sync` and `testpion merge-driver` (GIT-401, GIT-301). */
import { Command } from 'commander';
import {
  changesMarkdown,
  describeGitChanges,
  describeRevChanges,
  gitChangesByItem,
  gitBranches,
  gitDiff,
  gitLog,
  gitPull,
  gitPullFastForward,
  teamActivity,
  gitPush,
  gitResolve,
  gitStatus,
  gitSwitch,
  gitSync,
  type GitSyncResult,
  runMergeDriver,
  gitConflictDetail,
  gitDeleteBranch,
  gitRenameBranch,
  type MergeResolutions,
} from '@testpion/core';
import { EXIT, green, red, yellow, dim, bold, CliError, printJson, respond, withWorkspace, JSON_OPTION } from '../shared.js';
import { addOutputOptions, saveSurface, savedLine } from '../output-save.js';
import { commitScanned, registerGitItemCommands, splitKeyValue } from './git-items.js';
import { registerGitSetupCommands } from './git-setup.js';

const MARK: Record<string, string> = { added: 'A', untracked: 'A', removed: 'D', deleted: 'D', changed: 'M', modified: 'M', renamed: 'R', conflicted: '!' };

const out = (json: boolean, value: unknown, text: () => void) => (json ? printJson(value) : text());

export function registerGitCommands(git: Command, program: Command): void {
  registerGitItemCommands(git);
  registerGitSetupCommands(git);
  const wsOpt = (c: Command) => c.option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)').option(...JSON_OPTION);

  wsOpt(
    git
      .command('status')
      .description('branch, ahead / behind the remote, and the changed files of the workspace (--by-item: the changed items, named like the app does)')
      .option('--by-item', 'list the changes item by item ("MCP server Weather: URL") instead of file by file')
      .option('--kind <kind...>', 'with --by-item, only these kinds (mcp-server, provider, prompt, dataset, spec, request, environment …)'),
  ).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      if (o.byItem || o.kind) {
        const r = await gitChangesByItem(s.root, { kinds: o.kind });
        if (!r.repository) throw new CliError(`${s.root} is not in a git repository: run  git init  there (then  testpion git setup)`, EXIT.CONFIG_ERROR);
        return out(o.json, r, () => {
          console.log(`${bold(r.branch ?? '(detached)')}${r.ahead ? ` ↑${r.ahead}` : ''}${r.behind ? ` ↓${r.behind}` : ''}`);
          if (!r.items.length) console.log(dim(o.kind ? 'No changed items of these kinds.' : 'Nothing changed since the last commit.'));
          for (const i of r.items) console.log(`  ${MARK[i.change] ?? '?'} ${i.title}${i.details.length ? dim(`  ${i.details.join(', ')}`) : ''}${dim(`  ${i.file}${i.staged ? ' (staged)' : ''}`)}`);
        });
      }
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
    withWorkspace(o.workspace, async (s) => {
      const st = await gitStatus(s.root);
      const changes = await describeGitChanges(s.root, st.files);
      out(o.json, changes, () => {
        if (!changes.length) console.log(dim('Nothing changed since the last commit.'));
        for (const c of changes) console.log(`  ${MARK[c.change] ?? '?'} ${c.title}${c.details.length ? dim(`  ${c.details.join(', ')}`) : ''}`);
      });
    }),
  );

  addOutputOptions(
    git
      .command('diff')
      .description('the line diff of one file of the workspace (against the last commit); --out saves it as a patch or Markdown, like the app’s Git download')
      .argument('<file>', 'path inside the workspace, e.g. collections/payments.json')
      .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
      .option('--staged', 'the staged change'),
    'git.diff',
  ).action((file: string, o) =>
    withWorkspace(o.workspace, async (s) => {
      if (o.out) {
        const saved = await saveSurface({ store: s, surface: 'git.diff', format: o.format, out: o.out, params: { path: file, staged: !!o.staged } });
        return console.log(savedLine(saved));
      }
      const diff = await gitDiff(s.root, file, !!o.staged);
      respond({ path: file, staged: !!o.staged, diff }, () => process.stdout.write(diff));
    }),
  );

  wsOpt(
    git
      .command('commit')
      .description('commit the workspace changes (or the staged ones) after a scan of what is staged: a secret typed in refuses the commit (see git check --staged); --allow-secrets only confirms probable ones')
      .requiredOption('-m, --message <text>', 'the commit message')
      .option('--staged', 'commit only what is staged')
      .option('--allow-secrets', 'commit although probable secrets were found (a certain one always refuses: use a {{variable}} instead)')
      .option('--amend', 'replace the last commit (its message too)'),
  ).action((o) => withWorkspace(o.workspace, (s) => commitScanned(s, o)));

  wsOpt(git.command('log').description('commits that changed the workspace (or one file), newest first').option('--file <path>', 'only commits that changed this file').option('-n, --limit <n>', 'how many', '20')).action((o) =>
    withWorkspace(o.workspace, async (s) => {
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
    withWorkspace(o.workspace, async (s) => {
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
      withWorkspace(o.workspace, async (s) => {
        await gitSwitch(s.root, branch, { create: !!o.create });
        respond({ branch, created: !!o.create }, () => console.log(green(`On ${branch}`)));
      }),
    );

  wsOpt(git.command('activity').description('what other people changed in this workspace lately, by meaning: each commit with the items it changed (the app’s Home card “Your team’s changes”)').option('--days <n>', 'how many days (default 14)', (v) => Number(v)).option('--limit <n>', 'how many commits (default 8)', (v) => Number(v))).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      const a = await teamActivity(s.root, { days: o.days, limit: o.limit });
      out(o.json, a, () => {
        console.log(a.text);
        for (const c of a.commits) {
          console.log(`\n${bold(c.author)} ${dim(`${c.short} · ${c.date.slice(0, 10)}`)}  ${c.subject}`);
          for (const x of c.changes) console.log(`  ${x.change === 'added' ? green('+') : x.change === 'removed' ? red('-') : '~'} ${x.title}${x.details.length ? dim(`: ${x.details.join(', ')}`) : ''}`);
          if (c.more) console.log(dim(`  and ${c.more} more`));
        }
      });
    }),
  );

  wsOpt(
    git
      .command('pull')
      .description('bring in the remote’s commits; exit 1 when it stopped on conflicts')
      .option('--rebase', 'rebase instead of merge')
      .option('--ff-only', 'only a plain fast-forward (what the app does by itself with Settings ▸ Git ▸ pull when I have no changes): never merges, exit 1 when it cannot'),
  ).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      if (o.ffOnly) {
        let ff;
        try {
          ff = await gitPullFastForward(s.root);
        } catch (e) {
          const msg = `Not a plain fast-forward (you have changes or commits the remote lacks, or the remote needs a sign-in): ${(e as Error).message.split('\n')[0]}`;
          if (!o.json) throw new CliError(msg, EXIT.TEST_FAILURE);
          printJson({ conflicted: false, pulled: 0, ffOnly: true, error: msg });
          process.exitCode = EXIT.TEST_FAILURE;
          return;
        }
        out(o.json, { conflicted: false, ffOnly: true, ...ff }, () => console.log(ff.pulled ? green(`Pulled ${ff.pulled} commit(s):\n${ff.commits.map((c) => `  ${c.short} ${c.author}: ${c.subject}`).join('\n')}`) : green('Up to date with the remote.')));
        return;
      }
      const r = await gitPull(s.root, { rebase: !!o.rebase });
      out(o.json, r, () => console.log(r.conflicted ? red('Conflicts: settle them in TestPion (Git view) or with  testpion git resolve <file> --ours|--theirs, then commit.') : green('Pulled: up to date with the remote.')));
      if (r.conflicted) process.exitCode = EXIT.TEST_FAILURE;
    }),
  );

  wsOpt(
    git
      .command('sync')
      .description('pull & push in one step: fetch, pull with a merge when the remote has new commits (collections merge request by request; uncommitted changes are set aside and put back), then push. Exit 0 pushed or up to date, 1 conflicts (listed), 2 errors'),
  ).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      let r: GitSyncResult;
      try {
        r = await gitSync(s.root);
      } catch (e) {
        const err = e as { message?: string; suggestions?: string[] };
        if (!o.json) throw new CliError([err.message ?? String(e), ...(err.suggestions ?? [])].join('\n  '), EXIT.CONFIG_ERROR);
        printJson({ state: 'error', error: err.message ?? String(e), suggestions: err.suggestions ?? [] });
        process.exitCode = EXIT.CONFIG_ERROR;
        return;
      }
      out(o.json, r, () => {
        if (r.state !== 'conflicts') return console.log(green(r.message));
        console.log(red(r.message));
        for (const f of r.files ?? []) console.log(`  ! ${f}`);
        console.log(dim('Settle them in TestPion (Git view) or with  testpion git resolve <file> --ours|--theirs, commit, then  testpion git sync  again.'));
      });
      if (r.state === 'conflicts') process.exitCode = EXIT.TEST_FAILURE;
    }),
  );

  wsOpt(
    git
      .command('resolve')
      .description('settle a conflicted file: a file merged by meaning (collections, environments, MCP servers, providers, library, settings) keeps both sides\' changes and takes yours (--ours) or theirs (--theirs) only where they conflict; a text file (tests, flows, specs) is settled hunk by hunk; a binary file whole; then commit')
      .argument('<file>', 'path inside the workspace, e.g. collections/payments.json')
      .option('--ours', 'keep your version of what conflicts')
      .option('--theirs', 'take their version of what conflicts')
      .option('--pick <key=side...>', 'a choice per conflict (keys from `testpion git conflicts`), e.g. item:r1=theirs item:r1#request.url=ours hunk:0=ours step:create-order=theirs (a step of a test or flow file); the rest keep --ours/--theirs (default ours)')
      .option('--edit <key=value...>', 'your own value for a conflict: JSON for an item or field key (item:r1#request.url="https://…"), plain text for a hunk key (hunk:0=the lines to keep)'),
  ).action((file: string, o) =>
    withWorkspace(o.workspace, async (s) => {
      const picks = ((o.pick as string[] | undefined) ?? []).map((kv) => {
        const i = kv.lastIndexOf('=');
        const side = kv.slice(i + 1);
        if (i <= 0 || (side !== 'ours' && side !== 'theirs')) throw new CliError(`--pick expects key=ours or key=theirs, got "${kv}"`, EXIT.CONFIG_ERROR);
        return [kv.slice(0, i), side] as const;
      });
      const edits = ((o.edit as string[] | undefined) ?? []).map((kv) => {
        const [key, value] = splitKeyValue(kv, '--edit');
        if (key.startsWith('step:')) throw new CliError(`--edit ${key}: a step is settled with --pick ${key}=ours|theirs; edit one of its hunks (hunk:<n>)`, EXIT.CONFIG_ERROR);
        if (!key.startsWith('hunk:')) {
          try {
            JSON.parse(value);
          } catch {
            throw new CliError(`--edit ${key} expects JSON (a string needs its quotes: ${key}='"text"'), got ${value.slice(0, 40)}`, EXIT.CONFIG_ERROR);
          }
        }
        return [key, value] as const;
      });
      if (!picks.length && !edits.length && !!o.ours === !!o.theirs) throw new CliError('Choose --ours or --theirs (or --pick / --edit per conflict)', EXIT.CONFIG_ERROR);
      const side: 'ours' | 'theirs' = o.theirs ? 'theirs' : 'ours';
      const resolutions: MergeResolutions = {};
      if (picks.length || edits.length) {
        // only the conflicts named get their own answer: the rest keep `side` (the core fills them in)
        const detail = await gitConflictDetail(s.root, file);
        const keys = new Set([...detail.items.flatMap((i) => [i.key, ...(i.fields ?? []).map((f) => f.key)]), ...detail.hunks.map((h) => h.key), ...(detail.steps ?? []).map((st) => st.key)]);
        for (const k of [...picks.map(([k]) => k), ...edits.map(([k]) => k)])
          if (!keys.has(k)) throw new CliError(`No conflict "${k}" in ${file}. Keys: ${[...keys].join(', ') || '(none)'}`, EXIT.CONFIG_ERROR);
        for (const [k, v] of picks) resolutions[k] = v;
        for (const [k, v] of edits) resolutions[k] = { edit: v };
      }
      await gitResolve(s.root, file, side, Object.keys(resolutions).length ? resolutions : undefined);
      out(o.json, { resolved: file, side, picks: picks.length, edits: edits.length }, () => console.log(green(`Resolved ${file}`)));
    }),
  );

  wsOpt(
    git
      .command('conflicts')
      .description('after a pull that stopped on conflicts: each conflicted file by what it holds (items with their fields, text hunks, or a binary file with sizes) and the key to --pick / --edit; --resolve ours|theirs settles them all')
      .argument('[file]', 'one conflicted file (default: all)')
      .option('--resolve <side>', 'settle every conflicted file (or the one given) with this side: ours or theirs'),
  ).action((file: string | undefined, o) =>
    withWorkspace(o.workspace, async (s) => {
      const st = await gitStatus(s.root);
      if (!st.repository) throw new CliError(`${s.root} is not in a git repository: run  git init  there (then  testpion git setup)`, EXIT.CONFIG_ERROR);
      const files = st.files.filter((f) => f.state === 'conflicted' && (!file || f.path === file));
      if (o.resolve !== undefined) {
        if (o.resolve !== 'ours' && o.resolve !== 'theirs') throw new CliError('--resolve takes ours or theirs', EXIT.CONFIG_ERROR);
        const side: 'ours' | 'theirs' = o.resolve;
        for (const f of files) await gitResolve(s.root, f.path, side);
        return out(o.json, { side, resolved: files.map((f) => f.path) }, () => {
          if (!files.length) return console.log(green('No conflicts.'));
          for (const f of files) console.log(green(`Resolved ${f.path} (${side})`));
          console.log(dim('Commit to finish.'));
        });
      }
      const details = await Promise.all(files.map((f) => gitConflictDetail(s.root, f.path)));
      out(o.json, details, () => {
        if (!details.length) return console.log(green('No conflicts.'));
        for (const d of details) {
          console.log(bold(d.path) + dim(d.mode === 'items' ? '  (merged by meaning: item by item)' : d.mode === 'text' ? '  (text: hunk by hunk)' : '  (binary: --ours or --theirs takes the whole file)'));
          for (const i of d.items) {
            console.log(`  ${yellow(i.key)}  ${i.where} ${dim(`(${i.kind})`)}`);
            if (i.fields?.length) for (const f of i.fields) console.log(`    ${yellow(f.key)}  ${dim(`mine ${JSON.stringify(f.ours ?? '(deleted)')} · theirs ${JSON.stringify(f.theirs ?? '(deleted)')}`)}`);
            else for (const p of i.parts.filter((x) => x.differs)) console.log(dim(`    ${p.part}: mine ${JSON.stringify(p.ours ?? '(deleted)')} · theirs ${JSON.stringify(p.theirs ?? '(deleted)')}`));
          }
          for (const st of d.steps ?? []) console.log(`  ${yellow(st.key)}  step ${st.step} ${dim(`(settles ${st.hunks.join(', ')})`)}`);
          for (const h of d.hunks) {
            console.log(`  ${yellow(h.key)}  ${h.where}`);
            console.log(dim(`    mine:\n${h.ours.replace(/\n$/, '').replace(/^/gm, '      ')}\n    theirs:\n${h.theirs.replace(/\n$/, '').replace(/^/gm, '      ')}`));
          }
          if (d.sizes) console.log(dim(`  mine ${d.sizes.ours ?? 0} bytes · theirs ${d.sizes.theirs ?? 0} bytes`));
        }
      });
    }),
  );

  wsOpt(git.command('push').description('send your commits to the remote (the first push of a branch sets its upstream)')).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      await gitPush(s.root);
      out(o.json, { pushed: true }, () => console.log(green('Pushed.')));
    }),
  );

  // the semantic diff between two commits: for reviews and CI (a pull-request comment with --markdown)
  program
    .command('diff')
    .description('what changed in the workspace between two commits, branches or tags, by meaning (requests, folders, environment variables; flow and test files step by step: added, removed, renamed, which parts changed, connections, rearranged); without <to>: up to the working folder')
    .argument('<from>', 'commit, branch or tag, e.g. origin/main')
    .argument('[to]', 'commit, branch or tag (default: the working folder)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
    .option(...JSON_OPTION)
    .option('--markdown', 'print a Markdown list (for a pull-request comment)')
    .action((from: string, to: string | undefined, o) =>
      withWorkspace(o.workspace, async (s) => {
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
