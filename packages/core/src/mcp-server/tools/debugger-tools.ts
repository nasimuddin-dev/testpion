import { startDebuggerProxy, type DebuggerExchange, type DebuggerProxy } from '../../debugger/proxy.js';
import { exchangesFromHar, exchangesToHar } from '../../debugger/har.js';
import { describeRule, rulePresets, ruleMatches, statusMatches, type DebuggerRule } from '../../debugger/rules.js';
import { lastScriptRun, testRuleScript } from '../../debugger/script-rules.js';
import { checkRuleShape } from '../../debugger/rule-shape.js';
import { describeNetworkSpeed, NETWORK_SPEEDS, parseNetworkSpeed, type NetworkSpeed } from '../../debugger/network-speed.js';
import { annotate, AUTO_BREAKPOINT_LABEL, autoBreakpointMode, cleanAnnotation, parseAutoBreakpointMode, withAutoBreakpoint } from '../../debugger/auto-breakpoint.js';
import { shortId } from '../../util/ids.js';
import { debuggerCertDir, ensureRootCertificate, installRootCertificate, leafSigner, removeRootCertificate, rootCertificateTrust, rootStanding, trustInstructions } from '../../debugger/certificate.js';
import { disengageSystemProxy, engageSystemProxy, type SystemProxySnapshot } from '../../debugger/system-proxy.js';
import { adviceFor, aiCallOf, cachingOf, compileWhere, cookiesOf, EXCHANGE_VIEWS, exchangeView, graphqlOf, hostMatches, parseWhere, paramsOf, tlsFindings, type ExchangeViewName } from '@testpion/shared';
import { generateCode } from '../../codegen/codegen.js';
import { debuggerReplayTools } from './debugger-replay-tools.js';
import type { BreakpointEdits } from '../../debugger/proxy.js';
import { exchangesFromSaz } from '../../debugger/saz.js';
import { grpcDecoder, grpcMethodIndex, workspaceProtoRoots } from '../../debugger/grpc.js';
import type { WorkspaceStore } from '../../storage/workspace.js';

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Redactor } from '../../util/redact.js';
import { ApsError } from '../../errors.js';
import { str, type Tool, limitArg } from '../tool.js';
import { connectionProperties, diffForAgent, exchangesFromFile, gatewayFromArgs } from './debugger-enterprise-tools.js';
import { exchangesToSaz } from '../../debugger/saz-export.js';
import { createShareBundle } from '../../debugger/bundle.js';
import { rulesFromFarx, describeFarxImport } from '../../debugger/farx.js';
import { planLaunch, startLaunch, LAUNCH_KINDS, type LaunchKind } from '../../debugger/launcher.js';
import { strictHarRedactor } from '../../debugger/har.js';
import type { Gateway } from '../../debugger/gateway.js';
import type { SecretReader } from '../../vars/variables.js';

/**
 * The HTTP Debugger for agents: start the proxy, point a program at it, read what it sent and got. The capture lives
 * in this server process; secrets in URLs, headers and bodies pass the redactor before an agent sees them.
 */
export function debuggerTools(d: { redactor: Redactor; store?: WorkspaceStore; /** The capture's list, when other tools read it too (flow_from_exchanges). */ session?: DebuggerExchange[]; /** A read-only server: nothing here may change the capture. */ readOnly?: boolean; /** The secret store: a gateway password or a key passphrase is read by name. */ secrets?: SecretReader }): Tool[] {
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
  /** FG-9: the gateway of this capture, a line about it, and the root certificate's path when HTTPS is decrypted (for the launcher). */
  let gateway: Gateway | undefined;
  let gatewaySummary: string | undefined;
  let rootPath: string | undefined;
  const session: DebuggerExchange[] = d.session ?? [];
  /** The rules of this server process (an agent adds them; the proxy reads them on every request). */
  const rules: DebuggerRule[] = [];
  /** The Network speed switch (debugger_rules action speed). */
  let speed: NetworkSpeed | undefined;
  const red = d.redactor;
  const graphqlView = (e: DebuggerExchange) => {
    const g = graphqlOf({ method: e.method, url: e.url, requestContentType: e.requestHeaders['content-type'], requestBody: e.requestBody, responseBody: e.responseBody });
    return g ? red.redact(g) : undefined;
  };
  const aiView = (e: DebuggerExchange) => {
    const c = aiCallOf({ method: e.method, url: e.url, host: e.host, requestHeaders: e.requestHeaders, requestBody: e.requestBody, responseBody: e.responseBody, status: e.status });
    return c ? red.redact(c) : undefined;
  };
  const safe = (e: DebuggerExchange, bodies: boolean) => {
    const headers = (h?: Record<string, string>) => (h ? red.redactHeaders(h) : h);
    // bodies, frames, events and gRPC messages only for one exchange, and redacted like everything else
    const { requestBody, responseBody, requestBodyBase64: _qb, responseBodyBase64: _pb, frames, events, grpc, trailers, ...rest } = e;
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
    ...debuggerReplayTools({ session, redactor: red, readOnly: d.readOnly }),
    {
      name: 'debugger_capture',
      write: true,
      description:
        "Start or stop TestPion's HTTP Debugger proxy (forward proxy on 127.0.0.1). Run the program to watch with HTTP_PROXY set to the returned url (a browser: --proxy-server=url); traffic is captured for debugger_exchanges. HTTP is captured whole; HTTPS is a tunnel by host unless decrypt.",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'status', 'clear', 'pause', 'resume', 'launch'], description: 'pause: keep forwarding, stop listing; resume lists again; launch: start command through the running proxy' },
          ...connectionProperties,
          command: { type: 'string', description: 'With launch: the program (runtime recognised by name: node, python, java, dotnet, curl, Chromium, firefox)' },
          args: { type: 'array', items: { type: 'string' }, description: 'With launch: its arguments' },
          kind: { type: 'string', enum: [...LAUNCH_KINDS], description: 'With launch: the runtime when the name does not say' },
          preview: { type: 'boolean', description: 'With launch: only say what would be set' },
          port: { type: 'number', description: 'With start: the port (default: any free one)' },
          decrypt: { type: 'boolean', description: 'With start: decrypt HTTPS with the TestPion root certificate (the program must trust it; the result gives the file)' },
          system_proxy: { type: 'boolean', description: 'With start: capture the whole computer' },
        },
        required: ['action'],
      },
      run: async (a) => {
        const status = () => ({ running: !!proxy, paused, url: proxy?.url, port: proxy?.port, systemProxy: !!systemProxy, exchanges: session.length, ...(gatewaySummary ? { gateway: gatewaySummary } : {}) });
        if (a.action === 'launch') {
          if (!proxy) throw new ApsError('ConfigurationError', 'Start the proxy first (action start), then launch the program');
          const plan = planLaunch({ command: String(a.command ?? ''), args: Array.isArray(a.args) ? a.args.map(String) : [], proxyUrl: proxy.url, kind: a.kind as LaunchKind | undefined, caPath: rootPath });
          const view = { kind: plan.kind, command: plan.command, args: plan.args, variables: Object.keys(plan.env), notes: plan.notes };
          if (a.preview === true) return { ...view, started: false };
          const r = await startLaunch(plan, { cwd: d.store?.root });
          return { ...view, started: true, pid: r.pid, next: 'Use the program, then call debugger_exchanges.' };
        }
        if (a.action === 'start') {
          const connections = gatewayFromArgs(a, d.secrets); // before anything is stopped: a wrong setting changes nothing
          await proxy?.close();
          await restoreSystem();
          gateway = connections.gateway;
          gatewaySummary = connections.summary;
          const root = a.decrypt ? ensureRootCertificate(debuggerCertDir()) : undefined;
          rootPath = root?.path;
          const leaf = root ? leafSigner(root) : undefined;
          proxy = await startDebuggerProxy({
            port: a.port ? Number(a.port) : undefined,
            rules: () => rules,
            gateway: () => gateway,
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
        'What the HTTP Debugger captured, newest last: method, URL, status, program, content type, bytes, timings (no bodies: debugger_exchange has them). Filter by host, method, status class (ok, redirect, client-error, server-error, error) or text.',
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
          include: { type: 'array', items: { type: 'string', enum: ['params', 'cookies', 'summary', 'caching', 'tls', 'graphql', 'ai'] }, description: 'Add inspector data: caching (would a browser cache it), tls (version, cipher, certificate findings), graphql (operation, variables, errors)' },
          where: str('A condition: status>=400 and host~api and size>200kb. Fields: status method host url type size time app ip user pid note mark kind; operators = != > >= < <= ~ !~ ^= $=; join with and'),
          columns: { type: 'array', items: { type: 'string' }, description: 'Header columns to add to every row: request:x-request-id, response:cache-control' },
        },
      },
      run: (a) => {
        let whereTest: ReturnType<typeof compileWhere> | undefined;
        if (typeof a.where === 'string' && a.where.trim()) {
          const w = parseWhere(a.where);
          if (!w.ok) throw new ApsError('ValidationError', w.error);
          whereTest = compileWhere(w.clauses);
        }
        const columns = (Array.isArray(a.columns) ? (a.columns as unknown[]).map(String) : []).slice(0, 8).flatMap((c) => {
          const m = /^(request|response):(.+)$/i.exec(c.trim());
          return m ? [{ key: c.trim().toLowerCase(), side: m[1]!.toLowerCase() as 'request' | 'response', name: m[2]!.trim().toLowerCase() }] : [];
        });
        const needle = typeof a.text === 'string' ? a.text.toLowerCase() : undefined;
        const out = session.filter((e) => {
          if (whereTest && !whereTest(e)) return false;
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
          ...(include.includes('caching') ? { caching: cachingOf(e) } : {}),
          ...(include.includes('tls') && e.connection ? { tls: { ...e.connection, findings: tlsFindings(e.connection, e.host) } } : {}),
          ...(include.includes('graphql') ? { graphql: graphqlView(e) } : {}),
          ...(include.includes('ai') ? { ai: aiView(e) } : {}),
          ...(include.length && (e.error || (e.status ?? 0) >= 400) ? { advice: adviceFor(e) } : {}),
        });
        return {
          running: !!proxy,
          url: proxy?.url,
          total: session.length,
          exchanges: out.slice(-limitArg(a.limit, include.length ? 100 : 200, include.length ? 100 : 2000)).map((e) => ({
            ...safe(e, false),
            ...more(e),
            ...(columns.length ? { columns: Object.fromEntries(columns.map((c) => [c.key, red.isSensitiveKey(c.name) ? '***' : ((c.side === 'request' ? e.requestHeaders : e.responseHeaders)?.[c.name] ?? null)])) } : {}),
            ref: { kind: 'exchange', exchangeId: e.id },
          })),
        };
      },
    },
    {
      name: 'debugger_exchange',
      description:
        'One captured exchange whole: headers and bodies (redacted), timings, the sending program, its note and colour mark. annotate sets (empty removes) the note and mark; a note is saved in the HAR as the entry comment. view reads the body as the Debugger window shows it: list (which views fit), image, xml (tree), form, graphql (operation, query, variables, errors), ai (LLM call to OpenAI, Anthropic, Gemini or Ollama, or MCP messages: model, messages, tools, the answer with a stream put together, tool calls, tokens, cost estimate; keys redacted), msgpack, protobuf (no .proto needed), signalr, socketio, syntax, caching (would a browser cache it), tls (version, cipher, certificate findings); side: request or response (default response). Decoded text is redacted.',
      inputSchema: {
        type: 'object',
        properties: {
          id: str('The exchange id (from debugger_exchanges)'),
          action: { type: 'string', enum: ['get', 'annotate', 'snippet'], description: 'get (default) reads it; annotate sets note and / or mark; snippet writes it as code (language: curl, powershell, fetch, httpie, python, go …)' },
          language: str('With snippet: the language (default curl)'),
          view: { type: 'string', enum: [...EXCHANGE_VIEWS], description: 'Read the body as this view instead of returning the whole exchange' },
          side: { type: 'string', enum: ['request', 'response'], description: 'With view: which body (default response)' },
          note: str('With annotate: a comment (up to 2000 characters; empty removes it)'),
          mark: { type: 'string', enum: ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'grey', ''], description: 'With annotate: a colour mark (empty removes it)' },
        },
        required: ['id'],
      },
      run: (a) => {
        const e = session.find((x) => x.id === a.id);
        if (!e) throw new ApsError('ValidationError', `No exchange ${String(a.id)} in the session`);
        if (a.action === 'snippet') {
          const language = typeof a.language === 'string' && a.language ? a.language : 'curl';
          const headers = Object.entries(red.redactHeaders(e.requestHeaders)).filter(([k]) => !/^(host|content-length|connection|proxy-.*)$/i.test(k)) as Array<[string, string]>;
          try {
            return { language, text: generateCode({ method: e.method, url: red.redactUrl(e.url), headers, body: e.requestBody && red.redactString(e.requestBody) }, language) };
          } catch (err) {
            throw new ApsError('ValidationError', (err as Error).message);
          }
        }
        if (a.action === 'annotate') {
          if (d.readOnly) throw new ApsError('ValidationError', 'This server is read-only: it cannot annotate an exchange');
          try {
            annotate(e, cleanAnnotation({ note: a.note, mark: a.mark }));
          } catch (err) {
            throw new ApsError('ValidationError', (err as Error).message);
          }
        }
        if (typeof a.view === 'string') {
          if (!(EXCHANGE_VIEWS as readonly string[]).includes(a.view)) throw new ApsError('ValidationError', `Unknown view "${a.view}": ${EXCHANGE_VIEWS.join(', ')}`);
          // what a decoder reads out of a body is masked like the body itself
          return { id: e.id, url: red.redactUrl(e.url), ...exchangeView(e, a.view as ExchangeViewName, a.side === 'request' ? 'request' : 'response', red) };
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
          action: { type: 'string', enum: ['save', 'open', 'export_saz', 'bundle', 'diff'], description: 'export_saz writes a masked Fiddler archive; bundle writes a masked .tpbundle (HAR, active rules, environment facts, notes) to share; diff compares the session with the earlier run in path (or path with other)' },
          path: str('The file: .har (open also reads .saz and .tpbundle); export_saz: the .saz to write; bundle: the .tpbundle; diff: the earlier run (HAR, SAZ or bundle)'),
          other: str('With diff: a second file to compare path with, instead of the captured session'),
          notes: str('With bundle: a text for the person who opens it (masked like the rest)'),
          with_rules: { type: 'boolean', description: 'With bundle: include the active rules (default true)' },
          ignore_query: { type: 'boolean', description: 'With diff: match requests without their query string' },
          include_size: { type: 'boolean', description: 'With diff: also report a different response size' },
          append: { type: 'boolean', description: 'With open: add to the session instead of replacing it' },
        },
        required: ['action', 'path'],
      },
      run: async (a) => {
        const file = resolve(String(a.path));
        if (a.action === 'export_saz') {
          writeFileSync(file, await exchangesToSaz(session, strictHarRedactor(red)));
          return { saved: file, exchanges: session.length, masked: true };
        }
        if (a.action === 'bundle') {
          const { bytes, manifest } = await createShareBundle({ name: String(a.path).replace(/^.*[\\/]/, '').replace(/\.tpbundle$/i, ''), exchanges: session, rules: a.with_rules === false ? [] : rules.filter((r) => r.enabled), notes: typeof a.notes === 'string' ? a.notes : undefined, redactor: red, state: { running: !!proxy, port: proxy?.port, systemProxy: !!systemProxy, networkSpeed: speed ? describeNetworkSpeed(speed) : undefined } });
          writeFileSync(file, bytes);
          return { saved: file, masked: true, exchanges: manifest.exchanges, rules: manifest.rules, hasNotes: manifest.hasNotes };
        }
        if (a.action === 'diff') {
          const before = exchangesFromFile(file).exchanges;
          const after = typeof a.other === 'string' && a.other ? exchangesFromFile(resolve(a.other)).exchanges : session;
          return diffForAgent(before, after, red, { ignoreQuery: a.ignore_query === true, includeSize: a.include_size === true });
        }
        if (a.action === 'save') {
          writeFileSync(file, JSON.stringify(exchangesToHar(session, red), null, 2));
          return { saved: file, exchanges: session.length };
        }
        const opened = exchangesFromFile(file);
        const loaded = opened.exchanges;
        if (!a.append) session.length = 0;
        session.push(...loaded);
        return { loaded: loaded.length, exchanges: session.length, kind: opened.kind, ...(opened.bundle ? { bundle: { name: opened.bundle.manifest.name, createdAt: opened.bundle.manifest.createdAt, rules: opened.bundle.rules.length, environment: opened.bundle.environment, notes: opened.bundle.notes && red.redactString(opened.bundle.notes) } } : {}) };
      },
    },
    {
      name: 'debugger_rules',
      write: true,
      description:
        "The HTTP Debugger's rules (what the proxy does to matching traffic): list, add (a preset by id filled in for a host, or a rule object), enable / disable, remove. Rule: kind ignore (filter out) | only (capture only what matches) | highlight | modify | reply | redirect | remap | fault | frame; match {host, url, method, application} globs plus optional where {column: status|url|method|host|application|user|type|version|ip|duration|size, op: equals|not-equals|contains|starts-with|ends-with|between|greater-than|less-than|matches, value, value2, regex}; kind fields: color, style {dark, light (#rrggbb), bold, row}; requestHeaders / responseHeaders [{op: set|remove, name, value}], requestBody, responseBody, delayMs; reply {status, headers, body, or file / folder + stripPrefix: map local}; redirect {host, scheme, rewrite {from, to, regex}}; modify also requestReplace / responseReplace [{find, replace, regex, ignoreCase}], setStatus; remap {to, scheme: auto|http|https, preserveHost} (match.host is the host to move); fault {action: drop|timeout|truncate|error, percent, bytes, status, timeoutMs}; frame (WebSocket) {direction: sent|received|both, when, action: drop|replace|break|delay, find, replace, regex, delayMs}. Speed: action speed with off | modem | edge | slow-3g | 3g | slow-4g, or custom with down_kbps / up_kbps / latency_ms, paces all traffic. Breakpoints: action breakpoints with mode off | request | response | post (POST only) | errors (status 400+) keeps one managed rule \"Auto breakpoint\"; an exchange is held until action resume or 2 minutes; held lists them; resume lets one (id) or all go on, or abort. Custom breakpoint rules need the app's window.",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'presets', 'add', 'remove', 'enable', 'disable', 'clear', 'breakpoints', 'held', 'resume', 'speed', 'import_farx'], description: 'import_farx maps a Fiddler AutoResponder file (.farx) in path into rules, best effort (dry_run only reports); each rule says imported, imported off, or skipped and why' },
          path: str('With import_farx: the .farx file'),
          dry_run: { type: 'boolean', description: 'With import_farx: report only' },
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
        if (a.action === 'import_farx') {
          const r = rulesFromFarx(readFileSync(resolve(String(a.path))));
          if (a.dry_run !== true) rules.push(...r.rules);
          return { summary: describeFarxImport(r), partial: true, applied: a.dry_run !== true && r.rules.length > 0, items: r.items, ...list() };
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
          if (!['ignore', 'only', 'highlight', 'modify', 'reply', 'redirect', 'breakpoint', 'remap', 'fault', 'frame', 'script'].includes(String(from.kind))) throw new ApsError('ValidationError', `Unknown rule kind "${String(from.kind)}"`);
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
      name: 'debugger_scripts',
      write: true,
      description:
        "JavaScript rule scripts for the HTTP Debugger: a script defines onRequest(ctx) and / or onResponse(ctx) and runs for the traffic its match selects, in a sandbox with no network, files or secrets (100 ms a hook by default, 2 s at most; a failing or slow hook is skipped). ctx.request: method, url, host, headers (lower-case), body (text or undefined); onResponse also ctx.response: status, headers, body. Change them to rewrite; ctx.reply(status, body, headers) answers without the server; ctx.delay(ms); ctx.highlight(color); ctx.ignore(); console.log(...). Actions: list (script rules, last run), set (add, or replace the one with id: code or file, match host / url / method, timeout_ms, enabled, name), enable / disable / remove (by id), test (run a saved rule by id, or code given here, against a captured exchange; nothing is sent or changed).",
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'set', 'enable', 'disable', 'remove', 'test'] },
          id: str('With set (to replace), enable, disable, remove, test: the rule id'),
          name: str('With set: the rule name'),
          code: str('With set / test: the script text (defines onRequest and / or onResponse)'),
          file: str('With set / test: a script file of the workspace instead of code, e.g. debugger/scripts/auth.js'),
          host: str('With set / test: glob on the host the rule matches'),
          url: str('With set / test: glob (or /regex/) on the URL the rule matches'),
          method: str('With set / test: the methods the rule matches'),
          timeout_ms: { type: 'number', description: 'With set / test: how long a hook may run, 10 to 2000 (default 100)' },
          enabled: { type: 'boolean', description: 'With set: whether the rule is on (default true)' },
          exchange: str('With test: the id of the captured exchange to run the script on'),
        },
        required: ['action'],
      },
      run: async (a) => {
        const scripts = () => rules.filter((r) => r.kind === 'script');
        const view = () => ({
          scripts: scripts().map((r) => {
            const last = lastScriptRun(r.id);
            return {
              id: r.id,
              name: r.name,
              enabled: r.enabled,
              match: r.match,
              summary: describeRule(r),
              script: r.script?.file ? { file: r.script.file, timeoutMs: r.script.timeoutMs } : { code: r.script?.code, timeoutMs: r.script?.timeoutMs },
              ...(last ? { lastRun: { phase: last.phase, ran: last.ran, ms: last.ms, error: last.error && red.redactString(last.error), logs: last.logs.map((l) => red.redactString(l)) } } : {}),
            };
          }),
        });
        const build = (id: string): DebuggerRule => {
          const existing = rules.find((r) => r.id === a.id);
          const code = typeof a.code === 'string' ? a.code : undefined;
          const file = typeof a.file === 'string' && a.file ? a.file : undefined;
          const script = { ...(code !== undefined ? { code } : file ? { file } : (existing?.script ?? {})), ...(typeof a.timeout_ms === 'number' ? { timeoutMs: a.timeout_ms } : existing?.script?.timeoutMs ? { timeoutMs: existing.script.timeoutMs } : {}) };
          const match = { ...(existing?.match ?? {}), ...(typeof a.host === 'string' ? { host: a.host } : {}), ...(typeof a.url === 'string' ? { url: a.url } : {}), ...(typeof a.method === 'string' ? { method: a.method } : {}) };
          const rule: DebuggerRule = { id, name: typeof a.name === 'string' && a.name ? a.name : (existing?.name ?? ''), enabled: a.enabled === undefined ? (existing?.enabled ?? true) : a.enabled !== false, kind: 'script', match, script };
          rule.name ||= describeRule({ ...rule, name: '' });
          const problem = checkRuleShape(rule);
          if (problem) throw new ApsError('ValidationError', problem);
          return rule;
        };
        if (a.action === 'list' || a.action === undefined) return view();
        if (a.action === 'set') {
          const id = typeof a.id === 'string' && a.id ? a.id : shortId('rule-');
          const i = rules.findIndex((r) => r.id === id);
          if (i >= 0 && rules[i]!.kind !== 'script') throw new ApsError('ValidationError', `Rule ${id} is not a script rule`);
          const rule = build(id);
          if (i >= 0) rules[i] = rule;
          else rules.push(rule);
          return { saved: id, ...view() };
        }
        if (a.action === 'enable' || a.action === 'disable' || a.action === 'remove') {
          const i = rules.findIndex((r) => r.id === a.id && r.kind === 'script');
          if (i < 0) throw new ApsError('ValidationError', `No script rule ${String(a.id)}`);
          if (a.action === 'remove') rules.splice(i, 1);
          else rules[i]!.enabled = a.action === 'enable';
          return view();
        }
        if (a.action === 'test') {
          const e = session.find((x) => x.id === a.exchange);
          if (!e) throw new ApsError('ValidationError', 'test needs exchange: the id of a captured exchange (debugger_exchanges lists them)');
          let rule: DebuggerRule;
          if (typeof a.code !== 'string' && typeof a.file !== 'string') {
            const saved = rules.find((r) => r.id === a.id && r.kind === 'script');
            if (!saved) throw new ApsError('ValidationError', 'test needs a script rule id, or code (or file) to run');
            rule = saved;
          } else rule = build(typeof a.id === 'string' && a.id ? a.id : 'test');
          const t = await testRuleScript(rule, e, ruleMatches(rule, e, 'request'), d.store?.root);
          return { exchange: e.id, ...t, phases: t.phases.map((p) => ({ ...p, logs: p.logs.map((l) => red.redactString(l)), does: p.does.map((l) => red.redactString(l)), ...(p.error ? { error: red.redactString(p.error) } : {}) })) };
        }
        throw new ApsError('ValidationError', `Unknown action ${String(a.action)}`);
      },
    },
    {
      name: 'debugger_stats',
      description: 'The captured session in numbers: exchanges, bytes, errors by host, content type and program; the largest and slowest.',
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
