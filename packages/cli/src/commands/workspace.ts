/** Managing workspaces. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import {
  WorkspaceManager,
  listTrash,
  purgeTrash,
  restoreFromTrash,
  trashKindsText,
  TRASH_DAYS,
  makeGitReady,
  findCommittableSecrets,
  installPreCommitHook,
  gitSetupMergeDriver,
  isInGitRepository,
  exportSummary,
  exportWholeWorkspace,
  workspaceExportFileName,
} from '@testpion/core';
import { EXIT, green, dim, bold, yellow, CliError, cliSelf, printJson, respond, withWorkspace, JSON_OPTION } from '../shared.js';
import { registerGitCommands } from './git.js';
import { checkStaged } from './git-items.js';

export function registerWorkspaceCommands(program: Command): void {
  const ws = program.command('workspace').description('manage workspaces');
  ws.command('list')
    .description('the workspaces on this computer: name, folder and whether it is the one the app opens')
    .option(...JSON_OPTION)
    .action((o) => {
      const list = new WorkspaceManager().list();
      if (o.json) printJson(list);
      else for (const w of list) console.log(`${w.name}\t${dim(w.path)}`);
    });
  ws.command('rename')
    .description('rename a workspace')
    .argument('<nameOrPath>')
    .argument('<newName>')
    .option('--json', 'print the renamed workspace as JSON')
    .action((ref: string, name: string, o) => {
      const w = new WorkspaceManager().rename(ref, name);
      if (o.json) printJson(w);
      else console.log(green(`Renamed to "${w.name}"`));
    });
  ws.command('delete')
    .description('delete a workspace the app created (its folder is removed), or unregister a folder you opened (its files stay)')
    .argument('<nameOrPath>')
    .option('--yes', 'confirm; required, because deleting cannot be undone')
    .option('--json', 'print the result as JSON')
    .action((ref: string, o) => {
      const mgr = new WorkspaceManager();
      const d = mgr.details(ref);
      if (!o.yes)
        throw new CliError(
          `Refusing to ${d.managed ? 'delete' : 'unregister'} "${d.name}" (${d.collections} collections, ${d.environments} environments, ${d.tests} test files at ${d.path}) without --yes`,
          EXIT.CONFIG_ERROR,
        );
      const r = mgr.delete(d.path);
      if (o.json) printJson({ name: d.name, path: d.path, ...r });
      else console.log(green(r.deletedFiles ? `Deleted "${d.name}"` : `Removed "${d.name}" from the list (folder kept: ${d.path})`));
    });
  ws.command('create')
    .description('make a new, empty workspace (a folder with workspace.json); --path puts it in a folder of your choice, e.g. inside a git repository')
    .argument('<name>')
    .option('--path <dir>', 'create in this directory (e.g. inside a git repo)')
    .action((name: string, o) => {
      const s = new WorkspaceManager().create(name, o.path ? resolve(o.path) : undefined);
      respond({ name, path: s.root }, () => console.log(green(`Created workspace "${name}" at ${s.root}`)));
      s.close();
    });
  ws.command('export')
    .description('a whole workspace as a bundle (the same file `testpion export --all` writes: every kind, previewed with conflict choices and Undo on import); secret values are replaced by {{variables}}, never exported')
    .argument('<nameOrPath>')
    .option('-o, --output <file>', 'the file to write (default: <workspace name>.testpion.zip, or .testpion.json when it is small and all text)')
    .option('--format <form>', 'zip or json (default: zip when the bundle has a binary file, is over 5 MB or has over 200 entries)')
    .option('--legacy', 'write the one-file workspace export of TestPion 0.53 and earlier (<name>.testpion.json), for a TestPion that cannot read bundles; removed in a later release')
    .option('--json', 'print what was exported, replaced (replaced: [{kind, item, field, variable}]) and left out (notes) as JSON')
    .action((ref: string, o) =>
      withWorkspace(ref, async (store) => {
        if (o.format && o.format !== 'zip' && o.format !== 'json') throw new CliError(`--format is zip or json, not ${o.format}`, EXIT.CONFIG_ERROR);
        if (o.legacy) {
          const bundle = store.exportBundle();
          const output = o.output ?? workspaceExportFileName(store.workspace.name);
          writeFileSync(output, JSON.stringify(bundle, null, 2));
          const summary = exportSummary(bundle);
          if (o.json) return printJson({ path: resolve(output), legacy: true, ...summary });
          console.log(green(`Exported to ${output}`));
          const [included, ...rest] = summary.lines;
          console.log(dim(included!));
          for (const line of rest) console.log(yellow(line));
          return;
        }
        const built = await exportWholeWorkspace(store, { format: o.format });
        const output = o.output ?? built.fileName;
        writeFileSync(output, built.bytes);
        if (o.json) return printJson({ path: resolve(output), format: built.format, size: built.bytes.length, counts: built.counts, ...built.summary });
        console.log(green(`Exported to ${output}`));
        const [included, ...rest] = built.summary.lines;
        console.log(dim(included!));
        for (const line of rest) console.log(yellow(line));
      }),
    );

  const git = program.command('git').description('keep a workspace in git (see the docs: Keep your workspace in git)');
  git
    .command('setup')
    .description('make a workspace git-ready: a .gitignore for results and local state, a .gitattributes for line endings, collection files in their git-friendly form; safe to run again')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
    .option('--json', 'print what changed as JSON')
    .action(async (o) => {
      return withWorkspace(o.workspace, async (store) => {
        const r = makeGitReady(store);
        // in a repository: collection files merge request by request (this CLI is the merge driver)
        const mergeDriver = isInGitRepository(store.root) ? await gitSetupMergeDriver(store.root, `${cliSelf()} merge-driver`).then(() => true, () => false) : false;
        if (o.json) return printJson({ ...r, mergeDriver });
        if (mergeDriver) console.log(`${green('set up')} merging collections request by request ${dim('(git config merge.testpion)')}`);
        if (!r.files.length && !r.collections.length) console.log(green('Already git-ready.'));
        for (const f of r.files) console.log(`${green('wrote')} ${f}`);
        for (const c of r.collections) console.log(`${green('tidied')} ${c} ${dim('(no save counter / time in the file)')}`);
        if (!r.inRepository) console.log(dim(`Not a git repository yet: run  git init  in ${store.root}`));
      });
    });

  git
    .command('check')
    .description('before a commit: list secrets typed into the workspace (headers, auth, body fields, plain-text variables, MCP servers, providers) that a commit would publish; exit 1 if any')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
    .option('--staged', 'scan what is staged (the blobs a commit would take) instead of the working folder: certain secrets and probable ones; exit 1 on any')
    .option('--json', 'print the findings as JSON')
    .action((o) => {
      if (o.staged) return withWorkspace(o.workspace, (store) => checkStaged(store, !!o.json));
      return withWorkspace(o.workspace, (store) => {
        const found = findCommittableSecrets(store);
        if (o.json) printJson(found);
        else if (!found.length) console.log(green('No secrets typed in: safe to commit.'));
        else {
          console.log(bold(`${found.length} secret${found.length === 1 ? '' : 's'} would be committed:`));
          for (const f of found) console.log(`  ${f.where} ${dim(`(${f.file})`)}\n    ${f.message}`);
        }
        if (found.length) process.exitCode = EXIT.TEST_FAILURE;
      });
    });
  git
    .command('hook')
    .description('git hooks for a workspace')
    .command('install')
    .description('install a pre-commit hook that runs `testpion git check` and refuses a commit that would publish a secret (an existing hook of yours is never overwritten)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
    .action((o) => {
      return withWorkspace(o.workspace, (store) => {
        // the hook can call this very CLI when `testpion` is not on the PATH (e.g. run from a checkout)
        const r = installPreCommitHook(store.root, cliSelf());
        respond({ installed: r.installed, path: r.path, message: r.message }, () => console.log(r.installed ? `${green('installed')} ${r.path}` : r.message));
        if (!r.installed) process.exitCode = EXIT.TEST_FAILURE;
      });
    });

  registerGitCommands(git, program);

  const trash = program.command('trash').description(`recently deleted ${trashKindsText()} (kept ${TRASH_DAYS} days): list, restore, empty`);
  trash
    .command('list')
    .description('list what was deleted in the last 30 days (Recently deleted): id, kind, name, when; restore one with `trash restore <id>`')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option(...JSON_OPTION)
    .action((o) => {
      return withWorkspace(o.workspace, (store) => {
        const items = listTrash(store);
        if (o.json) return printJson(items);
        if (!items.length) return console.log(dim('Nothing deleted in the last 30 days.'));
        for (const i of items) console.log(`${bold(i.name)}  ${dim(`${i.kind} · deleted ${i.deletedAt} · ${i.id}`)}`);
      });
    });
  trash
    .command('restore')
    .description('restore a deleted item (id from `trash list`); a name that is taken again gets "(restored)"')
    .argument('<id>')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--json', 'print the restored item as JSON')
    .action((id: string, o) => {
      return withWorkspace(o.workspace, (store) => {
        const r = restoreFromTrash(store, id);
        if (o.json) printJson(r);
        else console.log(green(`Restored ${r.kind} "${r.name}"`));
      });
    });
  trash
    .command('empty')
    .description('delete everything in the trash for good (or one item with --id)')
    .requiredOption('-w, --workspace <nameOrPath>')
    .option('--id <id>', 'only this item')
    .option('--yes', 'confirm; required, because this cannot be undone')
    .action((o) => {
      if (!o.yes) throw new CliError('Refusing to delete for good without --yes', EXIT.CONFIG_ERROR);
      return withWorkspace(o.workspace, (store) => {
        const n = purgeTrash(store, o.id);
        respond({ deleted: n }, () => console.log(green(`Deleted ${n} item(s) for good`)));
      });
    });
}
