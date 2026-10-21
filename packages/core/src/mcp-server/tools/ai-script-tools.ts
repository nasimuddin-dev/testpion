/**
 * MCP tool for AI-6 (the script helper): `write_script` writes a pre-request or post-response script in the tp.* script API
 * (never pm.*) for a description — or fixes a script that threw, from its error and logs — and runs it once in the sandbox
 * before offering it. It proposes: `ai_apply_proposal` puts it on the saved request, after the user agrees.
 */
import { parseItemRef, toItemRef } from '@testpion/shared';
import { ApsError } from '../../errors.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { createProposer, PRIVACY } from './ai-propose.js';
import { str, type Tool } from '../tool.js';

export function aiScriptTools({ store, secrets, settings }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings }): Tool[] {
  const propose = createProposer({ store, secrets, settings });
  return [
    {
      name: 'write_script',
      description:
        "Write a TestPion script with the model the user configured (their key or a local model): a pre-request script (change the request about to be sent, keep a value in a variable) or a post-response script (tp.test checks, keep a value for later requests) for `describe` — or, with `script` and `error`, the same script fixed. It uses the tp.* script API as the sandbox really has it (never pm.*) and is verified before it is offered: every member is checked, then it is parsed and run once in the sandbox against the request or the saved request's latest response; the badge says what it did (variables set, headers changed, tests run) and a script that throws or fails on its response is repaired, not returned as ready. Nothing is written: with `request` (a saved request) apply the proposal with ai_apply_proposal after the user agrees (mode append adds it after the request's own script). `dryRun` returns what would be sent.",
      inputSchema: {
        type: 'object',
        properties: {
          describe: str('What the script should do, e.g. "save the first order id whose status is paid"'),
          phase: { type: 'string', enum: ['pre', 'post'], description: 'pre: before the request is sent; post: after the response (default post)' },
          request: { description: 'A saved request (request:<collectionId>:<requestId> or its ref): its request and latest response are the context, and the script is proposed for it' },
          script: str('The script as it is now (to extend or fix)'),
          error: str('The error it threw'),
          logs: { type: 'array', items: { type: 'string' }, description: 'Its console output' },
          mode: { type: 'string', enum: ['replace', 'append'], description: 'append: add it after the request’s own script when applied; default replace' },
          hint: str('An extra instruction'),
          privacy: PRIVACY,
          environment: str('Environment whose variable names (never values) the script may use'),
          dryRun: { type: 'boolean', description: 'Send nothing: return what would be sent and the estimate' },
        },
        required: ['describe'],
      },
      run: (a) => {
        if (!a.describe && !a.error) throw new ApsError('ValidationError', 'describe is required: what the script should do');
        const ref = a.request ? (typeof a.request === 'string' ? parseItemRef(a.request) : toItemRef(a.request)) : undefined;
        if (a.request && (!ref || ref.kind !== 'request')) throw new ApsError('ValidationError', 'request must be a saved request: request:<collectionId>:<requestId>');
        const phase = a.phase === 'pre' ? 'pre' : 'test';
        return propose({
          task: 'write-script',
          item: ref,
          question: String(a.describe ?? 'Fix this script'),
          context: { phase, mode: a.mode === 'append' ? 'append' : 'replace', ...(a.script ? { script: String(a.script) } : {}), ...(a.error ? { error: String(a.error) } : {}), ...(Array.isArray(a.logs) ? { logs: a.logs.map(String) } : {}) },
          a,
          next: (p) =>
            `Show the user the script (proposal.items[0].after) and what the dry run did (its verification badge); ${ref ? `apply it with ai_apply_proposal { id: "${p.id}" } after they agree` : 'they paste it into the script editor'}.`,
        });
      },
    },
  ];
}
