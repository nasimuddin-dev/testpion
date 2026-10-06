/** RPC handlers: the HTTP Debugger (planning/http-debugger.md): a local proxy other programs send through, and what it saw. */
import { ApsError, startDebuggerProxy, type DebuggerExchange, type DebuggerProxy } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { request as httpRequest } from 'node:http';

export interface DebuggerState {
  proxy?: DebuggerProxy;
  /** Kept across stop / start, until cleared: the session. */
  exchanges: DebuggerExchange[];
}

/** An exchange for the window: bodies and header values pass the redactor (a captured token must not reach the screen or a report as is). */
function redacted(be: Backend, e: DebuggerExchange): DebuggerExchange {
  const red = be.logger.redactor;
  const headers = (h?: Record<string, string>) => (h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, red.isSensitiveKey(k) ? '***' : v])) : h);
  return {
    ...e,
    url: red.redactUrl(e.url),
    requestHeaders: headers(e.requestHeaders)!,
    responseHeaders: headers(e.responseHeaders),
    requestBody: e.requestBody && red.redactString(e.requestBody),
    responseBody: e.responseBody && red.redactString(e.responseBody),
  };
}

export function debuggerHandlers(be: Backend): Handlers {
  const state: DebuggerState = (be.debugger ??= { exchanges: [] });
  const status = () => ({ running: !!state.proxy, url: state.proxy?.url, port: state.proxy?.port, exchanges: state.exchanges.length });
  return {
    'debug.status': () => status(),
    /** Send one request through the proxy from this process (the e2e suite's "program"; also a quick check that the proxy works). */
    'debug.selfTest': ({ url }: { url: string }) =>
      new Promise<{ status: number }>((resolve, reject) => {
        if (!state.proxy) return reject(new ApsError('ConfigurationError', 'The debugger is not capturing'));
        const target = new URL(url);
        const req = httpRequest({ host: '127.0.0.1', port: state.proxy.port, method: 'GET', path: target.href, headers: { host: target.host, 'user-agent': 'TestPion self-test' } }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
        });
        req.on('error', reject);
        req.end();
      }),
    /** Start the proxy; programs point at its URL (HTTP_PROXY=…, a browser's proxy setting, --proxy-server=…). */
    'debug.start': async ({ port, lan }: { port?: number; lan?: boolean } = {}) => {
      await state.proxy?.close();
      state.proxy = await startDebuggerProxy({
        port,
        lan,
        onExchange: (e, phase) => {
          if (phase === 'request') {
            state.exchanges.push(e);
            if (state.exchanges.length > 5000) state.exchanges.shift();
          }
          be.host.emit('debug.exchange', { exchange: redacted(be, e), phase });
        },
      });
      be.logger.info(`HTTP Debugger listening on ${state.proxy.url}`);
      return status();
    },
    'debug.stop': async () => {
      await state.proxy?.close();
      state.proxy = undefined;
      return status();
    },
    /** What was captured (newest last), with filters; bodies only with `withBodies`, for the grid's sake. */
    'debug.exchanges': ({
      host,
      method,
      status: st,
      text,
      kind,
      bookmarked,
      limit = 1000,
    }: {
      host?: string;
      method?: string;
      status?: 'ok' | 'redirect' | 'client-error' | 'server-error' | 'error';
      text?: string;
      kind?: 'http' | 'tunnel';
      bookmarked?: boolean;
      limit?: number;
    } = {}) => {
      const needle = text?.toLowerCase();
      const out = state.exchanges.filter((e) => {
        if (host && !e.host.toLowerCase().includes(host.toLowerCase())) return false;
        if (method && e.method !== method.toUpperCase()) return false;
        if (kind && e.kind !== kind) return false;
        if (bookmarked && !e.bookmarked) return false;
        if (st) {
          const s = e.status ?? 0;
          const ok = st === 'ok' ? s >= 200 && s < 300 : st === 'redirect' ? s >= 300 && s < 400 : st === 'client-error' ? s >= 400 && s < 500 : st === 'server-error' ? s >= 500 : !!e.error;
          if (!ok) return false;
        }
        if (needle && !`${e.method} ${e.url} ${e.application ?? ''} ${e.contentType ?? ''} ${e.status ?? ''}`.toLowerCase().includes(needle)) return false;
        return true;
      });
      return out.slice(-limit).map((e) => {
        const { requestBody: _rb, responseBody: _sb, ...rest } = redacted(be, e);
        return rest;
      });
    },
    /** One exchange whole (bodies included, redacted). */
    'debug.exchange': ({ id }: { id: string }) => {
      const e = state.exchanges.find((x) => x.id === id);
      if (!e) throw new ApsError('ValidationError', 'That exchange is no longer in the session');
      return redacted(be, e);
    },
    'debug.bookmark': ({ id, on }: { id: string; on: boolean }) => {
      const e = state.exchanges.find((x) => x.id === id);
      if (e) e.bookmarked = on;
      return true;
    },
    'debug.delete': ({ ids }: { ids: string[] }) => {
      const set = new Set(ids);
      state.exchanges = state.exchanges.filter((e) => !set.has(e.id));
      if (be.debugger) be.debugger.exchanges = state.exchanges;
      return status();
    },
    'debug.clear': () => {
      state.exchanges.length = 0;
      state.proxy?.clear();
      return status();
    },
    /** Statistics of the session: by host, by content type, the largest and the slowest. */
    'debug.stats': () => {
      const by = <K extends string>(key: (e: DebuggerExchange) => K | undefined) => {
        const m = new Map<K, { count: number; bytes: number; ms: number }>();
        for (const e of state.exchanges) {
          const k = key(e);
          if (!k) continue;
          const v = m.get(k) ?? { count: 0, bytes: 0, ms: 0 };
          v.count++;
          v.bytes += e.responseBodyBytes;
          v.ms += e.durationMs ?? 0;
          m.set(k, v);
        }
        return [...m.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.bytes - a.bytes);
      };
      const done = state.exchanges.filter((e) => e.durationMs !== undefined);
      return {
        total: state.exchanges.length,
        bytes: state.exchanges.reduce((n, e) => n + e.responseBodyBytes, 0),
        errors: state.exchanges.filter((e) => e.error || (e.status ?? 0) >= 400).length,
        hosts: by((e) => e.host).slice(0, 20),
        contentTypes: by((e) => e.contentType?.split(';')[0]?.trim()).slice(0, 20),
        applications: by((e) => e.application).slice(0, 20),
        largest: [...done]
          .sort((a, b) => b.responseBodyBytes - a.responseBodyBytes)
          .slice(0, 10)
          .map((e) => ({ id: e.id, method: e.method, url: be.logger.redactor.redactUrl(e.url), bytes: e.responseBodyBytes })),
        slowest: [...done]
          .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
          .slice(0, 10)
          .map((e) => ({ id: e.id, method: e.method, url: be.logger.redactor.redactUrl(e.url), ms: e.durationMs })),
      };
    },
    /** The session as HAR (the same format the history exports), for saving and for other tools. */
    'debug.har': () => ({
      log: {
        version: '1.2',
        creator: { name: 'TestPion HTTP Debugger', version: '1' },
        entries: state.exchanges
          .filter((e) => e.kind === 'http')
          .map((e) => {
            const r = redacted(be, e);
            return {
              startedDateTime: e.startedAt,
              time: e.durationMs ?? 0,
              request: {
                method: e.method,
                url: r.url,
                httpVersion: 'HTTP/1.1',
                headers: Object.entries(r.requestHeaders).map(([name, value]) => ({ name, value })),
                queryString: [],
                cookies: [],
                headersSize: -1,
                bodySize: e.requestBodyBytes,
                ...(r.requestBody ? { postData: { mimeType: e.requestHeaders['content-type'] ?? '', text: r.requestBody } } : {}),
              },
              response: {
                status: e.status ?? 0,
                statusText: e.statusText ?? '',
                httpVersion: 'HTTP/1.1',
                headers: Object.entries(r.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
                cookies: [],
                content: { size: e.responseBodyBytes, mimeType: e.contentType ?? '', text: r.responseBody ?? '' },
                redirectURL: '',
                headersSize: -1,
                bodySize: e.responseBodyBytes,
              },
              cache: {},
              timings: { send: 0, wait: e.waitMs ?? 0, receive: Math.max(0, (e.durationMs ?? 0) - (e.waitMs ?? 0)) },
              ...(e.application ? { comment: `application: ${e.application}` } : {}),
            };
          }),
      },
    }),
  };
}
