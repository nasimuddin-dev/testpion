/**
 * What the AI assistant is asked to do for each task of the app (Explain this error, Suggest assertions, Write a
 * commit message …): one instruction per task, prepended to the user's context. Secrets are hidden before anything is
 * sent (the context is redacted); an instruction may therefore never ask for a value.
 */
const ASSISTANT_TASKS: Record<string, string> = {
  'explain-error': 'Explain what went wrong in plain language, the most likely cause, and concrete troubleshooting steps. Be concise. Use short headings: What happened, Why, How to fix.',
  'generate-assertions':
    'Propose assertions for this response as a YAML list using the TestPion check types (status, exists, equals, contains, regex, json-schema, type, length, latency, header). Output only YAML.',
  'generate-test': 'Write an TestPion YAML test for the described scenario. Output only YAML.',
  'generate-query': 'Write a GraphQL operation for the request using the given schema. Output only the GraphQL document.',
  'generate-args': 'Produce example JSON arguments that satisfy this JSON Schema. Output only JSON.',
  'generate-mock-data': 'Generate realistic mock data matching the description or schema. Output only JSON.',
  'design-toolset':
    'Design the tools an AI agent needs for the described job, as a TestPion MCP mock definition in YAML (the toolset is served as a real MCP server before the backend exists). Output a YAML document with: name (kebab-case), instructions (one sentence for the agent), and tools: for each tool a snake_case name, a description that says what it does and when the agent should call it, inputSchema (a JSON Schema object with properties, each with a type and a description, and required), annotations when relevant (readOnlyHint: true for reads, destructiveHint: true for deletes), and responses: a realistic default json answer, one response with `when` (argument values) and isError: true for an error or edge case, and a `script` response (`(args) => result`, plain JavaScript, no network) when the answer depends on the arguments. `{{args.name}}` placeholders and dynamic variables such as `{{$guid}}` or `{{$randomInt(1,100)}}` are allowed in text and json answers. Keep the tools few and orthogonal; existing tools in the context are kept unless the request says otherwise. Output only YAML.',
  analyze: 'Analyse the results: identify patterns, regressions, bottlenecks and likely causes. Be specific and concise.',
  'explain-response':
    'Explain this HTTP response for the request: what the status and body mean, the most likely cause if it is an error, and how to fix the request. Be concise. Use short headings: What happened, Why, How to fix.',
  'generate-request':
    'Turn the description into one HTTP request. Output only a JSON object: {"name": short name, "method": HTTP method, "url": full URL, "headers": [{"key": ..., "value": ...}], "body": JSON value or string or null}. Use {{variable}} references for values available in context.variables (for example {{baseUrl}} for the host when the description does not name one). Never invent secrets: use {{variables}} for tokens and keys.',
  'generate-pm-tests':
    'Write a TestPion post-response script for this response using tp.test and tp.expect (the Postman-compatible TestPion script API: always write tp.*; chai style, e.g. tp.response.to.have.status(200), tp.expect(json.id).to.be.a("number")). Check the status, important fields and their types, and response time. Output only JavaScript, no explanations.',
  'explain-api-changes':
    'These are the changes between two versions of an OpenAPI document. Explain which clients break and how, in order of impact, and what each client team must change. Suggest how the API could stay backwards compatible (e.g. keep the old field, make the new parameter optional, version the endpoint). Be concise; use short headings.',
  'fix-security':
    'These are security findings in an API collection (no secret values are included). For each kind of finding, explain the risk in one sentence and the exact fix in TestPion (secret variables, headers instead of query parameters, https, TLS settings). Be concise.',
  'explain-fuzz':
    'These are findings from fuzzing an API from its OpenAPI document: each is an operation, the invalid (or valid) request sent, the status and the start of the response. server-error means the API failed (5xx) on that input; accepted-invalid means it accepted input its document forbids; undocumented-status means it answered with a status the document does not list; not-authorized means the token was missing or wrong. Group them by cause. For each group say what is probably wrong in the API (missing validation, an unhandled null, a parse error that escapes as 500) and the fix: the validation to add on the server, or the change to the OpenAPI document when the document is what is wrong. Be concise; use short headings: What fails, Likely cause, Fix.',
  'fix-openapi-lint':
    'These are lint problems of an OpenAPI document (rule, line, where, message) and the document itself. Group them by rule; for each group say in one sentence why it matters for clients or tools, then give the exact change as a small YAML snippet for the first places (with the line). Errors first, then warnings; mention notes only briefly. Never invent endpoints or fields the document does not have. Be concise.',
  'analyze-load':
    'Analyse these load test results: throughput, latency percentiles, errors and per-request numbers. Point out the bottleneck requests, whether errors grow with load, and what to investigate or tune next. Be specific and concise.',
  'explain-test-failure':
    'A test failed: here are its failed and passed checks with expected and actual values, and its input and output. Say in plain words why it failed, whether the API or the test looks wrong (e.g. a changed field, a stale expected value, a timing issue), and the exact change to make (the check to edit, or what to fix in the API). Be concise; use short headings: Why it failed, What to change.',
  'suggest-coverage-tests':
    'These operations of an OpenAPI document were never called by the tests, or have documented responses the tests never saw (untestedStatuses). Write TestPion YAML tests (type: http, a `tests:` list) for the most important gaps first, including error cases (e.g. 401 without a token, 404 for an unknown id, 400/422 for an invalid body). Use {{baseUrl}} and {{variables}} for hosts, ids and tokens; never invent secrets. Output only YAML.',
  'explain-exchange':
    "This is one HTTP exchange the HTTP Debugger captured from another program (a browser, an app, a script): the request as sent (method, URL, headers, body), the response (status, headers, body), timings, and the program that sent it. Secrets are redacted. Explain in plain words what the request does and what the response means; if it failed (4xx, 5xx, an error), say the most likely cause and what to check first; point out anything odd (a missing or wrong header, caching, redirects, a slow wait, a large body, credentials sent in the clear over http). End with how to turn this into a TestPion request or test. Be concise; use short headings: What it does, What the response says, What to check.",
  'explain-timing':
    'These are the timing phases of one HTTP request (prepare, DNS lookup, TCP connect and TLS handshake on a new connection, waiting for the first byte, download), whether the connection was reused, and the TLS certificate. Say where the time went, which phase is unusually slow (rough guides: DNS over 100 ms, TCP over 100 ms, TLS over 200 ms, a server wait far above the rest), the likely causes (distance to the server, no keep-alive, a slow DNS resolver, server work, a large body) and what to try. Mention an expiring certificate. Be concise; use short headings: Where the time went, What to try.',
  'explain-test-history':
    'This is one test across its latest runs (newest first): status, latency, the checks that failed and the environment, with a summary (runs, passed, failed, flips: how often the result changed). Say whether it looks flaky, broken since a point in time, or slowing down, the most likely cause (timing-dependent checks, shared state or data between tests, an unstable dependency, an environment difference) and what to change. Be concise; use short headings: What the history shows, Likely cause, What to change.',
  'explain-monitor':
    'A scheduled monitor of an API is failing or slow. Here are its settings (schedule, response time and certificate limits), its latest results (status, failed requests, p95, reasons) and each request over the latest runs (median and p95 time, failures, latest failure). Say what is wrong in plain words, since when, which request is the cause, whether it looks like an outage, a slowdown, an expiring certificate, a changed API or a flaky check, and what to do (fix the API, adjust the check or the limit, renew the certificate). Be concise; use short headings: What is wrong, Likely cause, What to do.',
  'triage-attention':
    'These are the things that need attention in an API testing workspace (failing monitors, expiring TLS certificates, a failed latest run, saved requests whose latest response failed, flaky tests), with their severity. Say what to fix first and why (what users or CI it affects), group items that probably share a cause (e.g. one API outage behind several failures), and give one concrete next step for each group. Be concise; use a short ordered list.',
  'write-commit-message':
    'These are the changes of an API testing workspace about to be committed to git, said by what they mean (requests added, changed or removed and which parts, environments and their variables). Write a git commit message: a subject line under 72 characters in the imperative mood, then a blank line and a short list of the main changes when there is more than one. No secrets, no quotes around it. Output only the message.',
  free: 'Answer the developer question about their API/protocol/AI testing work.',
};

/** The instruction for a task, or the free-question one. */
export const assistantInstruction = (task: string): string => ASSISTANT_TASKS[task] ?? ASSISTANT_TASKS.free!;
