/**
 * Asking the person before a tool deletes, overwrites or spends, through the client (MCP elicitation), on every revision
 * of the protocol. Up to 2025-11-25 a server sent the question to the client while the call waited; from 2026-07-28 a
 * call answers "input required" with the question, and the client calls again with the answer. The tool code is written
 * once for the second form: the confirmer reads the answer of this call when there is one, and otherwise stops the call
 * with the question (NeedsInput), which the server turns into the "input required" answer. For a client of an earlier
 * revision the SDK asks the old way and enters the call again, so both see the same question.
 *
 * A call is entered twice then, so nothing before the question may change anything: the contract (tool-contract.ts) asks
 * before the tool runs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mcpServer } from './sdk.js';
import type { Confirmer } from './tool-contract.js';

/** The call cannot go on without the person's answer to `question`. */
export class NeedsInput extends Error {
  constructor(readonly question: string) {
    super(`The person's answer is needed: ${question}`);
    this.name = 'NeedsInput';
  }
}

interface Call {
  /** The client can show a question to its user (its `elicitation` capability). */
  canAsk: boolean;
  /** The answers the client sent with this call (`inputResponses`), by the key of the question. */
  answers?: Record<string, unknown>;
}

const calls = new AsyncLocalStorage<Call>();
const KEY = 'confirm';

/** Runs one tool call with what its client can do and what it answered; calls run side by side, each with its own. */
export const withCall = <T>(call: Call, run: () => Promise<T>): Promise<T> => calls.run(call, run);

/** What the client is asked: one yes or no. */
export const confirmQuestion = (message: string) => ({
  key: KEY,
  message,
  requestedSchema: { type: 'object' as const, properties: { confirm: { type: 'boolean' as const, title: 'Go ahead', description: message } }, required: ['confirm'] },
});

/**
 * true or false when the person answered, undefined when the client cannot ask (the caller falls back to `confirm` in the
 * arguments, or a confirmation code); throws NeedsInput when the client can ask and has not yet.
 */
export const inputConfirmer: Confirmer = async (message) => {
  const call = calls.getStore();
  if (!call?.canAsk) return undefined;
  const answer = call.answers?.[KEY] as { action?: unknown; content?: Record<string, unknown> } | undefined;
  // what a client sends is not trusted to have a shape: anything that is not an answer is no answer yet
  if (!answer || typeof answer !== 'object' || typeof answer.action !== 'string') throw new NeedsInput(message);
  return answer.action === 'accept' ? answer.content?.confirm === true : false;
};

const CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';

interface AskingServer {
  /** What the client said it can do when it connected (revisions up to 2025-11-25). */
  getClientCapabilities(): { elicitation?: unknown } | undefined;
}
interface AskingContext {
  mcpReq: { envelope?: Record<string, unknown>; inputResponses?: Record<string, unknown> };
}

/**
 * Runs a tools/call so that the tool can ask the person: with the client's answers of this call, and, when the tool
 * stops for a question, the "input required" answer that carries it. A client of the 2026 revision says what it can do
 * with every request; an earlier one said it once, at the handshake.
 */
export async function callThatCanAsk<T>(server: AskingServer, ctx: AskingContext, run: () => Promise<T>): Promise<T> {
  const capabilities = (ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES] ?? server.getClientCapabilities()) as { elicitation?: unknown } | undefined;
  try {
    return await withCall({ canAsk: !!capabilities?.elicitation, answers: ctx.mcpReq.inputResponses }, run);
  } catch (e) {
    if (!(e instanceof NeedsInput)) throw e;
    const { inputRequired } = mcpServer();
    const q = confirmQuestion(e.question);
    return inputRequired({ inputRequests: { [q.key]: inputRequired.elicit({ message: q.message, requestedSchema: q.requestedSchema }) } }) as T;
  }
}
