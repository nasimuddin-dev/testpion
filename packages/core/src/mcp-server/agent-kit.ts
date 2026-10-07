/**
 * What makes the TestPion MCP server easy for an AI agent to use, beyond the tools themselves: a display title
 * and behaviour hints for every tool (MCP tool annotations: read-only, destructive, idempotent, reaches the
 * network), a guide to the workspace and the test file format (a resource, and the `testpion_guide` tool for
 * clients without resources), and prompts for the common jobs (find what fails, write tests, debug a request).
 */

/** Tools that reach the network (the API under test, an OTLP collector, a certificate's host …). */
const OPEN_WORLD = new Set([
  'send_request',
  'grpc_call',
  'realtime_exchange',
  'graphql_operation',
  'graphql_subscribe',
  'import_definition',
  'compare_request_across_environments',
  'run_monitor',
  'run_collection',
  'run_tests',
  'run_evaluation',
  'load_test',
  'check_certificate',
  'export_traces',
  'openapi_diff',
  'openapi_lint',
  'openapi_outline',
  'api_coverage',
]);

/** Tools that change or remove what is already there (variable values everywhere, files), or send requests that may change the API's data. */
const DESTRUCTIVE = new Set([
  'debugger_capture',
  'git_resolve',
  'debugger_rules',
  'debugger_session',
  'delete_request',
  'update_request',
  'move_request',
  'set_collection_variable',
  'mcp_call_tool',
  'rename_variable',
  'set_environment_variable',
  'write_test_file',
  'set_request_checks',
  'send_request',
  'grpc_call',
  'realtime_exchange',
  'graphql_operation',
  'run_collection',
  'run_tests',
  'run_monitor',
  'load_test',
  'compare_request_across_environments',
]);

/** Write tools that give the same result when called again with the same arguments. */
const IDEMPOTENT = new Set(['set_environment_variable', 'reorder_environments', 'write_test_file', 'set_request_checks']);

const WORDS: Record<string, string> = { jwt: 'JWT', openapi: 'OpenAPI', ci: 'CI', mcp: 'MCP', llm: 'LLM', grpc: 'gRPC', graphql: 'GraphQL', api: 'API', testpion: 'TestPion' };

/** "list_collections" → "List collections", "decode_jwt" → "Decode JWT". */
export function toolTitle(name: string): string {
  const t = name
    .split('_')
    .map((w) => WORDS[w] ?? w)
    .join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export interface ToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

/** MCP tool annotations: clients use them to auto-approve safe calls and to ask before risky ones. */
export function toolAnnotations(name: string, write: boolean): ToolAnnotations {
  return {
    title: toolTitle(name),
    readOnlyHint: !write,
    ...(write ? { destructiveHint: DESTRUCTIVE.has(name), idempotentHint: IDEMPOTENT.has(name) } : {}),
    openWorldHint: OPEN_WORLD.has(name),
  };
}

/** The guide for agents: how the workspace is laid out, which tools to use for what, and the test file format. */
export function agentGuide(o: { workspace: string; checkTypes: string[]; readOnly?: boolean }): string {
  return `# TestPion for AI agents

Workspace: **${o.workspace}**. TestPion is an API client and test runner (REST, GraphQL, gRPC, WebSocket / Socket.IO / MQTT / Kafka, MCP, LLMs). Secret values never leave the machine: tools return variable *names*, and saved requests keep secrets as \`{{variables}}\`.${o.readOnly ? '\n\nThis server is **read-only**: tools that send requests or change files are not available.' : ''}

## Where to start

| Job | Tools |
|---|---|
| What is broken or about to break | \`what_needs_attention\`, then \`recent_failures\`, \`monitor_results\`, \`flaky_tests\` |
| Understand the API | \`list_collections\` → \`list_requests\` → \`get_request\` / \`collection_docs\`; \`list_environments\` |
| Call an endpoint | \`send_request\` (a saved request, or method + url, or a cURL / fetch snippet) |
| Run tests | \`run_collection\` (a collection or folder), \`run_tests\` (test files), then \`run_breakdown\`, \`compare_runs\` |
| Write tests | \`set_request_checks\` (checks on a saved request), \`write_test_file\` (a YAML file under tests/), \`save_test\` (a saved request as a test) |
| Save what the user pasted | \`parse_request_snippet\`, \`save_request\` (secrets become {{variables}}) |
| Performance | \`response_time_stats\`, \`collection_timing\`, \`load_test\` (local APIs only), \`load_history\` |
| Contracts | \`import_definition\`, \`api_coverage\`, \`openapi_diff\`, \`openapi_lint\`, \`openapi_outline\`, \`collection_openapi\` |
| Git | \`git_status\`, \`git_diff\` (changes by meaning, or between two commits), \`git_log\`, \`git_propose_commit\` (stages and proposes; a person commits) |
| Change the workspace | \`update_request\` (URL, headers, body, scripts of a saved request), \`move_request\`, \`delete_request\`, \`create_collection\`, \`create_folder\`, \`set_collection_variable\` |
| Test an MCP server | \`list_mcp_servers\`, \`mcp_server_tools\` (what it offers), \`mcp_call_tool\` (call a tool and read the result) |

Names or ids work wherever a collection, request, environment or monitor is asked for. Errors say what is available, so read them and retry.

## Variables

\`{{name}}\` resolves from the chosen environment, then collection, workspace and global variables. \`{{$guid}}\`, \`{{$timestamp}}\`, \`{{$randomInt}}\` are dynamic. \`{{$env.NAME}}\` reads an OS environment variable. Pass \`environment\` to tools that send; production environments are refused unless the server was started with --allow-production.

## Checks

A check is \`{ type, name?, path?, expected?, ... }\`; \`path\` is a JSONPath into the response body (\`$.data.items[0].id\`). The types this engine knows:

${o.checkTypes.map((t) => `\`${t}\``).join(', ')}

Common ones:

- \`{ type: status, expected: 200 }\` (also \`"2xx"\`, \`[200, 201]\`)
- \`{ type: equals, path: $.id, expected: 42 }\`, \`{ type: exists, path: $.token }\`, \`{ type: contains, path: $.name, expected: Rex }\`
- \`{ type: json-schema, path: $, schema: {...} }\` or \`{ type: snapshot, mode: shape }\`
- \`{ type: latency, max: 800 }\`, \`{ type: header, header: content-type, expected: application/json }\`
- \`{ type: jwt, path: $.access_token, min: 300 }\`, \`{ type: openapi, spec: specs/api.yaml }\`
- GraphQL: \`graphql-no-errors\`; gRPC: \`grpc-status\`; LLM: \`llm-judge\`, \`similarity\`, \`refusal\`, \`no-leak\`, \`tool-called\`

## Test files

YAML under \`tests/\` (\`testpion test\` and CI run them). One file holds one test or a \`tests:\` list with shared \`defaults:\`:

\`\`\`yaml
defaults:
  type: http
  tags: [smoke]
tests:
  - id: create-pet
    name: Create a pet
    method: POST
    url: "{{baseUrl}}/pets"
    headers: { Authorization: "Bearer {{token}}" }
    body: { name: Rex, kind: dog }
    extract: { petId: $.id }        # a runtime variable for later tests
    assertions:
      - { type: status, expected: 201 }
      - { type: exists, path: $.id }
  - id: get-pet
    name: Read it back
    dependsOn: create-pet
    method: GET
    url: "{{baseUrl}}/pets/{{petId}}"
    assertions:
      - { type: equals, path: $.name, expected: Rex }
\`\`\`

Other types: \`graphql\` (\`endpoint\`, \`query\`, \`variables\`), \`grpc\` (\`target\`, \`method\`, \`message\`), \`websocket\` / \`socketio\` / \`mqtt\`, \`mcp\` (\`server\`, \`tool\`, \`arguments\`), \`llm\` (\`provider\`, \`model\`, \`prompt\`). Suites are \`*.suite.yaml\` (\`tests: [rest, graphql]\`, \`setup\`, \`teardown\`, \`concurrency\`, \`retries\`, \`environment\`).

\`write_test_file\` checks a file (it must parse and use known check types) before saving it, and \`run_tests\` with \`paths\` runs it.
`;
}

export interface PromptDef {
  name: string;
  title: string;
  description: string;
  arguments: Array<{ name: string; description: string; required?: boolean }>;
  text(args: Record<string, string | undefined>): string;
}

/** Prompts (MCP): ready-made instructions for the common jobs, which a user picks in their agent (e.g. a / command). */
export const AGENT_PROMPTS: PromptDef[] = [
  {
    name: 'investigate_failures',
    title: 'Find what is failing and why',
    description: 'Look through monitors, runs, certificates and recent responses, explain each problem and suggest a fix.',
    arguments: [{ name: 'focus', description: 'A collection, monitor or area to look at first (optional)' }],
    text: (a) =>
      `Find out what is failing in this TestPion workspace${a.focus ? `, starting with "${a.focus}"` : ''}, and why.

1. Call what_needs_attention and read every item.
2. For a failing monitor, call monitor_results and monitor_requests; for a failed run, run_breakdown; for requests, recent_failures and request_history; for flaky tests, test_history.
3. Where the cause is not clear, send the request again with send_request (not to production) and compare with compare_responses or the saved examples.
4. Answer with a short list: what fails, since when, the most likely cause (with the evidence: status, message, timing), and the fix you suggest. Say what you could not check.`,
  },
  {
    name: 'write_tests',
    title: 'Write tests for a collection',
    description: 'Add meaningful checks to the requests of a collection and save them as a test file the CI can run.',
    arguments: [
      { name: 'collection', description: 'Collection name or id', required: true },
      { name: 'environment', description: 'Environment to send the requests with' },
    ],
    text: (a) =>
      `Write tests for the collection "${a.collection}"${a.environment ? ` (environment "${a.environment}")` : ''}.

1. Read testpion_guide (the check types and the test file format), then list_requests and collection_docs.
2. Send each request with send_request to see its real response.
3. For each request choose checks that would catch a real regression: the status, the fields a client relies on (exists / equals / type), a json-schema or snapshot of the shape, and a latency limit with headroom. Don't assert values that change on every call (ids, timestamps).
4. Save them with set_request_checks (they then run in the app and in run_collection), and when the user wants CI, with write_test_file under tests/.
5. Run them with run_collection and fix checks that fail because they were wrong (not because the API is wrong; report those).
Finish with what you added per request and anything that looked like a bug.`,
  },
  {
    name: 'debug_request',
    title: 'Debug a request',
    description: 'Send a saved request, explain the response (status, body, headers, timing) and what to change when it fails.',
    arguments: [
      { name: 'collection', description: 'Collection name or id', required: true },
      { name: 'request', description: 'Request name or id', required: true },
      { name: 'environment', description: 'Environment name' },
    ],
    text: (a) =>
      `Debug the request "${a.request}" in "${a.collection}"${a.environment ? ` with the environment "${a.environment}"` : ''}.

1. get_request to see how it is built (variables, auth, scripts, checks); list_environments for the variables it needs.
2. send_request and read the status, body, headers, timing phases and script logs.
3. If it fails, find the reason: an unresolved {{variable}}, auth, the body, the URL, a failing check, or the server. Use request_history and compare_responses to see whether it used to work and what changed.
4. Explain the cause in two or three sentences and give the exact change (a header, a variable, a check), without inventing values for secrets.`,
  },
  {
    name: 'api_health_report',
    title: 'API health report',
    description: 'A short report of how the APIs in this workspace are doing: availability, speed, failures and certificates.',
    arguments: [{ name: 'days', description: 'How many days back (default 7)' }],
    text: (a) =>
      `Write a short health report of the APIs in this workspace for the last ${a.days || '7'} days.

Use workspace_activity, list_monitors with monitor_uptime and monitor_results, response_time_stats or collection_health for the main collections, recent_failures, list_certificates and flaky_tests.

Report in Markdown: a one-line summary, then availability per monitor, the slowest requests (p95) and whether they got slower, the failures that repeat, certificates that expire soon, and the three things to fix first.`,
  },
  {
    name: 'import_and_test',
    title: 'Import a request or API and test it',
    description: 'Take a cURL / fetch command or an OpenAPI link, save it to a collection, send it and add checks.',
    arguments: [
      { name: 'source', description: 'A cURL / fetch / PowerShell command, or an OpenAPI URL', required: true },
      { name: 'collection', description: 'Collection to save into (created when missing)' },
    ],
    text: (a) =>
      `Import this into the workspace and test it:

${a.source}

If it is an OpenAPI link or document, use import_definition and then api_coverage. If it is a command, use parse_request_snippet, then save_request into "${a.collection || 'Imported'}" (create it if needed; secrets become {{variables}}: tell the user which ones to set). Send it with send_request, then add checks with set_request_checks and confirm they pass.`,
  },
];

const AGENTS_START = '<!-- testpion:start (written by TestPion; edit outside these markers) -->';
const AGENTS_END = '<!-- testpion:end -->';

/**
 * The TestPion part of a workspace's AGENTS.md (the file coding agents such as Claude Code, Codex, Cursor and
 * Copilot read first in a folder): how to reach the workspace (MCP, CLI) and the guide. `connect` is the command
 * that serves the workspace over MCP, as the app shows it.
 */
export function agentsMarkdown(o: { workspace: string; checkTypes: string[]; connect?: string }): string {
  const guide = agentGuide({ workspace: o.workspace, checkTypes: o.checkTypes }).replace(/^# TestPion for AI agents\n/, '');
  return `${AGENTS_START}
# TestPion workspace

This folder is a TestPion workspace: collections/ (saved requests), environments/ (variables; secret values are not in these files), tests/ (YAML test files), specs/ (OpenAPI), mocks/, datasets/. Prefer the TestPion tools to editing these JSON files by hand: they keep ids, secrets and references right.

## Use it

- **MCP** (best for agents): \`${o.connect ?? 'testpion mcp-server -w .'}\` serves this workspace as MCP tools, resources and prompts (in the TestPion app: Settings ▸ AI agents has the setup for Claude, Cursor, VS Code and Codex). Start with \`what_needs_attention\` or the \`testpion_guide\` tool.
- **CLI**: \`testpion test tests/\` runs the test files and \`testpion run-collection "<name>"\` a collection (\`-r json\` writes report.json); \`testpion send <url> --json\` sends one request; listing commands (\`collections\`, \`requests\`, \`history\` …) take \`--json\`.
${guide}${AGENTS_END}
`;
}

/** AGENTS.md with the TestPion part added or replaced; what the user wrote around it stays as it is. */
export function upsertAgentsMarkdown(existing: string | undefined, block: string): string {
  if (!existing?.trim()) return block;
  const a = existing.indexOf(AGENTS_START);
  const b = existing.indexOf(AGENTS_END);
  if (a >= 0 && b > a) return existing.slice(0, a) + block.trimEnd() + existing.slice(b + AGENTS_END.length);
  return `${existing.trimEnd()}\n\n${block}`;
}
