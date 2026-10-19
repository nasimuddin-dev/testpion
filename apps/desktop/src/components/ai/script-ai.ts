import type { ItemRef } from '@testpion/shared';
import { aiMenuItems } from '../../lib/ai-menu';
import { promptText, type AiResponse, type AssistantApplied, type AssistantRequest } from '../../store';
import type { MenuItem } from '../ui';
import { startAi } from './AiAction';

/**
 * The script editors' AI entry (AI-6): "Write a script with AI…", "Fix this script with AI…" and "Explain this script with
 * AI", on Pre-request and Post-response scripts alike. The request goes through the same assistant panel and proposal review
 * as every generating AI action: the script is written for the tp.* API as the sandbox has it (never pm.*), run once in the
 * sandbox against the request / the response on screen before it is offered, and Accept puts it into the editor (its own
 * undo; nothing is saved until the request is). The items come from the one AI table (aiMenuItems), so Settings ▸ Hide all
 * AI actions removes them with the rest.
 */

/** What the script editor knows about the request it belongs to (the REST editor passes it; a folder or collection script has none). */
export interface ScriptAiContext {
  /** The saved request (the proposal is for it; its latest response is the response to try a post-response script on). */
  item?: ItemRef;
  /** The request as the editor has it, unsaved edits included. */
  request?: { method: string; url: string; headers?: Array<{ key: string; value: string; enabled?: boolean }>; body?: string };
  /** The response on screen and the one before it: a post-response script is run on them. */
  response?: AiResponse;
  previous?: AiResponse;
}

type Phase = 'pre' | 'post';

/** The assistant request for one script (see the module comment). */
export function writeScriptAi(o: {
  description: string;
  phase: Phase;
  script: string;
  error?: string;
  ctx?: ScriptAiContext;
  /** Put the code in the editor: replace its script or add after it. */
  use(code: string, mode: 'replace' | 'append'): AssistantApplied;
}): AssistantRequest {
  const mode = o.error ? 'replace' : o.script.trim() ? 'append' : 'replace';
  const r = o.ctx?.response;
  return {
    task: 'write-script',
    title: o.error ? 'Fix the script' : 'Write a script',
    question: o.description,
    context: {
      phase: o.phase === 'pre' ? 'pre' : 'test',
      mode,
      ...(o.script.trim() ? { script: o.script } : {}),
      ...(o.error ? { error: o.error } : {}),
      ...(o.ctx?.request ? { request: { ...o.ctx.request, headers: (o.ctx.request.headers ?? []).filter((h) => h.enabled !== false && h.key).map((h) => ({ key: h.key, value: h.value })) } } : {}),
      ...(r ? { status: r.status, headers: r.headers?.slice(0, 20), body: r.body, ...(r.latencyMs !== undefined ? { latencyMs: r.latencyMs } : {}) } : {}),
    },
    ...(r ? { response: r } : {}),
    ...(o.ctx?.previous ? { previous: o.ctx.previous } : {}),
    ...(o.ctx?.item ? { item: o.ctx.item } : {}),
    autoReview: true,
    apply: { label: mode === 'append' ? 'Add to the script' : 'Use this script', run: (code) => o.use(code, mode) },
  };
}

/** The menu of the editor's "Script with AI" button: Write, Fix (when there is a script) and Explain. */
export function scriptAiItems(o: { phase: Phase; script: string; ctx?: ScriptAiContext; use(code: string, mode: 'replace' | 'append'): AssistantApplied }): MenuItem[] {
  const has = !!o.script.trim();
  return [
    ...aiMenuItems('writeScript', () => {
      void promptText('Write a script with AI', {
        message: o.phase === 'pre' ? 'What should run before the request is sent? The assistant writes it with the tp.* API and tries it once in the sandbox.' : 'What should run after the response? The assistant writes it with the tp.* API and tries it on the response on screen.',
        placeholder: o.phase === 'pre' ? 'send a fresh nonce in an X-Nonce header and keep it in a variable' : 'save the id of the first paid order in a variable',
        okLabel: 'Write',
        detail: has ? 'The new code is added after the script you have.' : undefined,
      }).then((description) => description && startAi(writeScriptAi({ ...o, description })));
    }),
    ...(has
      ? aiMenuItems('fixScript', () => {
          void promptText('Fix this script with AI', {
            message: 'What went wrong? Paste the error from the console or say what you expected.',
            placeholder: "TypeError: cannot read property 'token' of undefined",
            okLabel: 'Fix',
          }).then((error) => error && startAi(writeScriptAi({ ...o, description: 'Fix this script', error })));
        })
      : []),
    ...(has ? aiMenuItems('explainScript', () => startAi({ task: 'explain-script', title: 'Explain this script', context: { phase: o.phase === 'pre' ? 'pre' : 'test', script: o.script } })) : []),
  ];
}
