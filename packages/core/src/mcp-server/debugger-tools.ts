import { startDebuggerProxy, type DebuggerExchange, type DebuggerProxy } from '../debugger/proxy.js';
import { Redactor } from '../util/redact.js';
import { ApsError } from '../errors.js';
import { str, type Tool } from './tool.js';

/**
 * The HTTP Debugger for agents: start the proxy, point a program at it, read what it sent and got. The capture lives
 * in this server process; secrets in URLs, headers and bodies pass the redactor before an agent sees them.
 */
export function debuggerTools(d: { redactor: Redactor }): Tool[] {
  let proxy: DebuggerProxy | undefined;
  const session: DebuggerExchange[] = [];
  const red = d.redactor;
  const safe = (e: DebuggerExchange, bodies: boolean) => {
    const headers = (h?: Record<string, string>) => (h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, red.isSensitiveKey(k) ? '***' : v])) : h);
    const { requestBody, responseBody, ...rest } = e;
    return {
      ...rest,
      url: red.redactUrl(e.url),
      requestHeaders: headers(e.requestHeaders),
      responseHeaders: headers(e.responseHeaders),
      ...(bodies ? { requestBody: requestBody && red.redactString(requestBody), responseBody: responseBody && red.redactString(responseBody) } : {}),
    };
  };
  return [
    {
      name: 'debugger_capture',
      write: true,
      description:
        "Start or stop TestPion's HTTP Debugger proxy (a forward proxy on 127.0.0.1). Start it, then run the program to watch with HTTP_PROXY set to the returned url (or a browser with --proxy-server=url); its requests and responses are captured for debugger_exchanges. Plain HTTP is captured whole; HTTPS is listed as a tunnel by host.",
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['start', 'stop', 'status', 'clear'] }, port: { type: 'number', description: 'With start: the port (default: any free one)' } },
        required: ['action'],
      },
      run: async (a) => {
        const status = () => ({ running: !!proxy, url: proxy?.url, port: proxy?.port, exchanges: session.length });
        if (a.action === 'start') {
          await proxy?.close();
          proxy = await startDebuggerProxy({
            port: a.port ? Number(a.port) : undefined,
            onExchange: (e, phase) => {
              if (phase === 'request') {
                session.push(e);
                if (session.length > 5000) session.shift();
              }
            },
          });
          return { ...status(), next: `Run the program with HTTP_PROXY=${proxy.url} (and HTTPS_PROXY for HTTPS tunnels), then call debugger_exchanges.` };
        }
        if (a.action === 'stop') {
          await proxy?.close();
          proxy = undefined;
          return status();
        }
        if (a.action === 'clear') {
          session.length = 0;
          proxy?.clear();
          return status();
        }
        return status();
      },
    },
    {
      name: 'debugger_exchanges',
      description:
        'What the HTTP Debugger captured, newest last: method, URL, status, program, content type, bytes, timings (bodies left out; debugger_exchange has them). Filter by host, method, status class (ok, redirect, client-error, server-error, error) or text.',
      inputSchema: {
        type: 'object',
        properties: {
          host: str('Only this host'),
          method: str('Only this method'),
          status: { type: 'string', enum: ['ok', 'redirect', 'client-error', 'server-error', 'error'] },
          text: str('Only exchanges whose URL, program or type contains this'),
          limit: { type: 'number', description: 'How many (default 200, max 2000)' },
        },
      },
      run: (a) => {
        const needle = typeof a.text === 'string' ? a.text.toLowerCase() : undefined;
        const out = session.filter((e) => {
          if (a.host && !e.host.toLowerCase().includes(String(a.host).toLowerCase())) return false;
          if (a.method && e.method !== String(a.method).toUpperCase()) return false;
          if (a.status) {
            const s = e.status ?? 0;
            const ok =
              a.status === 'ok'
                ? s >= 200 && s < 300
                : a.status === 'redirect'
                  ? s >= 300 && s < 400
                  : a.status === 'client-error'
                    ? s >= 400 && s < 500
                    : a.status === 'server-error'
                      ? s >= 500
                      : !!e.error;
            if (!ok) return false;
          }
          if (needle && !`${e.method} ${e.url} ${e.application ?? ''} ${e.contentType ?? ''}`.toLowerCase().includes(needle)) return false;
          return true;
        });
        return { running: !!proxy, url: proxy?.url, total: session.length, exchanges: out.slice(-Math.min(Math.max(Number(a.limit) || 200, 1), 2000)).map((e) => safe(e, false)) };
      },
    },
    {
      name: 'debugger_exchange',
      description: 'One captured exchange whole: request and response headers and bodies (redacted), timings, the program that sent it.',
      inputSchema: { type: 'object', properties: { id: str('The exchange id (from debugger_exchanges)') }, required: ['id'] },
      run: (a) => {
        const e = session.find((x) => x.id === a.id);
        if (!e) throw new ApsError('ValidationError', `No exchange ${String(a.id)} in the session`);
        return safe(e, true);
      },
    },
    {
      name: 'debugger_stats',
      description: 'The captured session in numbers: exchanges, bytes, errors; by host, content type and program; the largest and the slowest.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const by = (key: (e: DebuggerExchange) => string | undefined) => {
          const m = new Map<string, { count: number; bytes: number }>();
          for (const e of session) {
            const k = key(e);
            if (!k) continue;
            const v = m.get(k) ?? { count: 0, bytes: 0 };
            v.count++;
            v.bytes += e.responseBodyBytes;
            m.set(k, v);
          }
          return [...m.entries()]
            .map(([name, v]) => ({ name, ...v }))
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, 20);
        };
        return {
          total: session.length,
          bytes: session.reduce((n, e) => n + e.responseBodyBytes, 0),
          errors: session.filter((e) => e.error || (e.status ?? 0) >= 400).length,
          hosts: by((e) => e.host),
          contentTypes: by((e) => e.contentType?.split(';')[0]?.trim()),
          applications: by((e) => e.application),
          largest: [...session]
            .sort((a, b) => b.responseBodyBytes - a.responseBodyBytes)
            .slice(0, 10)
            .map((e) => ({ id: e.id, method: e.method, url: red.redactUrl(e.url), bytes: e.responseBodyBytes })),
          slowest: [...session]
            .filter((e) => e.durationMs !== undefined)
            .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
            .slice(0, 10)
            .map((e) => ({ id: e.id, method: e.method, url: red.redactUrl(e.url), ms: e.durationMs })),
        };
      },
    },
  ];
}
