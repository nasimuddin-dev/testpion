---
title: "Use TestPion from AI agents"
description: "Serve a workspace to Claude, IDE assistants and other AI agents over MCP with testpion mcp-server, and point them to llms.txt."
---

::: v-pre

# Use TestPion from AI agents

`testpion mcp-server` makes a workspace available to AI agents as [Model Context Protocol](https://modelcontextprotocol.io) tools. An agent such as Claude Code, Claude Desktop or an IDE assistant can then find your requests, read their documentation, send them and run collections, with your environments and auth, without seeing your secrets.

## Connect from the app

**Settings ▸ AI agents (MCP)** (or *Connect an AI agent* in the command palette) has the setup for **Claude Code**, **Claude Desktop**, **Cursor / Windsurf**, **VS Code** (Copilot agent mode) and **Codex**, filled in for the open workspace: copy it into the agent's configuration. The installed app is the server, so there is nothing else to install, and it uses the secrets you saved in the app. Two switches make the server read-only or allow production environments. **Test connection** starts the server the way your agent will and shows what it offers (tools, resources, prompts).

The command it shows is the app with `--mcp-server`:

| OS | Command |
|---|---|
| Windows | `"%LOCALAPPDATA%\Programs\TestPion\TestPion.exe" --mcp-server -w "C:\path\to\workspace"` |
| macOS | `/Applications/TestPion.app/Contents/MacOS/TestPion --mcp-server -w /path/to/workspace` |
| Linux | `testpion --mcp-server -w /path/to/workspace` (the .deb / .rpm install; for the AppImage, its path) |

No window opens; `--read-only`, `--allow-production`, `--block-private-networks` and `--allow-host` work as below. Without `-w` it serves the workspace the app last opened. The app can stay open at the same time.

## Register the server with the CLI

The server speaks MCP over stdio. Point your agent at the `testpion` CLI with the workspace to serve:

```json
{
  "mcpServers": {
    "testpion": {
      "command": "testpion",
      "args": ["mcp-server", "-w", "/path/to/my-workspace"]
    }
  }
}
```

For Claude Code: `claude mcp add testpion -- testpion mcp-server -w /path/to/my-workspace`.

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: the nearest `workspace.json` above the current directory). |
| `--read-only` | Only the browsing tools. The agent can read collections and docs but not send requests. |
| `--allow-production` | Allow sending to environments marked as **production**. They are refused by default. |
| `--block-private-networks` | Refuse requests to localhost, private networks and cloud metadata addresses (and local stdio MCP servers). Use it when agents you don't fully control get the server. `--allow-host` keeps chosen hosts reachable. |

## Tools

| Tool | What it does |
|---|---|
| `list_collections` | Collections with their request, gRPC call, connection and example counts. |
| `list_requests` | What a collection holds: its requests (id, name, method, URL with `{{variables}}`, folder), then its gRPC calls (target, method) and WebSocket / Socket.IO / MQTT connections (url, mode). `run_collection` runs them all. |
| `get_request` | One saved request (headers, body, auth type, scripts, docs, example names), or one of the collection's gRPC calls (target, method, message, metadata) or connections (url, mode, message). Sensitive values are masked. |
| `list_environments` | Environments and their variable **names** (values are not returned). |
| `collection_docs` | The collection's [Markdown documentation](/api-testing/collections#documentation). |
| `send_request` | Send a saved request (its scripts and assertions run too) or an ad-hoc request: `method` + `url` (+ `headers`, `body`), or a copied cURL / fetch / PowerShell `snippet`. `{{variables}}` resolve from the chosen environment. Returns status, headers, body (up to 20,000 characters) and timing; for a saved request also the scripts' `console.log` output (`scriptLogs`) and the [`pm.visualizer`](/api-testing/rest#visualize-responses-pm-visualizer) rendering (`visualization.html`). |
| `grpc_call` | Call a [gRPC](/api-testing/grpc) method described by `.proto` files in the workspace (`protos`: paths, with the files they import; leave out to use server reflection), or list the methods with example requests when `method` is left out. Returns the gRPC status, the response (or the streamed messages), metadata and trailers. |
| `realtime_exchange` | Talk to a [WebSocket, Socket.IO, MQTT or Kafka](/api-testing/websocket) server: connect, send messages, emit events (optionally waiting for acknowledgements), subscribe and publish (MQTT), or read topics and produce (Kafka, in a consumer group of its own), collect what arrives for `waitMs`, close. Returns the messages with direction, time, event name or topic (Kafka: key, partition, offset, headers). |
| `run_collection` | Run a collection or one folder like the [Collection Runner](/api-testing/collections#collection-runner) and return totals and per-request results with failure messages, script logs and visualizations. With `data` (a CSV, JSON, JSONL or SQLite file inside the workspace, or a PostgreSQL / MySQL database as `env:NAME` naming an environment variable that holds its URL; plus `query` for databases) each row is one iteration; `iterations` repeats the run. |
| `parse_request_snippet` | Turn a request copied from browser devtools or docs (cURL for bash or cmd, fetch, fetch (Node.js), PowerShell `Invoke-WebRequest` / `Invoke-RestMethod`) into a structured request: method, URL, params, headers, cookies, body and auth. Nothing is sent or saved. Tokens, keys, cookies and passwords come back as `{{variables}}`, listed in `placeholders`. |
| `save_request` | Save a request into a collection and folder path (`"Auth / Tokens"`, created as needed; `create: true` makes a new collection). Give a `snippet` or `method` + `url` (+ `headers`, `body`). Secret values are **not** written to the workspace: they become `{{variables}}`, and the result's `placeholders` lists them so the user can add them as secret environment variables. |
| `request_history` | Earlier responses of a saved request (sent in the app), newest first: id, time, status, duration, size. |
| `score_trend` | Each evaluator's mean score run by run (evaluations, AI and RAG tests). |
| `flaky_tests` | Tests whose result keeps changing across the latest runs, or that passed only after a retry. |
| `test_history` | One test across the latest runs (status, latency, failed checks) with how often its result flipped. |
| `recent_failures` | The latest failed responses across the workspace (4xx/5xx, transport errors, non-OK gRPC codes, MCP tool errors): time, kind, name, URL, status and duration. |
| `response_time_stats` | Response-time summary of a saved request's recent responses: count, failed, fastest, mean, median (p50), p95 and slowest (ms). |
| `collection_timing` | Where a collection's request time went (DNS, TCP, TLS, server, download; new vs reused connections). |
| `collection_health` | How the requests of a collection are doing: per request its folder, method, whether it has checks, responses, failures, latest status and median time (failing first, then slowest). |
| `run_breakdown` | A finished run in detail: tests per response-time range, results per type, slowest and flaky tests, most failed checks and evaluator scores. |
| `decode_jwt` | Decode a JSON Web Token (header, claims, issued / expires / not before, seconds left, expired); the signature is not verified. |
| `compare_runs` | What changed between two runs: new failures, fixed tests, slower tests, new and removed tests and the change of totals; `passed` is false when something regressed. |
| `list_datasets` | Data files in the workspace's `datasets/` folder (path, format, size; tables of SQLite databases), to pass to `run_collection` as `data`. |
| `load_history` | Earlier load tests (from the app and `load_test`), newest first: target, virtual users, throughput, error rate, p50 / p95 / p99 and pass rules. |
| `update_request` | Change a saved REST request: name, method, URL, headers, body, description, scripts. Secrets typed in become `{{variables}}` (listed in `placeholders`), never written. |
| `move_request` | Move a request or folder to a folder (created when missing) of the same or another collection. |
| `delete_request` | Delete a request or folder; the deleted item is returned so it can be put back. |
| `create_collection`, `create_folder` | A new empty collection (with plain variables); a folder path such as `Auth / Tokens`. |
| `set_collection_variable` | Set or remove a plain collection variable (names that look like secrets are refused: those belong in secret environment variables). |
| `list_mcp_servers` | The workspace's MCP servers (id, name, transport, target; whether a stdio command was allowed). |
| `mcp_server_tools` | Connect to one of them and list its tools (with schemas), resources and prompts. |
| `mcp_call_tool` | Call a tool of one of the workspace's MCP servers and return the result: the way to test an MCP server. A stdio server runs only after the user allowed its command in the app (Connect ▸ Always for this workspace). |
| `debugger_capture`, `debugger_exchanges`, `debugger_exchange`, `debugger_session`, `debugger_rules`, `debugger_stats` | The HTTP Debugger: start a proxy, run a program with `HTTP_PROXY` set to it, read what it sent and got (redacted, `deep` searches bodies), save the session as HAR or open one, rules that ignore, highlight, modify, answer or redirect matching traffic (presets: offline, slow, CORS…), the session in numbers. |
| `git_status` | Git state of the workspace: branch, ahead / behind the remote, changed files. |
| `git_conflicts`, `git_resolve` | After a pull that stopped on conflicts: each conflict of a collection file with its parts side by side (base, ours, theirs; redacted), and settling a file with one side or a choice per conflict. `git_resolve` is not on a read-only server. |
| `git_diff` | The workspace's changes by meaning (requests, folders, environment variables, test files); with `from` / `to`, between two commits; `markdown: true` for a pull-request comment. |
| `git_log` | Commits of the workspace, of a file or of a collection. |
| `git_propose_commit` | Stage the changes and propose a commit message (after the secret check). It does not commit: the message appears in the app's Git view for a person to commit. Not on a read-only server. See [Keep your workspace in git](/getting-started/git). |
| `what_needs_attention` | Failing monitors, expiring certificates, the latest failed run, failing requests and flaky tests, most severe first. A good first call. |
| `workspace_activity` | Per-day activity of the workspace (`days`, default 14): requests and failed requests, median response time, test runs and failed tests, requests per type and the slowest requests. |
| `environment_matrix` | Every variable across every environment: set, empty, missing or disabled in each (statuses only). |
| `compare_environments` | Differences between two environments: missing keys, different values, disabled variables, secrets set on one side only. Statuses only, never values. |
| `compare_request_across_environments` | Send a saved request with two environments and diff the responses (status, time, headers, JSON fields); masked; production refused unless allowed. |
| `ci_config` | A CI pipeline file (GitHub Actions, GitLab CI, Azure Pipelines, Jenkins) that runs a suite, collection or tests, with the CI secrets to create. |
| `list_monitors` | Monitors (collections on a schedule) with their schedule, last result and next run. |
| `monitor_requests` | Each request of a monitor over its latest runs: median / p95 time, failures and the latest failure. |
| `monitor_results` | A monitor's recent results, newest first. |
| `check_certificate` | Connect to a host and read its TLS certificate now: subject, issuer, days left, trusted or why not, protocol. |
| `list_certificates` | TLS certificates of the HTTPS hosts the workspace called, soonest to expire first (optionally only those within N days). |
| `llm_usage` | Prompts run in the AI Lab per provider and model: tokens in / out, estimated cost, median time. |
| `mcp_tool_usage` | How the tools of the workspace's MCP servers were called from the app: calls, failures, median and p95 time per tool. |
| `monitor_uptime` | A monitor's uptime per day over the last N days (runs, passed, uptime, slowest p95). |
| `run_monitor` | Run a monitor now; returns the result and the failed requests. |
| `compare_responses` | Compare two responses by history id: status, timing, header changes and a field-by-field JSON body diff (`$.path` added / removed / changed). Sensitive values are masked. |
| `set_environment_variable` | Set plain variables of an environment (optionally creating it). Secret variables are refused. |
| `reorder_environments` | Set the order of environments in the environment picker (names or ids, first to last). |
| `load_test` | Load-test a local URL, a collection or a gRPC method (`grpc: { target, method, message }`) (localhost and private networks only, at most 50 virtual users for 60 seconds; optional warm-up). Returns throughput, latency percentiles, error rate and per-request numbers; `thresholds` (e.g. `["p95<500", "errors<1%"]`) adds pass/fail per rule. |
| `export_traces` | Send the newest traces (optionally of one kind) to an OpenTelemetry collector as OTLP, redacted; header values may be `{{variables}}`. |
| `lint_tests` | What is wrong in test files before they run: unknown test or check types, keys the runner does not read (with the likely key), `dependsOn` ids nobody defines; each with a line. Files, or the text of one file. |
| `list_tests` | The test files under `tests/` with their tests (id, name, type, tags). |
| `run_tests` | Run test files (all, or files / folders, filtered by name or tags) like `testpion test`; `rerunFailed` runs only the failures of the last run (or a run id). The run is recorded in the workspace history. |
| `save_test` | Save a collection's REST or GraphQL request as a YAML test file under `tests/`, with its checks. |
| `graphql_operation` | Build a valid, ready-to-run operation for a root field of a GraphQL endpoint (introspected): variables with placeholder values and a selection of fields, so agents don't guess field names. |
| `graphql_subscribe` | Run a GraphQL subscription over WebSocket and return the events received (up to a count or 60 seconds). |
| `security_review` | Security findings in a collection's requests (typed-in secrets, secrets in URLs, plain http, turned-off TLS checks). |
| `collection_openapi` | An OpenAPI 3.1 document (YAML) describing a collection's HTTP requests, examples and auth. |
| `unused_variables` | Variables of the environments and the workspace that nothing reads, to clean up (check one with `variable_usages` first). |
| `variable_flow` | How variables flow through a collection run: which requests' scripts set each one and which use it, in run order; flags used-before-set, never-set and unused. |
| `variable_usages` | Where a variable is used or defined: requests, scripts, environments, collection / folder / workspace variables, test files. |
| `rename_variable` | Rename a variable everywhere in the workspace (secret values move with it). |
| `openapi_diff` | Breaking and other changes between two OpenAPI versions (links, workspace paths such as `specs/…`, or text). |
| `move_variables_to_environments` | Move collection variables into environments so each can set its own value (`dryRun` to preview). |
| `replace_in_collection` | Find and replace across a collection's requests (URLs, params, headers, bodies, auth, scripts, names): a preview, then `apply: true`. |
| `generate_tests` | A first test suite from an API definition in the workspace: each operation's example and one invalid request, per tag, with a suite. |
| `generate_dataset` | Rows of test data into `datasets/` from a JSON schema or an API definition operation's request body. |
| `api_fuzz` | Fuzz an API from its OpenAPI document (local hosts only, DELETE left out unless asked): server errors, invalid input accepted, undocumented statuses. |
| `openapi_outline` | An OpenAPI document's operations by tag, with parameters, request body, responses (schemas as short type outlines) and the request an import would make; narrow it with `tag` or `operationId`. |
| `openapi_lint` | Lint problems of an OpenAPI document (or every document in `specs/`), each with its rule, level, line and column. |
| `import_definition` | Import an OpenAPI document, Postman / Insomnia / Bruno / Hoppscotch collection, HAR or .env, from a public link (`url`) or `text`. OpenAPI imports get contract checks. |
| `testpion_guide` | How to use the workspace: which tool for which job, how variables resolve, every check type this engine knows (with examples) and the YAML test file format. Agents read it before writing tests. |
| `set_request_checks` | Add (`mode: append`) or replace the checks of a saved REST or GraphQL request; they then run whenever it is sent, in `run_collection` and in CI. Unknown check types are refused with the list of known ones. |
| `write_test_file` | Write a YAML or JSON test file under `tests/`. The content is checked first (it must parse as tests or a suite and use known check types), so a broken file never lands in the workspace; an existing file is replaced only with `overwrite: true`. |

`save_request`, `import_definition`, `rename_variable`, `reorder_environments`, `set_request_checks` and `write_test_file` change workspace files, `load_test` generates load, and `--read-only` hides them together with the tools that send requests.

Every tool has a **title** and **annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so agents can run the read-only ones without asking and ask before the ones that send requests or change files. Results come as JSON text and as **structured content** (a list is wrapped as `{ "items": [...] }`).

## Resources

For agents that read context (in Claude Code, type `@` to attach one):

| URI | What |
|---|---|
| `testpion://guide` | The guide (as `testpion_guide`), Markdown. |
| `testpion://workspace` | Collections with their counts, environments (variable names), monitors. |
| `testpion://attention` | What needs attention (as `what_needs_attention`). |
| `testpion://collections/{collection}` | A collection's documentation, Markdown (each collection is also listed). |
| `testpion://collections/{collection}/requests/{request}` | A saved request (secrets masked). |

## Prompts

Ready-made instructions for the common jobs, which you pick in your agent (in Claude Code: `/`):

| Prompt | What it does |
|---|---|
| `investigate_failures` | Finds what is failing (monitors, runs, certificates, requests, flaky tests), why, and what to fix. |
| `write_tests` | Adds checks to the requests of a collection after sending them, saves them, and runs them. |
| `debug_request` | Sends a saved request and explains the response and what to change when it fails. |
| `api_health_report` | A short Markdown report: availability, slow requests, repeating failures, certificates. |
| `import_and_test` | Saves a pasted cURL / fetch command (or imports an OpenAPI link), sends it and adds checks. |

The read-only server offers `investigate_failures` and `api_health_report`.

## AGENTS.md

Coding agents (Claude Code, Codex, Cursor, Copilot) read `AGENTS.md` first when they open a folder. **Write AGENTS.md** in Settings ▸ AI agents, or `testpion agents-md -w <workspace>`, adds a section to the workspace's `AGENTS.md` (or creates it): how to reach the workspace over MCP and the CLI, the check types and the test file format. What you wrote around it stays; writing it again refreshes only the TestPion part. It holds no paths of your machine, so it can be committed with the workspace.

## What agents can and can't see

- Output uses the workspace's redaction rules. Sensitive headers, JSON fields and known secret values are masked, and environment values are never listed.
- Secrets resolve inside TestPion when a request is sent. The agent sees `{{accessToken}}`, never the token. In the CLI, secrets come from `TESTPION_SECRET_*` environment variables (see [Secrets](/security/secrets)).
- Requests go only where your collections and environments point. Production environments need `--allow-production`, and `--read-only` removes sending altogether.

## llms.txt

The documentation site publishes [`/llms.txt`](https://nasimuddin-dev.github.io/testpion/llms.txt), a short, link-rich summary of TestPion for language models. Give it to an assistant that should learn how TestPion works.

:::
