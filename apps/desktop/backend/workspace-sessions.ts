/**
 * What belongs to the open workspace and must not outlive it: the servers that answer for it (mocks, the GraphQL mock,
 * flow webhooks, the traffic recorder), its open connections (MCP, WebSocket, Socket.IO, MQTT, Kafka, GraphQL
 * subscriptions), its running data runs, and what the Debugger read from its files. One list for a workspace switch;
 * quitting closes the same things in Backend.dispose, where it waits for them.
 */
import type { Backend } from './backend.js';
import { stopFlowWebhooks } from './handlers/flow-deploy.js';
import { cancelScaleRuns } from './handlers/flow-scale.js';
import { forgetProductionSessions } from './production-guard.js';

const quietly = (fn: () => unknown) => {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch(() => undefined);
  } catch {
    /* closing what is already closed */
  }
};

/** Close everything that served the workspace that is being left. `another`: the folder really changes (not the same one by another name). */
export function closeWorkspaceSessions(be: Backend, another: boolean): void {
  for (const s of be.mcpSessions.values()) quietly(() => s.close());
  be.mcpSessions.clear();
  forgetProductionSessions(be);
  for (const m of be.mocks.values()) quietly(() => m.close());
  be.mocks.clear();
  quietly(() => be.gqlMock?.close());
  be.gqlMock = undefined;
  quietly(() => stopFlowWebhooks(be)); // it served the old workspace's flows
  cancelScaleRuns(be); // data runs and matrices of the old workspace
  if (!another) return;
  // the old workspace's connections and its recorder: nothing in the new one owns them, and a save would write into it
  for (const s of be.wsSessions.values()) quietly(() => s.close());
  be.wsSessions.clear();
  for (const s of be.sioSessions.values()) quietly(() => s.close());
  be.sioSessions.clear();
  for (const s of be.mqttSessions.values()) quietly(() => s.close());
  be.mqttSessions.clear();
  for (const s of be.kafkaSessions.values()) quietly(() => s.closeAndWait());
  be.kafkaSessions.clear();
  for (const s of be.gqlSubs.values()) quietly(() => s.stop());
  be.gqlSubs.clear();
  quietly(() => be.recorder?.close());
  be.recorder = undefined;
  // the Debugger's rules are read once from the workspace's debugger/rules.json: the next read is the new workspace's
  // (kept, the old rules would act on the new one's traffic and be written into its file at the next edit)
  if (be.debugger) be.debugger.rules = undefined;
}
