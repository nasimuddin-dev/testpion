import { request as httpRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { connect as tcpConnect, isIP, Socket } from 'node:net';
import { connect as tlsConnect, rootCertificates } from 'node:tls';
import { duplexPair } from 'node:stream';
import { ApsError } from '../errors.js';
import { isLocalOnlyAddress } from '../net/policy.js';
import { guardedLookup, upstreamAgents } from './upstream-guard.js';
import { remoteHttpAgent } from './proxy-page.js';
import type { Gateway } from './gateway.js';

/**
 * How the Debugger's proxy reaches the servers (FG-9): directly, as before, or through the corporate gateway (an upstream
 * proxy that tunnels HTTPS with CONNECT), with the extra authorities and the client certificate that apply to the server.
 * `proxy.ts` asks this for the options of every upstream request, HTTP/2 session and opaque tunnel; with no gateway and no
 * client certificate the answers are exactly what it used before.
 */
type ProxyRef = NonNullable<ReturnType<Gateway['proxyFor']>>;

/**
 * Open a CONNECT tunnel through an HTTP proxy: the socket returned is the connection to the proxy; `ready` is called, with
 * the number of bytes the proxy's answer took, once the tunnel to host:port is up. A refusal or a silence ends in an 'error'
 * on the socket (with the proxy's words in it).
 */
export function connectViaProxy(p: ProxyRef, host: string, port: number, ready: (headBytes: number) => void): Socket {
  const s = tcpConnect({ host: p.host, port: p.port });
  const target = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  let buf = Buffer.alloc(0);
  let done = false;
  s.setTimeout(30_000, () => !done && s.destroy(new Error(`The gateway ${p.label} did not answer`)));
  s.once('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${p.auth ? `Proxy-Authorization: ${p.auth}\r\n` : ''}Proxy-Connection: keep-alive\r\n\r\n`));
  const onData = (c: Buffer) => {
    buf = Buffer.concat([buf, c]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) {
      if (buf.length > 16_384) s.destroy(new Error(`The gateway ${p.label} sent an answer that is not HTTP`));
      return;
    }
    done = true;
    s.off('data', onData);
    s.setTimeout(0);
    const line = buf.subarray(0, buf.indexOf('\r\n')).toString('latin1');
    const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(line)?.[1]);
    if (status === 200) return ready(end + 4);
    const why = status === 407 ? 'wants a user name and password (Capture ▸ Connections)' : status === 403 ? 'refused the connection (is the host allowed?)' : `answered ${line.slice(0, 80) || 'with something that is not HTTP'}`;
    s.destroy(new Error(`The gateway ${p.label} ${why}`));
  };
  s.on('data', onData);
  return s;
}

export function createUpstream(o: { trustedCa(): string[] | undefined; insecure(): boolean; gateway(): Gateway | undefined }) {
  const plain = upstreamAgents(o.trustedCa, o.insecure);
  const remoteHttp = remoteHttpAgent(); // plain-HTTP keep-alive pool of the devices on the network
  const agents = new Map<string, { agent: HttpsAgent; ca: string[] | undefined }>(); // bounded: past 32 the oldest is destroyed
  const caLists = new WeakMap<Gateway, { base: string[] | undefined; list: string[] }>(); // registry: one merged list per gateway

  const caFor = (gw: Gateway | undefined): string[] | undefined => {
    const base = o.trustedCa();
    if (!gw?.extraCa.length) return base;
    let hit = caLists.get(gw);
    if (!hit || hit.base !== base) caLists.set(gw, (hit = { base, list: [...(base ?? rootCertificates), ...gw.extraCa] }));
    return hit.list;
  };
  /** A device on the network must not reach this computer through the gateway either (the gateway cannot be asked what a name points at). */
  const refuseThisComputer = (host: string) => {
    if (/^localhost$/i.test(host) || isLocalOnlyAddress(host.replace(/^\[|\]$/g, ''))) throw new ApsError('AuthorizationError', `${host} is this computer`);
  };
  const agentFor = (key: string, ca: string[] | undefined, make: () => HttpsAgent): HttpsAgent => {
    const hit = agents.get(key);
    if (hit && hit.ca === ca) return hit.agent;
    hit?.agent.destroy();
    const agent = make();
    agents.delete(key);
    agents.set(key, { agent, ca });
    if (agents.size > 32) {
      const [oldKey, old] = agents.entries().next().value!;
      old.agent.destroy();
      agents.delete(oldKey);
    }
    return agent;
  };

  /** The https.Agent whose connections go through the gateway: CONNECT, then TLS inside the tunnel. */
  const tunnelling = (p: ProxyRef, base: object): HttpsAgent => {
    const agent = new HttpsAgent({ keepAlive: true, ...base });
    (agent as unknown as { createConnection: unknown }).createConnection = (opts: Record<string, any>, cb: (err: Error | null, s?: Socket) => void) => {
      const host = String(opts.host ?? opts.hostname);
      let failed = false;
      const s = connectViaProxy(p, host, Number(opts.port) || 443, () => {
        const t = tlsConnect({ ...opts, socket: s, servername: opts.servername || (isIP(host) ? undefined : host) });
        cb(null, t as never);
      });
      s.once('error', (err) => {
        if (!failed) cb(err);
        failed = true;
      });
      return undefined;
    };
    return agent;
  };

  const certOptions = (c: ReturnType<Gateway['clientCertFor']>) => (c ? { cert: c.cert, key: c.key, ...(c.passphrase ? { passphrase: c.passphrase } : {}) } : {});

  return {
      /**
       * The request options that route one upstream request: the agent, the lookup of a device on the network, the client
       * certificate; for plain HTTP through the gateway also the address of the gateway, the full URL as the path and the
       * headers with Proxy-Authorization. Spread after the request's own options.
       */
      options(target: URL, headers: Record<string, unknown>, remote: boolean): Record<string, unknown> {
        const gw = o.gateway();
        const secure = target.protocol === 'https:';
        const p = gw?.proxyFor(target);
        const cert = secure ? gw?.clientCertFor(`${target.hostname}:${target.port || 443}`) : undefined;
        if (p) if (remote) refuseThisComputer(target.hostname);
        if (!p && !cert && !gw?.extraCa.length) return { ...(remote ? { lookup: guardedLookup } : {}), ...(secure ? plain(remote) : remote ? { agent: remoteHttp } : {}) };
        const ca = caFor(gw);
        if (!secure) {
          if (!p) return { ...(remote ? { lookup: guardedLookup, agent: remoteHttp } : {}) };
          return { hostname: p.host, port: p.port, path: target.href, headers: { ...headers, host: target.host, ...(p.auth ? { 'proxy-authorization': p.auth } : {}) }, ...(remote ? { agent: remoteHttp } : {}) };
        }
        const base = { ca, rejectUnauthorized: !o.insecure(), ...certOptions(cert) };
        const key = `${remote ? 'remote' : 'local'} ${p ? `${p.label} ${p.auth ?? ''}` : 'direct'} ${cert?.id ?? ''}`;
        if (p) return { agent: agentFor(key, ca, () => tunnelling(p, base)) };
        return { ...(remote ? { lookup: guardedLookup } : {}), agent: agentFor(key, ca, () => new HttpsAgent({ keepAlive: true, ...base, ...(remote ? { lookup: guardedLookup } : {}) })) };
      },
      /** The options of an upstream HTTP/2 session (a gRPC call, h2c): TLS trust, client certificate, or the tunnel through the gateway. */
      h2(target: URL, remote: boolean): Record<string, unknown> {
        const gw = o.gateway();
        const secure = target.protocol === 'https:';
        const p = gw?.proxyFor(target);
        const cert = secure ? gw?.clientCertFor(`${target.hostname}:${target.port || 443}`) : undefined;
        const tlsOptions = secure ? { ca: caFor(gw), rejectUnauthorized: !o.insecure(), ALPNProtocols: ['h2'], ...certOptions(cert) } : {};
        if (!p) return { ...(remote ? { lookup: guardedLookup } : {}), ...tlsOptions };
        if (remote) refuseThisComputer(target.hostname);
        if (!secure) throw new ApsError('ConfigurationError', 'HTTP/2 without TLS cannot go through the gateway', { suggestions: ['Add the host to the gateway bypass list (Capture ▸ Connections).'] });
        const host = target.hostname.replace(/^\[|\]$/g, '');
        return {
          ...tlsOptions,
          createConnection: () => {
            const [a, b] = duplexPair();
            const s = connectViaProxy(p, host, Number(target.port) || 443, () => {
              const t = tlsConnect({ ...tlsOptions, socket: s, servername: isIP(host) ? undefined : host });
              t.on('error', (err) => a.destroy(err));
              t.on('close', () => a.destroy());
              a.on('close', () => t.destroy());
              t.pipe(b);
              b.pipe(t);
            });
            s.once('error', (err) => a.destroy(err));
            return a;
          },
        };
      },
      /** An opaque tunnel (HTTPS that is not decrypted) to host:port; `ready(headBytes)` once connected, headBytes being what the gateway's answer took. */
      connect(to: { host: string; port: number }, remote: boolean, ready: (headBytes: number) => void): Socket {
        const p = o.gateway()?.proxyFor(new URL(`https://${to.host.includes(':') ? `[${to.host}]` : to.host}:${to.port}`));
        if (p) {
          try {
            if (remote) refuseThisComputer(to.host);
          } catch (err) {
            const refused = new Socket();
            queueMicrotask(() => refused.destroy(err as Error)); // reported as the connection's error, like any other
            return refused;
          }
          return connectViaProxy(p, to.host, to.port, ready);
        }
        return tcpConnect({ port: to.port, host: to.host, ...(remote ? { lookup: guardedLookup } : {}) }, () => ready(0));
      },
      destroy() {
        plain.destroy();
        remoteHttp.destroy();
        for (const a of agents.values()) a.agent.destroy();
        agents.clear();
      },
  };
}

export type Upstream = ReturnType<typeof createUpstream>;

/**
 * Try a gateway: open a tunnel (https) or ask for the head of the page (http) through it, and say what happened in words. Never
 * rejects; `via` is `direct` when the gateway does not apply to the URL (the bypass list, loopback).
 */
export async function probeGateway(gw: Gateway, url: string, timeoutMs = 8000): Promise<{ via: string; ok: boolean; ms: number; message: string }> {
  const t0 = Date.now();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { via: 'none', ok: false, ms: 0, message: `"${url}" is not a URL` };
  }
  const p = gw.proxyFor(u);
  if (!p) return { via: 'direct', ok: true, ms: 0, message: `${u.host} is not sent through the gateway (direct, or on the bypass list)` };
  return new Promise((resolve) => {
    let done = false;
    const end = (ok: boolean, message: string) => {
      if (done) return;
      done = true;
      resolve({ via: p.label, ok, ms: Date.now() - t0, message });
    };
    const timer = setTimeout(() => end(false, `No answer from ${p.label} in ${timeoutMs / 1000} s`), timeoutMs);
    timer.unref();
    if (u.protocol === 'https:') {
      const s = connectViaProxy(p, u.hostname, Number(u.port) || 443, () => {
        clearTimeout(timer);
        end(true, `${p.label} opened a tunnel to ${u.host}`);
        s.destroy();
      });
      s.once('error', (e) => (clearTimeout(timer), end(false, e.message.includes('ECONNREFUSED') ? `${p.label} refused the connection` : e.message)));
      return;
    }
    const req = httpRequest({ hostname: p.host, port: p.port, method: 'HEAD', path: u.href, headers: { host: u.host, ...(p.auth ? { 'proxy-authorization': p.auth } : {}) }, timeout: timeoutMs }, (res) => {
      clearTimeout(timer);
      res.resume();
      end(res.statusCode !== 407 && (res.statusCode ?? 0) < 500, res.statusCode === 407 ? `${p.label} wants a user name and password` : `${p.label} answered ${res.statusCode} for ${u.host}`);
    });
    req.once('error', (e) => (clearTimeout(timer), end(false, e.message)));
    req.end();
  });
}
