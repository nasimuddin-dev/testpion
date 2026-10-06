/** Servers and inspectors: the workspace MCP server, mock servers (REST, MCP, GraphQL) and the MCP inspector. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  ChainSecretStore,
  createEngineContext,
  startDebuggerProxy,
  EnvSecretStore,
  McpSession,
  recordingToCollection,
  startRecorder,
  collectSubscriptionEvents,
  WorkspaceManager,
  loadMcpMock,
  serveMcpMockStdio,
  startMcpMockHttp,
  startGraphQLMockServer,
  schemaFromText,
  introspect,
  buildGraphQLOperation,
  setNetworkPolicy,
  serveTestPionMcp,
  ENGINE_VERSION,
  type McpServerConfig,
  describeRoot,
  executeGrpc,
  grpcRoot,
  parseGrpcTarget,
  reflectServer,
  runRealtimeExchange,
  Redactor,
  agentsMarkdown,
  composeFeedback,
  type FeedbackKind,
  upsertAgentsMarkdown,
  checkTypes,
} from '@testpion/core';
import { EXIT, dim, bold, cyan, green, red, yellow, CliError, openWorkspace } from '../shared.js';
import { executeMock } from '../run.js';

export function registerServeCommands(program: Command): void {
  program
    .command('mcp-server')
    .description('serve a workspace to AI agents over MCP (stdio): list and read collections, send requests, run collections')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--read-only', 'only the browsing tools: no requests are sent')
    .option('--allow-production', 'allow sending to environments marked as production')
    .option('--block-private-networks', 'refuse requests to localhost, private and cloud-metadata addresses (for shared or hosted use)')
    .option('--allow-host <host...>', 'with --block-private-networks: hosts that stay reachable')
    .action(async (o: { workspace?: string; readOnly?: boolean; allowProduction?: boolean; blockPrivateNetworks?: boolean; allowHost?: string[] }) => {
      if (o.blockPrivateNetworks) setNetworkPolicy({ blockPrivateNetworks: true, allowHosts: o.allowHost ?? [] });
      // stdout carries the MCP protocol: everything else goes to stderr
      const mgr = new WorkspaceManager();
      const { store, ephemeral } = openWorkspace(o.workspace, undefined, mgr);
      if (ephemeral) {
        store.close();
        rmSync(ephemeral, { recursive: true, force: true });
        throw new CliError('No workspace found: run inside a workspace folder or pass -w <name|path>', EXIT.CONFIG_ERROR);
      }
      console.error(dim(`TestPion MCP server for "${store.workspace.name}"${o.readOnly ? ' (read-only)' : ''} on stdio`));
      try {
        await serveTestPionMcp({ store, secrets: new ChainSecretStore([new EnvSecretStore()]), settings: mgr.loadSettings(), readOnly: o.readOnly, allowProduction: o.allowProduction, version: ENGINE_VERSION });
      } finally {
        store.close();
      }
    });
  program
    .command('feedback')
    .description('build a feedback or problem report (bug, idea, ui, question) as Markdown and a link to a pre-filled GitHub issue; nothing is sent')
    .requiredOption('-t, --title <title>', 'a short title')
    .requiredOption('-m, --message <text>', 'what happened, or what you would like')
    .option('-k, --kind <kind>', 'bug, idea, ui or question', 'idea')
    .option('--steps <text>', 'bug: steps to reproduce')
    .option('--expected <text>', 'bug: what you expected')
    .option('--diagnostics', 'include the TestPion version and platform')
    .option('--json', 'print { title, body, labels, url } as JSON')
    .action((o: { title: string; message: string; kind: string; steps?: string; expected?: string; diagnostics?: boolean; json?: boolean }) => {
      if (!['bug', 'idea', 'ui', 'question'].includes(o.kind)) throw new CliError('--kind must be bug, idea, ui or question', EXIT.CONFIG_ERROR);
      const r = composeFeedback({
        kind: o.kind as FeedbackKind,
        title: o.title,
        description: o.message,
        steps: o.steps,
        expected: o.expected,
        where: 'CLI',
        diagnostics: o.diagnostics ? [`TestPion CLI ${ENGINE_VERSION}`, `${process.platform} ${process.arch} · Node ${process.versions.node}`] : undefined,
      });
      if (o.json) return void console.log(JSON.stringify(r, null, 2));
      console.log(`${bold(r.title)}

${r.body}

${dim('Open this link to review and post it on GitHub:')}
${cyan(r.url)}`);
    });
  program
    .command('agents-md')
    .description('write (or refresh) the TestPion part of AGENTS.md in the workspace folder: how coding agents (Claude Code, Codex, Cursor, Copilot) use it over MCP and the CLI, the check types and the test file format')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--stdout', 'print it instead of writing the file')
    .action((o: { workspace?: string; stdout?: boolean }) => {
      const { store, ephemeral } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
      try {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace folder or pass -w <name|path>', EXIT.CONFIG_ERROR);
        const block = agentsMarkdown({ workspace: store.workspace.name, checkTypes: checkTypes() });
        if (o.stdout) return void process.stdout.write(block);
        const path = join(store.root, 'AGENTS.md');
        const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
        writeFileSync(path, upsertAgentsMarkdown(before, block));
        console.log(`${before === undefined ? 'Wrote' : 'Updated the TestPion part of'} ${path}`);
      } finally {
        store.close();
        if (ephemeral) rmSync(ephemeral, { recursive: true, force: true });
      }
    });
  program
    .command('graphql-subscribe')
    .description('run a GraphQL subscription over WebSocket (graphql-transport-ws or graphql-ws) and print the events')
    .argument('<endpoint>', 'GraphQL endpoint (http(s):// is turned into ws(s)://)')
    .requiredOption('-q, --query <query>', 'the subscription document')
    .option('--variables <json>', 'variables as JSON')
    .option('-H, --header <header...>', 'handshake headers "Name: value"')
    .option('--connection-params <json>', 'connection_init payload as JSON')
    .option('-n, --max <n>', 'stop after this many events', '10')
    .option('--duration <sec>', 'stop after this many seconds', '30')
    .option('--json', 'print { protocol, events, errors, completed } as JSON')
    .action(async (endpoint: string, o: { query: string; variables?: string; header?: string[]; connectionParams?: string; max: string; duration: string; json?: boolean }) => {
      const parseJson = (s: string | undefined, what: string) => {
        if (!s) return undefined;
        try {
          return JSON.parse(s);
        } catch {
          throw new CliError(`${what} is not valid JSON`, EXIT.CONFIG_ERROR);
        }
      };
      const headers = (o.header ?? []).map((h) => ({ key: h.slice(0, h.indexOf(':')).trim(), value: h.slice(h.indexOf(':') + 1).trim(), enabled: true }));
      const r = await collectSubscriptionEvents({ url: endpoint, query: o.query, variables: parseJson(o.variables, '--variables'), connectionParams: parseJson(o.connectionParams, '--connection-params'), headers, maxEvents: Number(o.max) || 10, durationMs: (Number(o.duration) || 30) * 1000 });
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else {
        for (const e of r.events) console.log(JSON.stringify(e));
        for (const e of r.errors) console.log(red(`error: ${JSON.stringify(e)}`));
        console.log(dim(`${r.events.length} events over ${r.protocol || 'WebSocket'}${r.completed ? ', completed by the server' : ''}`));
      }
      if (r.errors.length) process.exitCode = EXIT.TEST_FAILURE;
    });
  program
    .command('record')
    .description('record traffic: a reverse proxy on localhost that forwards to <target> and records every request and response; on Ctrl+C, -w saves them as a collection')
    .argument('<target>', 'the API base URL, e.g. https://api.example.com')
    .option('-p, --port <port>', 'port to listen on (default: any free port)')
    .option('-w, --workspace <nameOrPath>', 'save the recording to this workspace when you stop')
    .option('--collection <name>', 'name of the saved collection', 'Recorded')
    .option('-q, --quiet', 'do not log each exchange')
    .action(async (targetUrl: string, o: { port?: string; workspace?: string; collection: string; quiet?: boolean }) => {
      const rec = await startRecorder({
        target: targetUrl,
        port: o.port ? Number(o.port) : undefined,
        onExchange: (e) => {
          if (!o.quiet) console.log(`${e.error ? red(String(e.status)) : e.status >= 400 ? yellow(String(e.status)) : green(String(e.status))} ${e.method.padEnd(6)} ${e.path}  ${dim(`${e.durationMs} ms`)}`);
        },
      });
      console.log(bold(`Recording ${rec.target}`));
      console.log(`Point your client at ${cyan(rec.url)} (instead of ${rec.target}). Ctrl+C stops${o.workspace ? ' and saves the recording' : ''}.`);
      await new Promise<void>((done) => {
        const stop = () => {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
          done();
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
      await rec.close();
      console.log(dim(`\n${rec.exchanges.length} exchanges recorded.`));
      if (o.workspace && rec.exchanges.length) {
        const mgr = new WorkspaceManager();
        const { store } = openWorkspace(o.workspace, undefined, mgr);
        try {
          const r = recordingToCollection(rec.exchanges, { name: o.collection, target: rec.target, redactor: new Redactor(mgr.loadSettings().redactFields) });
          const saved = store.saveCollection(r.collection);
          console.log(green(`Saved ${r.requests} requests to the collection "${saved.name}".`));
          if (r.placeholders.length) console.log(yellow(`Secrets were replaced by variables; set them as secret environment variables: ${r.placeholders.map((p) => p.variable).join(', ')}`));
        } finally {
          store.close();
        }
      }
    });
  program
    .command('mock')
    .description("serve a collection's saved examples on localhost (like a Postman mock server) until Ctrl+C\n<collection> is a collection name or id in the workspace, or a TestPion / Postman v2.1 collection or OpenAPI file or link")
    .argument('<collection>', 'collection name or id, a file, or an http(s) link')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('-p, --port <port>', 'port to listen on (default: any free port)')
    .option('--delay <ms>', 'delay every response by this many ms')
    .option('--fallback <url>', 'forward requests that match no example to this API (partial mocking)')
    .option('-q, --quiet', 'do not log requests')
    .action(async (ref: string, o: { workspace?: string; port?: string; delay?: string; fallback?: string; quiet?: boolean }) => {
      process.exitCode = await executeMock(ref, o);
    });
  program
    .command('mock-mcp')
    .description('serve a fake MCP server from a mock definition (*.mcp-mock.yaml): over stdio for AI agents, or --http on localhost')
    .argument('<file>', 'mock definition (YAML or JSON)')
    .option('--http', 'serve Streamable HTTP on localhost instead of stdio')
    .option('-p, --port <port>', 'port for --http (default: any free port)')
    .action(async (file: string, o: { http?: boolean; port?: string }) => {
      const def = loadMcpMock(readFileSync(file, 'utf8'));
      if (!o.http) {
        // stdout carries the MCP protocol: messages go to stderr
        console.error(dim(`MCP mock "${def.name}" on stdio: ${(def.tools ?? []).length} tools`));
        await serveMcpMockStdio(def);
        return;
      }
      const server = await startMcpMockHttp(def, { port: o.port ? Number(o.port) : 0 });
      console.log(bold(`MCP mock "${def.name}": ${server.url}`));
      console.log(dim(`Tools: ${(def.tools ?? []).map((t) => t.name).join(', ') || 'none'}. Press Ctrl+C to stop.`));
      await new Promise<void>((done) => {
        const stop = () => {
          process.off('SIGINT', stop);
          void server.close().then(done);
        };
        process.on('SIGINT', stop);
      });
    });
  program
    .command('mock-graphql')
    .description('serve fake, correctly typed data for any query against a GraphQL schema, on localhost until Ctrl+C')
    .option('--schema <file>', 'schema file: SDL (.graphql) or an introspection result (.json)')
    .option('--endpoint <url>', 'or: introspect this GraphQL endpoint')
    .option('-p, --port <port>', 'port to listen on (default: any free port)')
    .option('--overrides <file>', 'JSON file with fixed values per type, e.g. {"Patient": {"name": "Rex"}}')
    .option('--list-length <n>', 'items in every list', '2')
    .option('--delay <ms>', 'delay every response by this many ms')
    .action(async (o: { schema?: string; endpoint?: string; port?: string; overrides?: string; listLength?: string; delay?: string }) => {
      if (!o.schema === !o.endpoint) throw new CliError('Give --schema <file> or --endpoint <url>', EXIT.CONFIG_ERROR);
      const schema = o.schema ? schemaFromText(readFileSync(o.schema, 'utf8')) : (await introspect({ endpoint: o.endpoint! })).schema;
      const overrides = o.overrides ? (JSON.parse(readFileSync(o.overrides, 'utf8')) as Record<string, Record<string, unknown>>) : undefined;
      const server = await startGraphQLMockServer(schema, { port: o.port ? Number(o.port) : 0, overrides, listLength: Number(o.listLength) || 2, delayMs: o.delay ? Number(o.delay) : undefined });
      console.log(bold(`GraphQL mock: ${server.url}`));
      console.log(dim(`Queries: ${Object.keys(schema.getQueryType()?.getFields() ?? {}).join(', ') || 'none'}. Press Ctrl+C to stop.`));
      await new Promise<void>((done) => {
        const stop = () => {
          process.off('SIGINT', stop);
          void server.close().then(done);
        };
        process.on('SIGINT', stop);
      });
    });
  program
    .command('graphql-op')
    .description('build a ready-to-run operation for a root field of a GraphQL schema: variables for its arguments and a selection of its fields')
    .argument('<field>', 'root field: Query.patient, Mutation.addPet, or just patient')
    .option('--schema <file>', 'schema file: SDL (.graphql) or an introspection result (.json)')
    .option('--endpoint <url>', 'or: introspect this GraphQL endpoint')
    .option('-H, --header <key:value...>', 'headers for introspection (e.g. Authorization)')
    .option('-d, --depth <n>', 'levels of nested objects to select', '2')
    .option('--required-args', 'only the required arguments (default: all)')
    .option('--json', 'print { operation, operationName, query, variables } as JSON (for scripts and AI agents)')
    .action(async (field: string, o: { schema?: string; endpoint?: string; header?: string[]; depth: string; requiredArgs?: boolean; json?: boolean }) => {
      if (!o.schema === !o.endpoint) throw new CliError('Give --schema <file> or --endpoint <url>', EXIT.CONFIG_ERROR);
      const headers = (o.header ?? []).map((kv) => {
        const i = kv.indexOf(':');
        if (i <= 0) throw new CliError(`--header expects key:value, got "${kv}"`, EXIT.CONFIG_ERROR);
        return { key: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim() };
      });
      const schema = o.schema ? schemaFromText(readFileSync(o.schema, 'utf8')) : (await introspect({ endpoint: o.endpoint!, headers })).schema;
      const op = buildGraphQLOperation(schema, field, { depth: Number(o.depth), includeOptionalArgs: !o.requiredArgs });
      if (o.json) console.log(JSON.stringify(op, null, 2));
      else {
        console.log(op.query);
        if (Object.keys(op.variables).length) console.log(`\n${dim('# variables')}\n${JSON.stringify(op.variables, null, 2)}`);
      }
    });
  program
    .command('mcp')
    .description('connect to an MCP server and print its tools, resources and prompts; with --call, call one tool and print the result')
    .option('--url <url>', 'Streamable HTTP endpoint')
    .option('--sse <url>', 'legacy SSE endpoint')
    .option('-s, --server <nameOrId>', 'a server saved in the workspace (mcp-servers.json), with the environment\'s variables')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest)')
    .option('-e, --environment <name>', 'environment for {{variables}} in the server settings')
    .option('--call <tool>', 'call this tool instead of listing')
    .option('--args <json>', 'arguments of the tool as JSON', '{}')
    .option('--json', 'print as JSON (for scripts and AI agents)')
    .argument('[command...]', 'stdio command, e.g. -- node server.js')
    .action(async (command: string[], o) => {
      let cfg: McpServerConfig;
      let dispose: (() => Promise<void>) | undefined;
      if (o.server) {
        const { store } = openWorkspace(o.workspace, undefined, new WorkspaceManager());
        const ctx = createEngineContext({ store, secrets: new ChainSecretStore([new EnvSecretStore()]), settings: new WorkspaceManager().loadSettings(), environment: o.environment });
        const r = String(o.server).toLowerCase();
        const found = ctx.services.mcpServers.find((x) => x.id.toLowerCase() === r) ?? ctx.services.mcpServers.find((x) => x.name.toLowerCase() === r);
        if (!found) throw new CliError(`No MCP server "${o.server}" in the workspace. Available: ${ctx.services.mcpServers.map((x) => x.name).join(', ') || 'none'}`, EXIT.CONFIG_ERROR);
        cfg = found;
        dispose = async () => {
          await ctx.dispose();
          store.close();
        };
      } else
        cfg = o.url
          ? { id: 'cli', name: o.url, transport: 'streamable-http', url: o.url }
          : o.sse
            ? { id: 'cli', name: o.sse, transport: 'sse', url: o.sse }
            : command.length
              ? { id: 'cli', name: command.join(' '), transport: 'stdio', command: command[0]!, args: command.slice(1) }
              : (() => {
                  throw new CliError('Provide --url, --sse, --server or a stdio command', EXIT.CONFIG_ERROR);
                })();
      const s = new McpSession(cfg);
      await s.connect();
      try {
        if (o.call) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(String(o.args)) as Record<string, unknown>;
          } catch {
            throw new CliError(`--args is not valid JSON: ${String(o.args)}`, EXIT.CONFIG_ERROR);
          }
          const r = await s.callTool(String(o.call), args);
          if (o.json) console.log(JSON.stringify({ tool: o.call, isError: r.isError, durationMs: r.durationMs, content: r.content, structuredContent: r.structuredContent }, null, 2));
          else {
            console.log(`${r.isError ? red('error') : green('ok')} ${dim(`${r.durationMs} ms`)}`);
            for (const c of r.content as Array<{ type: string; text?: string }>) console.log(c.type === 'text' ? c.text : dim(`[${c.type}]`));
            if (r.structuredContent !== undefined) console.log(JSON.stringify(r.structuredContent, null, 2));
          }
          if (r.isError) process.exitCode = EXIT.TEST_FAILURE;
          return;
        }
        const d = await s.discover();
        if (o.json) return console.log(JSON.stringify({ serverInfo: d.serverInfo, instructions: d.instructions, capabilities: d.capabilities, tools: d.tools, resources: d.resources, resourceTemplates: d.resourceTemplates, prompts: d.prompts }, null, 2));
        console.log(bold(`${d.serverInfo?.name ?? 'server'} ${d.serverInfo?.version ?? ''}`), dim(JSON.stringify(d.capabilities)));
        if (d.instructions) console.log(dim(d.instructions));
        console.log(cyan(`\nTools (${d.tools.length})`));
        for (const t of d.tools) console.log(`  ${t.name} ${dim(t.description ?? '')}\n    ${dim(JSON.stringify(t.inputSchema))}`);
        console.log(cyan(`\nResources (${d.resources.length})`));
        for (const r of d.resources) console.log(`  ${r.uri} ${dim(r.name)}`);
        for (const r of d.resourceTemplates) console.log(`  ${r.uriTemplate} ${dim(`${r.name} (template)`)}`);
        console.log(cyan(`\nPrompts (${d.prompts.length})`));
        for (const p of d.prompts) console.log(`  ${p.name} ${dim(p.description ?? '')}`);
      } finally {
        await s.close();
        await dispose?.();
      }
    });

  program
    .command('debug')
    .description("the HTTP Debugger from the terminal: a proxy other programs send through (HTTP_PROXY=…); every exchange is printed as it happens, and the session can be saved as HAR")
    .option('-p, --port <port>', 'port to listen on (default: 8899)', '8899')
    .option('--lan', 'listen on every interface (a phone, another computer), not only this one')
    .option('-o, --out <file.har>', 'save the session as HAR when stopped (Ctrl+C)')
    .option('--json', 'print each exchange as one JSON line (for scripts and AI agents)')
    .action(async (o: { port: string; lan?: boolean; out?: string; json?: boolean }) => {
      const redactor = new Redactor();
      const proxy = await startDebuggerProxy({
        port: Number(o.port) || undefined,
        lan: !!o.lan,
        onExchange: (e, phase) => {
          if (phase !== 'response') return;
          if (o.json) console.log(JSON.stringify({ ...e, url: redactor.redactUrl(e.url), requestBody: undefined, responseBody: undefined }));
          else console.log(`${e.error ? red('ERR') : (e.status ?? 0) >= 400 ? red(String(e.status)) : green(String(e.status ?? '-'))}  ${bold(e.method.padEnd(7))} ${redactor.redactUrl(e.url)}  ${dim(`${e.application ?? ''} ${e.responseBodyBytes} B ${e.durationMs ?? 0} ms`)}`);
        },
      });
      console.error(`${green('HTTP Debugger')} listening on ${proxy.url}  ${dim(`(HTTP_PROXY=${proxy.url}; Ctrl+C to stop${o.out ? `, saves ${o.out}` : ''})`)}`);
      await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
      if (o.out) {
        const entries = proxy.exchanges.filter((e) => e.kind === 'http');
        writeFileSync(o.out, JSON.stringify({ log: { version: '1.2', creator: { name: 'TestPion HTTP Debugger', version: ENGINE_VERSION }, entries: entries.map((e) => ({ startedDateTime: e.startedAt, time: e.durationMs ?? 0, request: { method: e.method, url: redactor.redactUrl(e.url), httpVersion: 'HTTP/1.1', headers: Object.entries(e.requestHeaders).map(([name, value]) => ({ name, value: redactor.isSensitiveKey(name) ? '***' : value })), queryString: [], cookies: [], headersSize: -1, bodySize: e.requestBodyBytes, ...(e.requestBody ? { postData: { mimeType: e.requestHeaders['content-type'] ?? '', text: redactor.redactString(e.requestBody) } } : {}) }, response: { status: e.status ?? 0, statusText: e.statusText ?? '', httpVersion: 'HTTP/1.1', headers: Object.entries(e.responseHeaders ?? {}).map(([name, value]) => ({ name, value: redactor.isSensitiveKey(name) ? '***' : value })), cookies: [], content: { size: e.responseBodyBytes, mimeType: e.contentType ?? '', text: e.responseBody ? redactor.redactString(e.responseBody) : '' }, redirectURL: '', headersSize: -1, bodySize: e.responseBodyBytes }, cache: {}, timings: { send: 0, wait: e.waitMs ?? 0, receive: Math.max(0, (e.durationMs ?? 0) - (e.waitMs ?? 0)) } })) } }, null, 2));
        console.error(`Saved ${entries.length} exchanges to ${o.out}`);
      }
      await proxy.close();
    });

  program
    .command('ws')
    .description('talk to a WebSocket or Socket.IO server: send messages / emit events, print what comes back, close')
    .argument('<url>', 'ws:// or wss:// (WebSocket); http(s)://host/namespace (Socket.IO)')
    .option('-m, --message <text...>', 'WebSocket: messages to send, in order')
    .option('-e, --emit <event=json...>', 'Socket.IO: events to emit, e.g. say=\'{"text":"hi"}\' (a JSON list gives several arguments)')
    .option('--ack', 'Socket.IO: wait for acknowledgements')
    .option('--socketio', 'use Socket.IO (default for http(s) URLs)')
    .option('-H, --header <key:value...>', 'handshake headers')
    .option('--auth <json>', 'Socket.IO handshake auth payload')
    .option('-w, --wait <ms>', 'how long to listen after sending', '1500')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action(async (url: string, o) => {
      const headers = ((o.header as string[] | undefined) ?? []).map((kv) => {
        const i = kv.indexOf(':');
        if (i <= 0) throw new CliError(`--header expects key:value, got "${kv}"`, EXIT.CONFIG_ERROR);
        return { key: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim() };
      });
      const parse = (s: string, what: string) => {
        try {
          return JSON.parse(s) as unknown;
        } catch {
          throw new CliError(`${what} is not valid JSON: ${s}`, EXIT.CONFIG_ERROR);
        }
      };
      const emits = ((o.emit as string[] | undefined) ?? []).map((e) => {
        const i = e.indexOf('=');
        const event = i < 0 ? e : e.slice(0, i);
        const v = i < 0 ? undefined : parse(e.slice(i + 1), `--emit ${event}`);
        return { event, args: v === undefined ? [] : Array.isArray(v) ? v : [v], ack: !!o.ack };
      });
      const r = await runRealtimeExchange(
        {
          url,
          mode: o.socketio || emits.length ? 'socketio' : undefined,
          send: emits.length ? emits : (o.message as string[] | undefined),
          waitMs: Number(o.wait),
          headers,
          auth: o.auth ? (parse(o.auth, '--auth') as Record<string, unknown>) : undefined,
        },
        { redactor: new Redactor() },
      );
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.connected ? green('connected') : red('not connected')} ${dim(`${r.mode} · ${url} · ${r.durationMs} ms`)}`);
        for (const m of r.messages) console.log(`${dim(`${(m.atMs / 1000).toFixed(2)}s`)} ${m.direction === 'sent' ? cyan('→') : m.direction === 'received' ? green('←') : dim('·')} ${m.event ? bold(`${m.ack ? 'ack ' : ''}${m.event} `) : ''}${m.data}`);
      }
      process.exitCode = r.connected ? EXIT.SUCCESS : EXIT.EXECUTION_ERROR;
    });

  program
    .command('mqtt')
    .description('talk to an MQTT broker: subscribe to topics, publish messages, print what arrives, disconnect')
    .argument('<url>', 'mqtt://host:1883, mqtts://host:8883, or ws(s)://host/mqtt for brokers behind WebSocket')
    .option('-s, --subscribe <topic...>', 'topic filters to subscribe to first (+ and # wildcards)')
    .option('-p, --publish <topic=payload...>', "messages to publish, in order, e.g. clinic/7/vitals='{\"hr\":80}'")
    .option('-q, --qos <0|1|2>', 'QoS for subscriptions and messages', '0')
    .option('--retain', 'publish retained messages')
    .option('-i, --client-id <id>', 'client ID (default: random)')
    .option('-u, --username <name>', 'username')
    .option('--password-env <name>', 'environment variable holding the password (never type it on the command line)', 'MQTT_PASSWORD')
    .option('--mqtt5', 'use MQTT 5 (default 3.1.1)')
    .option('-w, --wait <ms>', 'how long to listen after publishing', '1500')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action(async (url: string, o) => {
      const qos = Number(o.qos);
      if (![0, 1, 2].includes(qos)) throw new CliError('--qos must be 0, 1 or 2', EXIT.CONFIG_ERROR);
      const publish = ((o.publish as string[] | undefined) ?? []).map((p) => {
        const i = p.indexOf('=');
        if (i <= 0) throw new CliError(`--publish expects topic=payload, got "${p}"`, EXIT.CONFIG_ERROR);
        return { topic: p.slice(0, i), payload: p.slice(i + 1), qos: qos as 0 | 1 | 2, retain: !!o.retain };
      });
      const password = o.username ? process.env[String(o.passwordEnv)] : undefined;
      const redactor = new Redactor();
      if (password) redactor.addSecret(password);
      const r = await runRealtimeExchange(
        {
          url,
          mode: 'mqtt',
          subscribe: ((o.subscribe as string[] | undefined) ?? []).map((topic) => ({ topic, qos: qos as 0 | 1 | 2 })),
          send: publish,
          waitMs: Number(o.wait),
          clientId: o.clientId,
          username: o.username,
          password,
          protocolVersion: o.mqtt5 ? 5 : 4,
        },
        { redactor },
      );
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.connected ? green('connected') : red('not connected')} ${dim(`mqtt · ${url} · ${r.durationMs} ms`)}`);
        for (const m of r.messages) console.log(`${dim(`${(m.atMs / 1000).toFixed(2)}s`)} ${m.direction === 'sent' ? cyan('→') : m.direction === 'received' ? green('←') : dim('·')} ${m.topic ? bold(`${m.topic} `) : ''}${m.data}`);
      }
      process.exitCode = r.connected ? EXIT.SUCCESS : EXIT.EXECUTION_ERROR;
    });

  program
    .command('grpc')
    .description('call a gRPC method (or list the methods in the .proto files when no method is given)')
    .argument('<target>', 'server address: host:port, or grpcs://host:port for TLS')
    .argument('[method]', 'package.Service/Method')
    .option('-p, --proto <files...>', '.proto files (with the files they import); without them the server is asked through server reflection')
    .option('-d, --data <json>', 'request message as JSON (a JSON list for client streaming), or @file.json', '{}')
    .option('-H, --metadata <key:value...>', 'metadata entries')
    .option('--tls', 'use TLS')
    .option('--timeout <ms>', 'deadline in ms', '30000')
    .option('--json', 'print the result as JSON (for scripts and AI agents)')
    .action(async (target: string, method: string | undefined, o) => {
      const protoFiles = ((o.proto as string[] | undefined) ?? []).map((f) => ({ name: f.replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }));
      const metadata = ((o.metadata as string[] | undefined) ?? []).map((kv) => {
        const i = kv.indexOf(':');
        if (i <= 0) throw new CliError(`--metadata expects key:value, got "${kv}"`, EXIT.CONFIG_ERROR);
        return { key: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim() };
      });
      // no proto files: the server describes itself (server reflection)
      const descriptorSet = protoFiles.length ? undefined : (await reflectServer(parseGrpcTarget(target, o.tls), { metadata })).descriptorSet;
      if (!method) {
        const methods = describeRoot(grpcRoot({ protoFiles, descriptorSet }));
        if (o.json) console.log(JSON.stringify(methods, null, 2));
        else for (const m of methods) console.log(`${m.name} ${dim(`${m.clientStreaming ? 'stream ' : ''}${m.requestType} → ${m.serverStreaming ? 'stream ' : ''}${m.responseType}`)}\n  ${dim(JSON.stringify(m.example))}`);
        return;
      }
      const data = String(o.data).startsWith('@') ? readFileSync(String(o.data).slice(1), 'utf8') : String(o.data);
      const r = await executeGrpc({ target, method, message: data, metadata, protoFiles, descriptorSet, tls: o.tls, timeoutMs: Number(o.timeout) }, { redactor: new Redactor() });
      if (o.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.code === 0 ? green(`${r.code} ${r.codeName}`) : red(`${r.code} ${r.codeName}`)} ${dim(`${r.method} @ ${r.target} · ${Math.round(r.durationMs)} ms`)}${r.details ? ` ${r.details}` : ''}`);
        if (r.response !== undefined) console.log(JSON.stringify(r.response, null, 2));
        for (const m of r.messages ?? []) console.log(`${dim(`${(m.atMs / 1000).toFixed(2)}s`)} ${JSON.stringify(m.data)}`);
      }
      process.exitCode = r.code === 0 ? EXIT.SUCCESS : EXIT.TEST_FAILURE;
    });
}
