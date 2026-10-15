/**
 * WF-06: the window's one answer to the production guard. The backend refuses every send and run that would change
 * (or run against) an environment marked as production (backend/production-guard.ts); `call()` hands the refusal here,
 * the person is asked once with the same dialog everywhere, and the call is made again with `allowProduction: true`.
 * Every view gets it, whichever RPC it uses: no view asks on its own.
 *
 * "… and don't ask again" lasts until the app restarts, per workspace, environment and kind (sends, runs).
 * Refusals that arrive while the question is open (a run and a send at once) wait for the same answer.
 */
import { productionAskOf, productionAskText, type ProductionAsk } from '@testpion/shared';
import { setCallRecovery } from '../api';
import { ask, useApp } from '../store';

const allowedThisSession = new Set<string>();
const pending = new Map<string, Promise<boolean>>();

const keyOf = (a: ProductionAsk) => `${useApp.getState().workspace?.id ?? ''}\u0000${a.environment.toLowerCase()}\u0000${a.run ? 'run' : 'send'}`;

/** The question for one ask (exported for the tests): its title, message and the confirm button's label. */
export function productionQuestion(a: ProductionAsk): { title: string; message: string; confirm: string; always: string } {
  const verb = a.run ? 'Run' : 'Send';
  return {
    title: a.run ? `Run against ${a.environment}?` : `Send to ${a.environment}?`,
    message: `"${a.environment}" is a production environment. ${productionAskText(a)}${a.changesData ? ' may change real data.' : '.'}`,
    confirm: verb,
    always: `${verb} and don't ask again`,
  };
}

/** Ask the person (once for concurrent refusals of the same kind); true when they confirmed. */
export async function confirmProduction(a: ProductionAsk): Promise<boolean> {
  const key = keyOf(a);
  if (allowedThisSession.has(key)) return true;
  const open = pending.get(key);
  if (open) return open;
  const q = productionQuestion(a);
  const answer = ask({
    title: q.title,
    message: q.message,
    tone: 'warning',
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'always', label: q.always },
      { id: 'go', label: q.confirm, variant: 'danger' },
    ],
    cancelId: 'cancel',
  }).then((choice) => {
    if (choice === 'always') allowedThisSession.add(key);
    return choice === 'go' || choice === 'always';
  });
  pending.set(key, answer);
  try {
    return await answer;
  } finally {
    pending.delete(key);
  }
}

/** The error a declined confirmation leaves the caller with (shown like any failed send or run). */
function declined(a: ProductionAsk): Error {
  return Object.assign(new Error(`Not ${a.run ? 'run' : 'sent'}: "${a.environment}" is a production environment and it was not confirmed`), {
    kind: 'CancelledError',
    what: 'Cancelled',
    why: 'Sending to an environment marked as production needs a confirmation.',
    suggestions: [],
    details: { code: 'PRODUCTION_DECLINED', environment: a.environment },
  });
}

/** Forget the session's "don't ask again" answers (tests; a workspace switch keeps them per workspace anyway). */
export function resetProductionAnswers(): void {
  allowedThisSession.clear();
}

setCallRecovery(async (e, _method, params) => {
  const a = productionAskOf(e);
  // a call that already carried consent and was refused again is not asked about twice
  if (!a || (params as { allowProduction?: unknown } | undefined)?.allowProduction === true) return undefined;
  if (!(await confirmProduction(a))) throw declined(a);
  return { ...((params as object | undefined) ?? {}), allowProduction: true };
});
