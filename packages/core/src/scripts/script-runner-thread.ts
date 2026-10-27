import { evaluateExpressionInThread, renderTemplateInThread, runMetricScriptInThread, runScriptInThread } from './sandbox.js';
import type { ScriptRunner } from './script-runner.js';

/** The engine in the calling thread: the default runner of the CLI, tests and the desktop app. */
export const threadScriptRunner: ScriptRunner = {
  kind: 'thread',
  runScript: runScriptInThread,
  evaluateExpression: evaluateExpressionInThread,
  renderTemplate: renderTemplateInThread,
  runMetricScript: runMetricScriptInThread,
  dispose: async () => undefined,
};
