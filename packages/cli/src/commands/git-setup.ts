/**
 * `testpion git fix|textconv|large|share-session|unshare-session|codeowners|allow-secret|disallow-secret|fix-secrets` (release C
 * of planning/git-everything.md): making a workspace ready for git in one previewed, undoable step, the readable-diff driver,
 * big files, sharing a Debugger session, a starter CODEOWNERS and the staged secret scan's allowlist. The work is in core
 * (git/fix-setup.ts, textconv.ts, large-files.ts, codeowners.ts, secrets-allow.ts, staged-fix.ts, debugger/share-session.ts);
 * this module reads arguments and prints.
 */
import type { Command } from 'commander';
import {
  Redactor,
  WorkspaceManager,
  allowSecret,
  checkReferences,
  disallowSecret,
  findLargeFiles,
  fixGitSetup,
  fixStagedFiles,
  listSharedSessions,
  readSecretsAllow,
  scanStagedSecrets,
  shareSession,
  textconvFile,
  trackByReference,
  trackWithLfs,
  unshareSession,
  writeCodeowners,
  type GitFixResult,
  type LargeResult,
} from '@testpion/core';
import { EXIT, CliError, bold, cliSelf, dim, green, printJson, red, withWorkspace, yellow } from '../shared.js';

const out = (json: boolean, value: unknown, text: () => void) => (json ? printJson(value) : text());
const mb = (n: number) => `${(n / 1048576).toFixed(n >= 10485760 ? 0 : 1)} MB`;

function printFix(r: GitFixResult) {
  if (!r.gitAvailable) console.log(yellow('Git is not installed: the files below are still written; install Git from https://git-scm.com for the rest.'));
  for (const s of r.steps) {
    const mark = s.state === 'todo' ? (r.applied ? green('done') : yellow('will')) : s.state === 'advice' ? dim('note') : dim('skip');
    console.log(`${mark} ${s.title}`);
    for (const d of s.detail) console.log(dim(`       ${d}`));
  }
  for (const p of r.problems) console.log(yellow(`  ${p}`));
  console.log(r.message);
  if (r.dryRun && r.changed) console.log(dim('Nothing was changed (--dry-run). Run without it to apply; `testpion git undo` puts the files back.'));
  if (r.undoId) console.log(dim(`Undo with:  testpion git undo ${r.undoId}`));
}

function printLarge(r: LargeResult) {
  console.log(`${r.applied ? green('Tracked') : yellow('Would track')} ${bold(r.file)} ${dim(`(${mb(r.bytes)}) ${r.mode === 'lfs' ? 'with Git LFS' : 'by reference'}`)}`);
  for (const n of r.notes) console.log(dim(`  ${n}`));
  console.log(dim(`  writes: ${r.writes.join(', ')}${r.untrack ? '; removed from git (stays on disk)' : ''}`));
  if (r.undoId) console.log(dim(`Undo with:  testpion git undo ${r.undoId}`));
  if (!r.applied) console.log(dim('Nothing was written (--dry-run).'));
}

export function registerGitSetupCommands(git: Command): void {
  const wsOpt = (c: Command) => c.option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)').option('--json', 'print as JSON');
  const dry = (c: Command) => c.option('--dry-run', 'change nothing: print what would change');

  dry(
    wsOpt(
      git
        .command('fix')
        .description(
          'Fix git setup: .gitignore and .gitattributes (line endings, merge and diff drivers), the drivers in the repository config, existing files rewritten once into the stable format, optionally the pre-commit secret check; previews with --dry-run, undoable, safe to run again',
        )
        .option('--hook', 'also install the pre-commit secret check (an existing hook of yours is never overwritten)')
        .option('--untrack', 'also remove from git (not from disk) the files it tracks that the ignore rules say to leave out'),
    ),
  ).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      const self = cliSelf();
      const r = await fixGitSetup(s, {
        dryRun: !!o.dryRun,
        mergeDriverCommand: `${self} merge-driver`,
        textconvCommand: `${self} git textconv`,
        hook: o.hook ? { cli: self } : false,
        untrack: !!o.untrack,
      });
      out(o.json, r, () => printFix(r));
    }),
  );

  // git calls this with the temporary file it made of one version of a file (diff.testpion.textconv)
  git
    .command('textconv', { hidden: true })
    .description('the readable-diff driver: print a collection, environment, library, MCP servers or providers file item by item (used by git, see git fix)')
    .argument('<file>')
    .action((file: string) => {
      process.stdout.write(textconvFile(file));
    });

  dry(
    wsOpt(
      git
        .command('large')
        .description('big files: list those over the size policy (5 MB warn, 50 MB offer LFS or a reference, 100 MB refused in a commit), --check the .ref files, or --track one')
        .option('--check', 'check every <file>.ref against the data on this computer (exit 1 when one is missing or different)')
        .option('--track <file>', 'track this file: with --lfs (Git LFS) or --reference (a .ref file with its checksum; the data is git-ignored)')
        .option('--lfs', 'with --track: Git LFS')
        .option('--reference', 'with --track: by reference')
        .option('--source <where>', 'with --reference: where the team keeps the data (a URL, a bucket, a share)'),
    ),
  ).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      if (o.check) {
        const r = await checkReferences(s.root);
        out(o.json, r, () => {
          if (!r.length) console.log(dim('No reference files (*.ref).'));
          for (const c of r) console.log(`${c.state === 'ok' ? green('ok') : red(c.state.padEnd(9))} ${c.message}`);
        });
        if (r.some((c) => c.state !== 'ok')) process.exitCode = EXIT.TEST_FAILURE;
        return;
      }
      if (o.track) {
        if (!!o.lfs === !!o.reference) throw new CliError('Choose --lfs or --reference with --track', EXIT.CONFIG_ERROR);
        const r = o.lfs ? await trackWithLfs(s.root, o.track, { dryRun: !!o.dryRun }) : await trackByReference(s.root, o.track, { dryRun: !!o.dryRun, source: o.source });
        return out(o.json, r, () => printLarge(r));
      }
      const list = await findLargeFiles(s.root);
      out(o.json, list, () => {
        if (!list.length) console.log(green('No file is over the size policy.'));
        for (const l of list) console.log(`${l.level === 'refuse' ? red(l.level.padEnd(6)) : l.level === 'lfs' ? yellow(l.level.padEnd(6)) : dim(l.level.padEnd(6))} ${l.file} ${dim(mb(l.bytes))}`);
        if (list.some((l) => l.level !== 'warn')) console.log(dim('Track one:  testpion git large --track <file> --lfs   or   --reference'));
      });
    }),
  );

  dry(
    wsOpt(
      git
        .command('share-session')
        .description('share a saved Debugger session: a masked copy goes to debugger/shared/ (tracked); the session itself stays git-ignored')
        .argument('<name>', "the saved session's name"),
    ),
  ).action((name: string, o) =>
    withWorkspace(o.workspace, async (s) => {
      const r = shareSession(s, name, { redactor: new Redactor(new WorkspaceManager().loadSettings().redactFields), dryRun: !!o.dryRun });
      out(o.json, r, () => {
        console.log(
          `${r.applied ? green('Shared') : yellow('Would share')} ${bold(r.name)} ${dim(`${r.entries} exchanges → ${r.to}${r.masked ? ' (masked more than the capture had)' : ''}${r.replaced ? ', replacing the shared copy' : ''}`)}`,
        );
        if (r.undoId) console.log(dim(`Undo with:  testpion git undo ${r.undoId}`));
      });
    }),
  );
  wsOpt(git.command('unshare-session').description('stop sharing a session: delete its copy in debugger/shared/ (the saved session stays)').argument('<name>')).action((name: string, o) =>
    withWorkspace(o.workspace, async (s) => {
      const r = unshareSession(s, name);
      out(o.json, r, () => console.log(r.removed ? green(`Removed the shared copy of ${r.name}`) : dim(`${r.name} is not shared`)));
    }),
  );
  wsOpt(git.command('shared-sessions').description('the sessions shared so far (debugger/shared/)')).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      const list = listSharedSessions(s);
      out(o.json, list, () => {
        if (!list.length) console.log(dim('No session is shared.'));
        for (const x of list) console.log(`${x.name} ${dim(`${x.file}, ${mb(x.bytes)}`)}`);
      });
    }),
  );

  dry(
    wsOpt(
      git
        .command('codeowners')
        .description('a starter CODEOWNERS with a line per kind folder of the workspace (printed; --write puts it in .github/CODEOWNERS when the workspace is the repository; never overwrites)')
        .option('--owner <owner>', 'the owner for every line, e.g. @your-org/platform (default: lines are comments to fill in)')
        .option('--write', 'write .github/CODEOWNERS'),
    ),
  ).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      const r = await writeCodeowners(s.root, { owner: o.owner, dryRun: !o.write || !!o.dryRun });
      out(o.json, r, () => {
        if (o.write) console.log(r.written ? green(`Wrote ${r.path}`) : yellow(r.reason ?? 'Nothing was written'));
        else console.log(r.text);
        if (!o.write && r.existing) console.log(dim(`${r.existing} exists: it is never overwritten.`));
      });
    }),
  );

  wsOpt(
    git
      .command('allow-secret')
      .description(
        'let one reviewed value through the staged secret scan (.testpion/secrets-allow.json, committed): by the fingerprint `git check --staged --json` prints as `hash`; never a pattern, never the value',
      )
      .argument('<hash>', "the finding's hash (a start of it is enough)")
      .requiredOption('--reason <text>', 'why it is not a secret: read in review'),
  ).action((hash: string, o) =>
    withWorkspace(o.workspace, async (s) => {
      const scan = await scanStagedSecrets(s.root);
      const hits = [...scan.blocking, ...scan.confirm].filter((f) => f.hash.startsWith(hash));
      if (hits.length !== 1)
        throw new CliError(
          hits.length ? `${hash} matches ${hits.length} findings: use more of the hash` : `No staged finding has the hash ${hash}: run  testpion git check --staged --json`,
          EXIT.CONFIG_ERROR,
        );
      const r = allowSecret(s.root, hits[0]!, o.reason);
      out(o.json, r, () => console.log(r.applied ? `${green('Allowed')} ${hits[0]!.item}: ${hits[0]!.field} ${dim('(commit .testpion/secrets-allow.json with it)')}` : dim('It was allowed already.')));
    }),
  );
  wsOpt(git.command('disallow-secret').description('take a value out of .testpion/secrets-allow.json again').argument('<hash>')).action((hash: string, o) =>
    withWorkspace(o.workspace, async (s) => {
      const r = disallowSecret(s.root, hash);
      out(o.json, r, () => console.log(r.removed ? green(`Removed ${r.removed} entr${r.removed === 1 ? 'y' : 'ies'}`) : dim('No entry has that hash.')));
    }),
  );
  wsOpt(git.command('allowed-secrets').description('what .testpion/secrets-allow.json lets through (file, item, field, reason; never a value)')).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      const a = readSecretsAllow(s.root);
      out(o.json, a, () => {
        if (a.problem) console.log(red(a.problem));
        if (!a.entries.length) console.log(dim('Nothing is allowed.'));
        for (const e of a.entries) console.log(`${e.item}: ${e.field} ${dim(`${e.file}  ${e.hash.slice(0, 8)}  ${e.reason}`)}`);
      });
    }),
  );

  wsOpt(
    git
      .command('fix-secrets')
      .description(
        'what the one-click fix would do for secrets typed into staged MCP servers, providers, library items, tests and other files: the {{variable}} each value becomes (the values themselves move to secret variables in the TestPion app, whose secret store the command line does not have)',
      )
      .requiredOption('-e, --environment <name>', 'the environment whose secret variables would keep the values'),
  ).action((o) =>
    withWorkspace(o.workspace, async (s) => {
      const env = s.listEnvironments().find((e) => e.id === o.environment || e.name === o.environment);
      if (!env) throw new CliError(`No environment "${o.environment}"`, EXIT.CONFIG_ERROR);
      const scan = await scanStagedSecrets(s.root);
      const files = [...new Set([...scan.blocking, ...scan.confirm].map((f) => f.file))];
      const r = await fixStagedFiles(s, undefined, { files, environmentId: env.id, dryRun: true });
      out(o.json, r, () => {
        if (!r.fixed.length) console.log(green('Nothing the fix could move.'));
        for (const f of r.fixed) console.log(`  ${f.item}: ${f.field} ${dim(`→ ${f.variable}  (${f.file})`)}`);
        for (const k of r.skipped) console.log(yellow(`  ${k.file}: ${k.reason}`));
        if (r.fixed.length) console.log(dim('Apply it in TestPion: Git view ▸ Fix all (the values move to secret variables of the chosen environment).'));
      });
    }),
  );
}
