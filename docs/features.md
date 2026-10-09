---
title: Features
description: Everything TestPion does — REST, GraphQL, gRPC, WebSocket, MQTT and MCP testing, an AI Lab with model comparison, evaluations for LLMs, RAG and agents, a scalable test runner, load testing and traces.
---

# Features

TestPion combines an API client, a GraphQL playground, an MCP inspector, an LLM playground, an evaluation lab, a test runner, a load tester and a trace viewer. They all share one execution engine, which the [`testpion` CLI](/cli/reference) also uses.

## REST and HTTP

<figure class="aps-screenshot">
  <img src="/images/rest.jpg" alt="The REST view with a collection tree, a request, and its JSON response" width="1440" height="900" loading="lazy">
</figure>

- Any method, params, headers and cookies; JSON, XML, text, HTML, form, multipart and binary bodies.
- A per-workspace cookie jar, like Postman's: cookies from responses (including redirects) are sent with later requests and managed in a Cookies dialog. The jar is encrypted on your machine and never written to workspace files.
- API key, Basic, Bearer, JWT, OAuth 1.0, OAuth 2.0 (client credentials, password, authorization code with PKCE), AWS Signature v4, Digest, custom headers and mTLS, inherited from folders and collections.
- Responses as a virtualised JSON tree, raw text with search, or an HTML preview, plus headers, cookies and a timing breakdown. Large bodies stream to disk.
- Save responses as examples of a request (success and error cases), with secrets masked. Postman saved responses import as examples.
- Mock servers on localhost serve a collection's examples, from the app or with `testpion mock`, with fresh fake data from dynamic variables and optional forwarding of everything else to the real API (partial mocking). An imported OpenAPI document can be mocked straight away.
- Postman compatibility: collections (v2.0 and v2.1) and environments import with their scripts. Scripts written for Postman (`pm.*`) also run unchanged; `tp.*`, lodash, moment, tv4, `xml2Json` and ~75 dynamic variables work in scripts; `testpion run-collection` takes Newman's command-line options.
- OpenAPI in both directions: import (with contract checks and response examples), generate a document from a collection, find breaking changes between two versions (`testpion openapi-diff`, also as a pull-request check in generated CI pipelines), lint a document for broken references, undeclared parameters and examples that don't match their schema (`testpion openapi-lint`, the definition's Lint tab), and measure API coverage: which operations and documented responses the tests exercised (`testpion coverage --min 80`, the API coverage dialog, the `api_coverage` MCP tool).
- Security review of a collection (typed-in secrets, secrets in URLs, plain http) and a security-headers check for responses.
- Find where a variable is used and rename it everywhere, with secret values moved along.
- Markdown docs for every request and a generated documentation page per collection, exportable as Markdown or as a self-contained HTML page to publish (also `testpion docs --html`).
- Record traffic through a local reverse proxy and save it as a collection with examples.
- Pre-request and test scripts in a sandbox (with top-level `await`, `tp.require` script packages, `tp.vault`, cheerio, lodash and moment), assertions, highlighted variables, one-click cURL export, code snippets for 19 languages and libraries (cURL, HTTPie, PowerShell, fetch, Axios, Python requests and httpx, Go, Java OkHttp and HttpClient, Kotlin, C#, PHP, Ruby, Rust, Swift, Dart, raw HTTP), a response Visualizer (`tp.visualizer`), paste-to-request (cURL, fetch and PowerShell from browser devtools, and HTTPie or xh commands), and a console with every request and its script output.
- **Back and Forward** in the top bar (Alt+← / Alt+→, mouse buttons) return to the views and items you had open, with a list of recent places.
- The **Collections sidebar** (Collections on the rail, or Ctrl+B) is the one sidebar of the request editors, titled with the workspace name. It lists the workspace's collections; expanding one shows what it holds by category: **REST**, **SOAP**, **GraphQL**, **gRPC** and **WebSocket & MQTT**, each with its count, its folders and a **+** that creates that kind of request in the collection. SOAP requests are recognised by their XML envelope or SOAPAction header. Every saved request is in a collection, gRPC calls and WebSocket / Socket.IO / MQTT / Kafka connections too: saving a new one asks for its collection (or a new one) and folder, the same dialog as a REST request's, and their menu (or a drag onto another collection) moves them. Deleting a collection takes its gRPC calls and connections with it to Recently deleted, and restoring it brings them back. Unsaved tabs of every kind still send and connect without saving. Below the collections come the workspace-wide **MCP servers** (with their connection status) and **API definitions**. Every item opens in its own tab, like a request: an MCP server with its transport and command or URL, Connect, Save and a Settings tab; an API definition with its document (editable, with lint markers as you type), a **Preview** that reads like its docs and **Generate tests** writes a first suite from (operations by tag with parameters, request body and responses, schemas as short type outlines, and **Open as request**), its **Lint** problems, **Fuzz** (each operation sent invalid input one rule at a time: server errors, invalid input accepted, undocumented statuses; `testpion fuzz`), its **Coverage** and **Compare versions**. `testpion openapi-ops <spec>` lists the operations in a terminal and agents get them from `openapi_outline`. Ctrl+S saves the tab on screen, whatever it holds. One filter searches everything, and clicking an item opens it in its editor.
  - The header has **New**, **Import**, **Export** (a collection in TestPion, Postman, OpenAPI or Bruno format, or the whole workspace), **Refresh** and **Hide**; drag its right edge to resize it. **Collapse all** sits beside the filter.
  - Every row has a menu (right-click or **⋯**): a collection's has *Run*, *Monitor*, *New … request*, *Rename*, *Duplicate* (with its gRPC calls and connections), *Delete* and its settings; category rows, requests, folders, gRPC calls, connections, MCP servers and API definitions have theirs. Renaming happens in place: **F2** on the focused item (or *Rename* in its menu, or a double-click on a tab) turns its name into a text field; **Enter** or clicking away saves, **Esc** cancels. This works for collections, folders, requests, gRPC calls, connections, MCP servers, environments, tabs, the sidebar lists (monitors, load tests, saved prompts …) and saved examples. In every tree and list, ↑ ↓ move, **Home** / **End** jump to the first and last row, → opens and ← closes a folder. **Delete** deletes the focused request or folder; requests, folders, gRPC calls and connections can be dragged to another place or collection.
  - Running a collection runs everything it holds, its gRPC calls and connections included, and exporting it in TestPion's format shares them too.
  - Above every editor, a breadcrumb (*Collection › Folder › Request*) shows where the open item is saved.
- The same sidebar in every view: saved items with folders (collections, saved gRPC requests, WebSocket connections, MCP servers, AI prompts, test files, evaluations, load tests and monitors), **Environments** to switch or edit the active environment, and **History** or **Runs** for that view.
- Star frequently used REST or GraphQL requests from their **⋯** menu, then use the star button beside the collection filter to focus the REST sidebar on favorites. Favorites are saved in the collection file and retain their folder context.

[REST guide](/api-testing/rest) · [Authentication](/api-testing/authentication) · [Collections & import](/api-testing/collections)

## GraphQL

<figure class="aps-screenshot">
  <img src="/images/graphql.jpg" alt="The GraphQL view with the schema explorer, a query in the editor and the response" width="1440" height="900" loading="lazy">
</figure>

Introspect a schema to get autocomplete, validation and hover docs in the editor, plus a browsable schema explorer. Run operations with variables, scripts and assertions on data, GraphQL errors and latency, and run subscriptions over WebSocket (`graphql-transport-ws` and `graphql-ws`) with events listed live. **Build** writes a whole operation for a root field (typed variables, a selection of fields), and **Code** shows the call as cURL, fetch, Python and more.

[GraphQL guide](/graphql/overview)

## gRPC

- Calls services described by `.proto` files; imports and Google's well-known types resolve.
- Unary, server-streaming, client-streaming and bidirectional methods, with example messages.
- Metadata, TLS (`grpcs://`) and deadlines.
- Streamed responses appear live; **Stop** keeps what arrived.

See [gRPC](./api-testing/grpc.md).

## WebSocket, Socket.IO, MQTT and Kafka

- WebSocket with subprotocols and handshake headers; Socket.IO events with acknowledgements.
- MQTT 3.1.1 and 5 brokers (mqtt://, mqtts://, ws://, wss://): subscriptions with wildcards and QoS, publish with QoS and retain.
- Kafka clusters (kafka://, kafkas://, SASL PLAIN / SCRAM): read topics from the beginning or new messages in a consumer group of its own, produce with key and headers, list topics.
- A live message log with a filter and JSON tree, saved connections in folders, and saved messages to send again.
- `type: websocket`, `socketio`, `mqtt` and `kafka` tests, `testpion ws`, `testpion mqtt` and `testpion kafka`, and the `realtime_exchange` MCP tool.

See [WebSocket](./api-testing/websocket.md).

## MCP inspector

<figure class="aps-screenshot">
  <img src="/images/mcp-trace.jpg" alt="The MCP protocol trace listing initialize, tools/list and tools/call messages with latencies" width="1440" height="900" loading="lazy">
</figure>

- stdio, Streamable HTTP and SSE transports.
- Tools, resources, resource templates and prompts, with input forms generated from JSON Schema, the server's suggestions (completions) for arguments, and resource subscriptions.
- Elicitation, sampling and roots: answer a server that asks for input (a form from its schema) or for an LLM completion (reviewed before anything is sent), in the inspector and in tests.
- A protocol trace of every JSON-RPC message, with direction, payloads and latency.
- **Save as test** turns a tool call into a regression test.
- A mock server's **Tools** tab designs a toolset (name, description, input schema, canned or scripted answers per tool), tries it in place, and shows the commands that serve it to an agent before the real server exists; **Generate with AI** drafts it from a sentence. See [MCP mock server](./mcp/mocking.md#design-a-toolset).
- The other direction too: `testpion mcp-server` serves your workspace to AI agents as MCP tools (browse collections, send requests, run collections), with secrets redacted.
- **Your flows as tools**: a test file or suite with an `expose:` block (Tests ▸ file menu ▸ *Expose as MCP tool…*) is a tool of its own on that server: an agent calls it by name with the inputs as arguments and gets each step's result and the values the flow extracted. `testpion flows` and Settings ▸ AI agents list them.

[MCP guide](/mcp/overview) · [Use from AI agents](/ai-testing/mcp-server)

## AI Lab and model comparison

<figure class="aps-screenshot">
  <img src="/images/ai-lab.jpg" alt="The AI Lab playground with a streaming response and metrics" width="1440" height="900" loading="lazy">
</figure>

Prompt templates with variables, JSON mode and JSON Schema outputs, and streaming with time to first token. Token counts and estimated cost from a price table you control. Compare models side by side without a one-size-fits-all ranking (the fastest and the cheapest are marked). Providers include OpenAI-compatible, Azure OpenAI, Anthropic, Gemini, Amazon Bedrock, Ollama and an offline mock; a provider without its key says so before anything is sent, with **Add the key** one click away. An answer worth keeping becomes an evaluation case with **Add to dataset**.

[AI testing guide](/ai-testing/overview)

## Evaluations

<figure class="aps-screenshot">
  <img src="/images/evaluations.jpg" alt="The Evaluations view with a JSONL dataset and a completed run" width="1440" height="900" loading="lazy">
</figure>

Stream JSONL, CSV, JSON or Markdown datasets through evaluators. **Deterministic** evaluators cover exact match, JSON Schema, regex and thresholds. **Heuristic and semantic** evaluators cover similarity and RAG metrics; with a judge, the RAG checks work **claim by claim** (faithfulness, context precision and recall, answer correctness), each verdict with its evidence. **LLM-as-judge** scores are clearly labelled and reproducible. Also included: agent tool-use checks, safety checks (prompt injection, data leakage, tool misuse), baselines for regression tracking, and **human review**: 👍 / 👎 and a note on any result, kept beside the run and read by agents.

[Evaluations](/ai-testing/evaluations) · [RAG](/ai-testing/rag) · [Agents](/ai-testing/agents) · [Safety](/ai-testing/safety)

## Test runner and CI

<figure class="aps-screenshot">
  <img src="/images/tests.jpg" alt="The Tests view with test files, a completed run and the checks of an agent test" width="1440" height="900" loading="lazy">
</figure>

YAML tests in your repository, with parallel workers, backpressure, retries, timeouts, dependencies, setup and teardown, and runs you can cancel and resume. **Datasets** (CSV, JSONL, JSON, Markdown tables, SQLite) drive tests and collection runs: a sidebar section lists them with their row counts, and each opens in a tab with a preview table (column types), the file in the editor, **Run a collection with this dataset** and **Use in a test**; `testpion datasets show` and the `read_dataset` MCP tool read the same rows. An API definition or a collection generates a first suite — a test per operation, or an **integration suite** with a flow per resource (create, read, update, list, delete). Every run writes JUnit, JSON, HTML and Markdown reports. The CLI returns CI-friendly exit codes. A test file's preview shows each test's latest result; a result's **History** shows the test across runs, and the runs overview lists the flaky tests of the workspace and, for evaluations, each evaluator's score by run.

A test file's **Flow** tab draws its steps as a diagram (an arrow per `dependsOn`, the names each step extracts, the latest result on every node); `testpion flow <file> --json|--dot` and the `flow_graph` MCP tool give the same graph.

The **flow designer** builds a flow on that canvas: add steps (blank, from a collection's requests, or generated with AI), connect them by dragging port to port, edit each step in an inspector (request, extracts, checks, what it waits for), see which variables flow along each connection, run the flow or one step and watch the steps light up, with undo and redo; every change is written to the YAML (comments and line endings kept). `testpion flow edit <file> --op '<json>'` and the `flow_add_step`, `flow_connect`, `flow_disconnect`, `flow_update_step` and `flow_remove_step` MCP tools make the same edits. [Design a flow](/test-runner/integration-testing#design-a-flow)

**Arazzo 1.0** (the OpenAPI Initiative's workflow format) comes in and goes out: importing an Arazzo document writes one flow file per workflow (operations from its OpenAPI documents, runtime expressions as variables with the extracts that set them, success criteria as checks, retries; what does not fit stays as a comment and in the summary), and **Export as Arazzo…** in the Tests tree (`testpion flow export <file> --arazzo`, the `import_arazzo` / `export_arazzo` MCP tools) writes a flow back as a workflow. [Arazzo workflows](/test-runner/integration-testing#arazzo-workflows-import-and-export)

In git, flow files are compared by meaning like collections: steps added, removed, renamed or changed with the parts (request line, headers, body, extract, checks, if, forEach), connections added or removed, and "rearranged" when only the layout moved; in the Git view, pull-request descriptions and `testpion diff --json`. [Flows, step by step](/getting-started/git#flows-step-by-step)

[Test runner](/test-runner/overview) · [CI/CD](/test-runner/ci-cd)

## Load testing

<figure class="aps-screenshot">
  <img src="/images/load.jpg" alt="The Load view with live throughput, latency, error and virtual-user charts" width="1440" height="900" loading="lazy">
</figure>

Load-test one endpoint, a gRPC method or a whole collection (every virtual user runs its requests in order, with per-user cookies and an optional warm-up run for tokens). Configure virtual users, ramp-up and ramp-down, and an RPS cap. See p50–p99 latency, error rate and status distribution, per request for collections, plus AI metrics (tokens/s, TTFT, cost) for LLM targets. Pass/fail thresholds (`p95<500`, `errors<1%`, `p99[Get pet]<800`) fail a CI job on a slow build. Safeguards block production and remote hosts unless you opt in.

[Load testing](/performance/load-testing)

## HTTP Debugger

<figure class="aps-screenshot">
  <img src="/images/debugger.jpg" alt="The HTTP Debugger: a tool rail, a grid of captured requests with application, domain and IP address, a 404 with its request and response side by side, and the Summary panel" width="1440" height="900" loading="lazy">
</figure>

See the traffic of other programs (a browser, an app under test, a service, an agent) through TestPion's local proxy: a grid with the program, status, type, size, speed, domain and server address of every request; the request and response side by side; HTTPS decryption, HTTP/2, gRPC, WebSocket frames and Server-Sent Events. Rules filter, capture only, highlight, modify, auto-reply, redirect or pause the traffic; panels show its timeline, summary, structure and performance; sessions save as HAR. Requests your programs send to TestPion's mock servers are listed too. `testpion debug` and the `debugger_*` MCP tools do the same from a terminal or an agent.

[HTTP Debugger](/api-testing/http-debugger)

## Traces

<figure class="aps-screenshot">
  <img src="/images/traces.jpg" alt="A trace waterfall with nested spans and span attributes" width="1440" height="900" loading="lazy">
</figure>

Every request, GraphQL operation, MCP call, LLM call, tool call and evaluation becomes a span in an OpenTelemetry-shaped trace, shown as a waterfall with inputs, outputs and attributes. Traces can be sent to Jaeger, Grafana Tempo, Honeycomb or any OpenTelemetry collector (OTLP), from the app or during CLI runs (`--otlp`, or the standard `OTEL_EXPORTER_OTLP_*` variables). See [traces](./test-runner/traces.md).

## Workspace and productivity

<figure class="aps-screenshot">
  <img src="/images/home.jpg" alt="The Home view with a greeting, the active environment, colour-coded quick actions, and cards for recent requests, collections and environments" width="1440" height="900" loading="lazy">
</figure>

A Home view with quick actions, a **Needs attention** card (failing monitors, certificates that expire within 30 days, the latest failed run, saved requests whose latest response failed and flaky tests; also `testpion attention` and the `what_needs_attention` MCP tool), an activity dashboard (requests sent and failed, median response time and tests passed per day over 7, 14 or 30 days, requests by type and the slowest requests; **Share report** saves it with each collection's health, the monitors with their uptime by day and the latest runs as one HTML file), recent work, collections, environments with variable precedence and a quick look, secret variables, searchable history grouped by day (with a bar of 2xx, 3xx, 4xx, 5xx and errors), global search, a command palette (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd>), an AI assistant that turns plain words into requests, writes tp tests, explains errors, slow requests and flaky tests (always labelled as AI-generated), and dark and light themes. Import from OpenAPI, Postman, Insomnia, Bruno (collection folders too), Hoppscotch, WSDL (SOAP services), AsyncAPI (Kafka, MQTT and WebSocket channels), `.http` files (REST Client, JetBrains HTTP Client) or HAR, and export collections and environments to Postman v2.1 (and collections to `.http`, OpenAPI and Bruno).

<figure class="aps-screenshot">
  <img src="/images/home-activity.jpg" alt="The Home activity dashboard: requests sent, success rate, median response and tests passed, with daily charts, requests by type and the slowest requests" width="1440" height="900" loading="lazy">
</figure>
