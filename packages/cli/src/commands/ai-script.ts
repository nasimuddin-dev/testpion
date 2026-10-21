/**
 * `testpion ai script` (AI-6): a pre-request or post-response script written for a description with the model the user
 * configured — or a script that threw, fixed from its error and logs — in the tp.* script API (never pm.*), run once in
 * the sandbox before it is offered. A proposal: nothing is written until `--apply` (it needs a saved request), or you copy
 * the script from the printed proposal / the `--json` envelope.
 */
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { parseItemRef } from '@testpion/core';
import { bold, cliContext, CliError, dim, EXIT, green, withWorkspace, WORKSPACE_OPTION } from '../shared.js';
import { machine } from '../output.js';
import { proposeCommand } from './ai-propose.js';

export function registerAiScriptCommand(ai: Command): void {
  ai.command('script')
    .description(
      'write a tp.* script with AI (or fix one that threw): a pre-request script (change the request about to be sent, keep a value in a variable) or a post-response script (tp.test checks, keep a value for later requests). It is parsed and run once in the sandbox against the request / the saved request’s latest response before it is offered, and the proposal says what it did; a script that throws or fails on its response is repaired. Nothing is written until --apply (with --request) ',
    )
    .requiredOption('-d, --describe <text>', 'what the script should do, e.g. "save the id of the first paid order in a variable"')
    .option('--request <ref>', 'a saved request (request:<collectionId>:<requestId>): its request and latest response are the context, and --apply puts the script on it')
    .option('--phase <phase>', 'pre (before the request is sent) or post (after the response)', 'post')
    .option('--script <file>', 'the script as it is now (to extend or fix): a file, or - for standard input')
    .option('--error <text>', 'the error it threw (to fix it)')
    .option('--mode <mode>', 'replace (default) or append: with --apply, add it after the request’s own script')
    .option('--hint <text>', 'an extra instruction')
    .option('--privacy <level>', 'full (redacted, default) | metadata | names')
    .option('--provider <id>', 'provider id or name (default: TESTPION_AI_PROVIDER, then the app settings)')
    .option('--model <name>', 'model name (default: TESTPION_AI_MODEL[_LARGE], then the app settings)')
    .option('--dry-run', 'send nothing: print what would be sent (messages, sections, tokens, cost, what was masked)')
    .option('--apply', 'with --request: put the script on the saved request (ai undo restores it)')
    .option('-e, --environment <name>', 'environment whose variable names (never values) the script may use')
    .option(...WORKSPACE_OPTION)
    .option('--json', 'print { proposal, usage, applied } as JSON (for scripts and AI agents)')
    .action(
      async (o: {
        describe: string;
        request?: string;
        phase: string;
        script?: string;
        error?: string;
        mode?: string;
        hint?: string;
        privacy?: string;
        provider?: string;
        model?: string;
        dryRun?: boolean;
        apply?: boolean;
        environment?: string;
        workspace?: string;
        json?: boolean;
      }) =>
        withWorkspace(o.workspace, async (store) => {
          const item = o.request ? parseItemRef(o.request) : undefined;
          if (o.request && item?.kind !== 'request') throw new CliError(`--request: "${o.request}" is not a saved request (request:<collectionId>:<requestId>)`, EXIT.CONFIG_ERROR);
          if (o.apply && !item) throw new CliError('--apply needs --request: the script is put on a saved request (else copy it from the proposal)', EXIT.CONFIG_ERROR);
          if (o.phase !== 'pre' && o.phase !== 'post') throw new CliError('--phase is pre or post', EXIT.CONFIG_ERROR);
          const script = o.script ? readFileSync(o.script === '-' ? 0 : o.script, 'utf8') : undefined;
          const ctx = cliContext(store, o.environment);
          try {
            await proposeCommand({
              store,
              ctx,
              json: !!o.json || machine(),
              task: 'write-script',
              item,
              question: o.describe,
              context: { phase: o.phase === 'pre' ? 'pre' : 'test', mode: o.mode === 'append' ? 'append' : 'replace', ...(script ? { script } : {}), ...(o.error ? { error: o.error } : {}) },
              hint: o.hint,
              privacy: o.privacy,
              provider: o.provider,
              model: o.model,
              dryRun: o.dryRun,
              apply: o.apply,
              appliedHint: () => `it is on the request now`,
              show: (p) => {
                const it = p.items[0];
                if (!it) return;
                console.log(bold(it.title) + dim(it.target ? ` · ${o.request}` : ''));
                console.log(green(it.after.replace(/^\/\/ AI-generated.*\n/, '').trimEnd().replace(/^/gm, '  ')));
              },
            });
          } finally {
            await ctx.dispose();
          }
        }),
    );
}
