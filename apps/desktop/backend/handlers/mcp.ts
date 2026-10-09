/** RPC handlers: MCP servers: connect, discover, call tools, read resources, prompts, tests and mocks. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify as toYaml } from 'yaml';
import {
  ApsError,
  McpSession,
  Tracer,
  normalizeError,
  runChecks,
  shortId,
  dumpMcpMock,
  loadMcpMock,
  mcpResultBody,
  mockFromDiscovery,
  mockServeCommands,
  mockToolResult,
  type McpMockDefinition,
  type CheckConfig,
  type McpServerConfig,
  mcpToolUsage,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { commandLine, forgetTrustedCommands, isCommandTrusted, trustCommand, trustedCommands } from '@testpion/core';

/** Requests an inspected server sent to the client (elicitation, sampling) that wait for the user. */
interface PendingClientRequest {
  serverId: string;
  resolve(result: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

export function mcpHandlers(be: Backend): Handlers {
  const pending = new Map<string, PendingClientRequest>();
  // ask the UI and wait (at most 10 minutes); the answer comes back with mcp.clientRespond
  const askUser = <T>(serverId: string, serverName: string, kind: 'elicitation' | 'sampling', params: unknown, onTimeout: T): Promise<T> =>
    new Promise<T>((resolve) => {
      const id = shortId('mcpreq-');
      const timer = setTimeout(() => {
        pending.delete(id);
        be.host.emit('mcp.clientRequestDone', { id });
        resolve(onTimeout);
      }, 10 * 60_000);
      pending.set(id, { serverId, resolve: resolve as (r: unknown) => void, timer });
      be.host.emit('mcp.clientRequest', { id, serverId, serverName, kind, params: be.mcpRedactors.get(serverId)?.redact(params) ?? params });
    });
  const cancelPending = (serverId: string) => {
    for (const [id, p] of pending)
      if (p.serverId === serverId) {
        clearTimeout(p.timer);
        pending.delete(id);
        p.resolve({ action: 'cancel' });
        be.host.emit('mcp.clientRequestDone', { id });
      }
  };
  return {
    /** The user's answer to a server's elicitation or sampling request. */
    'mcp.clientRespond': ({ id, result }: { id: string; result: unknown }) => {
      const p = pending.get(id);
      if (!p) throw new ApsError('ValidationError', 'That request is no longer waiting (it timed out or the server disconnected)');
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve(result);
    },
    /** Draft a reply to a sampling request with the AI assistant's model (the user reviews it before it is sent). */
    'mcp.sampleDraft': async ({ params, environment }: { params: { systemPrompt?: string; maxTokens?: number; messages: Array<{ role: 'user' | 'assistant'; content: { type: string; text?: string } }> }; environment?: string }) =>
      be.sampleWithAssistant(params, environment),
    // calls, failures and times per tool of a server, from the history
    'mcp.toolUsage': ({ serverId }: { serverId?: string }) => mcpToolUsage(be.ws, { serverId }),
    'mcp.servers': () => be.ws.getMcpServers().map((s) => ({ ...s, connected: !!be.mcpSessions.get(s.id)?.connected })),
    'mcp.saveServers': ({ servers }: { servers: McpServerConfig[] }) => {
      be.ws.saveMcpServers(servers);
      return servers;
    },
    /** Programs this workspace may start on this computer (stdio MCP servers the user allowed). */
    'mcp.trusted': () => trustedCommands(be.ws),
    'mcp.forgetTrusted': () => forgetTrustedCommands(be.ws),
    'mcp.connect': async ({ serverId, environment, trust }: { serverId: string; environment?: string; trust?: 'once' | 'always' }) => {
      await be.mcpSessions.get(serverId)?.close();
      const cfg = be.ws.getMcpServers().find((s) => s.id === serverId);
      if (!cfg) throw new ApsError('ConfigurationError', `Unknown MCP server ${serverId}`);
      const ctx = be.context({ environment });
      const resolved = be.ws.resolveMcpServer(ctx.vars.resolveDeep(cfg));
      // a stdio server is a program this workspace asks the computer to run: the user sees the command line first
      // (a workspace comes from git, an import or a teammate), and may allow it for good on this computer
      if (resolved.transport === 'stdio' && !isCommandTrusted(be.ws, resolved.command, resolved.args ?? [])) {
        if (!trust) {
          const line = commandLine(resolved.command, resolved.args ?? []);
          throw new ApsError('ConfigurationError', `"${cfg.name}" starts a program on this computer: ${line}`, {
            why: 'Programs a workspace starts run with your permissions. Check the command before you allow it.',
            suggestions: ['Allow it once, or always for this workspace on this computer.'],
            details: { needsTrust: true, command: resolved.command, args: resolved.args ?? [], line },
          });
        }
        if (trust === 'always') trustCommand(be.ws, resolved.command, resolved.args ?? []);
      }
      // the inspector offers roots (the workspace folder) and lets the user answer elicitation and sampling
      const session = new McpSession(resolved, ctx.redactor, {
        cookieJar: ctx.services.cookieJar,
        handlers: {
          roots: () => [{ uri: pathToFileURL(be.ws.root).href, name: be.ws.workspace.name }],
          elicitation: (params) => askUser(serverId, cfg.name, 'elicitation', params, { action: 'cancel' as const }),
          sampling: async (params) => {
            const r = await askUser<{ text?: string; model?: string; action?: string }>(serverId, cfg.name, 'sampling', params, { action: 'cancel' });
            if (!r.text) throw new ApsError('ValidationError', 'The user declined the sampling request');
            return { role: 'assistant' as const, content: { type: 'text' as const, text: r.text }, model: r.model ?? 'user', stopReason: 'endTurn' };
          },
        },
      });
      const b = be.batched<unknown>('mcp.events');
      session.onEvent((e) => b.push({ serverId, event: e }));
      session.onResourceUpdated((uri) => be.host.emit('mcp.resourceUpdated', { serverId, uri }));
      be.mcpSessions.set(serverId, session);
      be.mcpRedactors.set(serverId, ctx.redactor);
      const started = Date.now();
      const target = `${cfg.name} › ${be.mcpTarget(resolved, ctx.redactor)}`;
      try {
        await session.connect();
        be.consoleProtocol('mcp', ctx.redactor, { name: cfg.name, method: 'CONNECT', url: target, status: 'ok', durationMs: Date.now() - started, logs: [`transport: ${cfg.transport}`] });
      } catch (e) {
        const err = normalizeError(e);
        be.consoleProtocol('mcp', ctx.redactor, { name: cfg.name, method: 'CONNECT', url: target, status: err.kind, durationMs: Date.now() - started, error: err.message });
        throw e;
      } finally {
        b.flush();
      }
      return { discovery: await session.discover(), events: session.events };
    },
    /**
     * Record the connected server as a mock: its tools, resources and prompts, plus the tool calls made
     * in this session (as seen in the protocol trace, already redacted), saved as mocks/<name>.mcp-mock.yaml.
     * With `addServer`, a server entry that runs the mock in-process is added too.
     */
    'mcp.mock.save': async ({ serverId, addServer }: { serverId: string; addServer?: boolean }) => {
      const s = be.session(serverId);
      const discovery = await s.discover();
      const requests = new Map<unknown, { tool: string; args: Record<string, unknown> }>();
      const calls: Array<{ tool: string; args: Record<string, unknown>; result: { content?: unknown[]; isError?: boolean } }> = [];
      for (const e of s.events) {
        const msg = (e.request ?? {}) as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
        if (e.kind === 'request' && e.method === 'tools/call') {
          const params = msg.params ?? (e.request as { name?: string; arguments?: Record<string, unknown> });
          if (params?.name) requests.set(e.rpcId, { tool: params.name, args: params.arguments ?? {} });
        } else if (e.kind === 'response' && requests.has(e.rpcId)) {
          const res = (e.response ?? {}) as { result?: { content?: unknown[]; isError?: boolean }; content?: unknown[]; isError?: boolean };
          calls.push({ ...requests.get(e.rpcId)!, result: res.result ?? res });
          requests.delete(e.rpcId);
        }
      }
      const texts: Record<string, string> = {};
      for (const r of discovery.resources.slice(0, 20)) {
        try {
          const c = (await s.readResource(r.uri)).contents as Array<{ text?: string }>;
          if (typeof c[0]?.text === 'string') texts[r.uri] = be.logger.redactor.redactString(c[0].text.slice(0, 100_000));
        } catch {
          /* unreadable resource: listed without text */
        }
      }
      const name = `${s.config.name}-mock`;
      const def = mockFromDiscovery(name, discovery, calls, texts);
      const rel = `mocks/${s.config.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.mcp-mock.yaml`;
      mkdirSync(be.ws.path('mocks'), { recursive: true });
      writeFileSync(be.ws.path(rel), dumpMcpMock(def));
      if (addServer) {
        const servers = be.ws.getMcpServers().filter((x) => !(x.transport === 'mock' && x.mockFile === rel));
        be.ws.saveMcpServers([...servers, { id: shortId('mcp-'), name: `${s.config.name} (mock)`, transport: 'mock', mockFile: rel }]);
      }
      return { path: rel, tools: def.tools?.length ?? 0, calls: calls.length, resources: Object.keys(texts).length };
    },
    /**
     * A mock definition file as the Tools tab edits it (a toolset): the parsed definition and the raw text. A file that
     * does not exist yet answers `exists: false` with a starter definition, so the tab can create it on Save.
     */
    'mcp.mock.read': ({ file, name }: { file: string; name?: string }) => {
      const abs = be.ws.safePath(file);
      if (!existsSync(abs)) {
        const def: McpMockDefinition = { name: name ?? file.replace(/^.*[\\/]/, '').replace(/\.mcp-mock\.(ya?ml|json)$/, ''), tools: [] };
        return { exists: false, definition: def, text: dumpMcpMock(def), serve: mockServeCommands(file) };
      }
      const text = readFileSync(abs, 'utf8');
      return { exists: true, definition: loadMcpMock(text), text, serve: mockServeCommands(file) };
    },
    /** Parse a definition typed or generated as YAML (the YAML editor, Generate with AI) without saving it. */
    'mcp.mock.parse': ({ text }: { text: string }) => loadMcpMock(text),
    /** Save a toolset: the definition (from the form) or the raw text (from the YAML editor, checked first). */
    'mcp.mock.write': ({ file, definition, text }: { file: string; definition?: McpMockDefinition; text?: string }) => {
      const abs = be.ws.safePath(file);
      const out = text !== undefined ? (loadMcpMock(text), text) : dumpMcpMock(loadMcpMock(dumpMcpMock(definition!)));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, out);
      return { text: out, definition: loadMcpMock(out) };
    },
    /** Try a tool of a toolset as edited (unsaved): the mock's answer in-process, shaped like mcp.call's result. */
    'mcp.mock.call': async ({ definition, tool, args }: { definition: McpMockDefinition; tool: string; args: Record<string, unknown> }) => {
      const started = performance.now();
      const r = await mockToolResult(definition, tool, args ?? {});
      const { body } = mcpResultBody(r);
      return { ...r, isError: !!r.isError, durationMs: Math.round(performance.now() - started), body, checks: [] };
    },
    'mcp.disconnect': async ({ serverId }: { serverId: string }) => {
      cancelPending(serverId);
      await be.mcpSessions.get(serverId)?.close();
      be.mcpSessions.delete(serverId);
      be.mcpRedactors.delete(serverId);
    },
    'mcp.events': ({ serverId }: { serverId: string }) => be.mcpSessions.get(serverId)?.events ?? [],
    'mcp.call': async ({ serverId, tool, args, assertions }: { serverId: string; tool: string; args: Record<string, unknown>; assertions?: CheckConfig[] }) => {
      const s = be.session(serverId);
      const tracer = new Tracer(`tools/call ${tool}`, be.logger.redactor);
      const span = tracer.start(`tools/call ${tool}`, 'mcp', { attributes: { server: s.config.name, tool }, input: args });
      try {
        const r = await s.callTool(tool, args);
        span.end({ status: r.isError ? 'error' : 'ok', output: r.raw });
        const { mcpResultBody } = await import('@testpion/core');
        const { body, text } = mcpResultBody(r);
        const checks = await runChecks(assertions, { testType: 'mcp', body, text, isError: r.isError, latencyMs: r.durationMs });
        const trace = tracer.finish();
        be.ws.saveTrace(trace, 'mcp');
        be.consoleProtocol('mcp', be.mcpRedactor(serverId), {
          name: `${s.config.name} · ${tool}`,
          method: 'CALL',
          url: `${s.config.name} › tools/call ${tool}`,
          status: r.isError ? 'error' : 'ok',
          durationMs: r.durationMs,
          request: args,
          response: r.raw,
          failedChecks: checks.filter((c) => !c.passed).length,
        });
        be.ws.meta.addHistory({ id: shortId('h-'), timestamp: new Date().toISOString(), kind: 'mcp', name: `${s.config.name} · ${tool}`, status: r.isError ? 'error' : 'ok', durationMs: r.durationMs, request: { serverId, tool, args }, traceId: trace.traceId });
        return { ...r, body, checks, traceId: trace.traceId };
      } catch (e) {
        span.fail(e);
        be.ws.saveTrace(tracer.finish('error'), 'mcp');
        const err = normalizeError(e);
        be.consoleProtocol('mcp', be.mcpRedactor(serverId), { name: `${s.config.name} · ${tool}`, method: 'CALL', url: `${s.config.name} › tools/call ${tool}`, status: err.kind, request: args, error: err.message });
        throw e;
      }
    },
    'mcp.read': ({ serverId, uri }: { serverId: string; uri: string }) =>
      be.mcpLogged(serverId, 'READ', `resources/read ${uri}`, undefined, () => be.session(serverId).readResource(uri)),
    'mcp.prompt': ({ serverId, name, args }: { serverId: string; name: string; args: Record<string, string> }) =>
      be.mcpLogged(serverId, 'PROMPT', `prompts/get ${name}`, args, () => be.session(serverId).getPrompt(name, args)),
    'mcp.ping': async ({ serverId }: { serverId: string }) => be.session(serverId).ping(),
    /** Suggestions for a prompt argument or resource-template parameter (completion/complete). */
    'mcp.complete': ({ serverId, ref, argument, context }: { serverId: string; ref: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string }; argument: { name: string; value: string }; context?: Record<string, string> }) =>
      be.session(serverId).complete(ref, argument, context),
    'mcp.subscribe': ({ serverId, uri }: { serverId: string; uri: string }) => be.session(serverId).subscribeResource(uri),
    'mcp.unsubscribe': ({ serverId, uri }: { serverId: string; uri: string }) => be.session(serverId).unsubscribeResource(uri),
    'mcp.saveTest': ({ serverId, tool, args, assertions, name }: { serverId: string; tool: string; args: Record<string, unknown>; assertions: CheckConfig[]; name: string }) => {
      const cfg = be.ws.getMcpServers().find((s) => s.id === serverId);
      const rel = `mcp/${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.yaml`;
      be.ws.writeTestFile(rel, toYaml({ name, type: 'mcp', server: cfg?.name ?? serverId, tool, arguments: args, assertions: assertions.length ? assertions : [{ type: 'status', expected: 'success' }] }));
      return rel;
    },
  };
}
