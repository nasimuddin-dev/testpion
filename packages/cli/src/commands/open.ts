import { spawn } from 'node:child_process';
import { Command } from 'commander';
import { ITEM_KINDS, pageArgs, itemRefUrl, parseItemRef, resolveItemRef, WorkspaceSearch, type RefResolution } from '@testpion/core';
import { CliError, EXIT, dim, printJson, withWorkspace, yellow } from '../shared.js';
import { noteError } from '../output.js';
import { reportPage } from '../paging.js';
import { runSearchAsk, type SearchAskOptions } from './search-ask.js';

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
    .command('search [query...]')
    .description(
      'find items in a workspace by name or content, like Quick Open in the app: requests, collections, test files and flows, environments and variables, monitors, history, traces, runs …; each hit has a ref for `testpion open`. With --ask, a question in your own words ("failed payment calls last week over 2 s") is translated by the configured model into a validated query over History, runs, test results and traces and run by TestPion (the model never sees the data); --query-json runs such a query directly',
    )
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: the nearest workspace.json)')
    .option('-n, --limit <n>', 'at most this many hits per page (plain search: default 20, at most 1000; --ask / --query-json: default 25, at most 200); more: --cursor')
    .option('--cursor <cursor>', 'where the page starts: the nextCursor of the page before')
    .option('--offset <n>', 'where the page starts, as a number (the same as --cursor)')
    .option('--ask <question>', 'ask in natural language: History, runs, test results and traces. The model only translates the question into a query (see how it was understood in the output); without a model the words are searched as typed')
    .option('--query-json <spec>', 'run a search query directly: JSON, @file or - for stdin ({"sources": [...], "where": [{"field", "op", "value"}], "sort", "limit"}); no model is called')
    .option('--in <sources>', 'with --ask / --query-json: search only these sources (comma-separated: history, runs, results, traces)')
    .option('--no-ai', 'with --ask: do not call a model; search the words as typed')
    .option('--dry-run', 'with --ask: send nothing, print what would be sent')
    .option('--privacy <level>', 'with --ask: full (redacted, default) | metadata | names')
    .option('--provider <id>', 'with --ask: provider id or name (default: TESTPION_AI_PROVIDER, then the app settings)')
    .option('--model <name>', 'with --ask: model name (default: TESTPION_AI_MODEL, then the app settings)')
    .option('--json', 'print the hits as JSON ({ kind, id, title, subtitle, ref }); with --ask / --query-json the answer: { question, mode, query, explain, chips, assumptions, fallback?, outcome: { rows, matched, truncated, nextCursor?, notes }, usage? }; a cut list also says so in the envelope (page)')
    .action((words: string[], o: { workspace?: string; limit?: string; cursor?: string; offset?: string; json?: boolean } & SearchAskOptions) => {
      if (o.ask !== undefined || o.queryJson !== undefined) return runSearchAsk(words, o);
      if (!words.length) throw new CliError('Give words to search for, or --ask "<question>" / --query-json <spec>', EXIT.CONFIG_ERROR);
      return withWorkspace(o.workspace, (store) => {
        const page = new WorkspaceSearch(store).searchPage(words.join(' '), pageArgs(o));
        const hits = page.items;
        if (o.json) printJson(hits);
        else if (!hits.length) console.log(dim('Nothing found.'));
        else for (const h of hits) console.log(`${h.title}${h.subtitle ? dim(`  ${h.subtitle}`) : ''}  ${dim(`[${h.kind}]`)}  ${dim(itemRefUrl(h.ref as never))}`);
        reportPage(page, o, 'hits');
      });
    });
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
