import { WebSocketSession } from '../websocket/websocket.js';
import { ApsError } from '../../errors.js';
import type { KeyValue } from '../../model/types.js';
import type { CookieJar } from '../../cookies/cookie-jar.js';

/**
 * GraphQL subscriptions over WebSocket. Both protocols in use are offered and the server picks one:
 * `graphql-transport-ws` (the graphql-ws library: connection_init → subscribe → next / error / complete)
 * and the older `graphql-ws` (subscriptions-transport-ws: connection_init → start → data / error / complete).
 */
export interface SubscriptionEvent {
  type: 'status' | 'next' | 'error' | 'complete';
  time: number;
  /** `next`: the payload ({ data, errors? }); `error`: the errors; `status`: a message. */
  data?: unknown;
  message?: string;
}

export interface GraphQLSubscription {
  id: string;
  protocol: string;
  stop(): void;
  /** Resolves when the server completes the subscription or the connection closes. */
  done: Promise<void>;
}

/**
 * Subscribe, collect up to `maxEvents` `next` payloads (or until `timeoutMs` / completion), then stop.
 * For the CLI and AI agents, which need a result rather than a stream.
 */
export async function collectSubscriptionEvents(opts: Omit<Parameters<typeof startGraphQLSubscription>[0], 'onEvent'> & { maxEvents?: number; durationMs?: number; signal?: AbortSignal }): Promise<{ protocol: string; events: unknown[]; errors: unknown[]; completed: boolean }> {
  const events: unknown[] = [];
  const errors: unknown[] = [];
  let completed = false;
  let stop: () => void = () => undefined;
  const enough = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const sub = await startGraphQLSubscription({
    ...opts,
    onEvent: (e) => {
      if (e.type === 'next') {
        events.push(e.data);
        if (events.length >= (opts.maxEvents ?? 10)) stop();
      } else if (e.type === 'error') errors.push(e.data);
      else if (e.type === 'complete') completed = true;
    },
  });
  const timer = setTimeout(stop, opts.durationMs ?? 30_000);
  // a stopped run ends the wait at once
  if (opts.signal?.aborted) stop();
  else opts.signal?.addEventListener('abort', () => stop(), { once: true });
  await Promise.race([enough, sub.done]);
  clearTimeout(timer);
  sub.stop();
  return { protocol: sub.protocol, events, errors, completed };
}

/** http(s)://host/graphql → ws(s)://host/graphql; ws URLs are kept. */
export function subscriptionUrl(endpoint: string): string {
  return endpoint.replace(/^http(s?):\/\//i, 'ws$1://');
}

export async function startGraphQLSubscription(opts: {
  url: string;
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  headers?: KeyValue[];
  /** Sent with connection_init (e.g. { authorization: "Bearer …" }). */
  connectionParams?: Record<string, unknown>;
  cookieJar?: CookieJar;
  onEvent: (e: SubscriptionEvent) => void;
  timeoutMs?: number;
}): Promise<GraphQLSubscription> {
  const session = new WebSocketSession(subscriptionUrl(opts.url), { protocols: ['graphql-transport-ws', 'graphql-ws'], headers: opts.headers, cookieJar: opts.cookieJar });
  const emit = (e: Omit<SubscriptionEvent, 'time'>) => opts.onEvent({ ...e, time: Date.now() });
  const opId = '1';
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  let acked = false;
  let ackResolve!: () => void;
  let ackReject!: (e: Error) => void;
  const ack = new Promise<void>((res, rej) => ((ackResolve = res), (ackReject = rej)));
  let modern = true;
  const send = (m: unknown) => session.send(JSON.stringify(m));

  session.onMessage((m) => {
    if (m.direction !== 'received') return;
    let msg: { type?: string; id?: string; payload?: unknown };
    try {
      msg = JSON.parse(m.data);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'connection_ack':
        acked = true;
        ackResolve();
        break;
      case 'connection_error':
        ackReject(new ApsError('AuthenticationError', `The server refused the connection: ${JSON.stringify(msg.payload)}`));
        break;
      case 'ping':
        send({ type: 'pong' });
        break;
      case 'ka':
        break;
      case 'next':
      case 'data':
        emit({ type: 'next', data: msg.payload });
        break;
      case 'error':
        emit({ type: 'error', data: msg.payload, message: 'The server reported an error for the subscription' });
        break;
      case 'complete':
        emit({ type: 'complete', message: 'The server completed the subscription' });
        session.close();
        break;
    }
  });
  session.onStatus((s) => {
    if (s === 'closed') {
      if (!acked) ackReject(new ApsError('NetworkError', 'The connection closed before the server acknowledged it'));
      emit({ type: 'status', message: 'Connection closed' });
      finish();
    }
  });

  await session.connect(opts.timeoutMs ?? 15_000);
  modern = session.protocol !== 'graphql-ws';
  emit({ type: 'status', message: `Connected (${session.protocol || 'no subprotocol'})` });
  send({ type: 'connection_init', ...(opts.connectionParams ? { payload: opts.connectionParams } : {}) });
  const timer = setTimeout(() => ackReject(new ApsError('TimeoutError', 'The server did not acknowledge the connection (connection_ack)')), opts.timeoutMs ?? 15_000);
  try {
    await ack;
  } catch (e) {
    session.close();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const payload = { query: opts.query, variables: opts.variables ?? {}, ...(opts.operationName ? { operationName: opts.operationName } : {}) };
  send(modern ? { id: opId, type: 'subscribe', payload } : { id: opId, type: 'start', payload });
  emit({ type: 'status', message: 'Subscribed' });
  return {
    id: session.id,
    protocol: session.protocol,
    stop: () => {
      if (session.status === 'open') {
        send(modern ? { id: opId, type: 'complete' } : { id: opId, type: 'stop' });
        if (!modern) send({ type: 'connection_terminate' });
      }
      session.close();
    },
    done,
  };
}
