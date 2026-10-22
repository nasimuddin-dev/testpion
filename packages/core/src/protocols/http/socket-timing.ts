/**
 * DNS, TCP and TLS timing of the connection a request went over. Node publishes every new client socket on the
 * `net.client.socket` diagnostics channel (its lookup / connect / secureConnect events are timed here), and undici
 * publishes `undici:client:sendHeaders` with the socket each request is written to, which ties the two together.
 */
import { subscribe } from 'node:diagnostics_channel';

interface SocketTimes {
  created: number;
  lookup?: number;
  connect?: number;
  secure?: number;
}

/** The server's TLS certificate, as far as checks and people need it. */
export interface PeerCertificate {
  subject?: string;
  issuer?: string;
  /** ISO dates. */
  validFrom?: string;
  validTo?: string;
  /** Whole days until it expires (negative once it has). */
  daysLeft?: number;
  altNames?: string[];
  fingerprint256?: string;
}

/** What the request was sent over: when its headers were written and the socket's timings and peer. */
interface SentOver {
  certificate?: PeerCertificate;
  sentAt: number;
  times?: SocketTimes;
  remoteAddress?: string;
  remotePort?: number;
  tlsProtocol?: string;
  cipher?: string;
}

type Sock = {
  once(event: string, fn: () => void): void;
  remoteAddress?: string;
  remotePort?: number;
  getProtocol?: () => string | null;
  getCipher?: () => { name?: string } | undefined;
  getPeerCertificate?: (
    detailed?: boolean,
  ) => { subject?: Record<string, string>; issuer?: Record<string, string>; valid_from?: string; valid_to?: string; subjectaltname?: string; fingerprint256?: string } | null;
};

const certs = new WeakMap<object, PeerCertificate | undefined>();
/** The certificate of a TLS socket (read once per socket: a reused connection has the same one). */
function peerCertificate(socket: Sock): PeerCertificate | undefined {
  if (certs.has(socket)) return certs.get(socket);
  let out: PeerCertificate | undefined;
  try {
    const c = socket.getPeerCertificate?.(false);
    if (c && (c.subject || c.valid_to)) {
      const name = (n?: Record<string, string>) => (n ? n.CN || n.O || Object.values(n)[0] : undefined);
      const to = c.valid_to ? new Date(c.valid_to) : undefined;
      const from = c.valid_from ? new Date(c.valid_from) : undefined;
      out = {
        subject: name(c.subject),
        issuer: [c.issuer?.CN, c.issuer?.O].filter(Boolean).join(', ') || undefined,
        validFrom: from && !isNaN(+from) ? from.toISOString() : undefined,
        validTo: to && !isNaN(+to) ? to.toISOString() : undefined,
        altNames: c.subjectaltname
          ?.split(/,\s*/)
          .map((s) => s.replace(/^DNS:/, ''))
          .slice(0, 20),
        fingerprint256: c.fingerprint256,
      };
    }
  } catch {
    /* not a TLS socket */
  }
  certs.set(socket, out);
  return out;
}

/** Days until a certificate expires, from now. */
export function certificateDaysLeft(c: PeerCertificate | undefined, now = Date.now()): number | undefined {
  return c?.validTo ? Math.floor((Date.parse(c.validTo) - now) / 864e5) : undefined;
}

const times = new WeakMap<object, SocketTimes>();
subscribe('net.client.socket', (m) => {
  const socket = (m as { socket?: Sock }).socket;
  if (!socket) return;
  const t: SocketTimes = { created: performance.now() };
  times.set(socket, t);
  socket.once('lookup', () => (t.lookup = performance.now()));
  socket.once('connect', () => (t.connect = performance.now()));
  socket.once('secureConnect', () => (t.secure = performance.now()));
});

interface Waiter {
  origin: string;
  path: string;
  method: string;
  sent?: SentOver;
}
const waiters = new Set<Waiter>(); // bounded: 200
subscribe('undici:client:sendHeaders', (m) => {
  if (!waiters.size) return;
  const { request, socket } = m as { request?: { origin?: unknown; path?: string; method?: string }; socket?: Sock };
  if (!request || !socket) return;
  const origin = String(request.origin);
  for (const w of waiters) {
    if (w.sent || w.origin !== origin || w.path !== request.path || w.method !== request.method) continue;
    let tlsProtocol: string | undefined;
    let cipher: string | undefined;
    try {
      tlsProtocol = socket.getProtocol?.() ?? undefined;
      cipher = socket.getCipher?.()?.name;
    } catch {
      /* a plain socket, or already closed */
    }
    const cert = tlsProtocol ? peerCertificate(socket) : undefined;
    w.sent = {
      sentAt: performance.now(),
      times: times.get(socket),
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      tlsProtocol,
      cipher,
      certificate: cert && { ...cert, daysLeft: certificateDaysLeft(cert) },
    };
    waiters.delete(w);
    return;
  }
});

/** Watch for the first time a request for this URL is written; read the result once the response has started. */
export function watchSend(url: URL, method: string): { result(): SentOver | undefined; stop(): void } {
  const w: Waiter = { origin: url.origin, path: url.pathname + url.search, method: method.toUpperCase() };
  // a request that failed before stop() leaves its waiter: drop the oldest ones past a bound
  if (waiters.size >= 200) waiters.delete(waiters.values().next().value!);
  waiters.add(w);
  return { result: () => w.sent, stop: () => waiters.delete(w) };
}
