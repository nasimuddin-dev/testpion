/**
 * RPC handlers: JS rule scripts (FG-21). `debug.testScript` runs a rule's script (as it is in the editor, saved or not) against a captured
 * exchange and says what it would do, sending nothing; `debug.scriptRun` is the last real run of a saved rule (its error or its logs).
 */
import { ApsError, lastScriptRun, ruleMatches, testRuleScript, type DebuggerRule } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { newDebuggerState } from './debugger-state.js';
import { cleanRule } from './debugger-rules.js';

export function debuggerScriptHandlers(be: Backend): Handlers {
  const red = be.logger.redactor;
  const state = () => (be.debugger ??= newDebuggerState());
  return {
    'debug.testScript': async ({ rule, id }: { rule: Partial<DebuggerRule>; id: string }) => {
      const r = cleanRule({ ...rule, kind: 'script' }, rule.id ?? 'test');
      const e = (state().view?.() ?? state().exchanges).find((x) => x.id === id);
      if (!e) throw new ApsError('ValidationError', 'That exchange is no longer in the session. Pick another one.');
      const t = await testRuleScript(r, e, ruleMatches(r, e, 'request'), be.ws.root);
      // what a script logs or does may repeat a secret of the exchange
      return { ...t, phases: t.phases.map((p) => ({ ...p, logs: p.logs.map((l) => red.redactString(l)), does: p.does.map((l) => red.redactString(l)), ...(p.error ? { error: red.redactString(p.error) } : {}) })) };
    },
    'debug.scriptRun': ({ id }: { id: string }) => {
      const r = lastScriptRun(id);
      return r ? { phase: r.phase, ran: r.ran, ms: r.ms, error: r.error && red.redactString(r.error), logs: r.logs.map((l) => red.redactString(l)) } : null;
    },
  };
}
