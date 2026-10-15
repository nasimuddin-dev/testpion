import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { ITEM_KINDS, itemRefUrl, parseItemRef, resolveItemRef, WorkspaceSearch, type RefResolution } from '@testpion/core';
import { CliError, EXIT, dim, printJson, withWorkspace, yellow } from '../shared.js';
import { noteError } from '../output.js';

/** Hand a testpion:// link to the OS, which starts the app (or brings the running one forward) on that item. */
function launch(url: string): void {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => undefined);
  child.unref();
}

/**
 * `testpion open <ref>`: bring the TestPion app to one item (a request, a run, a test file, a history entry …) by its
 * ItemRef, the `ref` field of `--json` output and MCP tool results. Checked against the workspace first: a ref to
 * something gone says why and what is still there (exit 2) instead of opening an empty editor.
 */
export function registerOpenCommand(program: Command): void {
  // `testpion search`: the app's Quick Open from a shell (each hit's ref goes to `testpion open`)
  program
    .command('search <query...>')
    .description('find items in a workspace by name or content, like Quick Open in the app: requests, collections, test files and flows, environments and variables, monitors, history, traces, runs …; each hit has a ref for `testpion open`')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: the nearest workspace.json)')
    .option('-n, --limit <n>', 'at most this many hits', '20')
    .option('--json', 'print the hits as JSON ({ kind, id, title, subtitle, ref })')
    .action((words: string[], o: { workspace?: string; limit: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const hits = new WorkspaceSearch(store).search(words.join(' '), Math.min(Math.max(Number(o.limit) || 20, 1), 100));
        if (o.json) return printJson(hits);
        if (!hits.length) return console.log(dim('Nothing found.'));
        for (const h of hits) console.log(`${h.title}${h.subtitle ? dim(`  ${h.subtitle}`) : ''}  ${dim(`[${h.kind}]`)}  ${dim(itemRefUrl(h.ref as never))}`);
      }),
    );
  program
    .command('open <ref>')
    .description(
      `open an item in the TestPion app by its ref: a testpion://open link, the JSON of a "ref" field, or kind:id (request:<collectionId>:<requestId>, run:<runId>, test:<path>). Kinds: ${ITEM_KINDS.join(', ')}`,
    )
    .option('-w, --workspace <nameOrPath>', 'check it in this workspace first (default: the nearest workspace.json)')
    .option('--no-check', 'do not look it up in a workspace; just open the link')
    .option('--print', 'print the testpion:// link instead of opening it')
    .option('--json', 'print {ref, url, resolution} as JSON instead of opening it')
    .action(async (text: string, o: { workspace?: string; check: boolean; print?: boolean; json?: boolean }) => {
      const ref = parseItemRef(text);
      if (!ref) throw new CliError(`Not a ref: "${text}". Give a testpion://open link, {"kind": …} JSON, or kind:id with kind one of ${ITEM_KINDS.join(', ')}`, EXIT.CONFIG_ERROR);
      let resolution: RefResolution | undefined;
      if (o.check) resolution = await withWorkspace(o.workspace, (store, ephemeral) => (ephemeral ? undefined : resolveItemRef(store, ref)));
      const url = itemRefUrl(resolution?.ok ? resolution.ref : ref);
      if (o.json) {
        printJson({ ref: resolution?.ok ? resolution.ref : ref, url, ...(resolution ? { resolution } : {}) });
        if (resolution && !resolution.ok) {
          // the envelope's errors say why (the data still has the resolution: what is still there)
          noteError(
            Object.assign(new CliError(resolution.message, EXIT.CONFIG_ERROR), {
              hint: resolution.next ? `Next: ${resolution.next.label}.` : '`testpion search <name>` finds what is there now.',
            }),
          );
          process.exitCode = EXIT.CONFIG_ERROR;
        }
        return;
      }
      if (resolution && !resolution.ok) throw new CliError(`${resolution.message}${resolution.next ? ` Next: ${resolution.next.label}.` : ''}`, EXIT.CONFIG_ERROR);
      if (o.print) return console.log(url);
      launch(url);
      console.log(`${resolution?.ok ? `Opening ${resolution.label}` : 'Opening'} in TestPion ${dim(url)}`);
      if (!resolution) console.log(yellow('Not checked against a workspace (none here): the app says so if it is gone.'));
    });
}
