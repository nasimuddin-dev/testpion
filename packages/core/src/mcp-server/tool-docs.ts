import type { ToolDoc } from './tool.js';

/** When to use each fixed MCP tool, when not, and one example call: the second half of its description (tool-contract.ts composes them). */
export const TOOL_DOCS: Record<string, ToolDoc> = {
  // ── Browsing the workspace ──────────────────────────────────────────────
  list_collections: {
    when: 'Use it first, to learn which collections exist and their exact names before calling a tool that takes `collection`.',
    whenNot: 'To find one request or variable by name across the workspace, use `search_workspace` instead.',
    example: {},
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  list_requests: {
    when: 'Use it to see the requests, gRPC calls and connections of one collection, with ids and folders, before reading or sending one.',
    whenNot: 'To see one request in full, use `get_request`; to search every collection at once, use `search_workspace`.',
    example: { collection: 'Veterinary API' },
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  collection_health: {
    when: 'Use it to find the broken, slow or untested requests of a collection from the responses already sent in the app.',
    whenNot: 'To send requests now, use `run_collection`; for one request over time, use `response_time_stats` or `request_history`.',
    example: { collection: 'Veterinary API' },
  },
  collection_timing: {
    when: 'Use it when a collection is slow, to tell a slow server (TTFB) from slow DNS, connect or TLS.',
    whenNot: 'For the slowest single requests, use `collection_health`; for a load test, use `load_test`.',
    example: { collection: 'Veterinary API' },
  },
  get_request: {
    when: 'Use it to read one saved request (headers, body, auth, scripts, examples) before changing, sending or testing it.',
    whenNot: 'To list what a collection holds, use `list_requests`; to send it, use `send_request`.',
    example: { collection: 'Veterinary API', request: 'Get patient' },
    narrow: 'Ask for one request at a time and leave `response_format` at `concise`.',
  },
  list_environments: {
    when: 'Use it to learn the environment names and which variables each defines before sending or running with `environment`.',
    whenNot: 'To compare two environments, use `compare_environments`; for every variable across all of them, use `environment_matrix`.',
    example: {},
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  collection_docs: {
    when: 'Use it to read a whole collection as Markdown documentation, e.g. to explain an API or write tests for it.',
    whenNot: 'For one request, use `get_request`; for an OpenAPI document of the collection, use `collection_openapi`.',
    example: { collection: 'Veterinary API' },
    narrow: 'Leave `response_format` at `concise`, or read one request with `get_request`.',
  },

  // ── Sending ─────────────────────────────────────────────────────────────
  send_request: {
    when: 'Use it to send a saved request (its scripts and checks run) or an ad-hoc method + url, and see the response.',
    whenNot: 'To run a whole collection or folder, use `run_collection`; for gRPC, use `grpc_call`; for WebSocket or MQTT, use `realtime_exchange`.',
    example: { collection: 'Veterinary API', request: 'List patients', environment: 'Development' },
    narrow: 'Send one request at a time; large bodies are cut, so ask the API for fewer items (a query param such as `?limit=5` in `url`).',
  },
  grpc_call: {
    when: 'Use it to call a gRPC method, or without `method` to list the methods a server offers with example messages.',
    whenNot: 'For HTTP or GraphQL, use `send_request`; for a saved gRPC call in a run, use `run_collection`.',
    example: { target: '127.0.0.1:50051', protos: ['protos/vet/v1/pets.proto'], method: 'vet.v1.PetService/GetPet', message: { id: 'pet-1' }, environment: 'Development' },
    narrow: 'Give `method` to call one method instead of listing all of them.',
  },
  realtime_exchange: {
    when: 'Use it to connect to a WebSocket, Socket.IO, MQTT or Kafka server, send or publish messages and read what comes back.',
    whenNot: 'For GraphQL subscriptions, use `graphql_subscribe`; for plain HTTP or Server-Sent Events, use `send_request`.',
    example: { url: '{{wsUrl}}', mode: 'websocket', send: ['{"type":"ping"}'], waitMs: 2000, environment: 'Development' },
    narrow: 'Lower `waitMs`, or subscribe to fewer topics in `subscribe`.',
  },
  decode_jwt: {
    when: 'Use it to read the claims, scopes, audience and expiry of an access or id token.',
    whenNot: 'It does not verify signatures; to check a token works, send a request with it via `send_request`.',
    example: { token: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ2ZXQtMSJ9.c2ln' },
  },
  export_traces: {
    when: 'Use it to send the recent request, run, MCP and LLM traces to an OpenTelemetry collector the user named.',
    whenNot: 'To read history inside TestPion, use `recent_failures`, `request_history` or `workspace_activity`.',
    example: { endpoint: 'http://localhost:4318/v1/traces', limit: 100 },
  },
  compare_responses: {
    when: 'Use it to see what changed between two earlier responses of a request: status, timing, headers and a JSON body diff.',
    whenNot: 'To compare one request across two environments live, use `compare_request_across_environments`; for two runs, use `compare_runs`.',
    example: { before: 'h-20261012-001', after: 'h-20261013-004' },
    narrow: 'Compare two responses at a time; pick the ids with `request_history`.',
  },
  parse_request_snippet: {
    when: 'Use it to turn a pasted cURL, fetch or PowerShell command into a structured request without sending or saving it.',
    whenNot: 'To save the snippet as a request, use `save_request` with `snippet`; to send it, use `send_request` with `snippet`.',
    example: { snippet: "curl -H 'Accept: application/json' http://127.0.0.1:4010/patients" },
  },
  save_test: {
    when: 'Use it to turn a saved request, folder, collection or history entry into a YAML test file under tests/ for CI.',
    whenNot: 'To write a test file with your own content, use `write_test_file`; to add checks to the request itself, use `set_request_checks`.',
    example: { collection: 'Veterinary API', request: 'List patients', name: 'list-patients' },
  },
  save_request: {
    when: 'Use it to add a new request to a collection from a snippet or method + url; secrets become {{variables}}.',
    whenNot: 'To change an existing request, use `update_request`; to only parse a snippet, use `parse_request_snippet`.',
    example: { collection: 'Veterinary API', folder: 'Patients', name: 'Delete patient', method: 'DELETE', url: '{{baseUrl}}/patients/{{patientId}}' },
  },
  graphql_operation: {
    when: 'Use it to build a valid GraphQL query for a root field by introspection instead of guessing field names.',
    whenNot: 'To send the operation, use `send_request`; for a subscription, use `graphql_subscribe`.',
    example: { endpoint: '{{graphqlEndpoint}}', field: 'patient', depth: 2, environment: 'Development' },
  },
  graphql_subscribe: {
    when: 'Use it to run a GraphQL subscription over WebSocket and collect the events it sends for a short time.',
    whenNot: 'For queries and mutations, use `send_request`; for plain WebSocket messages, use `realtime_exchange`.',
    example: { endpoint: '{{graphqlEndpoint}}', query: 'subscription { patientAdded { id name } }', environment: 'Development', maxEvents: 5 },
    narrow: 'Lower `maxEvents` or `durationSec`.',
  },
  security_review: {
    when: 'Use it to find typed-in secrets, secrets in query strings, plain http and turned-off TLS checks in a collection.',
    whenNot: 'To check a commit for secrets, use `git_propose_commit`; for TLS certificates, use `list_certificates` or `check_certificate`.',
    example: { collection: 'Veterinary API', environment: 'Development' },
  },
  collection_openapi: {
    when: 'Use it to get an OpenAPI 3.1 document of a collection, e.g. to document it or to diff it with a spec.',
    whenNot: 'To read an existing OpenAPI document, use `openapi_outline`; for Markdown docs, use `collection_docs`.',
    example: { collection: 'Veterinary API' },
  },

  // ── Variables and environments ─────────────────────────────────────────
  variable_usages: {
    when: 'Use it before changing or deleting a variable, to see every request, script, environment and test that uses or defines it.',
    whenNot: 'To rename it everywhere, use `rename_variable`; for variables nothing uses, use `unused_variables`.',
    example: { name: 'baseUrl' },
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  rename_variable: {
    when: 'Use it to rename a variable everywhere in the workspace in one step, secrets included.',
    whenNot: 'To find where it is used first, use `variable_usages`; to change a value, use `set_environment_variable`.',
    example: { from: 'baseUrl', to: 'apiBaseUrl', confirm: true },
  },
  set_environment_variable: {
    when: 'Use it to set plain variables such as a base URL in an environment, optionally creating it or copying to others.',
    whenNot: 'Secrets are refused: ask the user to set them in the app; for collection-wide values, use `set_collection_variable`.',
    example: { environment: 'Development', values: { baseUrl: 'http://127.0.0.1:4010' } },
  },
  reorder_environments: {
    when: 'Use it when the user wants the environment picker in a given order.',
    whenNot: 'To change variables, use `set_environment_variable`; to list environments, use `list_environments`.',
    example: { order: ['Development', 'Production'] },
  },
  compare_environments: {
    when: 'Use it when a request works in one environment and fails in another, to see which variables differ or are missing.',
    whenNot: 'For every variable across all environments, use `environment_matrix`; to compare live responses, use `compare_request_across_environments`.',
    example: { left: 'Development', right: 'Production' },
    narrow: 'Leave `includeSame` off so only differences come back.',
  },
  environment_matrix: {
    when: 'Use it to find a variable that one environment lacks, across every environment at once.',
    whenNot: 'For two environments in detail, use `compare_environments`; for where a variable is used, use `variable_usages`.',
    example: { onlyIncomplete: true },
    narrow: 'Set `onlyIncomplete: true`.',
  },
  compare_request_across_environments: {
    when: 'Use it to send one saved request in two environments and diff the responses, e.g. dev against staging.',
    whenNot: 'For variables only, without sending, use `compare_environments`; for a flow, use `flow_env_matrix`.',
    example: { collection: 'Veterinary API', request: 'List patients', left: 'Development', right: 'Production' },
  },
  unused_variables: {
    when: 'Use it to clean up, finding environment and workspace variables that nothing reads.',
    whenNot: 'To double-check one name before deleting it, use `variable_usages`; for unused collection variables, use `collection_tidy`.',
    example: {},
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  variable_flow: {
    when: 'Use it to debug request chaining: which requests set a variable, which use it, and what is used before it is set.',
    whenNot: 'For every place a name appears, use `variable_usages`; for a flow file, use `flow_graph`.',
    example: { collection: 'Veterinary API' },
  },

  // ── API definitions ────────────────────────────────────────────────────
  openapi_diff: {
    when: 'Use it to list breaking and non-breaking changes between two versions of an OpenAPI or Swagger document.',
    whenNot: 'To see what changed in workspace files, use `git_diff`; to read one document, use `openapi_outline`.',
    example: { old: 'specs/veterinary-api.v1.yaml', new: 'specs/veterinary-api.yaml' },
    narrow: 'Leave `response_format` at `concise` to get the breaking changes first.',
  },
  api_coverage: {
    when: 'Use it to find which operations and response codes of a spec the test runs never exercised, before writing more tests.',
    whenNot: 'To write tests for a spec, use `generate_tests`; to compare two specs, use `openapi_diff`.',
    example: { spec: 'specs/veterinary-api.yaml', history: 200 },
    narrow: 'Give fewer `runs`, a `baseUrl`, or `excludeDeprecated: true`.',
  },
  import_definition: {
    when: 'Use it to bring an OpenAPI, Postman, Insomnia, HAR or other definition into the workspace from a link or text.',
    whenNot: 'For an Arazzo workflow document, use `import_arazzo`; for one request snippet, use `save_request`.',
    example: { url: 'https://petstore3.swagger.io/api/v3/openapi.json', name: 'Petstore' },
  },
  openapi_outline: {
    when: 'Use it to read an OpenAPI document as a person reads its docs: operations, parameters, bodies and responses.',
    whenNot: 'To lint it, use `openapi_lint`; to import it as requests, use `import_definition`.',
    example: { spec: 'specs/veterinary-api.yaml', tag: 'patients' },
    narrow: 'Give `tag` or `operation_id` to read part of it.',
  },
  openapi_lint: {
    when: 'Use it to find errors and usability problems in an OpenAPI or Swagger document before generating tests from it.',
    whenNot: 'To compare two versions, use `openapi_diff`; to read it, use `openapi_outline`.',
    example: { spec: 'specs/veterinary-api.yaml', severity: 'error' },
    narrow: 'Raise `severity` to `error`, or `disable` noisy rules.',
  },
  ci_config: {
    when: 'Use it to get a CI pipeline file (GitHub, GitLab, Azure, Jenkins) that runs this workspace’s tests on every push.',
    whenNot: 'To run the tests now, use `run_tests`; to write the AGENTS.md guide, use `agents_init`.',
    example: { provider: 'github', suite: 'smoke', environment: 'Development' },
  },

  // ── Certificates and usage ─────────────────────────────────────────────
  list_certificates: {
    when: 'Use it to find TLS certificates of hosts already called that expire soon.',
    whenNot: 'To read a host’s certificate now, use `check_certificate`.',
    example: { withinDays: 30 },
    narrow: 'Lower `withinDays`, lower `limit`, or page with `cursor`.',
  },
  check_certificate: {
    when: 'Use it to read a host’s TLS certificate now: expiry, issuer and whether this machine trusts it.',
    whenNot: 'For every certificate already seen, use `list_certificates`.',
    example: { target: 'api.example.com:443' },
  },
  llm_usage: {
    when: 'Use it to see tokens, estimated cost and latency of the prompts run in the AI Lab, per provider and model.',
    whenNot: 'For MCP tool calls, use `mcp_tool_usage`; for evaluation scores, use `score_trend`.',
    example: {},
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  ai_list_tasks: {
    when: "Use it to see which of TestPion's AI tasks exist before calling `ai_run_task`: what each does, its context and whether it proposes changes.",
    whenNot: 'You are a model yourself: for most jobs read the workspace with the deterministic tools (get_request, run_breakdown, api_coverage) and reason on your own.',
    example: {},
  },
  ai_run_task: {
    when: "Use it when the user wants TestPion's own configured model (their key or a local model) to explain or generate: verified checks for a response, a flow, tp tests, a request.",
    whenNot: 'To write a test file yourself, use `write_test_file`; to apply a proposal, use `ai_apply_proposal`. Use `dryRun: true` first when the user asks what would be sent.',
    example: { task: 'generate-assertions', item: 'request:veterinary-api:get-pet' },
  },
  flow_generate: {
    when: "Use it when the user wants TestPion's own model to write an integration flow from a collection or a folder (their key or a local model); it proposes, verified.",
    whenNot: 'To write CRUD flows without a model, use `generate_flows`; to design one yourself, read the requests (`list_requests`, `get_request`) and use `write_test_file`. Apply the proposal with `ai_apply_proposal`.',
    example: { collection: 'Veterinary API', folder: 'Patients', hint: 'also test pagination' },
  },
  ai_triage_run: {
    when: "Use it when the user wants TestPion's own model to explain a failed run and propose fixes (their key or a local model): causes with evidence and verified fixes, as a proposal.",
    whenNot: 'To read failures yourself, use `recent_failures`, `run_breakdown` and `test_history`; to apply the fixes, use `ai_apply_proposal` after the user agrees.',
    example: { run: 'last', privacy: 'metadata' },
  },
  ai_analyze_flaky: {
    when: "Use it when the user asks why a test is flaky (flaky_tests names them) and wants TestPion's model to explain it and propose a verified fix.",
    whenNot: 'To list flaky tests, use `flaky_tests`; to read one test across runs yourself, use `test_history`. To apply and prove the fix, use `ai_attempt_fix`.',
    example: { item: 'test-case:jobs:job-is-done' },
  },
  ai_attempt_fix: {
    when: 'Use it after the user agreed to a flaky-test fix from `ai_analyze_flaky`: it applies the fix and runs the test 5 times for a stability verdict.',
    whenNot: 'Never without the user seeing the fix. For a triage proposal use `ai_apply_proposal`, then run the tests again.',
    example: { id: 'ai-k3x9q2', times: 5 },
  },
  ai_proposals: {
    when: 'Use it to list the open AI proposals, or read one in full (items, before/after, verification) before applying it.',
    whenNot: 'To make a new proposal, use `ai_run_task`.',
    example: { id: 'ai-k3x9q2' },
  },
  ai_apply_proposal: {
    when: 'Use it after the user agreed to an AI proposal: applies its ticked items (or `items`), keeping what it replaced for undo.',
    whenNot: 'Never apply without the user seeing the items; to look first, use `ai_proposals` or `dryRun: true`.',
    example: { id: 'ai-k3x9q2', items: ['i1', 'i2'] },
  },
  ai_undo_proposal: {
    when: 'Use it when the user wants an applied AI proposal reverted.',
    whenNot: 'To drop a proposal that was not applied, there is nothing to undo: just do not apply it.',
    example: { id: 'ai-k3x9q2' },
  },
  ai_usage: {
    when: "Use it to see what TestPion's AI features used (tokens, cost, per task, model and surface) and what is left of the user's daily caps.",
    whenNot: 'For AI Lab prompts per model, use `llm_usage`.',
    example: { days: 7 },
  },
  mcp_tool_usage: {
    when: 'Use it to see which tools of the workspace’s MCP servers are called most, are slow or fail.',
    whenNot: 'To call a tool, use `mcp_call_tool`; for LLM prompts, use `llm_usage`.',
    example: { server: 'customer-mcp' },
    narrow: 'Give `server`, lower `limit`, or page with `cursor`.',
  },

  // ── Monitors ───────────────────────────────────────────────────────────
  list_monitors: {
    when: 'Use it to see the scheduled monitors, their last result and next run.',
    whenNot: 'For one monitor’s history, use `monitor_results`; to add one, use `save_monitor`.',
    example: {},
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  monitor_results: {
    when: 'Use it to see when a monitor started failing, from its recent results.',
    whenNot: 'For which request fails, use `monitor_requests`; for daily uptime, use `monitor_uptime`.',
    example: { monitor: 'Veterinary API smoke', limit: 20 },
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  monitor_requests: {
    when: 'Use it to find which request makes a monitor slow or fail over its latest runs.',
    whenNot: 'For the runs themselves, use `monitor_results`; for one request’s history, use `request_history`.',
    example: { monitor: 'Veterinary API smoke', runs: 20 },
    narrow: 'Lower `runs` or `limit`, or page with `cursor`.',
  },
  monitor_uptime: {
    when: 'Use it for an SLA view: a monitor’s uptime percent per day.',
    whenNot: 'For individual runs, use `monitor_results`.',
    example: { monitor: 'Veterinary API smoke', days: 30 },
    narrow: 'Lower `days`.',
  },
  run_monitor: {
    when: 'Use it to run a monitor now, outside its schedule, and record the result.',
    whenNot: 'To run a collection without a monitor, use `run_collection`; to change a monitor, use `save_monitor`.',
    example: { monitor: 'Veterinary API smoke' },
  },
  save_monitor: {
    when: 'Use it to schedule a collection, folder or test file to run every few minutes, hours or days.',
    whenNot: 'To run once now, use `run_monitor` or `run_tests`; to list monitors, use `list_monitors`.',
    example: { name: 'Veterinary API smoke', collection: 'Veterinary API', every: '15m', environment: 'Development' },
  },

  // ── Runs and tests ─────────────────────────────────────────────────────
  run_collection: {
    when: 'Use it to run a collection or one folder in order with scripts and checks, optionally once per data row.',
    whenNot: 'For YAML test files, use `run_tests`; for a single request, use `send_request`.',
    example: { collection: 'Veterinary API', folder: 'Patients', environment: 'Development' },
    narrow: 'Give `folder` to run part of it, lower `iterations`, or read details later with `run_breakdown`.',
  },
  lint_tests: {
    when: 'Use it to check test files for typos, unknown check types and broken dependsOn before running them.',
    whenNot: 'To run the tests, use `run_tests`; `write_test_file` already validates what it writes.',
    example: { paths: ['rest/patients.yaml'] },
    narrow: 'Give fewer `paths`.',
  },
  list_tests: {
    when: 'Use it to see the test files under tests/ and the tests in each, before running some of them.',
    whenNot: 'To run them, use `run_tests`; to find a test by text, use `search_workspace`.',
    example: { path: 'rest' },
    narrow: 'Give `path` for one folder or file, lower `limit`, or page with `cursor`.',
  },
  run_tests: {
    when: 'Use it to run test files, suites or flows under tests/ like `testpion test`, all or filtered by path, name or tag.',
    whenNot: 'For a collection, use `run_collection`; for a flow over a dataset, use `flow_data_run`.',
    example: { paths: ['rest/patients.yaml'], environment: 'Development' },
    narrow: 'Give fewer `paths`, a `grep` or `tags`; read the full run later with `run_breakdown`.',
  },
  list_evaluations: {
    when: 'Use it to see the evaluations saved in the app before running one.',
    whenNot: 'To run one, use `run_evaluation`; for AI tests in YAML, use `list_tests`.',
    example: {},
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  run_evaluation: {
    when: 'Use it to run a saved evaluation: every dataset record through the model, scored by its evaluators.',
    whenNot: 'For YAML AI tests, use `run_tests`; to compare two evaluation runs, use `eval_compare`.',
    example: { name: 'Intent classification', environment: 'Development', limit: 20 },
    narrow: 'Lower `limit` to run fewer records.',
  },
  run_breakdown: {
    when: 'Use it to see why a finished run was slow or unstable: latency ranges, slowest tests, flaky ones and top failing checks.',
    whenNot: 'To compare two runs, use `compare_runs`; for one test across runs, use `test_history`.',
    example: { run_id: 'run-abc123' },
    narrow: 'Leave `response_format` at `concise`.',
  },
  run_reviews: {
    when: 'Use it to read a person’s good / bad ratings on a run’s results and improve tests or evaluators from them.',
    whenNot: 'To rate a result yourself, use `review_result`; for the run’s numbers, use `run_breakdown`.',
    example: { run_id: 'run-abc123' },
  },
  review_result: {
    when: 'Use it to rate one result of a finished run good or bad with a note, after reading its output and checks.',
    whenNot: 'To read existing ratings, use `run_reviews`.',
    example: { run_id: 'run-abc123', result_id: 'res-7', rating: 'bad', note: 'The answer names the wrong clinic.' },
  },
  compare_runs: {
    when: 'Use it to see what regressed or got fixed between two finished runs, e.g. before and after a change.',
    whenNot: 'For one run in detail, use `run_breakdown`; for evaluation runs case by case, use `eval_compare`.',
    example: { before: 'run-abc123', after: 'run-def456' },
    narrow: 'Raise `latencyPct` to ignore small slowdowns, and leave `response_format` at `concise`.',
  },
  testpion_guide: {
    when: 'Read it before writing checks or test files: tool overview, variable resolution, every check type and the YAML format.',
    whenNot: 'To find a tool by task, use `search_tools`.',
    example: {},
  },
  set_request_checks: {
    when: 'Use it to add or replace the checks (assertions) of a saved REST or GraphQL request.',
    whenNot: 'For a standalone test file, use `save_test` or `write_test_file`.',
    example: { collection: 'Veterinary API', request: 'List patients', checks: [{ type: 'status', expected: 200 }], mode: 'append' },
  },
  write_test_file: {
    when: 'Use it to write a YAML test file or suite with your own content under tests/; it is validated before saving.',
    whenNot: 'To save a request as a test, use `save_test`; to edit a flow step by step, use `flow_add_step` and `flow_update_step`.',
    example: { path: 'rest/health.yaml', content: 'name: Health\ntests:\n  - name: health\n    type: http\n    method: GET\n    url: "{{baseUrl}}/health"\n' },
  },

  // ── Load tests and histories ───────────────────────────────────────────
  load_history: {
    when: 'Use it to see whether an API got slower or less reliable between earlier load tests.',
    whenNot: 'To run a load test, use `load_test`; for single-request latency, use `response_time_stats`.',
    example: { query: 'patients', limit: 10 },
    narrow: 'Give `query`, lower `limit`, or page with `cursor`.',
  },
  load_test: {
    when: 'Use it to load-test a local API (URL, collection or flow) with up to 50 virtual users for up to 60 seconds.',
    whenNot: 'Remote hosts are refused; for functional checks, use `run_tests`; for earlier results, use `load_history`.',
    example: { url: 'http://127.0.0.1:4010/patients', virtualUsers: 10, durationSec: 20 },
  },
  request_history: {
    when: 'Use it to list earlier responses of a saved request and pick ids for `compare_responses`.',
    whenNot: 'For a latency summary, use `response_time_stats`; for failures across the workspace, use `recent_failures`.',
    example: { collection: 'Veterinary API', request: 'List patients', limit: 20 },
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  score_trend: {
    when: 'Use it to see whether a model, prompt or pipeline gets better or worse: each evaluator’s mean score run by run.',
    whenNot: 'For one evaluation run against a baseline, use `eval_compare`.',
    example: { name: 'Intent classification', limit: 20 },
    narrow: 'Filter by `name`, lower `limit`, or page with `cursor`.',
  },
  flaky_tests: {
    when: 'Use it to find unreliable tests whose result flips across the latest runs or that pass only after a retry.',
    whenNot: 'For one test in detail, use `test_history`.',
    example: { runs: 20 },
    narrow: 'Lower `runs` or `limit`, or page with `cursor`.',
  },
  test_history: {
    when: 'Use it to follow one test or saved request across the latest runs: status, latency, attempts and failed checks.',
    whenNot: 'For every flaky test at once, use `flaky_tests`; for a request’s app responses, use `request_history`.',
    example: { name: 'list patients', limit: 20 },
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  recent_failures: {
    when: 'Use it to see what broke recently across the workspace: the latest failed responses of every kind.',
    whenNot: 'For one request, use `request_history`; for a ranked to-do list, use `what_needs_attention`.',
    example: { kind: 'http', limit: 20 },
    narrow: 'Filter with `kind`, lower `limit`, or page with `cursor`.',
  },
  history_list: {
    when: 'Use it to browse History by kind or text, and (kind `capture`) to find what was captured in the HTTP Debugger and where it went: the collection, flow or saved session, with a ref that opens it.',
    whenNot: 'For only the failures, use `recent_failures`; for one saved request, use `request_history`; for the live Debugger session, use `debugger_exchanges`.',
    example: { kind: 'capture', limit: 20 },
    narrow: 'Filter with `kind` or `query`, lower `limit`, or page with `cursor`.',
  },
  response_time_stats: {
    when: 'Use it to spot a slow or flaky endpoint from a saved request’s recent response times (p50, p95).',
    whenNot: 'For the individual responses, use `request_history`; for a whole collection, use `collection_health`.',
    example: { collection: 'Veterinary API', request: 'List patients', limit: 50 },
  },
  what_needs_attention: {
    when: 'Use it first in a session: failing monitors, expiring certificates, failed runs and requests, flaky tests, worst first.',
    whenNot: 'For the recent failed responses themselves, use `recent_failures`.',
    example: { certDays: 30 },
    narrow: 'Lower `certDays`, lower `limit`, or page with `cursor`.',
  },
  workspace_activity: {
    when: 'Use it to spot the day things started failing or slowing down, from per-day counts of requests and runs.',
    whenNot: 'For individual failures, use `recent_failures`.',
    example: { days: 14 },
    narrow: 'Lower `days`.',
  },
  search_workspace: {
    when: 'Use it to find a request, test, flow, environment, variable or other item by name or content.',
    whenNot: 'To find a tool, use `search_tools`; to look up a `ref` you already have, use `resolve_ref`.',
    example: { query: 'patients', limit: 20 },
    narrow: 'Use a more specific `query`, lower `limit`, or page with `cursor`.',
  },
  list_kinds: {
    when: 'Use it to learn what an item of a kind offers (rename, move, delete with undo, run, monitor, CI, export …) and how its ref looks, before acting on one.',
    whenNot: 'To find items, use `search_workspace`; to check one ref, use `resolve_ref`.',
    example: { kind: 'mcp-server' },
  },
  resolve_ref: {
    when: 'Use it to check that a `ref` from another tool still exists, get its name and app link, or the nearest thing if gone.',
    whenNot: 'To find items by text, use `search_workspace`.',
    example: { ref: 'run:run-abc123' },
  },
  delete_item: {
    when: 'Use it to delete a collection, environment, dataset, API definition or MCP server the user no longer wants; it goes to Recently deleted, and `restore_item` brings it back.',
    whenNot: 'For a request or folder of a collection, use `delete_request`; `list_kinds` says which kinds have the `trash` capability.',
    example: { ref: 'environment:staging-old', confirm: true },
  },
  restore_item: {
    when: 'Use it to put back an item `delete_item` deleted (its `trashId`), or one listed by `testpion trash list`.',
    whenNot: 'To undo `delete_request`, save the returned item again with `save_request`.',
    example: { trash_id: 'environment/1760700000000--staging-old.json' },
  },

  // ── MCP servers and mocks ──────────────────────────────────────────────
  mock_tools: {
    when: 'Use it to read the tools an MCP mock file defines and the commands that serve it.',
    whenNot: 'For a real or saved server, use `mcp_server_tools`.',
    example: { file: 'mocks/weather.mcp-mock.yaml' },
  },
  list_mcp_servers: {
    when: 'Use it to see the MCP servers saved in the workspace before listing or calling their tools.',
    whenNot: 'For a server’s tools, use `mcp_server_tools`.',
    example: {},
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  mcp_server_tools: {
    when: 'Use it to connect to a saved MCP server and list its tools, resources and prompts before calling one.',
    whenNot: 'To call a tool, use `mcp_call_tool`; for a mock file, use `mock_tools`.',
    example: { server: 'customer-mcp' },
  },
  mcp_call_tool: {
    when: 'Use it to test an MCP server by calling one of its tools with arguments.',
    whenNot: 'To see what tools it has, use `mcp_server_tools`; for a repeatable test, write an mcp step with `write_test_file`.',
    example: { server: 'customer-mcp', tool: 'search_customer', arguments: { query: 'Bella' } },
  },
  list_flows: {
    when: 'Use it to see which flows this server offers as tools of their own, with their tool names and inputs.',
    whenNot: 'For every test file, use `list_tests`; to read a flow’s steps, use `flow_graph`.',
    example: {},
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  search_tools: {
    when: 'Use it before guessing a tool name: describe the task and get the matching tools with their required arguments.',
    whenNot: 'To find workspace items such as requests or tests, use `search_workspace`.',
    example: { query: 'compare two runs' },
  },

  // ── Datasets ───────────────────────────────────────────────────────────
  list_datasets: {
    when: 'Use it to see the data files in datasets/ before a data-driven run.',
    whenNot: 'To read rows, use `read_dataset`; to make data, use `generate_dataset`.',
    example: {},
    narrow: 'Lower `limit`, or page with `cursor`.',
  },
  read_dataset: {
    when: 'Use it to see a dataset’s columns and first rows, i.e. the {{variables}} a run can use.',
    whenNot: 'To list datasets, use `list_datasets`; to add a row, use `add_dataset_row`.',
    example: { name: 'intents.jsonl', limit: 10 },
    narrow: 'Lower `limit`, or give a narrower SQLite `query`.',
  },
  add_dataset_row: {
    when: 'Use it to add one record, such as an evaluation case, to a JSONL dataset.',
    whenNot: 'For many generated rows, use `generate_dataset`.',
    example: { dataset: 'intents.jsonl', row: { message: 'Cancel my booking', expected: 'cancellation' } },
  },
  generate_dataset: {
    when: 'Use it to generate test data rows from a JSON schema or an operation’s request body for data-driven runs.',
    whenNot: 'For one hand-written row, use `add_dataset_row`.',
    example: { name: 'patients', rows: 20, spec: 'specs/veterinary-api.yaml', operation: 'POST /patients', format: 'csv' },
  },

  // ── Arazzo ─────────────────────────────────────────────────────────────
  import_arazzo: {
    when: 'Use it to turn an Arazzo 1.0 workflow document into TestPion flow files under tests/arazzo/.',
    whenNot: 'For OpenAPI or Postman, use `import_definition`.',
    example: { file: 'specs/adopt-pet.arazzo.yaml', dry_run: true },
  },
  export_arazzo: {
    when: 'Use it to share a flow file as an Arazzo 1.0 document with other tools.',
    whenNot: 'To see the flow’s steps, use `flow_graph`.',
    example: { file: 'rest/patient-lifecycle.yaml', spec: 'specs/veterinary-api.yaml' },
  },

  // ── Git ────────────────────────────────────────────────────────────────
  git_conflicts: {
    when: 'Use it after a pull stopped on conflicts, to see each conflict side by side.',
    whenNot: 'To settle them, use `git_resolve`; for the general state, use `git_status`.',
    example: { path: 'collections/veterinary-api.json' },
    narrow: 'Give `path` for one file.',
  },
  git_resolve: {
    when: 'Use it to settle a conflicted file by taking ours or theirs, for all its conflicts or per conflict.',
    whenNot: 'To see the conflicts first, use `git_conflicts`.',
    example: { path: 'collections/veterinary-api.json', side: 'theirs', confirm: true },
  },
  git_status: {
    when: 'Use it to see the branch, ahead / behind counts and changed files of the workspace.',
    whenNot: 'For what changed inside the files, use `git_diff`.',
    example: {},
  },
  git_sync: {
    when: 'Use it to pull and push in one step when the user asks to sync the workspace.',
    whenNot: 'To prepare a commit, use `git_propose_commit`; for conflicts, use `git_conflicts`.',
    example: { confirm: true },
  },
  git_diff: {
    when: 'Use it to see what changed by meaning: requests, variables and flow steps added, changed or removed.',
    whenNot: 'For the list of changed files, use `git_status`; for API spec changes, use `openapi_diff`.',
    example: { file: 'collections/veterinary-api.json' },
    narrow: 'Give `file` or `item_id`, lower `limit`, or page with `cursor`.',
  },
  git_log: {
    when: 'Use it to see recent commits, or those that changed one file or collection.',
    whenNot: 'For what changed in them, use `git_diff` with `from` and `to`.',
    example: { collection: 'Veterinary API', limit: 20 },
    narrow: 'Give `file` or `collection`, lower `limit`, or page with `cursor`.',
  },
  git_propose_commit: {
    when: 'Use it to stage the changes, check them for secrets and propose a commit message for a person to commit.',
    whenNot: 'It never commits; to write the message, read `git_diff` first.',
    example: { message: 'Add checks to the Patients requests' },
  },

  // ── Generating ─────────────────────────────────────────────────────────
  generate_tests: {
    when: 'Use it to write a first test suite from an OpenAPI document: success, contract and negative tests per operation.',
    whenNot: 'For CRUD flows across operations, use `generate_flows`; to find gaps first, use `api_coverage`.',
    example: { spec: 'specs/veterinary-api.yaml', negative: true },
  },
  generate_flows: {
    when: 'Use it to write integration flows (create, read, update, list, delete) per resource from a spec or collection.',
    whenNot: 'For per-operation tests, use `generate_tests`; to record a flow from traffic, use `flow_from_exchanges`.',
    example: { spec: 'specs/veterinary-api.yaml' },
  },
  api_fuzz: {
    when: 'Use it to find 5xx bugs and validation gaps by sending requests that break the OpenAPI schema one rule at a time.',
    whenNot: 'For valid tests per operation, use `generate_tests`.',
    example: { spec: 'specs/veterinary-api.yaml', environment: 'Development', operations: ['createPatient'], maxPerOperation: 10 },
    narrow: 'Give fewer `operations`, or lower `maxPerOperation`.',
  },

  // ── HTTP Debugger ──────────────────────────────────────────────────────
  debugger_capture: {
    when: 'Use it to start the HTTP Debugger proxy, then run a program through it to capture its traffic.',
    whenNot: 'To read what was captured, use `debugger_exchanges`.',
    example: { action: 'start' },
  },
  debugger_exchanges: {
    when: 'Use it to list what the HTTP Debugger captured, filtered by host, method, status class or text.',
    whenNot: 'For one exchange with bodies, use `debugger_exchange`; for totals, use `debugger_stats`.',
    example: { host: '127.0.0.1:4010', status: 'server-error', limit: 20 },
    narrow: 'Filter with `host`, `method`, `status` or `text`, lower `limit`, or page with `cursor`.',
  },
  debugger_exchange: {
    when: 'Use it to read one captured exchange in full: headers, bodies and timings.',
    whenNot: 'To list exchanges, use `debugger_exchanges`.',
    example: { id: 'ex-42' },
    narrow: 'Read one exchange at a time; find it first with `debugger_exchanges` and its `text` filter.',
  },
  debugger_session: {
    when: 'Use it to save the captured session as a HAR file, or open a HAR file into the session.',
    whenNot: 'To turn the traffic into a test flow, use `flow_from_exchanges`.',
    example: { action: 'save', path: 'session.har' },
  },
  debugger_rules: {
    when: 'Use it to list, add or toggle rules that ignore, highlight, modify, reply to or redirect matching traffic.',
    whenNot: 'To filter only what you read, use `debugger_exchanges` filters.',
    example: { action: 'add', preset: 'slow', host: '127.0.0.1:4010' },
  },
  debugger_stats: {
    when: 'Use it to see the captured session in numbers: by host, content type and program, the largest and slowest.',
    whenNot: 'For the exchanges themselves, use `debugger_exchanges`.',
    example: {},
  },

  item_info: {
    when: 'Use it to see what one item touches: its file, the variables it uses, and the runs that included it.',
    whenNot: 'To check that a ref still exists, use `resolve_ref`; to find items, use `search_workspace`.',
    example: { ref: 'test:smoke/health.yaml' },
  },
  debugger_save_to_collection: {
    when: 'Use it to keep captured traffic (or a HAR file) as saved requests in a collection, to send again by hand.',
    whenNot: 'For a test flow with values chained between steps, use `flow_from_exchanges`.',
    example: { since: '2026-10-14T09:00:00Z', name: 'Checkout API', group: 'host' },
  },

  // ── Flows ──────────────────────────────────────────────────────────────
  flow_from_exchanges: {
    when: 'Use it to make a test flow from captured traffic or a HAR file, with values chained between steps.',
    whenNot: 'To write a flow from a spec, use `generate_flows`; to capture traffic first, use `debugger_capture`.',
    example: { har: 'debugger/session.har', name: 'booking', environment: 'Development', dry_run: true },
  },
  flow_graph: {
    when: 'Use it to read a flow file as a diagram: steps, edges, layers and problems such as cycles, before editing it.',
    whenNot: 'For its runs, use `flow_runs`; to see how a run spent its time, use `flow_timeline`.',
    example: { file: 'rest/patient-lifecycle.yaml' },
    narrow: 'Leave `response_format` at `concise`.',
  },
  flow_runs: {
    when: 'Use it to see a flow’s run history, or with `run_id` the steps of one run and the variables after each.',
    whenNot: 'For the timing of a run, use `flow_timeline`; for the flow’s structure, use `flow_graph`.',
    example: { file: 'rest/patient-lifecycle.yaml', limit: 10 },
    narrow: 'Lower `limit`, give `run_id` for one run, or page with `cursor`.',
  },
  flow_add_step: {
    when: 'Use it to add one or more steps to a flow, or saved requests from a collection as steps.',
    whenNot: 'To change a step, use `flow_update_step`; to link steps, use `flow_connect`.',
    example: { file: 'rest/patient-lifecycle.yaml', step: { name: 'health', type: 'http', method: 'GET', url: '{{baseUrl}}/health' } },
  },
  flow_connect: {
    when: 'Use it to make one step wait for another, so the values it extracts reach the next step.',
    whenNot: 'To remove a link, use `flow_disconnect`.',
    example: { file: 'rest/patient-lifecycle.yaml', from: 'create-patient', to: 'get-patient' },
  },
  flow_disconnect: {
    when: 'Use it to stop one step waiting for another.',
    whenNot: 'To add a link, use `flow_connect`; to remove a step, use `flow_remove_step`.',
    example: { file: 'rest/patient-lifecycle.yaml', from: 'create-patient', to: 'get-patient' },
  },
  flow_update_step: {
    when: 'Use it to change keys of one flow step such as url, body, extract or assertions, or to rename it.',
    whenNot: 'To add a step, use `flow_add_step`; to rewrite the whole file, use `write_test_file`.',
    example: { file: 'rest/patient-lifecycle.yaml', id: 'get-patient', set: { url: '{{baseUrl}}/patients/{{patientId}}' } },
  },
  flow_remove_step: {
    when: 'Use it to remove steps from a flow; steps that waited for them no longer do.',
    whenNot: 'To unlink without removing, use `flow_disconnect`.',
    example: { file: 'rest/patient-lifecycle.yaml', id: 'delete-patient', confirm: true },
  },
  flow_set_output: {
    when: 'Use it to set what a flow returns, for use as a sub-flow or as an MCP tool.',
    whenNot: 'To change a step’s extracts, use `flow_update_step`.',
    example: { file: 'rest/patient-lifecycle.yaml', output: { patientId: '{{patientId}}' } },
  },
  flow_annotate: {
    when: 'Use it to add or change sticky notes and frames on a flow’s canvas that explain it to people.',
    whenNot: 'To change what the flow does, use `flow_update_step`.',
    example: { file: 'rest/patient-lifecycle.yaml', action: 'add_note', text: 'Creates a patient, then cleans up.', x: 40, y: 40, color: 'yellow' },
  },
  flow_data_run: {
    when: 'Use it to run a flow once per row of a dataset or database query.',
    whenNot: 'To run a flow once, use `run_tests`; to read a finished data run, use `flow_scale_result`.',
    example: { file: 'rest/patient-lifecycle.yaml', data: 'datasets/patients.csv', environment: 'Development', limit: 50 },
    narrow: 'Lower `limit`; read rows later with `flow_scale_result`.',
  },
  flow_env_matrix: {
    when: 'Use it to run a flow in several environments and compare status, timing and extracted values per step.',
    whenNot: 'For one saved request, use `compare_request_across_environments`.',
    example: { file: 'rest/patient-lifecycle.yaml', environments: ['Development', 'Production'] },
  },
  flow_scale_result: {
    when: 'Use it to read back a data run or environment matrix by id, a page of rows or one row at a time.',
    whenNot: 'To start one, use `flow_data_run` or `flow_env_matrix`.',
    example: { id: 'data-abc123', status: 'failed', limit: 50 },
    narrow: 'Filter with `status`, lower `limit`, page with `offset`, or read one `row`.',
  },
  flow_timeline: {
    when: 'Use it to see where a flow run spent its time: lanes, waits and the critical path.',
    whenNot: 'For step results and variables, use `flow_runs`.',
    example: { file: 'rest/patient-lifecycle.yaml', run_id: 'run-abc123' },
  },
  flow_webhook_set: {
    when: 'Use it to serve a flow behind a webhook path so a POST runs it.',
    whenNot: 'To schedule it, use `save_monitor`; to see where it is deployed, use `flow_deploy_status`.',
    example: { file: 'rest/patient-lifecycle.yaml', path: '/hooks/patient-lifecycle', secret: '{{WEBHOOK_SECRET}}' },
  },
  flow_deploy_status: {
    when: 'Use it to see where a flow is deployed: schedule, webhook, MCP tool and CI.',
    whenNot: 'To deploy it, use `save_monitor`, `flow_webhook_set` or `ci_config`.',
    example: { file: 'rest/patient-lifecycle.yaml' },
  },

  // ── Evaluations ────────────────────────────────────────────────────────
  eval_matrix: {
    when: 'Use it to view evaluation runs side by side, case by variant, optionally against a baseline.',
    whenNot: 'For a regression verdict against a baseline, use `eval_compare`.',
    example: { runs: ['run-abc123', 'run-def456'], baseline: 'run-abc123', filter: 'regressed', limit: 50 },
    narrow: 'Filter with `filter`, `tag` or `search`, lower `limit`, or page with `offset`.',
  },
  eval_compare: {
    when: 'Use it to decide whether an evaluation run regressed against a baseline, case by case.',
    whenNot: 'For a matrix of several runs, use `eval_matrix`; for test runs, use `compare_runs`.',
    example: { run: 'run-def456', baseline: 'run-abc123', threshold: 0.05 },
    narrow: 'Lower `limit` or `maxRegressions`.',
  },
  rag_list_targets: {
    when: 'Use it to see which RAG systems the workspace can test (HTTP, SSE, WebSocket, gRPC or MCP endpoints with their mapping) and whether any is broken.',
    whenNot: 'To run a dataset through one, use `run_evaluation` on a saved evaluation of type rag.',
    example: {},
  },
  rag_probe: {
    when: 'Use it to ask a RAG target one question and see the answer and the retrieved contexts its mapping reads, before running an evaluation.',
    whenNot: 'For a whole dataset, use `run_evaluation`; to see the saved targets, use `rag_list_targets`.',
    example: { target: 'Clinic bot', question: 'What time does the clinic open?' },
  },
  rag_import_dataset: {
    when: 'Use it to read a Ragas or DeepEval dataset file as TestPion RAG records (question, reference, reference_contexts, reference_ids), or to save it under datasets/.',
    whenNot: 'To add one record to a dataset, use `add_dataset_row`; to convert the other way, use `rag_export_dataset`.',
    example: { path: 'datasets/ragas-export.jsonl', save_as: 'clinic-rag' },
    narrow: 'Lower `limit`.',
  },
  rag_export_dataset: {
    when: 'Use it to write a TestPion RAG dataset as Ragas or DeepEval records, to score the same questions with those tools.',
    whenNot: 'To read their files into TestPion, use `rag_import_dataset`.',
    example: { path: 'datasets/clinic-rag.jsonl', to: 'ragas' },
    narrow: 'Lower `limit`.',
  },
  agents_init: {
    when: 'Use it to write or refresh AGENTS.md (and optionally CLAUDE.md or Cursor rules) describing this workspace.',
    whenNot: 'To read how to use TestPion, use `testpion_guide`.',
    example: { targets: ['claude'], dryRun: true },
  },

  // ── Editing collections ────────────────────────────────────────────────
  replace_in_collection: {
    when: 'Use it to find and replace text across a collection’s URLs, headers, bodies and scripts; preview first.',
    whenNot: 'For one request, use `update_request`; to rename a variable everywhere, use `rename_variable`.',
    example: { collection: 'Veterinary API', find: 'http://127.0.0.1:4010', replace: '{{baseUrl}}', apply: true, confirm: true },
    narrow: 'Give `folder` or `fields`.',
  },
  move_variables_to_environments: {
    when: 'Use it when collection variables such as a base URL should differ per environment.',
    whenNot: 'To set environment values, use `set_environment_variable`.',
    example: { collection: 'Veterinary API', keys: ['baseUrl'], environments: ['Development', 'Production'], dryRun: true },
  },
  collection_tidy: {
    when: 'Use it to find and remove duplicate requests, empty folders and unused collection variables.',
    whenNot: 'For typed-in hosts, use `replace_in_collection`; for a security check, use `security_review`.',
    example: { collection: 'Veterinary API', removeDuplicates: true, confirm: true },
  },
  update_request: {
    when: 'Use it to change fields of a saved REST request: name, method, url, headers, body, scripts.',
    whenNot: 'To add a new request, use `save_request`; for checks, use `set_request_checks`.',
    example: { collection: 'Veterinary API', request: 'Get patient', url: '{{baseUrl}}/patients/{{patientId}}' },
  },
  move_request: {
    when: 'Use it to move a request or folder to another folder or collection.',
    whenNot: 'To rename it, use `update_request`.',
    example: { collection: 'Veterinary API', request: 'Health', folder: 'Diagnostics / Probes' },
  },
  delete_request: {
    when: 'Use it to delete a request or folder the user no longer wants; the deleted item is returned.',
    whenNot: 'To clean up duplicates, use `collection_tidy`; whole collections are deleted by the user in the app.',
    example: { collection: 'Veterinary API', request: 'Large response (10 MB)', confirm: true },
  },
  create_collection: {
    when: 'Use it to create an empty collection before adding requests.',
    whenNot: '`save_request` with `create: true` creates one on the way; to import a definition, use `import_definition`.',
    example: { name: 'Billing API', description: 'Invoices and payments.' },
  },
  create_folder: {
    when: 'Use it to create a folder or folder path in a collection.',
    whenNot: '`save_request` and `move_request` create missing folders on the way.',
    example: { collection: 'Veterinary API', folder: 'Appointments / Reminders' },
  },
  set_collection_variable: {
    when: 'Use it to set or remove a plain collection variable shared by every request of the collection.',
    whenNot: 'For values that differ per environment, use `set_environment_variable`; secrets are set by the user in the app.',
    example: { collection: 'Veterinary API', name: 'apiVersion', value: 'v2' },
  },
};
