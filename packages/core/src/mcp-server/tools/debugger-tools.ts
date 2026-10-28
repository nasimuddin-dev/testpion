import { startDebuggerProxy, type DebuggerExchange, type DebuggerProxy } from '../../debugger/proxy.js';
import { exchangesFromHar, exchangesToHar } from '../../debugger/har.js';
import { describeRule, rulePresets, statusMatches, type DebuggerRule } from '../../debugger/rules.js';
import { checkRuleShape } from '../../debugger/rule-shape.js';
import { describeNetworkSpeed, NETWORK_SPEEDS, parseNetworkSpeed, type NetworkSpeed } from '../../debugger/network-speed.js';
import { annotate, AUTO_BREAKPOINT_LABEL, autoBreakpointMode, cleanAnnotation, parseAutoBreakpointMode, withAutoBreakpoint } from '../../debugger/auto-breakpoint.js';
import { shortId } from '../../util/ids.js';
import { debuggerCertDir, ensureRootCertificate, installRootCertificate, leafSigner, removeRootCertificate, rootCertificateTrust, rootStanding, trustInstructions } from '../../debugger/certificate.js';
import { disengageSystemProxy, engageSystemProxy, type SystemProxySnapshot } from '../../debugger/system-proxy.js';
import { adviceFor, cookiesOf, hostMatches, paramsOf } from '@testpion/shared';
import type { BreakpointEdits } from '../../debugger/proxy.js';
import { exchangesFromSaz } from '../../debugger/saz.js';
import { grpcDecoder, grpcMethodIndex, workspaceProtoRoots } from '../../debugger/grpc.js';
import type { WorkspaceStore } from '../../storage/workspace.js';

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Redactor } from '../../util/redact.js';
import { ApsError } from '../../errors.js';
import { str, type Tool, limitArg } from '../tool.js';

/**
 * The HTTP Debugger for agents: start the proxy, point a program at it, read what it sent and got. The capture lives
 * in this server process; secrets in URLs, headers and bodies pass the redactor before an agent sees them.
 */
export function debuggerTools(d: { redactor: Redactor; store?: WorkspaceStore; /** The capture's list, when other tools read it too (flow_from_exchanges). */ session?: DebuggerExchange[]; /** A read-only server: nothing here may change the capture. */ readOnly?: boolean }): Tool[] {
  let proxy: DebuggerProxy | undefined;
  /** Listing is paused: the proxy forwards, rules act, nothing new is listed. */
  let paused = false;
  /** Exchanges held at a breakpoint, waiting for debugger_rules resume (each is let go after 2 minutes). */
  const held = new Map<string, { phase: 'request' | 'response'; exchange: DebuggerExchange; since: string; release(edits?: BreakpointEdits): void }>(); // bounded: every hold ends within 2 minutes
  const releaseAll = (edits?: BreakpointEdits) => {
    for (const h of [...held.values()]) h.release(edits);
  };
  /** The OS proxy as it was before `system_proxy`, to put back on stop (and when the process is told to end). */
  let systemProxy: SystemProxySnapshot | undefined;
  /** Hosts that stay opaque tunnels while HTTPS is decrypted (globs). */
  let noDecrypt: string[] = []; // bounded: the list the agent set (at most 200 hosts)
  const restoreSystem = async () => {
    const was = systemProxy;
    systemProxy = undefined;
    if (was) await disengageSystemProxy(debuggerCertDir(), was);
  };
  let guarded = false;
  const session: DebuggerExchange[] = d.session ?? [];
  /** The rules of this server process (an agent adds them; the proxy reads them on every request). */
  const rules: DebuggerRule[] = [];
  /** The Network speed switch (debugger_rules action speed). */
  let speed: NetworkSpeed | undefined;
  const red = d.redactor;
  const safe = (e: DebuggerExchange, bodies: boolean) => {
    const headers = (h?: Record<string, string>) => (h ? red.redactHeaders(h) : h);
    // bodies, frames, events and gRPC messages only for one exchange, and redacted like everything else
    const { requestBody, responseBody, frames, events, grpc, trailers, ...rest } = e;
    return {
      ...rest,
      url: red.redactUrl(e.url),
      ...(e.note ? { note: red.redactString(e.note) } : {}),
      requestHeaders: headers(e.requestHeaders),
      responseHeaders: headers(e.responseHeaders),
      ...(grpc
        ? {
            grpc: bodies
              ? { ...grpc, requests: red.redact(grpc.requests), responses: red.redact(grpc.responses) }
              : { service: grpc.service, method: grpc.method, status: grpc.status, statusName: grpc.statusName },
          }
        : {}),
      ...(bodies
        ? {
            requestBody: requestBody && red.redactString(requestBody),
            responseBody: responseBody && red.redactString(responseBody),
            trailers: headers(trailers),
            frames: frames?.map((f) => (f.text ? { ...f, text: red.redactString(f.text) } : f)),
            events: events?.map((ev) => ({ ...ev, data: red.redactString(ev.data) })),
          }
        : { ...(frames ? { frameCount: frames.length } : {}), ...(events ? { eventCount: events.length } : {}) }),
    };
  };
  /** Params and cookies as the inspector tabs show them, with secrets masked. */
  const inspect = (e: DebuggerExchange) => {
    const p = paramsOf(e);
    return {
      params: { query: red.redact(Object.fromEntries(p.query)) as Record<string, string>, form: red.redact(Object.fromEntries(p.form)) as Record<string, string> },
      cookies: { request: cookiesOf(e, 'request').map(([n]) => n), response: cookiesOf(e, 'response').map(([n, v]) => ({ name: n, attributes: v.includes('(') ? v.slice(v.indexOf('(')) : undefined })) },
    };
  };
  const summaryOf = (e: DebuggerExchange) => ({
    protocol: e.kind === 'tunnel' ? 'HTTPS tunnel' : e.httpVersion === '2' ? 'HTTP/2' : 'HTTP/1.1',
    tls: e.tls ? 'decrypted' : e.kind === 'tunnel' ? 'tunnel (not decrypted)' : 'no',
    program: e.application,
    serverAddress: e.serverAddress,
    requestBytes: e.requestBodyBytes,
    responseBytes: e.responseBodyBytes,
    sendMs: e.sendMs,
    waitMs: e.waitMs,
    totalMs: e.durationMs,
    rules: e.rules,
    error: e.error,
  });
  return [
    {
      name: 'debugger_capture',
      write: true,
      description:
        "Start or stop TestPion's HTTP Debugger proxy (a forward proxy on 127.0.0.1). Start it, then run the program to watch with HTTP_PROXY set to the returned url (or a browser with --proxy-server=url); its requests and responses are captured for debugger_exchanges. Plain HTTP is captured whole; HTTPS is listed as a tunnel by host.",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'status', 'clear', 'pause', 'resume'], description: 'pause: the proxy keeps forwarding but stops listing new traffic; resume lists again' },
          port: { type: 'number', description: 'With start: the port (default: any free one)' },
          decrypt: { type: 'boolean', description: 'With start: decrypt HTTPS with the TestPion root certificate (the program must trust it: the result says where the file is)' },
          system_proxy: { type: 'boolean', description: 'With start: capture the whole computer' },
        },
        required: ['action'],
      },
      run: async (a) => {
        const status = () => ({ running: !!proxy, paused, url: proxy?.url, port: proxy?.port, systemProxy: !!systemProxy, exchanges: session.length });
        if (a.action === 'start') {
          await proxy?.close();
          await restoreSystem();
          const root = a.decrypt ? ensureRootCertificate(debuggerCertDir()) : undefined;
          const leaf = root ? leafSigner(root) : undefined;
          proxy = await startDebuggerProxy({
            port: a.port ? Number(a.port) : undefined,
            rules: () => rules,
            speed: () => speed,
            workspaceRoot: () => d.store?.root,
            listing: () => !paused,
            onBreakpoint: (e, phase) =>
              new Promise<BreakpointEdits | undefined>((resolve) => {
                const id = shortId('bp-');
                const timer = setTimeout(() => release(), 120_000);
                const release = (edits?: BreakpointEdits) => (clearTimeout(timer), held.delete(id), resolve(edits));
                held.set(id, { phase, exchange: e, since: new Date().toISOString(), release });
              }),
            grpcDecode: grpcDecoder(grpcMethodIndex(workspaceProtoRoots(d.store))),
            ...(leaf ? { decrypt: { leafFor: leaf, enabled: (h: string) => !noDecrypt.some((p) => hostMatches(p, h)) } } : {}),
            onExchange: (e, phase) => {
              if (phase === 'request') {
                session.push(e);
                if (session.length > 5000) session.shift();
              }
            },
          });
          if (a.system_proxy === true) {
            systemProxy = await engageSystemProxy(debuggerCertDir(), proxy.url);
            if (!guarded) {
              guarded = true;
              // the OS setting must not outlive this process: put it back when the server is told to end
              for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void restoreSystem().finally(() => process.exit(0)));
            }
          }
          return {
            ...status(),
            ...(root ? { rootCertificate: root.path, fingerprint: root.fingerprint } : {}),
            next: `Run the program with HTTP_PROXY=${proxy.url} and HTTPS_PROXY=${proxy.url}${root ? ` and trust ${root.path} (Node: NODE_EXTRA_CA_CERTS, Python: REQUESTS_CA_BUNDLE, curl: --cacert)` : ''}, then call debugger_exchanges.`,
          };
        }
        if (a.action === 'pause' || a.action === 'resume') {
          paused = a.action === 'pause';
          return status();
        }
        if (a.action === 'stop') {
          paused = false;
          releaseAll();
          await restoreSystem();
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
      name: 'debugger_certificate',
      write: true,
      description: 'The HTTPS root certificate: info, install (trust it) or remove.',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['info', 'install', 'remove'] } }, required: ['action'] },
      run: async (a) => {
        const root = ensureRootCertificate(debuggerCertDir());
        let note: string | undefined;
        if (a.action === 'install') note = `Installed into ${(await installRootCertificate(root)).where}`;
        if (a.action === 'remove') {
          await removeRootCertificate(root);
          note = 'Removed from the trust store';
        }
        const { trusted, known } = await rootCertificateTrust(root);
        // known false: this computer cannot tell (Linux, or the check failed): the steps are for the person
        return { path: root.path, fingerprint: root.fingerprint, notAfter: root.notAfter, ...rootStanding(root.certPem), trusted, known, note, ...(trusted === true ? {} : { instructions: trustInstructions(root.path) }) };
      },
    },
    {
      name: 'debugger_no_decrypt',
      write: true,
      description: 'Hosts kept as HTTPS tunnels while decrypting: list or set (globs).',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'set'] }, hosts: { type: 'array', items: { type: 'string' }} }, required: ['action'] },
      run: (a) => {
        if (a.action === 'set') noDecrypt = (Array.isArray(a.hosts) ? a.hosts : []).map((h) => String(h).trim()).filter(Boolean).slice(0, 200);
        return { hosts: noDecrypt };
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
          deep: { type: 'boolean', description: 'With text: search headers and bodies too' },
          limit: { type: 'number', description: 'How many (default 200, max 2000)' },
          hide_tunnels: { type: 'boolean', description: 'Leave out HTTPS tunnels' },
          hide_304: { type: 'boolean', description: 'Leave out 304 Not Modified answers' },
          include: { type: 'array', items: { type: 'string', enum: ['params', 'cookies', 'summary'] }, description: 'Add inspector data' },
        },
      },
      run: (a) => {
        const needle = typeof a.text === 'string' ? a.text.toLowerCase() : undefined;
        const out = session.filter((e) => {
          if (a.host && !e.host.toLowerCase().includes(String(a.host).toLowerCase())) return false;
          if (a.method && e.method !== String(a.method).toUpperCase()) return false;
          if (a.hide_tunnels === true && e.kind === 'tunnel') return false;
          if (a.hide_304 === true && e.status === 304) return false;
          if (a.status && !statusMatches(String(a.status) as DebuggerRule['match']['status'], e.status, e.error)) return false;
          if (needle) {
            if (`${e.method} ${e.url} ${e.application ?? ''} ${e.contentType ?? ''}`.toLowerCase().includes(needle)) return true;
            if (!a.deep) return false;
            const h = (x?: Record<string, string>) => Object.entries(x ?? {}).some(([k, v]) => k.toLowerCase().includes(needle) || v.toLowerCase().includes(needle));
            return h(e.requestHeaders) || h(e.responseHeaders) || !!e.requestBody?.toLowerCase().includes(needle) || !!e.responseBody?.toLowerCase().includes(needle);
          }
          return true;
        });
        const include = Array.isArray(a.include) ? (a.include as unknown[]).map(String) : [];
        const more = (e: DebuggerExchange) => ({
          ...(include.includes('params') ? { params: inspect(e).params } : {}),
          ...(include.includes('cookies') ? { cookies: inspect(e).cookies } : {}),
          ...(include.includes('summary') ? { summary: summaryOf(e) } : {}),
          ...(include.length && (e.error || (e.status ?? 0) >= 400) ? { advice: adviceFor(e) } : {}),
        });
        return {
          running: !!proxy,
          url: proxy?.url,
          total: session.length,
          exchanges: out.slice(-limitArg(a.limit, include.length ? 100 : 200, include.length ? 100 : 2000)).map((e) => ({ ...safe(e, false), ...more(e), ref: { kind: 'exchange', exchangeId: e.id } })),
        };
      },
    },
    {
      name: 'debugger_exchange',
      description:
        'One captured exchange whole: request and response headers and bodies (redacted), timings, the program that sent it, and the note and colour mark on it. With action annotate: set (or, with an empty value, remove) its note and mark; a note is saved in the HAR as the entry comment.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('The exchange id (from debugger_exchanges)'),
          action: { type: 'string', enum: ['get', 'annotate'], description: 'get (default) reads it; annotate sets note and / or mark' },
          note: str('With annotate: a comment (up to 2000 characters; empty removes it)'),
          mark: { type: 'string', enum: ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey', ''], description: 'With annotate: a colour mark (empty removes it)' },
        },
        required: ['id'],
      },
      run: (a) => {
        const e = session.find((x) => x.id === a.id);
        if (!e) throw new ApsError('ValidationError', `No exchange ${String(a.id)} in the session`);
        if (a.action === 'annotate') {
          if (d.readOnly) throw new ApsError('ValidationError', 'This server is read-only: it cannot annotate an exchange');
          try {
            annotate(e, cleanAnnotation({ note: a.note, mark: a.mark }));
          } catch (err) {
            throw new ApsError('ValidationError', (err as Error).message);
          }
        }
        return safe(e, true);
      },
    },
    {
      name: 'debugger_session',
      write: true,
      description:
        "Save the captured session as a HAR file (redacted; every HTTP tool opens it), or open a HAR file (TestPion's or another tool's) into the session for debugger_exchanges. Paths are relative to the working directory.",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['save', 'open'] },
          path: str('The .har file (open also reads Fiddler .saz)'),
          append: { type: 'boolean', description: 'With open: add to the session instead of replacing it' },
        },
        required: ['action', 'path'],
      },
      run: (a) => {
        const file = resolve(String(a.path));
        if (a.action === 'save') {
          writeFileSync(file, JSON.stringify(exchangesToHar(session, red), null, 2));
          return { saved: file, exchanges: session.length };
        }
        const bytes = readFileSync(file);
        let loaded: DebuggerExchange[];
        if (bytes.subarray(0, 2).toString('latin1') === 'PK') loaded = exchangesFromSaz(bytes);
        else {
          let har: unknown;
          try {
            har = JSON.parse(bytes.toString('utf8'));
          } catch (e) {
            throw new ApsError('ValidationError', `Not a HAR or SAZ file: ${(e as Error).message}`);
          }
          loaded = exchangesFromHar(har);
        }
        if (!a.append) session.length = 0;
        session.push(...loaded);
        return { loaded: loaded.length, exchanges: session.length };
      },
    },
    {
      name: 'debugger_rules',
      write: true,
      description:
        "The HTTP Debugger's rules, what the proxy does to matching traffic: list them, add one (a preset by id, filled in for a host, or a rule object: kind ignore (filter out) | only (capture only: when any is on, only what one matches is listed) | highlight | modify | reply | redirect, match {host, url, method, application} as globs plus an optional where {column: status|url|method|host|application|user|type|version|ip|duration|size, op: equals|not-equals|contains|starts-with|ends-with|between|greater-than|less-than|matches, value, value2, regex}, and the kind's fields: color, style {dark, light (#rrggbb), bold, row}; requestHeaders / responseHeaders [{op: set|remove, name, value}], requestBody, responseBody, delayMs; reply {status, headers, body, or file / folder + stripPrefix of the workspace: map local}; redirect {host, scheme, rewrite {from, to, regex}}; modify also requestReplace / responseReplace [{find, replace, regex, ignoreCase}] and setStatus; kind remap {remap {to, scheme: auto|http|https, preserveHost}} with match.host as the host to move; kind fault {fault {action: drop|timeout|truncate|error, percent, bytes, status, timeoutMs}}; kind frame (WebSocket) {frame {direction: sent|received|both, when, action: drop|replace|break|delay, find, replace, regex, delayMs}}), enable / disable or remove one. Network speed: action speed with speed off | modem | edge | slow-3g | 3g | slow-4g, or custom with down_kbps / up_kbps / latency_ms, paces every forwarded request and response. Breakpoints: action breakpoints with mode off | request (every request) | response (every response) | post (only POST) | errors (only responses with status 400+) keeps one managed rule \"Auto breakpoint\" (the exchange is held until action resume, or 2 minutes); held lists what is held; resume lets one (id) or all go on, or abort them. Custom breakpoint rules need the app's window.",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'presets', 'add', 'remove', 'enable', 'disable', 'clear', 'breakpoints', 'held', 'resume', 'speed'] },
          speed: { type: 'string', description: 'With speed: off, modem, edge, slow-3g, 3g, slow-4g or custom (omit to read the current speed)' },
          down_kbps: { type: 'number', description: 'With speed custom: download kilobits per second' },
          up_kbps: { type: 'number', description: 'With speed custom: upload kilobits per second (default as down)' },
          latency_ms: { type: 'number', description: 'With speed custom: added to every request' },
          mode: { type: 'string', enum: ['off', 'request', 'response', 'post', 'errors'], description: 'With breakpoints: which traffic is held (off removes the Auto breakpoint rule)' },
          abort: { type: 'boolean', description: 'With resume: abort the held exchange(s) with a 502 instead of sending them on' },
          preset: str('With add: a preset id from the presets action'),
          host: str('With add + preset: the host the preset applies to'),
          rule: { type: 'object', description: 'With add: the rule (see the description)' },
          id: str('With remove / enable / disable: the rule id; with resume: the held exchange id (omit for all)'),
        },
        required: ['action'],
      },
      run: (a) => {
        const hits = proxy?.ruleHits() ?? {};
        const list = () => ({ autoBreakpoint: autoBreakpointMode(rules), rules: rules.map((r) => ({ ...r, summary: describeRule(r), hits: hits[r.id] ?? 0 })) });
        const heldList = () => ({ held: [...held.entries()].map(([id, h]) => ({ id, phase: h.phase, method: h.exchange.method, url: red.redactUrl(h.exchange.url), since: h.since })) });
        if (a.action === 'breakpoints') {
          let mode: ReturnType<typeof parseAutoBreakpointMode>;
          try {
            mode = parseAutoBreakpointMode(a.mode);
          } catch (err) {
            throw new ApsError('ValidationError', (err as Error).message);
          }
          const next = withAutoBreakpoint(rules, mode);
          rules.splice(0, rules.length, ...next);
          return { mode, label: AUTO_BREAKPOINT_LABEL[mode], ...list(), ...heldList() };
        }
        if (a.action === 'speed') {
          if (a.speed !== undefined) {
            try {
              speed = parseNetworkSpeed({ preset: String(a.speed), downKbps: a.down_kbps as number | undefined, upKbps: a.up_kbps as number | undefined, latencyMs: a.latency_ms as number | undefined });
            } catch (err) {
              throw new ApsError('ValidationError', (err as Error).message);
            }
          }
          return { speed: speed ?? null, label: describeNetworkSpeed(speed), presets: NETWORK_SPEEDS.map((s) => s.preset) };
        }
        if (a.action === 'held') return heldList();
        if (a.action === 'resume') {
          const one = typeof a.id === 'string' ? held.get(a.id) : undefined;
          if (typeof a.id === 'string' && !one) throw new ApsError('ValidationError', `No held exchange ${a.id}`);
          const released = one ? 1 : held.size;
          if (one) one.release(a.abort === true ? { abort: true } : undefined);
          else releaseAll(a.abort === true ? { abort: true } : undefined);
          return { released, ...heldList() };
        }
        if (a.action === 'presets') return { presets: rulePresets(typeof a.host === 'string' ? a.host : undefined).map((p) => ({ id: p.id, label: p.label })) };
        if (a.action === 'add') {
          const from = typeof a.preset === 'string' ? rulePresets(typeof a.host === 'string' ? a.host : undefined).find((p) => p.id === a.preset)?.rule : (a.rule as Partial<DebuggerRule> | undefined);
          if (!from) throw new ApsError('ValidationError', 'add needs a preset id or a rule object');
          if (!['ignore', 'only', 'highlight', 'modify', 'reply', 'redirect', 'breakpoint', 'remap', 'fault', 'frame'].includes(String(from.kind))) throw new ApsError('ValidationError', `Unknown rule kind "${String(from.kind)}"`);
          if (from.kind === 'breakpoint') throw new ApsError('ValidationError', 'A custom breakpoint needs the app window; use action breakpoints for the automatic ones, or modify / reply here');
          const rule: DebuggerRule = {
            ...(from as DebuggerRule),
            id: shortId('rule-'),
            name: from.name ?? describeRule({ ...(from as DebuggerRule), name: '' }),
            enabled: from.enabled !== false,
            match: from.match ?? {},
          };
          const problem = checkRuleShape(rule);
          if (problem) throw new ApsError('ValidationError', problem);
          rules.push(rule);
          return { added: { ...rule, summary: describeRule(rule) }, ...list() };
        }
        if (a.action === 'clear') {
          rules.length = 0;
          return list();
        }
        if (a.action === 'remove' || a.action === 'enable' || a.action === 'disable') {
          const i = rules.findIndex((r) => r.id === a.id);
          if (i < 0) throw new ApsError('ValidationError', `No rule ${String(a.id)}`);
          if (a.action === 'remove') rules.splice(i, 1);
          else rules[i]!.enabled = a.action === 'enable';
          return list();
        }
        return list();
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
