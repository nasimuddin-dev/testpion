import type { ProgramInfo } from './programs.js';
import type { DebuggerSession } from './session.js';
import type { DebuggerRule, HighlightStyle } from './rules.js';
import type { DebuggerSseEvent, WebSocketFrame } from './frames.js';
import type { NetworkSpeed } from './network-speed.js';
import type { LeafCertificate } from './certificate.js';
import type { TlsInfo } from '@testpion/shared';
import type { GrpcCapture } from './grpc.js';
import type { Gateway } from './gateway.js';

/** The HTTP Debugger proxy's data shapes (an exchange, the breakpoint edits, the options), apart from proxy.ts to keep that file within its size. */
export interface DebuggerExchange {
  id: string;
  /** When the request arrived (ISO). */
  startedAt: string;
  /** 'http' for a captured request, 'tunnel' for an HTTPS CONNECT (host only), 'websocket' for an upgraded connection. */
  kind: 'http' | 'tunnel' | 'websocket';
  /** How it came in: through the proxy (unset), or the reverse proxy standing in front of one server (`reverse`). */
  source?: 'proxy' | 'reverse';
  method: string;
  url: string;
  host: string;
  /** The port the client connected from, and the program behind it when it could be found. */
  clientPort: number;
  application?: string;
  /** The program's process id and the account it runs as, when they could be found with the program. */
  pid?: number;
  user?: string;
  /** The server's address the request went to (ip:port), once connected. */
  serverAddress?: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  requestBodyBytes: number;
  requestBodyTruncated?: boolean;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  responseBodyBytes: number;
  responseBodyTruncated?: boolean;
  /** The bodies were let go to keep the session within its memory budget (the oldest go first). */
  bodiesDropped?: boolean;
  contentType?: string;
  /** Milliseconds: until the request was sent whole, until the server answered its headers, and until the body ended. */
  sendMs?: number;
  waitMs?: number;
  durationMs?: number;
  error?: string;
  /** Set by the user (a star) or a rule (a colour). */
  bookmarked?: boolean;
  /** The user's comment on it, and a colour mark (red, orange, yellow, green, blue, purple, grey): saved in the HAR. */
  note?: string;
  mark?: string;
  /** A highlight rule's text colours, bold and whole row (with `highlight`). */
  highlightStyle?: HighlightStyle;
  highlight?: string;
  /** The rules that acted on this exchange, by name. */
  rules?: string[];
  /** A redirect rule sent it here instead. */
  redirectedTo?: string;
  /** A reply rule answered; the server never saw it. */
  repliedByRule?: boolean;
  /** A breakpoint held it, and the user changed it. */
  edited?: boolean;
  /** Captured inside a decrypted HTTPS tunnel. */
  tls?: boolean;
  /** Still streaming (a WebSocket, Server-Sent Events). */
  open?: boolean;
  /** WebSocket frames, both directions (up to a limit). */
  frames?: WebSocketFrame[];
  /** Server-Sent Events (up to a limit). */
  events?: DebuggerSseEvent[];
  /** DBG-5: '2' for HTTP/2 (inside a decrypted tunnel, or h2c); the connection the request came on; its stream. */
  httpVersion?: '1.1' | '2';
  connectionId?: string;
  streamId?: number;
  /** A gRPC call: its messages both ways, decoded, and the status from the trailers. */
  grpc?: GrpcCapture;
  /** HTTP/2 trailers (gRPC's status lives there). */
  trailers?: Record<string, string>;
  /** FG-8: a body with a view that is not text (image, MessagePack, Protobuf), whole as base64 if it fits the body limit. */
  requestBodyBase64?: string; responseBodyBase64?: string;
  /** FG-10: the TLS connection to the server. */
  connection?: TlsInfo;
}

/** What a breakpoint hands back: edits to apply, or nothing to let it go on as it was. */
export interface BreakpointEdits {
  abort?: boolean;
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  status?: number;
}

export interface DebuggerProxyOptions {
  port?: number;
  /** The session the captured exchanges go into (the app shares one across stop / start); a new one otherwise. */
  session?: DebuggerSession;
  /** Without a session given: how many bytes of bodies it keeps in memory in all (default 200 MB). */
  maxSessionBodyBytes?: number;
  /**
   * Listen on every interface (a phone, another computer), not only this one. A client that is not on this computer must
   * prove it was paired: it sends the pairing secret as the password of `Proxy-Authorization` (Basic), or opened the proxy's
   * own page with `/?pair=<secret>` (the QR code), which pairs its address for 8 hours. It also cannot reach this computer's
   * loopback or link-local addresses through the proxy.
   */
  lan?: boolean;
  /** The pairing secret of a LAN proxy (default: a new random one, `DebuggerProxy.pairingSecret`). */
  lanSecret?: string;
  maxBodyBytes?: number;
  /** The most a body is held in memory so that rules and breakpoints can change it (default 64 MB); a bigger one is sent on as it arrives, unchanged. */
  holdLimitBytes?: number;
  /** `update`: something learned later changed a listed exchange (its program, found after the response). */
  onExchange?(e: DebuggerExchange, phase: 'request' | 'response' | 'update'): void;
  /** Which program owns a client port (see applicationOfPort); replaceable in tests. */
  applicationOf?(port: number): Promise<string | ProgramInfo | undefined>;
  /** The account a process runs as (see ownerOfProcess); replaceable in tests. */
  ownerOf?(pid: number): Promise<string | undefined>;
  /** The active rules, read for every request (so edits apply at once). */
  rules?(): DebuggerRule[];
  /** The Network speed switch (FG-1), read for every request: while one is set, requests and responses are paced to it. */
  speed?(): NetworkSpeed | undefined;
  /** The workspace folder that map-local replies (FG-6) read files from; none: such a reply says so. */
  workspaceRoot?(): string | undefined;
  /** The dice of fault rules that fail a share of requests (default Math.random); replaceable in tests. */
  random?(): number;
  /** Asked for every request: false while listing is paused (the traffic is still forwarded, rules still act, nothing is listed). */
  listing?(): boolean;
  /** A breakpoint rule matched: show the exchange, resolve with edits (or nothing) to let it go on. */
  onBreakpoint?(e: DebuggerExchange, phase: 'request' | 'response'): Promise<BreakpointEdits | undefined>;
  /** HTTPS decryption: a certificate for each host, signed by the root the program trusts; `enabled` is asked per tunnel. */
  decrypt?: { leafFor(host: string): LeafCertificate; enabled(host: string): boolean; insecureUpstream?: boolean };
  /** gRPC messages as JSON: with the workspace's .proto files when one describes the method, else field by field. */
  grpcDecode?(path: string, direction: 'request' | 'response', bytes: Buffer): { value: unknown; with: 'proto' | 'raw' };
  /** The page the proxy serves to a browser that opens it directly (a phone on the LAN): the root certificate to download. */
  rootCertificatePem?(): string | undefined;
  /** The corporate gateway, client certificates and extra authorities (FG-9), read for every upstream connection; none: connect directly. */
  gateway?(): Gateway | undefined;
}
