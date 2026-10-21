import { ENGINE_VERSION } from '../version.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { mcpServer, mcpServerStdio, mcpTypes } from './sdk.js';
import type { AppSettings, Collection } from '../model/types.js';
import { AGENT_PROMPTS, agentGuide, toolAnnotations } from './agent-kit.js';
import { checkTypes } from '../eval/checks.js';
import { ApsError, normalizeError } from '../errors.js';
import { Redactor } from '../util/redact.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import type { SecretStore } from '../storage/secrets.js';
import { flowTools } from './tools/flow-tools.js';
import { moduleTools } from './tools/index.js';
import { contractCallResult, elicitationConfirmer, isContractResult, withToolContract, type Confirmer } from './tool-contract.js';
import { TOOL_DOCS } from './tool-docs.js';
import type { DebuggerExchange } from '../debugger/proxy.js';
import { withEnvironmentSecrets, withProductionConsent, type Tool } from './tool.js';
import { MINIMAL_TOOLS, searchTool } from './tools/search-tools.js';
import { readSpecRef } from '../openapi/spec-files.js';
import { requireCollection } from '../storage/env-edit.js';
import { browseTools } from './tools/browse-tools.js';
import { requestTools } from './tools/request-tools.js';
import { graphqlTools } from './tools/graphql-tools.js';
import { definitionTools } from './tools/definition-tools.js';
import { environmentTools } from './tools/environment-tools.js';
import { opsTools } from './tools/ops-tools.js';
import { monitorTools } from './tools/monitor-tools.js';
import { runTools } from './tools/run-tools.js';
import { testFileTools } from './tools/test-file-tools.js';
import { loadTools } from './tools/load-tools.js';
import { clip, findRequestIn, flatten, requestFrom, resultSummarizer, runRecorder } from './tools/server-kit.js';
import type { ModuleToolDeps } from './tools/deps.js';

/**
 * `testpion mcp-server`: the TestPion engine as MCP tools, so AI agents (Claude, IDE assistants …)
 * can browse a workspace's collections, send requests and run collections. Output is redacted with the
 * workspace's redaction rules; secret values never leave the machine through this server.
 */
export interface TestPionMcpOptions {
  store: WorkspaceStore;
  secrets: SecretStore;
  settings: AppSettings;
  /** Only the browsing tools (no requests are sent). */
  readOnly?: boolean;
  /**
   * Which tools are listed: `full` (every tool; the default) or `minimal` (the tools of the common jobs, for hosts
   * that load every listed tool into the context; search_tools finds the rest, and any tool can be called).
   */
  profile?: 'minimal' | 'full';
  /** Allow sending to environments marked as production (off by default). */
  allowProduction?: boolean;
  version?: string;
}

export function createTestPionMcpServer(opts: TestPionMcpOptions): Server {
  const { store, secrets, settings } = opts;
  const redactor = new Redactor(settings.redactFields);
  const collections = () => store.listCollections().filter((c) => !c.problem);
  const findCollection = (ref: unknown): Collection => requireCollection(store, String(ref ?? ''), { loadable: true });
  /** An OpenAPI document given as an http(s) link, a path inside the workspace (never outside it) or the text itself. */
  const readSpec = (ref: string): Promise<string> => readSpecRef(store, ref);
  const findRequest = findRequestIn;
  const summarizeResult = resultSummarizer(store, redactor);
  const recordedRun = runRecorder({ store, secrets, settings }, summarizeResult);
  const checkEnvironment = (name: unknown): string | undefined => {
    if (name === undefined || name === null || name === '') return undefined;
    const env = store.getEnvironment(String(name));
    if (!env) throw new ApsError('ConfigurationError', `No environment "${String(name)}". Available: ${store.listEnvironments().map((e) => e.name).join(', ') || 'none'}`);
    if (env.isProduction && !opts.allowProduction) throw new ApsError('ConfigurationError', `"${env.name}" is a production environment; the MCP server does not send to production unless started with --allow-production`);
    return env.name;
  };
  /** What debugger_capture captured in this server; flow_from_exchanges reads it too. */
  const captured: DebuggerExchange[] = [];
  const deps: ModuleToolDeps = { store, secrets, settings, redactor, collections, findCollection, findRequest, readSpec, captured, checkEnvironment, readOnly: opts.readOnly, flatten, clip, requestFrom, summarizeResult, recordedRun };
  const all: Tool[] = [
    ...browseTools(deps),
    ...requestTools(deps),
    ...graphqlTools(deps),
    ...definitionTools(deps),
    ...environmentTools(deps),
    ...opsTools(deps),
    ...monitorTools(deps),
    ...runTools(deps),
    ...testFileTools(deps),
    ...loadTools(deps),
    // the tools of every module (tools/index.ts): a new tool goes there, never here
    ...moduleTools(deps),
  ];
  // list_flows and one tool per flow with an expose: block (flow-tools.ts); a flow never shadows a built-in tool
  all.push(...flowTools({ store, secrets, settings, redactor, checkEnvironment }).filter((t) => !all.some((x) => x.name === t.name)));
  const base = withEnvironmentSecrets(store, withProductionConsent(all.filter((t) => !(opts.readOnly && t.write)), !!opts.allowProduction));
  base.push(searchTool(base, (name, write) => toolAnnotations(name, write).title));
  // one contract for every tool (tool-contract.ts): descriptions, id names, pages, size, confirmation, output schemas
  let confirmer: Confirmer | undefined;
  const tools = withToolContract(base, { docs: TOOL_DOCS, confirmer: () => confirmer });
  const listed = opts.profile === 'minimal' ? tools.filter((t) => MINIMAL_TOOLS.has(t.name)) : tools;

  const server = new (mcpServer().Server)(
    { name: 'testpion', version: opts.version ?? ENGINE_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions: `TestPion workspace "${store.workspace.name}". what_needs_attention lists what is failing or about to (monitors, certificates, runs, requests, flaky tests). Use list_collections and list_requests to find requests, get_request or collection_docs to understand them${opts.readOnly ? '' : ', send_request to call one and run_collection to run tests'}. list_monitors and monitor_results show scheduled checks${opts.readOnly ? '' : ' (run_monitor runs one now)'}. parse_request_snippet reads a cURL / fetch / PowerShell command${opts.readOnly ? '' : ' and save_request stores it in a collection (secrets become {{variables}})'}. Values of secrets are never returned. Read testpion_guide (or the testpion://guide resource) for the check types and the test file format before writing tests${opts.readOnly ? '' : ' (set_request_checks, write_test_file)'}; the prompts investigate_failures, write_tests, debug_request, api_health_report and import_and_test walk through the common jobs. ${opts.profile === 'minimal' ? 'This is the minimal profile: the listed tools cover the common jobs; search_tools finds the others (mocks, the debugger, git, load tests, certificates …), and any tool it names can be called.' : 'search_tools finds a tool by what you want to do.'}`,
    },
  );
  server.setRequestHandler(mcpTypes().ListToolsRequestSchema, async () => ({
    tools: listed.map(({ name, description, inputSchema, outputSchema, write }) => {
      const annotations = toolAnnotations(name, !!write);
      return { name, title: annotations.title, description, inputSchema, ...(outputSchema ? { outputSchema } : {}), annotations };
    }),
  }));
  // resources: what an agent (or its user, e.g. with @ in Claude Code) can read as context without calling tools
  const json = (uri: string, data: unknown) => ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] });
  const runTool = (name: string, args: Record<string, unknown> = {}) => all.find((t) => t.name === name)!.run(args);
  server.setRequestHandler(mcpTypes().ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'testpion://guide', name: 'guide', title: 'TestPion guide for agents', description: 'Which tool to use for what, variables, check types and the test file format', mimeType: 'text/markdown' },
      { uri: 'testpion://workspace', name: 'workspace', title: `Workspace "${store.workspace.name}"`, description: 'Collections (with request counts), environments (variable names) and monitors', mimeType: 'application/json' },
      { uri: 'testpion://attention', name: 'attention', title: 'What needs attention', description: 'Failing monitors, expiring certificates, failed runs and requests, flaky tests', mimeType: 'application/json' },
      ...collections().map((c) => ({ uri: `testpion://collections/${encodeURIComponent(c.id)}`, name: c.name, title: `Collection "${c.name}"`, description: 'Its documentation: every request with parameters, headers, body and examples', mimeType: 'text/markdown' })),
    ],
  }));
  server.setRequestHandler(mcpTypes().ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      { uriTemplate: 'testpion://collections/{collection}', name: 'collection', title: 'A collection\'s documentation', description: 'Collection name or id', mimeType: 'text/markdown' },
      { uriTemplate: 'testpion://collections/{collection}/requests/{request}', name: 'request', title: 'A saved request', description: 'Its method, URL, headers, body, auth type, scripts and checks (secrets masked)', mimeType: 'application/json' },
    ],
  }));
  server.setRequestHandler(mcpTypes().ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (uri === 'testpion://guide') return { contents: [{ uri, mimeType: 'text/markdown', text: agentGuide({ workspace: store.workspace.name, checkTypes: checkTypes(), readOnly: opts.readOnly }) }] };
    if (uri === 'testpion://workspace')
      return json(uri, { workspace: store.workspace.name, collections: await runTool('list_collections'), environments: await runTool('list_environments'), monitors: await runTool('list_monitors') });
    if (uri === 'testpion://attention') return json(uri, await runTool('what_needs_attention'));
    const m = /^testpion:\/\/collections\/([^/]+)(?:\/requests\/([^/]+))?$/.exec(uri);
    if (m) {
      const collection = decodeURIComponent(m[1]!);
      if (m[2]) return json(uri, await runTool('get_request', { collection, request: decodeURIComponent(m[2]) }));
      return { contents: [{ uri, mimeType: 'text/markdown', text: String(await runTool('collection_docs', { collection })) }] };
    }
    throw new ApsError('ConfigurationError', `Unknown resource ${uri}`);
  });
  server.setRequestHandler(mcpTypes().ListPromptsRequestSchema, async () => ({
    prompts: AGENT_PROMPTS.filter((p) => !opts.readOnly || p.name === 'investigate_failures' || p.name === 'api_health_report').map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })),
  }));
  server.setRequestHandler(mcpTypes().GetPromptRequestSchema, async (req) => {
    const p = AGENT_PROMPTS.find((x) => x.name === req.params.name);
    if (!p) throw new ApsError('ConfigurationError', `Unknown prompt ${req.params.name}. Available: ${AGENT_PROMPTS.map((x) => x.name).join(', ')}`);
    const args = (req.params.arguments ?? {}) as Record<string, string | undefined>;
    const missing = p.arguments.filter((x) => x.required && !args[x.name]).map((x) => x.name);
    if (missing.length) throw new ApsError('ValidationError', `Missing: ${missing.join(', ')}`);
    return { description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.text(args) } }] };
  });
  server.setRequestHandler(mcpTypes().CallToolRequestSchema, async (req) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }] };
    try {
      const r = await tool.run((req.params.arguments ?? {}) as Record<string, unknown>);
      if (isContractResult(r)) return contractCallResult(r);
      const out = r;
      if (typeof out === 'string') return { content: [{ type: 'text', text: out }] };
      // the JSON as text for every client, and as structured content for clients that read it (a list is wrapped: structured content is an object)
      const structured = Array.isArray(out) ? { items: out } : out && typeof out === 'object' ? (out as Record<string, unknown>) : { value: out };
      // a result that says so (a flow with a failed step) is an error result for the client, with the details kept
      return { ...(structured.isError === true ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: structured };
    } catch (e) {
      const err = normalizeError(e);
      return { isError: true, content: [{ type: 'text', text: `${err.kind}: ${err.message}${err.suggestions.length ? `\n${err.suggestions.join('\n')}` : ''}` }] };
    }
  });
  // a deleting or overwriting call without confirm: true asks the user when the client can (MCP elicitation)
  confirmer = elicitationConfirmer(server);
  return server;
}

/**
 * Serve the workspace over stdio until the client disconnects. `stdio` replaces process.stdin / stdout (the
 * desktop app passes streams on file descriptors 0 and 1: Electron's process.stdin reads nothing on Windows).
 */
export async function serveTestPionMcp(opts: TestPionMcpOptions & { stdio?: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } }): Promise<void> {
  const server = createTestPionMcpServer(opts);
  const transport = new (mcpServerStdio().StdioServerTransport)(opts.stdio?.input as never, opts.stdio?.output as never);
  const closed = new Promise<void>((resolve) => (server.onclose = () => resolve()));
  await server.connect(transport);
  await closed;
}
