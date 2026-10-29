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
| `--profile minimal` | List only the tools of the common jobs (find, send, run, check, import, generate, watch: about 25). For agents that load every listed tool into their context (Cursor, Copilot, Cline); Claude Code loads tools on demand and does well with the full list. `search_tools` finds the others and any tool it names can be called. |
| `--allow-production` | Allow sending to environments marked as **production**. They are refused by default. With it, a tool that sends with an `environment` (`send_request`, `run_tests`, `run_collection`, `grpc_call`, `run_monitor` …) takes `allowProduction`: data-changing requests to a production environment go out only when the call passes `allowProduction: true` (ask the user first); reads go out without it. |
| `--block-private-networks` | Refuse requests to localhost, private networks and cloud metadata addresses (and local stdio MCP servers). Use it when agents you don't fully control get the server. `--allow-host` keeps chosen hosts reachable. |

## How every tool behaves

Every tool keeps the same contract, so an agent learns it once:

- **Descriptions** say what the tool does, then `When to use:`, `When not:` (and which tool instead) and one `Example:` call.
- **Id parameters are snake_case**: `run_id`, `result_id`, `seed_run_id`, `item_id`, `operation_id`. The older names (`runId` …) are still accepted.
- **Lists page**: every list tool (`list_*`, `recent_failures`, `request_history`, `git_log`, `debugger_exchanges` …) takes `limit` (default 100, at most 500) and `cursor`. The text result is the page itself (a JSON list, as before); when there is more, a second text block says so and the structured result has `nextCursor` (and `total` when known). Pass `nextCursor` back as `cursor` for the next page.
- **Errors** come back as an error result with the text and, for tools without an output schema, `structuredContent.error` = `{ code, message, hint, retryable }`, the same object as the CLI envelope's `errors[]` (tools with an output schema carry it in `_meta["testpion/error"]`).
- **AI cost**: every tool that calls the model takes `max_cost_usd` (refused before anything is sent when one call could cost more) and returns `model`, `usage` and `costUsd`.
- **Big results** (`send_request`, `get_request`, `collection_docs`, the run tools, `run_breakdown`, `git_diff`, `openapi_outline`, `debugger_exchange` …) take `response_format`: `"concise"` (the default) cuts texts over 2,000 characters and lists over 50 items; `"detailed"` keeps up to 20,000 characters and 500 items. Every result is capped (60 KB concise, 400 KB detailed); a cut result has a `truncated` list (what was cut: path, shown, total) and a note `Truncated — … To see more or less: …` naming how to narrow it.
- **Deleting or overwriting needs consent**: `delete_request`, `delete_item`, `import_bundle_apply`, `undo_import`, `save_output` with `save_to`, `export_bundle`, `export_traces`, `import_definition` (unless `update: false`), `undo_definition_import`, `security_tests_run`, `flow_remove_step`, `git_resolve`, `git_sync`, `git_restore_item` and `git_discard_item` (without `dryRun`), `git_undo`, `git_stash` (push, apply, pop, drop), `git_fix_setup`, `git_track_large`, `git_share_session` and `git_codeowners` (when they write), `collection_tidy`, `rename_variable`, and `replace_in_collection` with `apply`, `move_variables_to_environments` without `dryRun`, `write_test_file` / `generate_*` with `overwrite`, `set_request_checks` with `mode: "replace"`, `flow_webhook_set` with `remove`, `debugger_rules` remove / clear, `debugger_session` open (replacing), `agents_init` with `force`, `ai_apply_proposal`, `ai_run_task` and `flow_generate` (without `dryRun`; they spend your AI credit), `ai_attempt_fix` and `ai_undo_proposal`, and the RAG tools that send requests to your system or spend judge tokens: `rag_run`, `rag_rescore`, `rag_probe`, `rag_try_metric` (a real run, or a dry run that asks a `target`), `rag_validate_metric` with `run_examples` and `rag_import_dataset` with `save_as`. Without `confirm: true` nothing changes: the result (an error result, so the agent does not take it for done) has `confirmationRequired: true`, `wouldDo` and, for tools with a dry run, a `preview`. A client that supports MCP **elicitation** is asked instead ("delete_request will delete the request … Go ahead?"): yes goes ahead, no changes nothing.

- **Environment variables** {#env}: `{{$env.NAME}}` reads an OS environment variable. The MCP server reads **none** unless you list the name in **Settings ▸ Privacy & security ▸ OS environment variables requests may read** (setting `envVariables`; `testpion settings set envVariables NAME`): an API response under test must not be able to make an agent send `{{$env.AWS_SECRET_ACCESS_KEY}}` to another server. A tool that left a variable unresolved for this reason says so (`blockedEnvVariables` and an `envNotice` with how to allow it); the agent cannot allow it itself without your approval. The CLI run commands (`testpion run`, CI) read every variable unless the setting lists some.
- **Confirmation without elicitation** {#confirmation}: `confirm: true` is only an argument, so an agent that reads "call `delete_item` with `confirm: true`" in an API response could pass it. When the client **cannot** ask you, the server started by the app or `testpion mcp-server` therefore shows **you** a one-time code instead, in its own log (the terminal, or the host's MCP log), and the call goes through only with `confirm: "ABC-DEF"`, the code you gave the agent. The code is for that tool and those arguments, works once and expires after 10 minutes; ten wrong codes end the guessing. The agent is told to ask you and cannot read the code. `TESTPION_MCP_CONFIRM_CODES=0` turns this off for a pipeline you trust.
- **Budgets and caps for agents**: the tools that send requests (`send_request`, `run_collection`, `run_tests`, `run_monitor`, `grpc_call`, `graphql_operation`, `mcp_call_tool` …) stop after 300 calls in a session and the AI tools that spend credit (`ai_run_task`, `flow_generate`) after 50, and ask for the same yes or code for each further block (`TESTPION_MCP_SEND_BUDGET` changes the first). AI calls from agents also run under default caps where Settings ▸ AI assistant ▸ Limits sets none: 50,000 tokens a call, 1,000,000 tokens and $5 a day.
- **Resources** (`testpion://…`) are read through the same contract: the size caps and named cuts apply.
- **Output schemas**: `send_request`, `run_tests`, `run_collection`, `run_evaluation`, `run_monitor`, `compare_runs`, `eval_compare`, `lint_tests` and `set_request_checks` declare an `outputSchema`, so clients can read their structured results as data.

## Paging {#paging}

Every list comes a page at a time with the same arguments and the same answer, whichever tool it is:

- **Arguments**: `limit` (how many) and `cursor` (the `nextCursor` of the page before; leave it out for the first page). `search_ask` and `read_dataset` also take `offset` (the same as a number); `search_ask`'s `limit` is 1 to 200 and replaces the `limit` of its `query`.
- **Answer**: `truncated` (more follow), `nextCursor` (pass it back as `cursor`) and, when known, `total`. For the list tools (`list_*`, `history_list`, `recent_failures`, `request_history`, `flaky_tests`, `search_workspace` …) the text is the page as a JSON list and the structured result is `{ items, total?, truncated, nextCursor? }`; `run_results` and `read_dataset` answer an object with `items` / `rows`, `total`, `truncated` and `nextCursor`; `search_ask` has them in `outcome`.
- **Defaults**: 100 a page for the list tools (at most 500), 100 for `run_results` (at most 500), 25 for `search_ask`. A list that fits has `truncated: false` and no cursor; a longer one says `truncated: true`, and a note names the call that fetches the next page. Keep `limit` within what `response_format: "concise"` shows (50), or use `"detailed"` (500), or the part beyond is cut.
- **Every item once**: a cursor names a position, so walking `nextCursor` until it is gone returns every item exactly once (a list that changes meanwhile can shift a position).

`run_results` is the way to read the results of a long run: `{ "run_id": "…", "status": "failed", "limit": 100 }`.

## Tools

Not sure which tool? **`search_tools`** takes what you want to do ("capture traffic", "compare two runs", "mock an endpoint") and answers with the matching tools, a line each and their required arguments.

| Tool | What it does |
|---|---|
| `list_collections` | Collections with their request, gRPC call, connection and example counts. |
| `list_requests` | What a collection holds: its requests (id, name, method, URL with `{{variables}}`, folder), then its gRPC calls (target, method) and WebSocket / Socket.IO / MQTT connections (url, mode). `run_collection` runs them all. |
| `get_request` | One saved request (headers, body, auth type, scripts, docs, example names), or one of the collection's gRPC calls (target, method, message, metadata) or connections (url, mode, message). Sensitive values are masked. |
| `get_settings` | The app settings of this computer (timeout, preview size, proxy mode, redaction field names, load-test limits, AI caps …) with defaults filled in; `describe: true` says what each does. Never a secret. CLI: `testpion settings get`. |
| `set_settings` | Change app settings, or put them back to their defaults (`settings`, `reset`); asks for `confirm: true`. **Security settings** (`proxy.*`, `tls.*`, `envVariables`, `redactFields`) decide where requests and their secrets go, which environment variables a request may read and what is hidden in logs: the question you are asked shows the old and the new value (a password in a proxy URL is masked), not only the key. CLI: `testpion settings set / reset`. |
| `auth_token` | Run the OAuth 2.0 grant of a collection or request now: whether it works, when the token ends, its scope, the token masked. CLI: `testpion auth token`. |
| `list_environments` | Environments and their variable **names** (values are not returned). |
| `collection_docs` | The collection's [Markdown documentation](/api-testing/collections#documentation). |
| `send_request` | Send a saved request (its scripts and assertions run too) or an ad-hoc request: `method` + `url` (+ `headers`, `body`), or a copied cURL / fetch / PowerShell `snippet`. `{{variables}}` resolve from the chosen environment. Returns status, headers, body (up to 20,000 characters) and timing; for a saved request also the scripts' `console.log` output (`scriptLogs`) and the [`tp.visualizer`](/api-testing/rest#visualize-responses-tp-visualizer) rendering (`visualization.html`). |
| `grpc_call` | Call a [gRPC](/api-testing/grpc) method described by `.proto` files in the workspace (`protos`: paths, with the files they import; leave out to use server reflection), or list the methods with example requests when `method` is left out. Returns the gRPC status, the response (or the streamed messages), metadata and trailers. |
| `realtime_exchange` | Talk to a [WebSocket, Socket.IO, MQTT or Kafka](/api-testing/websocket) server: connect, send messages, emit events (optionally waiting for acknowledgements), subscribe and publish (MQTT), or read topics and produce (Kafka, in a consumer group of its own), collect what arrives for `waitMs`, close. Returns the messages with direction, time, event name or topic (Kafka: key, partition, offset, headers). |
| `run_collection` | Run a collection or one folder like the [Collection Runner](/api-testing/collections#collection-runner) and return totals and per-request results with failure messages, script logs and visualizations. With `data` (a CSV, JSON, JSONL or SQLite file inside the workspace, or a PostgreSQL / MySQL database as `env:NAME` naming an environment variable that holds its URL; plus `query` for databases) each row is one iteration; `iterations` repeats the run. |
| `parse_request_snippet` | Turn a request copied from browser devtools or docs (cURL for bash or cmd, fetch, fetch (Node.js), PowerShell `Invoke-WebRequest` / `Invoke-RestMethod`) into a structured request: method, URL, params, headers, cookies, body and auth. Nothing is sent or saved. Tokens, keys, cookies and passwords come back as `{{variables}}`, listed in `placeholders`. |
| `save_request` | Save a request into a collection and folder path (`"Auth / Tokens"`, created as needed; `create: true` makes a new collection). Give a `snippet` or `method` + `url` (+ `headers`, `body`). Secret values are **not** written to the workspace: they become `{{variables}}`, and the result's `placeholders` lists them so the user can add them as secret environment variables. |
| `request_history` | Earlier responses of a saved request (sent in the app), newest first: id, time, status, duration, size. |
| `list_evaluations` | [Evaluations](/ai-testing/evaluations) saved in the app (dataset × prompt × model × evaluators): id, name, folder, model, number of cases and evaluator types. |
| `run_evaluation` | Run a saved evaluation by name or id, like `testpion eval run` (`max_cost_usd` stops a prompt evaluation at a spend cap, `confirm: true` goes past the question when it is estimated over $0.50): totals, mean scores and per-case results with failed checks; the run is recorded in the workspace history. `limit` runs only the first records (at most 500). |
| `run_results` | The results of a finished run, a page at a time (`status`: failed / passed / skipped / reviewed / unreviewed, `query` by name): id, name, status, latency, error and failed checks, with a person's rating. See [Paging](#paging). |
| `run_reviews`, `review_result` | A person's verdicts on a finished run's results (good / bad with a note), and rating a result as an agent (marked as an agent's; `rating: null` clears it). A bad rating on a passing result means the checks missed something. |
| `score_trend` | Each evaluator's mean score run by run (evaluations, AI and RAG tests). |
| `eval_sample` | Make the sample evaluation (*Sample: support intents*, 10 cases) on the offline demo model and run it: no key, no network. Returns the run and a headline (*10 of 10 passed*). The demo model answers by rules, so it says nothing about a real model. |
| `eval_estimate` | What a saved prompt evaluation would cost before it runs: cases, calls, tokens, dollars from the price table, seconds, the spend cap ($1.00 on a paid model) and whether `run_evaluation` would ask first (over $0.50 or 100 calls). Sends nothing. |
| `eval_try_check` | Try one check on one case of a saved evaluation: the reply, passed or failed and why, the cost. `dry_run` says what it would cost and sends nothing; a paid model needs `confirm: true`. |
| `eval_matrix` | Evaluation runs side by side: cases × variants (a run each, or a column per model), each cell's status and mean score, and with `baseline` regressed / improved / unchanged / new / missing with the score change. One page of rows with per-variant stats and counts per filter; `filter`, `tag`, `search`, `sort` narrow it; `run` + `result` returns one cell's full result. |
| `rag_list_targets` | The [RAG targets](/ai-testing/rag#connect) of the workspace: id, name, protocol, the mapping in a line and what stops one from being called. |
| `rag_probe` | Ask a RAG target one question (a real request, with the environment's variables) and read what its mapping finds: the answer, the retrieved contexts (id, text, score, source), usage, latency, and the response the mapping reads. |
| `rag_metrics` | The [RAG metric catalogue](/ai-testing/rag-metrics) (138 metrics) and the presets: id, group, kind (no model / judge), direction, what it reads, judge calls, default pass mark, other names (a Ragas name finds its metric). |
| `rag_list_custom_metrics` | The custom metrics of the workspace (`metrics/*.yaml`): id, kind, threshold, direction, the number of examples. |
| `rag_validate_metric` | Checks a metric file (text or saved id) and runs its examples; a judged kind spends the judge. Says whether the metric agrees with its examples. |
| `rag_save_custom_metric` | Writes `metrics/<id>.yaml` after the same check; replacing an existing file asks for confirmation. See [Custom RAG metrics](/ai-testing/custom-metrics). |
| `rag_generate_testset` | A RAG test set from documents as ONE proposal (questions, references, chunk ids, verification badges); asks first, `dry_run` returns the estimate. Add rows with `ai_apply_proposal`. See [Test sets from documents](/ai-testing/rag-testset). |
| `rag_capture_dataset` | A dataset from real calls (History, a saved Debugger session, a HAR file, a WebSocket message log, a run; gRPC and MCP calls of History as questions), masked; asks first; `dry_run` previews. See [Datasets from real calls](/ai-testing/rag-capture). |
| `rag_draft_references` | Reference answers drafted for the records of a captured dataset that have none, from the passages each record retrieved (not from the system's answer), as ONE proposal of checked drafts; asks first; `dry_run` shows what would be sent. Accepting replaces the records. See [Datasets from real calls](/ai-testing/rag-capture). |
| `rag_label` | Records a person's pass/fail label of a result in `labels/*.json`. A label is the person's verdict, not the agent's. |
| `rag_calibrate` | Judge vs labels per metric and judge: kappa, accuracy, confusion matrix, intervals, disagreements, the best pass mark (`tune`). No model call. See [Calibrating a judge](/ai-testing/rag-calibration). |
| `rag_make_metric_example` | Adds a labelled sample of a run to a custom metric's `examples:` (the person's verdict is what it must say). Edits only the metric's own file. See [Calibrating a judge](/ai-testing/rag-calibration). |
| `rag_author_evaluation` | A proposed evaluation for a target (metrics, pass marks, judge options, gates), dry-run on a few samples; asks first; `dry_run` shows what would be sent. See [Drafting an evaluation](/ai-testing/rag-author). |
| `rag_trend` | Metric means across the runs of an evaluation, with judge changes marked. |
| `rag_try_metric` | One metric on one sample: `dry_run` shows the exact judge prompts and sends nothing; otherwise the result with its items, the judge and the cost. The sample is given, taken from a run (`run_id` + `record`) or probed from a target. |
| `rag_try_metric` | One metric on one sample: `dry_run` shows the exact judge prompts and sends nothing (with the pictures it would send, as hashes); otherwise the result with its items, the judge and the cost. The sample is given, taken from a run (`run_id` + `record`) or probed from a target. `fields` carries the rest of a dataset record (a conversation as `turns`, `reference_tool_calls`, `expected_outcome`, `reference_topics`, `should_refuse`, `canaries`), `tool_calls` the calls the system made, `images` pictures (needs `allow_images` and a judge that can see). |
| `rag_try_metric` | (asks to confirm unless it is a dry run that asks no target) One metric on one sample: `dry_run` shows the exact judge prompts and sends nothing (with the pictures it would send, as hashes); otherwise the result with its items, the judge and the cost. The sample is given, taken from a run (`run_id` + `record`) or probed from a target. `fields` carries the rest of a dataset record (a conversation as `turns`, `reference_tool_calls`, `expected_outcome`, `reference_topics`, `should_refuse`, `canaries`), `tool_calls` the calls the system made, `images` pictures (needs `allow_images` and a judge that can see). |
| `rag_estimate` | What a RAG evaluation (or the re-scoring of a run, exactly) will cost before it runs: judge calls, tokens, a cost range, the calls to your system and the limits it would break. Nothing is sent. |
| `rag_probe_sets` | The seeded safety probe sets (jailbreaks, planted instructions, personal data, abuse, bias, off-topic requests, harmless look-alikes) and which are in the workspace; `add: true` writes them to `datasets/probes-<set>.jsonl` (never over a file that is there). Run one with `rag_run` and `preset: "safety"`. |
| `rag_run` | Run a saved RAG evaluation with chosen metrics and gates (`min: ["faithfulness=0.8"]`), a `baseline`, `two_phase`, a jury, `swap`, `repeat`, `short_circuit`, `max_cost_usd`, `allow_images` (pictures to the judge, as data), a decision tree (`when` / `unless`): aggregates per metric, why samples failed, the gates, the comparison and the worst samples. Stops before the first question without a usable target or judge. |
| `rag_rescore`, `rag_compare` | Score a finished run again with other metrics or another judge (no call to the RAG system), and compare two runs metric by metric with a paired bootstrap. The prompt `evaluate_rag_system` walks an agent through probe → metrics → estimate → run → compare. |
| `rag_import_dataset`, `rag_export_dataset` | Convert a Ragas or DeepEval dataset (a workspace file or text) into TestPion RAG records, optionally saved to `datasets/`, or TestPion's records into Ragas or DeepEval's. [Formats](/ai-testing/rag#ragas-deepeval). |
| `eval_compare` | An evaluation run against a baseline run, case by case (like `testpion eval compare`): regressions (stopped passing, or the score dropped by more than `threshold`, default 0.05), improvements, missing and new cases, per-variant pass rate and mean score change; `passed` is false beyond `maxRegressions` (default 0). |
| `agents_init` | Write (or refresh) [AGENTS.md](#agents-md) in the workspace root from the live workspace (`targets`: also `claude` for a CLAUDE.md pointer, `cursor` for a Cursor rule); only the part between the testpion markers is replaced; returns each file's status (created, updated, unchanged, skipped and why). `dryRun` writes nothing. |
| `flaky_tests` | Tests whose result keeps changing across the latest runs, or that passed only after a retry. |
| `test_history` | One test across the latest runs (status, latency, failed checks) with how often its result flipped. |
| `flow_graph` | A test file as a [flow](/test-runner/integration-testing#see-a-flow): steps (type, method and URL, extracted names, `dependsOn`), edges, the steps in columns, problems (a missing dependency, a cycle), the designer's checks (steps that can never run, cycles, `when:` without a condition, steps waiting for a finally step), the canvas's notes and frames, `inheritedAuth` (per HTTP step, the file's `defaults: auth:` it inherits, `overridden: true` when the step has its own; credentials typed into the file show as `***`), the latest run's status and duration per step, and the diagram as Graphviz DOT. |
| `flow_add_step` | Add a step to a flow ([the designer's edits](/test-runner/integration-testing#design-a-flow)): one `step` as a test is written, several `steps` (`chain`), or saved requests of a `collection` (`items`: requests or folders, chained, with extracts suggested from saved examples); `after` makes it wait for a step. Blocks: `delay`, `condition`, `script`, `flow`, `log`, `set` (`set`, `scope`), `assert` (`assertions`, `subject`), `wait` (a request with `until`); any step `if`, `when`, `repeat`, `forEach`, `until`, `finally`, `parallel`. Comments and line endings of the file stay. |
| `flow_connect` | Make step `to` wait for step `from` (its `dependsOn`); from a condition step, `when` (true or false) puts it on that branch. Refused when it would make a cycle. |
| `flow_disconnect` | Step `to` no longer waits for step `from`. |
| `flow_update_step` | Set keys of a step (`set`: url, headers, body, extract, assertions …; `null` removes one); `name` and `id` rename it and every `dependsOn` follows; `dependsOn` replaces what it waits for. With `id` a list and `set: { parallel: <group> }` (or `null`) or `set: { finally: true }` (or `false`): puts several steps in a parallel group or the Finally lane. |
| `flow_remove_step` | Remove steps; the steps that waited for them no longer do. |
| `flow_runs` | A flow file's run history, newest first (status, when, how long, the first failing step); with `runId`, that run's steps in file order with input, output, failed checks and the variables after each step ([Debug a flow](/test-runner/integration-testing#debug-a-flow)). |
| `flow_data_run` | Run a flow file once per data row ([Run a flow at scale](/test-runner/integration-testing#run-a-flow-at-scale)): `data` a workspace data file (CSV, JSON, JSONL, SQLite with `query`), a `postgres://` / `mysql://` URL or `env:NAME` with `query`, or the file's own `data:`; each row's columns are variables, with `{{$row.column}}` and `{{$index}}`; `concurrency` rows at once, `bail`, `limit`, `environment`. Returns the counts, the first failing rows (values, failing step, error) and an `id` for `flow_scale_result`. |
| `flow_env_matrix` | Run a flow file in each of `environments` and compare: per environment status, time and failing step; per step status and ms in each (`differingSteps`); per extracted or returned value, its value in each with `differs`. Production environments are refused unless the server allows them. |
| `flow_scale_result` | A data run or matrix by `id`: a data run's rows in row order a page at a time (`offset`, `limit` up to 500, `status` all / failed / passed / cancelled), one row's step results (`row`), or a matrix (with `environment`: that environment's step results). |
| `flow_timeline` | A run of a flow file as a timeline (the latest, or `run_id`; or `run_id` alone for a whole run): each step's start, end, wait and the step it waited for, lanes, the critical path, total and waiting time, the slowest steps; `html` writes the self-contained HTML report into the workspace. |
| `flow_set_output` | Set what a flow returns (`output:` { name: template }); sub-flows get it and exposed flows return it as `output`. |
| `flow_webhook_set` | Put a flow behind a webhook: its `webhook:` block (`path`, default `/hooks/<file>`; `secret`, best a `{{VARIABLE}}`; `remove: true` takes it away). `testpion serve flows` then runs the flow when its path is called and answers its `output` ([Deploy a flow](/test-runner/integration-testing#deploy-a-flow)). |
| `save_monitor` | Add or change a [monitor](/test-runner/monitors): a `collection` (and `selection`) or a `testFile` (a flow under `tests/`) run `every` minutes / `15m` / `1h`, with an `environment` and an alert `webhook`. A monitor with the same name is replaced. |
| `flow_deploy_status` | Where a flow is deployed: `schedule` (a monitor that runs it), `webhook` (path, whether it needs a secret), `mcp` (the tool its `expose:` offers) and `ci` (a pipeline file of the repository runs it; `ciFiles`). |
| `flow_annotate` | Sticky notes (Markdown) and coloured frames around steps on a flow's canvas (`layout.notes`, `layout.frames`): `add_note`, `update_note`, `remove_note`, `add_frame`, `update_frame`, `remove_frame`; the runner ignores them. |
| `recent_failures` | The latest failed responses across the workspace (4xx/5xx, transport errors, non-OK gRPC codes, MCP tool errors): time, kind, name, URL, status and duration. |
| `history_list` | The workspace's History by `kind` and `query` (what `testpion history list --json` prints); `kind: capture` lists the HTTP Debugger's capture sessions with what each became (`capture.ref`: the collection, the flow, the saved session). |
| `response_time_stats` | Response-time summary of a saved request's recent responses: count, failed, fastest, mean, median (p50), p95 and slowest (ms). |
| `collection_timing` | Where a collection's request time went (DNS, TCP, TLS, server, download; new vs reused connections). |
| `collection_health` | How the requests of a collection are doing: per request its folder, method, whether it has checks, responses, failures, latest status and median time (failing first, then slowest). |
| `run_breakdown` | A finished run in detail: tests per response-time range, results per type, slowest and flaky tests, most failed checks and evaluator scores. |
| `decode_jwt` | Decode a JSON Web Token (header, claims, issued / expires / not before, seconds left, expired); the signature is not verified. |
| `compare_runs` | What changed between two runs: new failures, fixed tests, slower tests, new and removed tests and the change of totals; `passed` is false when something regressed. |
| `list_datasets` | Data files in the workspace's `datasets/` folder (path, format, size; tables of SQLite databases), to pass to `run_collection` as `data`. |
| `read_dataset` | The first rows of a dataset with its columns and kinds of value and how many records it holds (`limit`; `query` for a SQLite database), so an agent knows which `{{variables}}` a run can use. |
| `add_dataset_row` | Add one record to a JSONL dataset in `datasets/` (made when missing), e.g. an evaluation case with its `expected` answer. |
| `list_flows` | The flows (test files and suites with an `expose:` block) this server offers as tools of their own, with their inputs; see [Your flows as tools](#your-flows-as-tools). |
| `load_history` | Earlier load tests (from the app and `load_test`), newest first: target, virtual users, throughput, error rate, p50 / p95 / p99 and pass rules. |
| `update_request` | Change a saved REST request: name, method, URL, headers, body, description, scripts. Secrets typed in become `{{variables}}` (listed in `placeholders`), never written. |
| `move_request` | Move a request or folder to a folder (created when missing) of the same or another collection. |
| `delete_request` | Delete a request or folder; the deleted item is returned so it can be put back. |
| `save_output` | Get or save an output of TestPion as a file format, the same bytes as the app's down arrow and `testpion output`: run results (HTML, JSON, JUnit, Markdown, CSV, ZIP), History (HAR, CSV, JSON), traces (OTLP JSON), a flow timeline, a data run's rows or an evaluation matrix, a monitor's runs, the runs list, the workspace's changes (patch, Markdown), the workspace report or a saved response body. Give the `surface`, its `format` and the parameters it needs (`run`, `file`, `data_run`, `runs`, `query`, `monitor`, `history_id` …). Without `save_to` the content comes back (text, or base64 for ZIP and PNG), cut at 15,000 characters with a note; with `save_to` it is written to a **new** file under `exports/` or `.local/exports/` and nowhere else (an allow-list: never over an existing file, never in a definition folder, the repository, a hidden folder such as `.husky/` or `.vscode/`, or as a program file; asks for consent, `confirm: true`) and only the path and size come back. Secrets stay masked; there is no way to include them. |
| `delete_item`, `restore_item` | Delete any item with the `trash` capability (a collection, an environment, a dataset, an API definition, an MCP server) to Recently deleted by its `ref` (`{kind, …ids}`, its link, or `kind:id`: `environment:staging-old`, `spec:specs/petstore.yaml`), the same as the app's Delete… with Undo and `testpion item delete`; `restore_item` puts it back by the `trashId` returned (an id or name taken again gives "… (restored)"). A kind without the capability is refused with the reason. |
| `create_collection`, `create_folder` | A new empty collection (with plain variables); a folder path such as `Auth / Tokens`. |
| `set_collection_variable` | Set or remove a plain collection variable (names that look like secrets are refused: those belong in secret environment variables). |
| `list_mcp_servers` | The workspace's MCP servers (id, name, transport, target; whether a stdio command was allowed). |
| `mcp_server_tools` | Connect to one of them and list its tools (with schemas), resources and prompts. |
| `mcp_call_tool` | Call a tool of one of the workspace's MCP servers and return the result: the way to test an MCP server. A stdio server runs only after the user allowed its command in the app (Connect ▸ Always for this workspace). |
| `mock_tools` | The tools of an MCP mock file (`mocks/*.mcp-mock.yaml`): a toolset designed before the real server exists, with each tool's arguments, how it answers (text, JSON, a script) and the commands that serve it to an agent. See [Design a toolset](/mcp/mocking#design-a-toolset). |
| `debugger_capture`, `debugger_exchanges`, `debugger_exchange`, `debugger_session`, `debugger_rules`, `debugger_stats` | The HTTP Debugger: start a proxy, run a program with `HTTP_PROXY` set to it, read what it sent and got (redacted, `deep` searches bodies), save the session as HAR or open one, rules that capture only, filter out, highlight (also by a condition on one column, with colours), modify, answer or redirect matching traffic (presets: offline, slow, CORS…), each with its hits, the session in numbers. Exchanges carry the program, its process id and account, the server address and the send / wait / receive times. |
| `git_status` | Git state of the workspace: branch, ahead / behind the remote, changed files. |
| `git_changes` | What changed since the last commit, item by item, named like the app ("MCP server Weather", "Dataset users.csv: 12 rows added"): registry `kind`, `change`, `details`, `ref` and `link`, and the `file` with whether it is staged. Filter with `kind` (an id or alias) or `file`. |
| `git_conflicts`, `git_resolve` | After a pull that stopped on conflicts: each conflicted file by `mode`: `items` (collections, environments, library, MCP servers, providers, settings: each conflict with its parts side by side and, when only some fields clash, those `fields` with their keys), `text` (test and flow files, API definitions, mocks: `hunks` with a key and where they are) or `binary` (the sizes of both sides); redacted. `git_resolve` settles a file with one side, or per conflict key with `"ours"`, `"theirs"` or `{ "edit": "<value>" }` (JSON for an item or field, text for a hunk). Not on a read-only server. |
| `git_history`, `git_blame` | One item in git, any versioned kind (`ref`: a link, `mcp-server:weather`, or `file` + `item_id`): its versions with what each changed and the changed parts side by side (values redacted), or who last changed each field. Pages with `limit` / `cursor`. |
| `git_restore_item`, `git_discard_item` | Put an older version of one item back (`rev` from `git_history`), or throw away the uncommitted change of one item while the rest of its file stays. Both return a plan (the title, the parts that change) and an `undoId`; `dryRun: true` only returns the plan; otherwise they need `confirm: true`. Not on a read-only server. |
| `git_stage_item` | Stage or unstage (`unstage: true`) one item. In a file with several items (a collection, MCP servers, providers, a library) only that item's change goes into the index (`partial: true`; `leftUnstaged` names the file's other changed items, which stay out of the commit); a file that is one item stages whole and `alsoStages` names the other changed items that come along. `dryRun: true` only reports. Not on a read-only server. |
| `git_undo` | Undo the last `git_restore_item` / `git_discard_item` (or the one with `id`); `list: true` lists what can be undone. Needs `confirm: true` to undo. Not on a read-only server. |
| `git_fix_setup` | Fix git setup: complete `.gitignore` and `.gitattributes`, rewrite existing files into the stable format once, optionally install the pre-commit secret check (`hook`) and remove ignored files from git (`untrack`). `dryRun: true` returns the plan (`steps`, `rewritten`, `files`). A real run returns an `undoId` for `git_undo`. The merge and diff drivers are registered by the app or `testpion git fix`, which know their program path. Needs `confirm: true` unless `dryRun`. Not on a read-only server. |
| `git_large_files`, `git_track_large` | Files over the size policy (`warn` 5 MB, `lfs` 50 MB, `refuse` 100 MB; `check: true` also compares the `.ref` files with the data). `git_track_large` takes one out of plain git: `mode: "lfs"` or `"reference"` (with a `source`); `dryRun: true` only returns the plan; an `undoId` for `git_undo`. Needs `confirm: true` unless `dryRun`. |
| `git_share_session` | Share a saved Debugger session: a copy masked once more with the export redaction goes to `debugger/shared/` where git tracks it; `unshare: true` deletes the copy; without `name` it lists the shared sessions. Needs `confirm: true` when it writes. |
| `git_codeowners` | A starter CODEOWNERS with a line per kind folder; `write: true` writes `.github/CODEOWNERS` when the workspace is the repository (never over one that exists, never outside the workspace). Needs `confirm: true` when it writes. |
| `git_allowed_secrets`, `git_secrets_fix_plan` | What `.testpion/secrets-allow.json` lets through the staged secret scan (never a value); and which `{{variable}}` each typed secret of the staged files would become. Adding an allowlist entry or applying the fix is for a person, in the app: an agent cannot switch the secret guard off, and the values move to the app's secret store. |
| `git_stash` | Set the uncommitted changes aside and put them back: `action` is `list`, `show`, `push` (with a `name`), `apply`, `pop` or `drop`; a stash is picked by `index` or `hash`. `push`, `apply`, `pop` and `drop` need `confirm: true` (`push` with `dryRun` does not). Not on a read-only server. |
| `git_diff` | The workspace's changes by meaning (requests, folders, environment variables, test files); with `from` / `to`, between two commits; `markdown: true` for a pull-request comment. |
| `git_log` | Commits of the workspace, of a file or of a collection. |
| `git_sync` | Pull & push in one step: fetch, pull with a merge when the remote has new commits (collections merge request by request; uncommitted changes are set aside and put back), then push. Returns `pushed`, `up-to-date`, `pulled-nothing-to-push`, or `conflicts` with the files (nothing is pushed then). Not on a read-only server. |
| `git_propose_commit` | Stage the changes and propose a commit message (after the secret scan of the staged files: a certain secret refuses it and is returned with the `{{variable}}` to use, a probable one is returned as `needsConfirmation` and goes ahead only after the user said so, with `allow_probable_secrets: true`). It does not commit: the message appears in the app's Git view for a person to commit. Not on a read-only server. See [Keep your workspace in git](/getting-started/git). |
| `what_needs_attention` | Failing monitors, expiring certificates, the latest failed run, failing requests and flaky tests, most severe first, each with a `ref`. A good first call. |
| `list_kinds` | Every kind of item a workspace holds (collections, requests, gRPC calls, connections, test files, API definitions, datasets, MCP servers, prompts, load tests, evaluations, monitors, runs, history …) and what each offers: its `ref` shape, where it is stored, where it opens, and each capability (`open`, `link`, `rename`, `move`, `delete`, `trash`, `run`, `monitor`, `ci`, `test-file`, `flow`, `export` …) as `true`, `{ na: why it never applies }` or `{ planned: release }`. `kind` narrows it to one (an alias such as `library:grpc` or `test-file` works too); `all` adds the kinds registered ahead of their release. A capability marked `planned` is not built yet. `nodes` is the menu of every row the kind has in the app (its row, section header and folders): groups in order, each action's `id`, `label` key and `shortcut`. The same answer as `testpion kinds --json`. |
| `resolve_ref` | Look up a `ref` (below): whether it still exists, its name, and the `testpion://open` link that opens it in the app; when it is gone, why and the nearest thing still there (`next`). |
| `workspace_activity` | Per-day activity of the workspace (`days`, default 14): requests and failed requests, median response time, test runs and failed tests, requests per type and the slowest requests. |
| `environment_matrix` | Every variable across every environment: set, empty, missing or disabled in each (statuses only). |
| `compare_environments` | Differences between two environments: missing keys, different values, disabled variables, secrets set on one side only. Statuses only, never values. |
| `compare_request_across_environments` | Send a saved request with two environments and diff the responses (status, time, headers, JSON fields); masked; production refused unless allowed. |
| `ci_config` | A CI pipeline file (GitHub Actions, GitLab CI, Azure Pipelines, Jenkins) that runs a suite, collection or tests, with the CI secrets to create. `runId` (or `"last"`: the newest finished run of test files or a collection) runs what that run ran, in its environment. |
| `list_monitors` | Monitors (collections, test files or flows on a schedule) with their schedule, last result and next run. |
| `monitor_requests` | Each request of a monitor over its latest runs: median / p95 time, failures and the latest failure. |
| `monitor_results` | A monitor's recent results, newest first. |
| `check_certificate` | Connect to a host and read its TLS certificate now: subject, issuer, days left, trusted or why not, protocol. |
| `list_certificates` | TLS certificates of the HTTPS hosts the workspace called, soonest to expire first (optionally only those within N days). |
| `trust_status` | What the user allowed this workspace on this computer: programs, hosts its scripts may reach, reading secrets. Read-only; an agent cannot allow anything (Settings ▸ Privacy & security, or `testpion trust`). |
| `llm_usage` | Prompts run in the AI Lab per provider and model: tokens in / out, estimated cost, median time. |
| `ai_list_tasks` | TestPion's own [AI tasks](/ai-testing/ai-features): id, what each does, tier (small or large model), output, what its context holds, whether it proposes changes and the verifiers that check them. |
| `ai_run_task` | Run an AI task with the model the user configured (their key or a local model): `task`, and `item` (a ref: `request:<c>:<r>`, `run:<id>:<resultId>`, `run:last`, `test:<path>` …) or `context`, `question`, `privacy` (`full`, `metadata`, `names`), `hint`, `path`. Returns the answer and, for generating tasks, a **proposal** with an id whose items were verified. Nothing is written. `dryRun: true` returns what would be sent (messages, sections, token and cost estimate, masks) without sending. Counted in the workspace's AI usage (as *MCP agents*), within the user's caps; the model, Local only and the limits are those of the app's **Settings ▸ AI assistant**. |
| `ai_proposals` | The AI proposals of the workspace (kept a day), or one with `id`: items with before/after text, target and verification badges. |
| `ai_apply_proposal` | Apply a proposal's ticked items, or `items`: writes test files, adds checks or scripts to saved requests, adds requests. Asks the user to confirm (`confirm: true`); `dryRun: true` lists what would be applied. |
| `flow_generate` | An integration flow from a collection or one folder (`collection`, `folder` by name, path or id), written by TestPion's configured model: steps that use the saved requests by id (an invented one is dropped), create → read → update → delete, values extracted and passed on, checks, one or two error cases, and the model's assumptions; verified (lint, every `{{variable}}` extracted before use, a run on a mock of the collection). Returns a **proposal**; apply it with `ai_apply_proposal` after the user agrees. `hint`, `privacy`, `path`, `environment`; `dryRun: true` returns what would be sent; `noAi: true` (or no model set up) returns the deterministic draft. |
| `spec_gaps` | What the tests and collections never prove about an API definition (`spec`): per operation the statuses asserted, negative / boundary / security tests, contract checks, parameters never sent, and the open gaps with the coverage; how many tests TestPion could build without a model. No model needed. |
| `generate_tests` with `ai: true` | The same proposal as `spec_tests_generate` (nothing is written); without `ai` it writes the first suite as before. |
| `spec_tests_generate` | Tests for those gaps as a **proposal** (`spec`; `categories`, `operations`, `gapsOnly`, `includeDelete`, `hint`, `privacy`, `path`, `environment`): TestPion's own cases built from the document plus the configured model's ideas, every test validated against the document (an invented operation is dropped), with the coverage before → after. Apply with `ai_apply_proposal`. `dryRun: true` returns what would be sent; `noAi: true` (or no model set up) the deterministic cases. |
| `security_tests_generate` | OWASP API security tests (BOLA/IDOR, broken auth, mass assignment, admin functions) for a collection or folder as a **proposal** (`collection`, `folder`, `identities`, `probes`, `includeWrite`, `rate`, `max`, `hint`, `privacy`, `environment`, `allowProduction`): the model only picks what to probe and which principals; every verdict is a check computed from the responses. Refuses a production environment unless `allowProduction`. |
| `security_tests_run` | Runs a generated security file (`path`, `environment`, `allowProduction`) one step at a time, rate-limited; returns a verdict per step (`finding`, `pass`, `inconclusive`) and a markdown report. |
| `contract_drift` | Spec versus real traffic (`spec`; `source` history/har/run, `limit`, `har`, `run`, `ai`, `propose`, `privacy`): deterministic drift findings; with `ai` the model explains them and proposes a spec or test fix as a **proposal**, verified by re-analysing the same traffic. |
| `write_script` | A `tp.*` script (never `pm.*`) for a request or script file (`describe`, `request`, `script`, `phase`, `error`, `mode`) as a **proposal**, dry-run once in the sandbox before it is offered. |
| `tidy_import` | The clean-up of a fresh import (`collection`; `flow`, `source`, `hint`, `privacy`) as a **proposal** of separate changes: names and folders, host and token variables, chained ids, dropped tracking and duplicate requests, optionally a flow — each verified (a valid collection; every remaining request sends what it sent). Apply with `ai_apply_proposal`, `ai_undo_proposal` reverts. |
| `ai_triage_run` | Explain and fix a failed run (`run`: an id, or `last`, the newest finished run with failures): its failures grouped (same failed check, status and endpoint), then the model's causes — one may explain many groups — each with evidence (the failing request and response, the failed check, what changed since the same test's last passing run), a confidence and a fix (a check to change, an edit, a variable to set, or a bug report when the API regressed), every fix verified against the failing and the last passing response. Returns `groups`, `findings` and a **proposal**; apply with `ai_apply_proposal`, then run the affected tests again. `privacy` (`metadata`: no body values, no failure messages), `hint`; `noAi: true` (or no model set up) returns the grouping with likely causes; `dryRun: true` what would be sent. See [Explain and fix failures](/ai-testing/ai-features#explain-and-fix-failures-triage). |
| `ai_analyze_flaky` | Why a test is flaky (`item`: `test-case:<testId>` as `flaky_tests` names it, or `test:<path>[:<step>]`): its signals across runs (pass rate, flips, retries, environments, statuses, latency of passes and failures) and the model's pattern (timing, ordering, shared state, time-dependent, external dependency, rate limit, data collision) with evidence and a verified fix that never hides a failure (a wait with `until:`, a stable check, isolated data; no skip or quarantine; a retry only as a last resort, flagged), as a **proposal**. `privacy`, `hint`; `dryRun: true` what would be sent; `noAi: true` (or no model set up) returns the signals, the signature (how failing responses differ from passing ones) and the likely pattern. See [Why is this flaky?](/ai-testing/ai-features#why-is-this-flaky) |
| `ai_attempt_fix` | Apply an `ai_analyze_flaky` proposal (`id`, `items`) and run the test `times` times (default 5, at most 20) in the environment of its runs; returns the verdict (`stable`, `flaky`, `failing`), kept with the proposal; not stable: `ai_undo_proposal` puts the test back. It changes the test and sends its requests, so it asks to confirm; an environment marked as production is refused unless the server was started with `--allow-production`. |
| `ai_undo_proposal` | Put back what an applied proposal replaced. Asks to confirm. |
| `ai_usage` | What the AI features used: today and the last `days` days, per task, model and surface (app, cli, mcp, ci), the latest calls, the caps and what is left today. |
| `mcp_tool_usage` | How the tools of the workspace's MCP servers were called from the app: calls, failures, median and p95 time per tool. |
| `monitor_uptime` | A monitor's uptime per day over the last N days (runs, passed, uptime, slowest p95). |
| `run_monitor` | Run a monitor now; returns the result and the failed requests. |
| `compare_responses` | Compare two responses by history id: status, timing, header changes and a field-by-field JSON body diff (`$.path` added / removed / changed). Sensitive values are masked. |
| `set_environment_variable` | Set plain variables of an environment (optionally creating it); `alsoIn` adds them to other environments where they are missing (empty, or the same values with `copyValues`). Secret variables are refused. |
| `reorder_environments` | Set the order of environments in the environment picker (names or ids, first to last). |
| `load_test` | Load-test a local URL, a collection, a flow file (`test_file`: every virtual user runs the whole flow; per-step numbers and `iteration`: runs, failed, p50 / p95) or a gRPC method (`grpc: { target, method, message }`) (localhost and private networks only, at most 50 virtual users for 60 seconds; optional warm-up). Returns throughput, latency percentiles, error rate and per-request numbers; `thresholds` (e.g. `["p95<500", "errors<1%"]`) adds pass/fail per rule. |
| `export_traces` | Send the newest traces (optionally of one kind) to an OpenTelemetry collector as OTLP, redacted; header values may be `{{variables}}`. |
| `lint_tests` | What is wrong in test files before they run: unknown test or check types, keys the runner does not read (with the likely key), `dependsOn` ids nobody defines; each with a line. Files, or the text of one file. |
| `list_tests` | The test files under `tests/` with their tests (id, name, type, tags). |
| `run_tests` | Run test files (all, or files / folders, filtered by name or tags) like `testpion test`; `rerunFailed` runs only the failures of the last run (or a run id). With one flow file in `paths`, `from` runs from that step on and `seedRunId` seeds the steps before it from that run (alone: replays it from its first failing step). The run is recorded in the workspace history. |
| `run_tests` (results) | Each result has a `ref` to its source (`{ kind: "test", path, step }`); pass `step` (with `paths`) to run one test or step again. |
| `search_ask` | Search History, runs, test results and traces from a `question` in plain words (*failed payment calls last week over 2 s*) or from a `query` object (`{sources, where: [{field, op, value}], sort, limit}`; fields: [Ask](/getting-started/finding-your-way#ask)). With a question, TestPion's configured model only translates it into a validated query and TestPion runs it, so the model never sees the data; without a model, or when its query is invalid, the words are searched as typed (`mode: "text"`, `fallback` says why). Returns `explain` (how it was understood), `chips`, `assumptions` and `outcome.rows`, each with a `ref`. `sources` limits the search, `noAi` skips the model, `dryRun` shows what would be sent. Read-only. |
| `search_workspace` | Find items by name or content (Quick Open): requests, collections, test files, environments and variables, monitors, history, traces, runs …; each hit has a `ref`. |
| `save_test` | Save as a YAML test file under `tests/`, with its checks: a saved request (`collection` + `request`), or any item by its `ref` (a folder or a whole collection becomes one file with a test per request, a saved gRPC call or connection, a History entry). Returns `path`, `tests` and the file's `ref`. |
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
| `collection_tidy` | Duplicate requests, hosts typed into URLs, empty folders and unused variables of a collection; `removeDuplicates`, `removeEmptyFolders`, `removeUnusedVariables` fix them. |
| `replace_in_collection` | Find and replace across a collection's requests (URLs, params, headers, bodies, auth, scripts, names): a preview, then `apply: true`. |
| `generate_tests` | A first test suite from an API definition in the workspace: each operation's example and one invalid request, per tag, with a suite. |
| `generate_flows` | An [integration suite](/test-runner/integration-testing) from an API definition (`spec`) or a collection (`collection`): a flow per resource under `tests/<api>/flows/` (create, read back, update, list, delete, see it gone) with the created id flowing between the steps and the login first, plus a suite file; the result names the environment variables to set. |
| `api_coverage` | Which operations and documented response codes of an OpenAPI document the workspace's runs (default: the latest) and optionally its history exercised, which were never called, and codes or paths the document doesn't describe. |
| `generate_dataset` | Rows of test data into `datasets/` from a JSON schema or an API definition operation's request body. |
| `api_fuzz` | Fuzz an API from its OpenAPI document (local hosts only, DELETE left out unless asked): server errors, invalid input accepted, undocumented statuses. |
| `openapi_outline` | An OpenAPI document's operations by tag, with parameters, request body, responses (schemas as short type outlines) and the request an import would make; narrow it with `tag` or `operationId`. |
| `openapi_lint` | Lint problems of an OpenAPI document (or every document in `specs/`), each with its rule, level, line and column. |
| `import_definition` | Import an OpenAPI document, Postman (v1, v2, v3) / Insomnia / Bruno / Hoppscotch / Thunder Client / Yaak / HTTPie / Apidog collection, GraphQL schema, HAR or .env, from a public link (`url`: a file, or a GitHub / GitLab repository or folder) or `text` or `files`. A source imported before updates the collection it made (`update: false` adds a copy; `decisions` overrides single items; `lift_tests: true` lifts simple tests into assertions). OpenAPI imports get contract checks; a document of a name `specs/` already holds is kept beside it. `notes` lists what did not map one to one (unsupported auth, template tags, values needed); `report` is the compatibility report and `importId` takes the import back or reads the report again. |
| `import_preview` | Read-only: what importing would create (collections with their tree, environments, API definitions, flows, name clashes, secret values) and the compatibility report, for text, a link, a `postman:collection/<id>` reference (with `postman_api_key`) or `files` (a folder's files, several files). Nothing is written. |
| `export_collection` | A collection as a file other tools import, returned as text and never written: `postman`, `insomnia` (v5 YAML), `insomnia-v4`, `opencollection-file`, `opencollection` / `bruno` (the files of a folder), `http`, `openapi`. `notes` lists what the format cannot hold. |
| `convert_script_code`, `convert_scripts`, `lift_tests` | Another tool's script API (`postman`, `insomnia`, `bruno`, `thunder`, `hoppscotch`) to `tp.*`: one script (read-only), or the scripts of a collection (saved unless `dry_run`); simple tests of a script as assertions (read-only). Findings name the calls with no equivalent. |
| `get_import_report` | The compatibility report of an import (`importId`), or the list of the last imports. |
| `undo_definition_import` | Take back an `import_definition`: its collections, environments and API definitions go to Recently deleted (`restore_item` brings them back), its flow files are removed. Refused while an imported collection was edited, unless `force`. |
| `export_bundle`, `describe_bundle`, `import_bundle_preview`, `import_bundle_apply`, `undo_import` | Move work between workspaces as a [TestPion bundle](/getting-started/export-import). `export_bundle` writes items (`items`: `kind:id` or refs, `folder:<collection>/<folder>` and `request:<collection>/<request>` for a part of a collection; or a `section`; or a `folder` of a list; or `all`; `uses: true` adds what they use and `exclude` leaves some of those out; `globals` carries the workspace variables; `package: "postman"` or `"bruno"` writes one collection as a zip for that tool instead) as a **new** file under `.local/exports/` (or `exports/`; asks for consent; never over a file, never anywhere else) in the workspace, with secrets replaced by `{{variables}}`; `describe_bundle` reads one without importing. `import_bundle_preview` is read-only and returns each item as `create`, `identical`, `conflict` or `invalid` with a `plan_id`; `import_bundle_apply` (needs the `plan_id`; `on_conflict` keep-both, replace or skip; `globals` merge, replace or skip for the workspace variables it carries; `into` adds its collection under a collection or folder; asks for consent) is the only write, and `undo_import` takes it back as one step. Nothing in a bundle runs. |
| `import_arazzo` | Import an [Arazzo 1.0](/test-runner/integration-testing#arazzo-workflows-import-and-export) document (`text`, a workspace `file` or a `url`) as flow files under `tests/arazzo/`, one per workflow; its OpenAPI sources are found in the workspace (`fetch_sources: true` downloads http(s) ones). Returns the files and `notes` (what did not come over); `dry_run: true` writes nothing. |
| `export_arazzo` | A flow file as an Arazzo 1.0 document (`text` as YAML, `document`, `notes`), matched against an OpenAPI `spec` (default: the sources an import noted, else the best-matching spec in `specs/`). |
| `item_info` | One item's context, as the app's Info panel shows it: the file that holds it, the `{{variables}}` it uses and the latest runs that included it. Takes a ref like `resolve_ref`. |
| `debugger_save_to_collection` | Captured traffic (`ids`, `since`) or a HAR file (`har`) as saved requests: a new collection (`name`) or added to one (`collection`), a folder per host, path or none (`group`); origins become collection variables, secrets variables listed in `secrets` (never saved). |
| `flow_from_exchanges` | A flow file from recorded traffic: exchanges `debugger_capture` captured (`ids`, or `since` a time) or a HAR file (`har`); values that flow between requests become extracts and `{{variables}}`, noise is left out, secrets become variables listed in `secrets`. Writes `tests/recorded/<name>.yaml` unless `dry_run` ([Record a flow](/test-runner/integration-testing#record-a-flow)). |
| `testpion_guide` | How to use the workspace: which tool for which job, how variables resolve, every check type this engine knows (with examples) and the YAML test file format. Agents read it before writing tests. |
| `set_request_checks` | Add (`mode: append`) or replace the checks of a saved REST or GraphQL request; they then run whenever it is sent, in `run_collection` and in CI. Unknown check types are refused with the list of known ones. |
| `write_test_file` | Write a YAML or JSON test file under `tests/`. The content is checked first (it must parse as tests or a suite and use known check types), so a broken file never lands in the workspace; an existing file is replaced only with `overwrite: true`. |

`save_request`, `import_definition`, `convert_scripts`, `undo_definition_import`, `import_arazzo`, `export_bundle`, `import_bundle_apply`, `undo_import`, `rename_variable`, `reorder_environments`, `set_request_checks` and `write_test_file` change workspace files, `load_test` generates load, and `--read-only` hides them together with the tools that send requests.

Results that name an item carry a `ref`, the same object as in the app and in CLI `--json` output: `{ "kind": "run", "runId": "run-8f2c1a" }`, `{ "kind": "request", "collectionId": …, "requestId": … }`, `{ "kind": "history", "historyId": … }` … (`run_tests`, `recent_failures`, `what_needs_attention`, `git_status`, `git_changes`, `git_diff`, `debugger_exchanges`). Hand one to `resolve_ref`, or to `testpion open <ref>` to bring the app to it; the kinds are listed in [Finding your way around](/getting-started/finding-your-way#for-ai-agents-ref).

Every tool has a **title** and **annotations** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), so agents can run the read-only ones without asking and ask before the ones that send requests or change files. Results come as JSON text and as **structured content** (a list is wrapped as `{ "items": [...] }`).

## Your flows as tools

A test file or suite can be a tool of its own, the way Postman deploys a flow as an MCP server: add an `expose:` block and the server registers a tool under that name. Its `inputs` are variables the flow reads as `{{name}}`; each becomes an argument of the tool, with its description and default (an input without a default is required). In the app, a file's menu in the Tests view has **Expose as MCP tool…** (a dialog that writes the block; *Stop exposing* removes it), and Settings ▸ AI agents (MCP) lists the exposed flows.

```yaml
name: Order round trip
expose:
  tool: order_flow
  description: Create an order for a customer and check it can be fetched back.
  inputs:
    - { name: customerId, description: The customer to order for }
    - { name: qty, description: How many, default: "1" }
defaults:
  # the values the inputs have when the file runs on its own; the tool's arguments replace them
  vars: { customerId: "42", qty: "1" }
tests:
  - id: create
    name: Create the order
    method: POST
    url: "{{baseUrl}}/orders"
    json: { customer: "{{customerId}}", quantity: "{{qty}}" }
    extract: { orderId: $.id }
    assertions: [{ type: status, expected: 201 }]
  - name: Read it back
    dependsOn: create
    url: "{{baseUrl}}/orders/{{orderId}}"
    assertions: [{ type: equals, path: $.customer, expected: "{{customerId}}" }]
```

An agent then calls `order_flow` with `{ "customerId": "42", "environment": "Staging" }` (`environment` is added to every flow tool; a suite's own `environment` is the default). The flow runs like `testpion test` with the arguments as runtime variables, the run is recorded in the workspace history, and the result is:

```json
{
  "runId": "run-…", "tool": "order_flow", "file": "flows/order.yaml", "environment": "Staging",
  "passed": 2, "failed": 0, "errors": 0, "skipped": 0, "durationMs": 412,
  "steps": [
    { "name": "Create the order", "status": "passed", "durationMs": 230 },
    { "name": "Read it back", "status": "passed", "durationMs": 180 }
  ],
  "extracted": { "orderId": "o-1001" }
}
```

A step that failed or errored lists its `error` or `failedChecks`, and the result is marked `isError` so the agent treats it as a failure. Values the flow extracted come back in `extracted` (a sensitive name such as `token` is masked). `list_flows` lists the exposed flows and `testpion flows --json` prints them in a terminal; a flow added or changed while an agent is connected appears after it reconnects, since the tools are read when the server starts. `--read-only` hides them with the other tools that send requests.

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

## agent-info

`testpion agent-info` prints, as one JSON object, what an agent needs to use TestPion on this machine: the workspace it would get, the commands with their exit codes and output modes, the environment variables, the MCP server command and profiles, and where the docs for agents are. An agent reads it instead of guessing from `--help`.

## AGENTS.md

Coding agents (Claude Code, Codex, Cursor, Copilot) read `AGENTS.md` first when they open a folder. **Write AGENTS.md** (**Update AGENTS.md** once there is one) in **Settings ▸ AI agents (MCP)**, `testpion agents init -w <workspace>`, or the `agents_init` tool writes it into the workspace root from the live workspace:

- what the folders hold, the collections (with their request counts), the environments **by name only** (which are production), the test files, suites and flows exposed as tools, saved evaluations, datasets and API definitions;
- the CLI commands to run tests, suites, collections, flows and evaluations, with the exit codes (the same list `testpion agent-info` prints);
- the MCP server command and client config, how to add a request, a test and a flow, the secrets rules (never commit or write a secret: secret values live in the app's secret store or `TESTPION_SECRET_<NAME>`) and the production rules (`--allow-production`);
- the check types and the test file format.

Tick **Also CLAUDE.md** (a one-line pointer: `See @AGENTS.md …`) and **Also a Cursor rule** (`.cursor/rules/testpion.mdc`) for those agents; `--targets agents,claude,cursor` on the command line. Only the part between `<!-- testpion:begin -->` and `<!-- testpion:end -->` is TestPion's: what you wrote around it stays, and writing it again refreshes only that part (the result says per file: created, updated, unchanged or skipped and why). A file with broken markers is left alone unless `--force` (the tool: `force` with `confirm: true`); `--dry-run` (the tool: `dryRun`) reports what would be written and writes nothing. No variable value and no path of your machine is written, so the files can be committed with the workspace.

## What agents can and can't see

- Output uses the workspace's redaction rules. Sensitive headers, JSON fields and known secret values are masked, and environment values are never listed.
- Secrets resolve inside TestPion when a request is sent. The agent sees `{{accessToken}}`, never the token. In the CLI, secrets come from `TESTPION_SECRET_*` environment variables (see [Secrets](/security/secrets)).
- An agent's import never overwrites: `import_definition` keeps an API definition beside a different one of the same name (`specs/x-2.yaml`, said in `notes`), as the app and `testpion import` do. Deleting an MCP server in the app happens at once with **Undo** and goes to **Recently deleted**; the agent tools that delete keep asking to confirm (above).
- Requests go only where your collections and environments point. Production environments need `--allow-production` on the server, and a data-changing request to one also needs `allowProduction: true` on the call; `--read-only` removes sending altogether.

## llms.txt

The documentation site publishes [`/llms.txt`](https://nasimuddin-dev.github.io/testpion/llms.txt), a short, link-rich summary of TestPion for language models. Give it to an assistant that should learn how TestPion works.

:::
