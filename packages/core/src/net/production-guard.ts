/**
 * The production guard: one rule for every host (the app's backend, the CLI, the MCP server). An environment marked
 * as production is never changed by accident:
 *
 * - **the engine** refuses a data-changing step (POST/PUT/PATCH/DELETE, a GraphQL mutation, a gRPC call that is not a
 *   read, a message sent over a WebSocket / Socket.IO / MQTT / Kafka connection, an MCP tool call) in a context created
 *   for a production environment unless that context was created with the person's (or the caller's) consent;
 * - **a host** decides what consent is: the app asks once per send or run (and retries the call with
 *   `allowProduction: true`), the CLI takes `--allow-production`, the MCP server needs both its own
 *   `--allow-production` and `allowProduction: true` on the call.
 *
 * Consent travels with the async call (an AsyncLocalStorage), so code deep inside a host (a run that continues after
 * the RPC returned, a data run's rows, a monitor) never has to pass it along by hand: `createEngineContext` reads it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApsError } from '../errors.js';
import { PRODUCTION_CONFIRMATION, productionAskText, type ProductionAsk } from '@testpion/shared';

export { PRODUCTION_CONFIRMATION, isDataChangingMethod, productionAskOf, productionAskText, type ProductionAsk } from '@testpion/shared';

const allowance = new AsyncLocalStorage<boolean>();
let processAllows = false;

/** Run `fn` (and everything it starts, however late) with production consent given or withheld. */
export function allowProductionFor<T>(allowed: boolean, fn: () => T): T {
  return allowance.run(allowed, fn);
}

/** Whether the current call may change a production environment (the CLI's `--allow-production` is the process default). */
export function productionAllowed(): boolean {
  return allowance.getStore() ?? processAllows;
}

/** The CLI: `--allow-production` for the whole command. */
export function setProductionAllowedByDefault(allowed: boolean): void {
  processAllows = allowed;
}

/** A GraphQL document whose operation is a mutation (an unparseable one that says `mutation` counts too). */
export function isGraphQLMutation(type: string | undefined, query: string): boolean {
  return type === 'mutation' || (type === undefined && /(^|[\s{}])mutation\b/.test(query));
}

const GRPC_READ = /^(Get|List|Search|Find|Read|Watch|Describe|Check|Query|Count|Lookup|Fetch|Stream(?!Upload)|Subscribe|Health|Ping|Echo|Info|Status|Validate|Preview|Explain)/;

/** A gRPC method that reads by its name (`pkg.Service/GetPatient`, `grpc.health.v1.Health/Check`); anything else may change data. */
export function isGrpcReadMethod(method: string | undefined): boolean {
  const name =
    String(method ?? '')
      .split(/[/.]/)
      .pop() ?? '';
  return GRPC_READ.test(name) || /\.reflection\.|grpc\.health\./i.test(String(method ?? ''));
}

/** The error a host turns into its question (the app: a dialog; the CLI and MCP: the message with what to pass). */
export function productionRefusal(ask: ProductionAsk, how = 'Confirm it in the app, pass allowProduction: true, or use --allow-production in the CLI.'): ApsError {
  return new ApsError('ConfigurationError', `"${ask.environment}" is a production environment: ${productionAskText(ask)} needs confirmation (the app asks; from the CLI add --allow-production; an agent passes allowProduction: true)`, {
    why: ask.changesData
      ? 'It may change real data, and environments marked as production are not changed without asking.'
      : 'Runs against an environment marked as production are not started without asking.',
    suggestions: [how],
    details: { code: PRODUCTION_CONFIRMATION, ...ask },
  });
}

/** The engine's gate on a production context: who it is for, and whether consent was given when it was created. */
export interface ProductionGate {
  environment: string;
  allowed: boolean;
}

/** Throws the refusal when `gate` is a production context without consent and the step changes data. */
export function assertProductionStep(gate: ProductionGate | undefined, step: { action: string; changesData: boolean }): void {
  if (gate && !gate.allowed && step.changesData) throw productionRefusal({ environment: gate.environment, action: step.action, changesData: true });
}
