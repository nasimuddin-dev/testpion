---
title: "CLI reference"
description: "Reference for the testpion command-line interface."
---

::: v-pre

# CLI reference

```text
testpion test [paths...]      Run test files, directories, globs or a *.suite.yaml
testpion run --suite <name>   Run tests/<name>.suite.yaml from a workspace
testpion send <request|url>   Send one saved request (scripts, auth, checks) or a URL and print the response, like curl
testpion run-collection <collection>   Run a collection like Postman's Collection Runner / Newman
testpion mock-graphql --schema <file>   Fake data for any query against a GraphQL schema (see GraphQL mock server)
testpion mock <collection>    Serve a collection's saved examples on localhost
testpion graphql-subscribe <endpoint> -q <doc>   Run a GraphQL subscription and print the events
testpion graphql-op <Type.field> --endpoint <url> Build a ready-to-run operation for a root field (or --schema <file>)
testpion lint <collection>    Security review of a collection's requests (--fail-on high for CI)
testpion fuzz <spec>           Fuzz an API from its OpenAPI document: server errors, invalid input accepted (local hosts only)
testpion vars move <c> --to <envs> Move collection variables into environments (each can set its own value)
testpion tidy <collection>     Duplicate requests, typed-in hosts, empty folders, unused variables (--remove-* fixes)
testpion replace <c> <find> <with> Find and replace across a collection's requests (preview; --apply saves)
testpion agent-info               What an AI agent needs to use TestPion here, as JSON (workspace, commands, exit codes, MCP setup)
testpion tests-from-spec <spec> Write a first test suite from an API definition (examples and invalid requests)
testpion integration-suite <spec|collection> Write an integration suite: a flow per resource (create, read, update, list, delete), the login first
testpion generate-data <name>  Generate rows of test data into datasets/ from a JSON schema or an API operation
testpion export <c> -f http    Write a collection as an .http file (REST Client, JetBrains HTTP Client)
testpion export <c> -f asyncapi Write a collection's connections as an AsyncAPI 3.0 document
testpion openapi-ops <spec>    List an OpenAPI document's operations by tag (--json: schemas and a request per operation)
testpion secrets <environment> Check an environment's secret manager references (op://, vault://, aws-sm:// …)
testpion record <target>      Record traffic through a local reverse proxy; -w saves it as a collection (see Record traffic)
testpion debug [-p port] [-o session.har] [--rules debugger/rules.json] [--decrypt] [-w workspace] [--json]   The HTTP Debugger's proxy: other programs' traffic (HTTP_PROXY=…), printed as it happens (program, process id, server); rules applied
testpion mock-mcp <file>      Serve an MCP mock (stdio, or --http) for AI agents and MCP clients
testpion env set|unset|get <env> -w   Set or remove plain variables of an environment (secrets stay in the app)
testpion vars usages|rename -w   Where a variable is used; rename it everywhere
testpion openapi-diff <old> <new>   List breaking changes between two OpenAPI versions (--fail-on-breaking for CI)
testpion openapi-lint [specs...]     Lint OpenAPI documents: broken $refs, undeclared path parameters, duplicate operationIds …
testpion eval list|run <name>   Evaluations saved in the app: list them, or run one by name (exit 1 on failures)
testpion coverage <spec> -w   API coverage: which OpenAPI operations and responses the runs exercised (--min for CI)
testpion docs <collection>    Write Markdown (or --html) documentation for a collection
testpion export <collection>  Export a collection as Postman v2.1 (or TestPion JSON)
testpion export-environment <name>   Export an environment in Postman's format
testpion mcp-server           Serve a workspace to AI agents over MCP (stdio)
testpion load <url>           Safeguarded load test (--threshold "p95<500" "errors<1%" to pass/fail; --grpc <method> for a gRPC server)
testpion import <file|-> -w   Import OpenAPI/Swagger, Postman, Insomnia, Bruno (a collection folder too), WSDL (SOAP), HAR, collections, or a copied cURL / fetch / PowerShell request
testpion env list|order|diff -w  List environments; set their order; compare two
testpion monitor list|add|remove|run|results|uptime|start -w  Collections on a schedule (monitors)
testpion ci <github|gitlab|azure|jenkins> -w  A CI pipeline file for a suite, collection or tests (--start, --wait-for: start the system under test first)
testpion lint-tests [paths] -w   Check test files before running them: unknown types, check types, misspelt keys, dependsOn ids (--json; exit 1 on errors)
testpion flow <file> -w       A test file as a flow: the steps in columns with the latest run's results (--json for steps, edges, layers and problems; --dot for Graphviz)
testpion flows -w             The flows exposed as MCP tools (test files and suites with an expose: block): tool, file, inputs (--json)
testpion wait-for <url>       Wait until a URL answers (the health check before integration tests); exit 3 when it never does
testpion trash list|restore|empty -w  Recently deleted collections and environments (30 days)
testpion history list|stats|diff|test|export-har -w  Response history of saved requests; response times; compare two responses; a test across runs; HAR export
testpion workspace list|create|rename|delete|export   Manage workspaces (see Workspaces)
testpion git setup|check|hook install -w   Make a workspace git-ready; find secrets before a commit; a pre-commit hook
testpion git status|changes|diff|commit|log|branch|switch|pull|push|sync|resolve -w   Git for the workspace (sync: pull & push in one step) (see Keep your workspace in git)
testpion diff <from> [to] -w  What changed between two commits, by meaning (--markdown for a pull-request comment)
testpion mcp [--url|--sse|--server <name> -w] [--call <tool> --args <json>] [--json]   Inspect an MCP server (a saved one with --server), or call one of its tools
testpion ws <url> [-m msg] [-e event=json]    Talk to a WebSocket or Socket.IO server and print the replies
testpion mqtt <url> [-s topic] [-p topic=msg] Subscribe and publish on an MQTT broker and print what arrives
testpion kafka <brokers> [-r topic] [-p topic=value] Read and produce Kafka topics and print what arrives
testpion grpc <target> [method] [-p protos]   Call a gRPC method, or list the methods (.proto files or server reflection)
testpion report <results.jsonl>              Re-generate reports
```

## `test` / `run` options

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: nearest `workspace.json`). |
| `-e, --environment` | Environment name. |
| `-c, --concurrency` | Parallel workers. |
| `--retries`, `--timeout` | Retries per failing test; per-test timeout in ms. |
| `-r, --reporter` | `console junit json html markdown` |
| `-o, --out` | Output directory (default `runs/<runId>` in the workspace, or `./testpion-results/<runId>` outside one). |
| `-t, --tags`, `-g, --grep` | Filter tests. |
| `--bail` | Stop after the first failure. |
| `--resume <runId>` | Continue an interrupted run. |
| `--var k=v` | Runtime variable (repeatable). |
| `--baseline`, `--save-baseline`, `--fail-on-regression` | Regression testing. |
| `--trace all\|failures\|none` | Trace persistence. |
| `--log-level` | Enable debug logging; secrets stay redacted. |
| `--watch` | Run again whenever a test, collection, environment or data file in the workspace (or the given paths) changes, until Ctrl+C. Results and reports the run writes don't count as changes. |
| `--rerun-failed [runId]` | Run only the tests that failed or errored in a run (default: the last one). In the app: **Re-run failed** on a finished run. |
| `--otlp <url>`, `--otlp-header k:v` | Send the run's traces to an OpenTelemetry collector (OTLP/HTTP); without `--otlp`, `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` are used. See [traces](/test-runner/traces). Also for `run-collection`. |

## `send`

Sends one request and prints the response body (pretty-printed JSON), like `curl`. The request is a saved one, by name, with its scripts, auth (inherited too), variables and checks, or a URL:

```bash
testpion send "Veterinary API/Authentication/Get access token" -e Development -i
testpion send "Get patient" -e Development --fail          # a unique name is enough
testpion send "{{baseUrl}}/patients?limit=2" -e Development --json
testpion send https://api.example.com/items -X POST -H "Content-Type: application/json" -d '{"name":"Rex"}'
```

| Option | Description |
|---|---|
| `-e, --environment` | Environment whose variables resolve (and the collection's). |
| `-X`, `-H`, `-d` | Method, headers and body, for a URL. |
| `-i, --include` | Also print the status line and response headers. |
| `--fail` | Exit `1` on an HTTP error status (400+) or a failed check. |
| `--json` | Print `{ status, statusText, url, durationMs, headers, body, checks }`. |

Check results go to stderr, so `testpion send … | jq` gets only the body.

## `collections` and `requests`

What a workspace holds, for scripts and AI agents (`--json`), the same as the `list_collections` and `list_requests` MCP tools:

```bash
testpion collections                     # each collection: requests, gRPC calls, connections
testpion doctor -w my-workspace          # Node.js, SQLite, secrets, proxy, certificates, workspace files (exit 1 on errors)
testpion storage -w my-workspace --delete-runs-older-than 30   # disk use; clean up old runs
testpion load-history -w my-workspace          # earlier load tests: req/s, p95 (and server p95), errors, pass rules
testpion variable-flow "Veterinary API"  # who sets and uses each variable; exit 1 on used-before-set / never-set
testpion attention -w my-workspace --markdown    # what needs attention (exit 1 on a high-severity item); --markdown to post it
testpion certificates --warn 21          # TLS certificates of the hosts called, soonest to expire first; exit 1 if one expires within 21 days
testpion certificates --check api.example.com:443 https://auth.example.com --warn 21   # connect and check now (trust, days left)
testpion workspace-report -o report.html # what needs attention, activity, collection health, monitors (with 30-day uptime) and runs as one HTML file to share
testpion datasets                        # data files in datasets/ (for run-collection -d); SQLite tables too
testpion requests "Veterinary API"       # its requests, then its gRPC calls and WebSocket / MQTT connections
testpion requests "Veterinary API" --json
testpion requests "Veterinary API" --health   # plus latest status, median time and failures from the app, and which have no checks
```

## `run-collection`

Runs a collection one request at a time, in order, with its `tp.*` scripts, like Postman's Collection Runner or Newman. `<collection>` is a collection name or id in the workspace, a collection file (TestPion or Postman v2.1 JSON), or an http(s) link to one (e.g. a collection published in a repository). A collection file runs in a temporary workspace, so your own workspace isn't changed.

```bash
# a collection in the workspace
testpion run-collection "Veterinary API" -e Development

# Newman-style: Postman collection + environment files, one iteration per CSV row
testpion run-collection api.postman_collection.json -e staging.postman_environment.json -d users.csv -r console junit
```

| Option | Description |
|---|---|
| `-e, --environment` | Environment name, or a Postman environment file. |
| `-d, --iteration-data` | CSV, JSON or JSONL data file, or a SQLite database: one row per iteration (`tp.iterationData`, `{{column}}`). |
| `--iteration-query` | With a SQLite database as `-d`: the read-only `SELECT` whose rows are the iterations. |
| `-n, --iteration-count` | Number of iterations (default: the number of data rows, or 1). |
| `--delay-request <ms>` | Pause between requests. |
| `--watch` | Run again whenever the collection, an environment or the data file changes, until Ctrl+C. |
| `--rerun-failed [runId]` | Run only the requests that failed in a run of this collection (default: the last run). |
| `--folder <name...>` | Only run these folders or requests, by name or id (repeatable). |
| `--bail`, `--timeout` | Stop after the first failure; per-request timeout in ms. |
| `--cookie-jar <file>` | Start with the cookies in this JSON file (TestPion format or a Newman cookie jar). |
| `--export-cookie-jar <file>` | Write the run's cookie jar to this JSON file afterwards (plain text: keep it out of git). |
| `-g, --globals <file>` | A Postman globals file. |
| `--env-var <key=value>`, `--global-var <key=value>` | Set an environment or global variable (repeatable); overrides the files. |
| `--export-environment <file>`, `--export-globals <file>` | Write the environment / globals after the run, including values scripts set, as Postman files. Secret values are left empty. |
| `-k, --insecure` | Don't verify TLS certificates (development servers only). |
| `--suppress-exit-code` | Exit `0` even when tests fail (configuration errors still exit `2`). |
| `--reporter-junit-export <file>` | Also write the JUnit report to this file. |
| `-w`, `-r`, `-o`, `--var`, `--trace`, `--baseline` … | Same as `test`. |

**Coming from Newman?** Most command lines work after replacing `newman run` with `testpion run-collection`: `-e`, `-g`, `-d`, `-n`, `--folder`, `--env-var`, `--global-var`, `--delay-request`, `--timeout-request`, `--bail`, `-k`, `--export-environment`, `--export-globals`, `--suppress-exit-code`, `--reporters` and `--reporter-junit-export` mean the same.

```bash
# newman run api.json -e staging.json -g globals.json --env-var token=$TOKEN --reporters cli,junit --reporter-junit-export out.xml
testpion run-collection api.json -e staging.json -g globals.json --env-var token=$TOKEN --reporters console junit --reporter-junit-export out.xml
```

Variables set by scripts carry over to later requests and iterations, and so do cookies (see [Cookies](/api-testing/cookies)). `tp.execution.setNextRequest()` changes the order. Outside a workspace, reports go to `./testpion-results/<runId>` unless you pass `-o`.

Exit codes: `0` success, `1` test failure, `2` configuration error, `3` execution error.

## `coverage`

Shows which operations of an OpenAPI 3 / Swagger 2 document, and which of their documented response codes, your tests and requests exercised. It reads the workspace's latest run by default. It also lists operations that were never called, observed codes the document doesn't describe, and requests to paths it doesn't have. See [API coverage](/test-runner/ci-cd#api-coverage).

```bash
testpion coverage specs/pets.yaml                        # the latest run
testpion coverage specs/pets.yaml --run run-abc --history 500 --markdown coverage.md
testpion coverage https://api.example.com/openapi.json --min 80   # exit 1 below 80%
```

| Option | Description |
|---|---|
| `--run <id...>` | Use these runs instead of the latest one. |
| `--history [n]` | Also use the last `n` request history entries (default 1000). |
| `--base-url <url>` | Only count requests under this URL. |
| `--exclude-deprecated` | Leave deprecated operations out of the totals. |
| `--min <percent>` | Exit `1` when fewer operations are covered. |
| `--markdown <file>` | Also write a Markdown report, e.g. for a pull request comment. |
| `--json` | The full report as JSON, for scripts and AI agents. |

## `openapi-diff`

Compares two versions of an OpenAPI 3 / Swagger 2 document (files or http(s) links) and lists breaking and other changes. See [Catch breaking API changes](/test-runner/ci-cd#catch-breaking-api-changes).

| Option | Description |
|---|---|
| `--fail-on-breaking` | Exit `1` when there are breaking changes. |
| `--breaking-only` | Leave out the non-breaking changes. |
| `--json` | Print `{ breaking, nonBreaking, operations }` as JSON. |

## `openapi-lint`

Lints OpenAPI 3 / Swagger 2 documents (files or http(s) links; with none given, every document in the workspace's `specs/` folder). Each problem is printed as `file:line:column`, with its level and rule. See [Lint API definitions](/test-runner/ci-cd#lint-api-definitions) for the rules.

```bash
testpion openapi-lint specs/clinic.yaml
testpion openapi-lint --fail-on warning --disable operation-tags,component-unused
```

| Option | Description |
|---|---|
| `-w, --workspace <dir>` | With no documents given: the workspace folder whose `specs/` to lint. |
| `--disable <rules>` | Rules to leave out, comma separated. |
| `--severity <level>` | Show only `error`, `warning` or `info` (the default) and worse. |
| `--fail-on <level>` | Exit `1` when a problem of this level or worse is found: `error` (the default), `warning`, `info` or `none`. |
| `--rules` | List the rules and exit. |
| `--json` | Print a list with one `{ file, problems, counts, operations }` per document as JSON (a list even for one document). |

## `mock`

Serves the [saved examples](/api-testing/collections#examples) of a collection on `127.0.0.1` until you press Ctrl+C. See [Mock servers](/api-testing/mock-servers) for how requests are matched to examples.

```bash
testpion mock "Veterinary API" -p 4545
testpion mock api.postman_collection.json      # Postman saved responses work too
```

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: nearest `workspace.json`). |
| `-p, --port <port>` | Port to listen on (default: any free port; the URL is printed). |
| `--delay <ms>` | Delay every response. |
| `-q, --quiet` | Don't log requests. |

## `mock-mcp`

Serves an [MCP mock](/mcp/mocking) (`*.mcp-mock.yaml`: tools with canned responses, resources, prompts). By default it speaks MCP over stdio, so AI agents can start it as a command; logs go to stderr.

```bash
testpion mock-mcp mocks/customer.mcp-mock.yaml
testpion mock-mcp mocks/customer.mcp-mock.yaml --http -p 3333   # Streamable HTTP on 127.0.0.1
```

| Option | Description |
|---|---|
| `--http` | Serve over Streamable HTTP on `127.0.0.1` instead of stdio (the URL is printed). |
| `-p, --port <port>` | Port for `--http` (default: any free port). |

## `graphql-op`

Builds a [ready-to-run operation](/graphql/schema-explorer#build-an-operation) for one root field: variables for its arguments (with placeholder values) and a selection of its fields. The schema comes from `--schema` (SDL or an introspection result) or by introspecting `--endpoint`.

```bash
testpion graphql-op Query.patient --endpoint http://127.0.0.1:4011/graphql -H 'Authorization: Bearer …'
testpion graphql-op Mutation.createPatient --schema schema.graphql --json
```

| Option | Description |
|---|---|
| `--schema <file>` / `--endpoint <url>` | Where the schema comes from. |
| `-H, --header <key:value...>` | Headers for introspection. |
| `-d, --depth <n>` | Levels of nested objects to select (default 2, at most 6). |
| `--required-args` | Only the required arguments. |
| `--json` | Print `{ operation, operationName, query, variables }`. |

## `ws`

Connects to a [WebSocket or Socket.IO](/api-testing/websocket) server, sends messages (WebSocket) or emits events (Socket.IO) in order, prints everything the server sends while it listens, then closes. The exit code is 3 when it can't connect (the reason is printed).

```bash
testpion ws ws://127.0.0.1:4013 -m '{"type":"ping"}' -m second
testpion ws http://127.0.0.1:4015/chat -e 'say={"text":"hi"}' --ack --json
```

| Option | Description |
|---|---|
| `-m, --message <text...>` | WebSocket messages, in order. |
| `-e, --emit <event=json...>` | Socket.IO events with their argument (a JSON list gives several arguments). Implies Socket.IO. |
| `--ack` | Socket.IO: wait for acknowledgements. |
| `--socketio` | Use Socket.IO (the default for `http(s)://` URLs). |
| `-H, --header <key:value...>` | Handshake headers. |
| `--auth <json>` | Socket.IO handshake auth payload. |
| `-w, --wait <ms>` | How long to listen after sending (default 1500). |
| `--json` | Print the result as JSON, for scripts and AI agents. |

## `mqtt`

Connects to an [MQTT broker](/api-testing/websocket#mqtt), subscribes to topic filters, publishes messages in order, prints everything that arrives while it listens, then disconnects. The exit code is 3 when it can't connect (for example when the broker refuses the login).

```bash
testpion mqtt mqtt://127.0.0.1:4016 -s 'clinic/+/vitals' -w 5000
MQTT_PASSWORD=… testpion mqtt mqtts://broker.example.com -u vet -s 'clinic/7/acks' -p 'clinic/7/commands={"action":"recheck"}' -q 1 --json
```

| Option | Description |
|---|---|
| `-s, --subscribe <topic...>` | Topic filters to subscribe to first (`+` and `#` wildcards). |
| `-p, --publish <topic=payload...>` | Messages to publish, in order. |
| `-q, --qos <0\|1\|2>` | QoS for the subscriptions and messages (default 0). |
| `--retain` | Publish retained messages. |
| `-i, --client-id <id>` | Client ID (default: random). |
| `-u, --username <name>` | Username. The password is read from the environment variable named by `--password-env` (default `MQTT_PASSWORD`), never from the command line. |
| `--mqtt5` | Use MQTT 5 (default 3.1.1). |
| `-w, --wait <ms>` | How long to listen after publishing (default 1500). |
| `--json` | Print the result as JSON, for scripts and AI agents. |

## `kafka`

Connects to a [Kafka cluster](/api-testing/websocket#kafka), reads topics (new messages, or with `-b` from the beginning) in a consumer group of its own, produces messages in order, prints everything that arrives while it listens, then disconnects. The exit code is 3 when it can't connect.

```bash
testpion kafka kafka://127.0.0.1:4017 -r clinic.events -b
KAFKA_PASSWORD=… testpion kafka kafkas://broker.example.com:9094 -u app --mechanism scram-sha-512 -r confirmations -p 'orders={"id":42}' -k order-42 -H source:testpion --json
```

| Option | |
|---|---|
| `-r, --read <topic...>` | Topics to read (new messages). |
| `-b, --from-beginning` | Read the topics from the beginning. |
| `-p, --produce <topic=value...>` | Messages to produce, in order. |
| `-k, --key <key>` | The key of the produced messages. |
| `-H, --header <name:value...>` | Headers of the produced messages. |
| `-g, --group <id>` | Consumer group (default: one of its own). |
| `-u, --username`, `--mechanism`, `--password-env` | SASL login; the password comes from an environment variable (default `KAFKA_PASSWORD`). |
| `-w, --wait <ms>` | How long to listen after producing (default 3000). |
| `--json` | The result as JSON. |

## `grpc`

Calls a [gRPC](/api-testing/grpc) method described by `.proto` files (or, without `-p`, by the server through server reflection), or lists the methods (with example requests) when no method is given. The exit code is 0 for status `OK` and 1 otherwise.

```bash
testpion grpc localhost:4014 -p protos/vet/v1/pets.proto                  # list methods
testpion grpc localhost:4014 vet.v1.PetService/GetPet -p protos/vet/v1/pets.proto -d '{"id": "1"}'
testpion grpc grpcs://api.example.com vet.v1.PetService/ListPets -p pets.proto -H "authorization:Bearer $TOKEN" --json
```

| Option | Description |
|---|---|
| `-p, --proto <files...>` | The `.proto` files, including the ones they import. Leave out to use server reflection. |
| `-d, --data <json>` | The request message as JSON (a JSON list for client streaming), or `@file.json`. Default `{}`. |
| `-H, --metadata <key:value...>` | Metadata entries. |
| `--tls` | Use TLS (also on with a `grpcs://` address). |
| `--timeout <ms>` | Deadline (default 30000). |
| `--json` | Print the result as JSON, for scripts and AI agents. |

## `docs`

Writes the [documentation](/api-testing/collections#documentation) of a collection as Markdown: the collection description, a table of contents, then every folder and request with its description, URL, auth, parameters, headers, body and saved examples. Sensitive values are masked.

```bash
testpion docs "Veterinary API" -o API.md
testpion docs "Veterinary API" --html -o api.html   # one self-contained page to publish
testpion docs api.postman_collection.json > API.md
```

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: nearest `workspace.json`). |
| `-o, --out <file>` | Write to a file instead of standard output. |
| `--no-examples` | Leave out saved examples. |

## `feedback`

Build a feedback or problem report as Markdown, and a link to a pre-filled GitHub issue (nothing is sent). `-k` is `bug`, `idea`, `ui` or `question`; `--diagnostics` adds the version and platform; home folders and secret-looking values are masked.

```bash
testpion feedback -k idea -t "Import Swagger 2 examples" -m "Examples in Swagger 2 files are not imported" --json
```

## `agents-md`

Write (or refresh) the TestPion section of `AGENTS.md` in the workspace folder, for coding agents (Claude Code, Codex, Cursor, Copilot): how to use the workspace over MCP and the CLI, the check types and the test file format. Text outside the section is kept. `--stdout` prints it instead. See [Use TestPion from AI agents](/ai-testing/mcp-server#agents-md).

```bash
testpion agents-md -w my-workspace
```

## `jwt`

Decode a JSON Web Token: header, claims, when it was issued and when it expires. The signature is not verified. A `Bearer ` prefix is fine; `-` reads the token from standard input.

```bash
testpion jwt eyJhbGciOiJIUzI1NiJ9...
curl -s https://auth.example.com/token | jq -r .access_token | testpion jwt -
testpion jwt "$TOKEN" --json
```

## `export` and `export-environment`

Convert a collection to a Postman v2.1 collection, or write an environment in Postman's environment format. See [Export](/api-testing/collections#export) for what the Postman format can hold.

```bash
testpion export "Veterinary API" -o vet.postman_collection.json
testpion export my.collection.json -f postman > out.json    # convert a file
testpion export-environment Staging -o staging.postman_environment.json
```

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: nearest `workspace.json`). |
| `-f, --format` | `postman` (default) or `testpion` (`export` only). |
| `-o, --out <file>` | Write to a file instead of standard output. |

Parts that Postman can't represent are listed on standard error as `not exported: …`. Secret environment values are never written.

## `import`

```bash
testpion import openapi.yaml -w my-workspace
testpion import ./bruno/clinic-api -w my-workspace      # a Bruno collection folder (bruno.json + .bru files)
testpion export "Clinic API" -w my-workspace --format bruno --out ./bruno/clinic-api   # and back
testpion import 'http://127.0.0.1:4010/soap/patients?wsdl' -w my-workspace   # a SOAP service's WSDL
# a request copied from browser devtools (cURL for bash or cmd, fetch, PowerShell), from a file or stdin
testpion import copied-request.txt -w my-workspace --collection "Checkout API" --folder "Cart" --json
pbpaste | testpion import - -w my-workspace
```

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (required). |
| `--collection <name>` | For a copied request: the collection to add it to, created if needed (default **Imported**). |
| `--folder <path>` | For a copied request: folder path inside the collection, such as `"Auth / Tokens"`. |
| `--name <name>` | For a copied request: its name (default: the method and path, e.g. `POST /v1/owners`). |
| `--no-contract-checks` | For an OpenAPI / Swagger document: don't add `openapi` contract checks to the imported requests (the document is still kept in `specs/`). |
| `--keep-pm` | For a Postman or Insomnia file: keep `pm.*` in scripts. By default they are converted to TestPion's `tp.*` and the output says `Converted N scripts to tp.*` (`pm.*` runs either way; `testpion export -f postman` turns `tp.*` back into `pm.*`). |
| `--json` | Print the result as JSON, for scripts and AI agents (includes `specPath` and `contractChecks` for OpenAPI imports, and `scripts` — `{ converted, unchanged: [{ where, reason }] }` — for Postman and Insomnia imports). |

Secrets in a copied request (the `Authorization` header and other sensitive headers, auth credentials, cookies, and sensitive query or body fields) are not written to the workspace. They are replaced by `{{variables}}`, and the output lists them (`placeholders` with `--json`) so you can add them as secret environment variables.

## `scripts convert`

```bash
testpion scripts convert --to tp -w my-workspace --dry-run --json   # what would change
testpion scripts convert --to tp -w my-workspace --collection "Checkout API"
```

Rewrites collection, folder and request scripts written for Postman to TestPion's `tp.*` (or back to Postman's name with `--to pm`). Both names always run in TestPion; only code changes, not strings or comments, and scripts that declare their own `tp` are skipped and listed.

## `history`

```bash
testpion history list -w my-workspace --request "List patients" --json   # newest first
testpion history stats -w my-workspace --request "List patients" --json  # median, p95, slowest, failed
testpion history diff h-abc h-def -w my-workspace --json                  # older id first
testpion history activity -w my-workspace --days 30 --json              # per-day requests, failures, runs
testpion history test "Authentication / Basic auth" -w my-workspace     # one test across the latest runs; flags flaky ones
testpion history flaky -w my-workspace                                  # every test that flips between runs (exit 1 if any)
testpion history scores -w my-workspace -q "Intent"                     # mean score per evaluator, run by run
testpion history mcp-tools -w my-workspace --server weather            # MCP tool calls per tool: count, failures, median / p95
testpion history llm -w my-workspace                                    # AI Lab prompts per model: tokens, estimated cost, median time
```

`history list` shows recent responses of requests sent in the app (`--collection`, `--request`, `--failed`, `-n/--limit`). `history stats` summarises the response times of a request's recent responses (`-n/--limit`, default 50): count, failed (no status or 400+), fastest, mean, median, p95 and slowest. `history diff` compares two of them: the status, timing, header changes (volatile ones such as `date` are flagged) and a field-by-field JSON body diff, or a line diff for text. Values of sensitive fields and headers are masked. `history activity` is the Home dashboard as data: per local day, requests sent and how many failed (4xx/5xx, transport errors, non-OK gRPC codes, MCP tool errors), the median response time, test runs and failed tests; plus requests per type and the slowest requests on average (`-d/--days`, default 14, up to 90).

## `monitor`

```bash
testpion monitor add "API health" --collection "My API" --folder Smoke --every 15m -e Staging -w my-workspace
testpion monitor add "API health" --collection "My API" --every 5m --max-p95 800 -w my-workspace   # also fail when p95 > 800 ms
testpion monitor add "API health" --collection "My API" --every 1h --min-cert-days 21 -w my-workspace   # and when a certificate expires within 21 days
testpion monitor run --due -w my-workspace      # for cron; exit 1 if a run failed
testpion monitor uptime "API health" -w my-workspace --days 90   # uptime per day, like a status page
testpion monitor requests "API health" -w my-workspace          # each request over the latest runs: median / p95, failures
testpion monitor start -w my-workspace          # keep running them until Ctrl+C
```

`list`, `results`, `uptime` and `add` take `--json`. See [Monitors](/test-runner/monitors).

## `ci`

```bash
testpion ci github -w . --suite regression -e Staging -o .github/workflows/testpion.yml
testpion ci gitlab -w api-tests --collection "My API" --folder Smoke --workspace-dir api-tests
testpion ci jenkins -w . --tests rest graphql --json
```

Writes a pipeline for GitHub Actions, GitLab CI, Azure Pipelines or Jenkins that installs the CLI (pinned to this version), runs the suite, collection or tests, publishes `junit.xml` and keeps the reports. Without `-o` it prints the file; the CI secrets to create are listed on stderr (and under `secrets` with `--json`). See [CI/CD](/test-runner/ci-cd#generate-a-pipeline).

## `env`

```bash
testpion env list -w my-workspace --json          # environments in display order, variable names only
testpion env diff Staging Production -w my-workspace --values   # what differs (exit 1 if anything does)
testpion env diff Staging Production --request "List patients" -w my-workspace   # send it to both, diff the responses
testpion env matrix -w my-workspace                         # every variable in every environment: set, empty, missing or off
testpion env order Development Staging Production -w my-workspace
```

`env order` sets the order of the environment picker. Environments you don't name keep their order after the named ones. Both commands take `--json`.

## `mcp-server`

Serves a workspace to AI agents over MCP on stdio: `list_collections`, `list_requests`, `get_request`, `list_environments`, `collection_docs`, `send_request`, `grpc_call`, `realtime_exchange` and `run_collection`. See [Use TestPion from AI agents](/ai-testing/mcp-server).

```bash
testpion mcp-server -w my-workspace
testpion mcp-server --read-only
```

| Option | Description |
|---|---|
| `-w, --workspace` | Workspace name or directory (default: nearest `workspace.json`). |
| `--read-only` | Only the browsing tools; no requests are sent. |
| `--allow-production` | Allow sending to environments marked as production. |
| `--block-private-networks` | Refuse requests to localhost, private networks and cloud metadata addresses, and don't start local (stdio) MCP servers. For shared or hosted use; see [Network policy](/security/privacy#network-policy-shared-and-hosted-servers). |
| `--allow-host <host...>` | With `--block-private-networks`: hosts that stay reachable. |

A test file or suite with an `expose:` block is served as a tool of its own, named after `expose.tool`, with its `inputs` as arguments; `testpion flows` lists them (see [Your flows as tools](/ai-testing/mcp-server#your-flows-as-tools)).

:::
