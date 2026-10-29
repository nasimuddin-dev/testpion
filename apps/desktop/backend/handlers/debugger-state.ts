/** The Debugger's state in the backend (handlers/debugger.ts uses it; debugger-rules.ts and debugger-reverse.ts read it). */
import { DebuggerSession, type DebuggerExchange, type DebuggerProxy, type DebuggerRulesFile, type Gateway, type GatewayConfig, type NetworkSpeed } from '@testpion/core';
import { type LeafCertificate, type RootCertificate, type SystemProxySnapshot } from '@testpion/core/desktop';
import type { PendingBreakpoint } from './debugger-rules.js';

/** A request one of the workspace's mock servers received. */
export interface IncomingRequest {
  id: string;
  time: string;
  collectionId: string;
  server?: string;
  method: string;
  path: string;
  status: number;
  example?: string;
  forwarded?: boolean;
  /** The mock server's address (http://127.0.0.1:port). */
  base?: string;
  query?: string;
  headers?: Record<string, string>;
  body?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  ms?: number;
}

/** A header shown as a grid column. */
export interface HeaderColumn {
  name: string;
  side: 'request' | 'response';
}

export interface ListSync {
  rev: number;
  epoch: number;
  nextSeq: number;
  /** When the session's first request started (the grid's Offset counts from it). */
  firstAt?: number;
  seqs: WeakMap<DebuggerExchange, number>;
  revs: WeakMap<DebuggerExchange, number>;
}

/** The state before anything was captured: an empty session. */
export function newDebuggerState(): DebuggerState {
  const session = new DebuggerSession();
  return { session, exchanges: session.items };
}

export interface DebuggerState {
  proxy?: DebuggerProxy;
  /** Kept across stop / start, until cleared: the session, with its limits; `exchanges` is its array. */
  session: DebuggerSession;
  exchanges: DebuggerExchange[];
  /** The system proxy as it was before TestPion switched it to ours (restored on stop, on clear and when the app quits). */
  systemProxy?: SystemProxySnapshot;
  /** AutoSave: the live session is written to debugger/autosave.har every minute while something changed. */
  autosave?: ReturnType<typeof setInterval>;
  dirty?: boolean;
  /** The rules file (handlers/debugger-rules.ts), read once; the proxy asks for the active profile's rules on every request. */
  rules?: DebuggerRulesFile;
  /** Listing is paused (Pause in the capture bar): the proxy keeps forwarding and rules keep acting, but nothing new is listed. */
  paused?: boolean;
  /** Exchanges held at a breakpoint, waiting for the window. */
  breakpoints?: Map<string, PendingBreakpoint>;
  /** HTTPS decryption (DBG-4): on or off for the session; hosts kept opaque; the root and the per-host signer. */
  decrypt?: boolean;
  noDecrypt?: string[];
  root?: RootCertificate;
  leafFor?(host: string): LeafCertificate;
  /** The Network speed switch (FG-1): while set, the proxy paces the traffic it forwards. Not saved: a restart is full speed. */
  speed?: NetworkSpeed;
  /** FG-9: the gateway, extra authorities and client certificates, resolved (the proxy reads `gateway` for every upstream connection), the saved settings, and a one-line account of them. */
  gateway?: Gateway;
  gatewayConfig?: GatewayConfig;
  gatewaySummary?: string;
  /** FG-28: large-session mode is on (older exchanges go to a file instead of being forgotten). */
  spoolOn?: boolean;
  /** Listening on the local network (a phone, another computer), not only on this computer. */
  lan?: boolean;
  /** Requests TestPion's mock servers received (the Incoming tab): at most the last 2000. */
  incoming?: IncomingRequest[];
  /**
   * The window's list stays in sync by changes, not by reloading it: every exchange has a place in the session (seq,
   * the grid's #) and a revision; `rev` is the latest; `epoch` changes when the list is replaced or rows removed.
   */
  list?: ListSync;
  /** Header columns the grid shows (FG-12): the lean rows carry these headers' values. Set by the window (debug.columns). */
  columns?: HeaderColumn[];
  columnsGen?: number;
  /** Put everything back (the system proxy) and stop the timers; the backend calls it when it is disposed. */
  release?(): Promise<void>;
  /** The exchanges of the session on screen (the live capture, or a saved session's tab): what selections refer to. */
  view?(): DebuggerExchange[];
  /**
   * Add an exchange another capture mode made (the reverse proxy, handlers/debugger-reverse.ts) to the session, as the
   * proxy's own are: the grid, AutoSave and the list's changes see it the same.
   */
  capture?(e: DebuggerExchange): void;
}
