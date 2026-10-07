---
title: "What's new: how to use it"
description: "Step by step: the HTTP Debugger, Git compare and conflicts, the API definition tabs (Preview, Lint, Fuzz, Generate tests), test data, database datasets, secrets from a secret manager, AsyncAPI, .http files, Kafka, GraphQL subscriptions in tests and the variable popover."
---

::: v-pre

# What's new: how to use it

The options added in 0.44, each with the steps to use it and a link to the full reference. Every one also works from the terminal (`testpion …`, with `--json`) and for AI agents (an MCP tool of `testpion mcp-server`).

## HTTP Debugger: see what other programs send

The **Debugger** (on the rail, and a tile on Home) shows the HTTP traffic of other programs (a browser, a mobile app, a script, a service you are building) as it happens.

1. Open **Debugger** and click **Start capturing**. The proxy listens on `127.0.0.1` and shows its address.
2. Point a program at it with **Capture**: open a browser through it (Chrome, Edge, Firefox or Brave, in a profile of their own), open a terminal with `HTTP_PROXY` set, copy the lines for a shell, or switch the Windows **system proxy** to TestPion (it is switched back when you stop or quit).
3. Use the program. Every request appears in the grid: #, Offset, Duration, Method, Version, URL, Status, Type, Size, Speed, Application, Domain and IP Address (sort by any column, choose the columns, Ctrl/Shift+click several). Filter by application, domain, type, method, status or text (**In bodies** searches the bodies too); ↑ ↓ Enter, Delete, Ctrl+F and Ctrl+E work in the list, and the footer totals what is listed.
4. Click a row: **Request Details** and **Response Details** open side by side, each a header table with **Header**, **Content**, **Raw** and **JSON** tabs at the bottom (plus **Auth**, **Hex**, **gRPC**, **Frames**, **Events**). **Open** makes it a request tab, **Resend** sends it again, **Ask AI** explains it.
5. The **tool rail** on the left opens a panel on the right: **Filter** (Filter Out and Capture Only rules, with hits), **Highlight** (rules like *Status is between 400 and 499* in your colours, bold or the whole row), **Auto-Reply**, **Modify**, **Timeline** (sending, waiting, receiving; several requests on one axis), **Summary**, **Structure** (domains and paths with counts and sizes), **Performance** (the slowest, the largest, by domain) and **Convert** (URL, Base64, hex, HTML, JWT). Right-click a row to turn its program, URL, domain, method or IP into one of these rules. **Incoming requests** (under the grid) lists what your programs sent to TestPion's mock servers.

**HTTPS.** HTTPS shows as a tunnel by host until you choose **Decrypt HTTPS**: a root certificate made on this computer (trust it with one click; **Settings** shows how to remove it) lets the Debugger read the traffic of programs that trust it. Hosts can stay encrypted. WebSocket frames and Server-Sent Events show live; HTTP/2 and gRPC calls are decoded (with the workspace's `.proto` files when it has them).

**Rules** change the traffic on the way: capture only, filter out, highlight, modify headers or the body, reply with a canned response (the server never sees the request), redirect to another host, or set a **breakpoint** that pauses a request or response in a dialog so you can edit it. **Rule** on a row adds *Reply with this response from now on*. Rules live in `debugger/rules.json`, shared through git.

**Sessions.** **Session ▸ Save** keeps a capture as a HAR file in `debugger/`; AutoSave keeps the live one every minute; HAR and Fiddler `.saz` files open too. **Compare** shows two exchanges side by side.

**A phone or another computer.** **Capture ▸ A phone or another computer** listens on the network and shows QR codes; the page they open has the proxy settings and, with HTTPS decryption on, the certificate to install.

While capturing, the **status bar** shows *Debugger :port* wherever you are, in the warning colour when rules change traffic or the system proxy points at TestPion; click it to come back. Terminal: `testpion debug`; agents: `debugger_capture`, `debugger_exchanges`, `debugger_rules`. [More](/api-testing/http-debugger)

## Git: compare, conflicts side by side, history

- **Compare a change.** In the **Git** view, **Compare** on a changed request, folder, collection setting or environment shows it side by side with the last commit, part by part (request line, params, headers, auth, body, scripts, checks).
- **Conflicts side by side.** After a pull that conflicts, **Compare…** on the file shows each conflict with the version before, yours and theirs. Pick **Mine** or **Theirs** per conflict, then **Resolve with these choices**; every change that didn't conflict stays. Environments merge variable by variable and library files item by item, like collections.
- **Branches.** The branch menu renames the current branch and deletes another (an unmerged one asks again).
- **History.** **History in git…** on a request, a collection or an environment lists its versions, each compared with now; **Restore this version** puts it back as a change to commit.
- **Open tabs follow the disk.** After a pull or branch switch, open requests show the new version; a tab with unsaved edits asks **Keep mine** or **Take the new version**.

[More](/getting-started/git#merging-collections-request-by-request)

## Commit without leaking secrets

Before a commit, the Git view lists every secret the commit would publish (a token typed into a header, a password in a body …), grouped by where it is. **Open** goes to it; **Fix** moves the value into a secret variable of the active environment (kept in the OS credential store) and leaves `{{variable}}` in its place; **Fix all** does every one. [More](/getting-started/git#the-secret-guard)

## Editors that know what they edit

- **Test files (YAML):** keys complete with a line of help for the test's type, check types complete under `assertions:` (or `checks:`), hovering a key explains it, and mistakes are underlined a moment after you type (an unknown type or check, a key the runner doesn't read, a `dependsOn` nobody defines). The same checks run as `testpion lint-tests`.
- **JSON bodies:** when a request belongs to an API definition in `specs/`, its body completes and is checked against the operation's schema (fields, required ones, types); a line above the body names the operation.
- **Scripts:** `tp.*` (and `pm.*`) complete, and `{{braces}}` in a script aren't flagged as missing variables.

## API definitions: Preview, Lint, Fuzz, Generate tests

An API definition is an OpenAPI or Swagger document kept in the workspace's `specs/` folder. **Import** an OpenAPI file and it is kept there; open it from **API definitions** in the Collections sidebar.

### Preview: read the API like its docs

1. Open the definition and choose the **Preview** tab.
2. The operations are grouped by tag. Click one to see its parameters (required ones have `*`), its request body and each response, with schemas written as short type outlines.
3. **Open as request** puts the operation in a request tab with the server address, path parameters as `{{variables}}` and an example body. Fill the values and send.

Terminal: `testpion openapi-ops specs/clinic.yaml` (`--tag pets`, `--json`). Agents: `openapi_outline`.

### Generate tests: a first suite in one click

1. In **Preview**, click **Generate tests** and confirm.
2. TestPion writes `tests/<api>/<tag>.yaml` for each tag and `tests/<api>.suite.yaml`. Each operation gets its example request, checked for the documented status, the OpenAPI contract and latency, plus one invalid request that must get a 4xx.
3. Open **Tests**, look at the example values (ids, tokens, bodies) and change what your API needs, then run the suite with the right environment.

Files that already exist are kept. Terminal: `testpion tests-from-spec specs/clinic.yaml`. Agents: `generate_tests`. [More](/test-runner/overview#a-first-suite-from-an-api-definition)

### Lint: find mistakes in the document

1. Choose the **Lint** tab. The badge on it counts errors (red) or warnings (amber).
2. Each row says what is wrong and where. Click it and the **Definition** tab opens on that line, selected.
3. While you edit the definition, problems are underlined as you type.
4. **How to fix (AI)** asks the assistant for the changes, grouped by rule.

Errors are things that break tools and clients: a `$ref` to nothing, a `{param}` in a path with no parameter for it, two operations with one operationId, an undefined security scheme. Warnings and notes point at gaps such as an example that doesn't match its schema or an operation without a success response.

Terminal: `testpion openapi-lint` lints every document in `specs/` and exits 1 on errors, which suits a CI step. Agents: `openapi_lint`. [All rules](/test-runner/ci-cd#lint-api-definitions)

### Fuzz: find the input your API mishandles

1. Start the API locally (or a test copy) and choose the environment with its `{{baseUrl}}` and token, or type the **Base URL**.
2. Choose the **Fuzz** tab and click **Fuzz**. Each operation gets its valid example, then requests that break one rule of the schema at a time.
3. Read the findings:
   - **Server errors**: the API answered 5xx. These are bugs.
   - **Invalid input accepted**: a 2xx for input the document forbids. Validation is missing, or the document is wrong.
   - **Undocumented statuses**: answers the document doesn't list.
   - **Not authorized**: the token was missing or wrong, so that operation wasn't judged. Choose an environment that has the token.
4. Click a finding to see the request and the response; **Open as request** reproduces it. **Explain and fix (AI)** says where to look.
5. **Save as tests** writes the server errors and accepted invalid inputs as tests that expect a 4xx (`tests/<api>/fuzz-findings.yaml`): they pass once the API is fixed, and keep it fixed.

Fuzzing sends real requests, some that create or change data. It only targets local or private-network hosts unless you switch on **Allow remote hosts**, never runs with a production environment, and leaves DELETE out unless you switch on **Include DELETE**.

Terminal: `testpion fuzz specs/clinic.yaml --base-url http://localhost:3000 -e Development`. Agents: `api_fuzz`. [More](/test-runner/ci-cd#fuzz-an-api)

## Test data for data-driven runs

### Generate rows

1. Open a collection's **Run** tab (the Collection Runner) and find **Data**.
2. Click **Generate…**.
3. Choose **From an API operation** (an API definition and an operation with a JSON body) or **From a JSON schema** (write the fields of one row).
4. Give it a name and the number of rows, then **Generate**. The rows are saved as `datasets/<name>.csv` and become the run's data: each row is one iteration, and `{{column}}` reads a value.

Values fit each field: one of its enum values, its format (email, UUID, date), its range and length, or what its name suggests (`email`, `firstName`, `city`, `price`, `createdAt` …). Terminal: `testpion generate-data patients --spec specs/clinic.yaml --operation "POST /patients" --rows 50`. Agents: `generate_dataset`. [More](/test-runner/datasets#generate-test-data)

### Rows from PostgreSQL or MySQL

1. In the Collection Runner's **Data**, click **Database…**.
2. Type the connection URL, with the password in a secret variable: `postgres://app:{{dbPassword}}@localhost:5432/shop` (or `mysql://…`).
3. Pick a table, or write a `SELECT`. The preview shows the rows; each one is an iteration.

Only one read-only `SELECT` runs, in a read-only transaction. Terminal: `testpion run-collection "Shop" -d postgres://… --iteration-query "SELECT …"`. [More](/test-runner/datasets#postgresql-and-mysql)

## Secrets from a secret manager

Keep a secret in 1Password, HashiCorp Vault, AWS Secrets Manager, Azure Key Vault or Google Secret Manager, and point a variable at it.

1. Sign in to the manager's own command-line tool on your computer: `op`, `vault`, `aws`, `az` or `gcloud`.
2. In **Environments**, set a variable's value to a reference, for example `op://Clinic/API/credential` or `vault://secret/clinic#apiKey`.
3. Send a request that uses `{{apiKey}}`. The first time, TestPion shows the exact command it would run; **Allow on this computer** remembers it for this workspace.
4. Under the variables, the environment shows which ones come from a manager and whether they were read. **Read again** fetches them after you rotate a secret.

The reference is safe to commit: it holds no secret, and each person reads the value with their own access. Terminal: `testpion secrets Development` checks the references. [All reference formats](/api-testing/environments#secrets-from-a-secret-manager)

## A variable: which value is used, and why

1. Click a `{{variable}}` in the URL bar, params or headers (double-click in other fields).
2. The popover shows its value and scope. **Where it's set** opens the overview on that variable:
   - **This request uses** gives the value and the scope it comes from;
   - every scope follows in the order they win (collection, environment, workspace, globals), marked **used**, **overridden**, **turned off** or **not set**, with **Edit**.
3. A variable that is set nowhere says so, with **Add to** the active environment. **Show all variables** goes back to the full list.

[More](/api-testing/environments#see-or-change-one-variable)

## A smoke run: only the GET requests

1. Open a collection's **Run** tab.
2. Click **Only GET**: only the requests that read (GET, HEAD) stay ticked, so the run changes nothing on the server.
3. Choose the environment and **Run**. The results show which endpoints answer and which fail.

In a long list, the filter above the requests narrows it by name, folder or method, and **Select all** / **Deselect all** act on what it shows. From the terminal: `testpion run-collection "Master Collections" -e Development --method GET`.

## Tidy up a collection

1. Open a collection and choose **Tools ▸ Tidy up…** in its header.
2. Read the findings: duplicate requests, hosts typed into URLs, empty folders, unused variables.
3. Tick the fixes to make and **Remove what is ticked** (**Undo** puts it back). For a typed-in host, **Use a variable…** opens Replace with the host filled in.

[More](/api-testing/collections#tidy-up)

## Find and replace in a collection

1. Open a collection and choose **Tools ▸ Find and replace…** in its header.
2. Type what to find and what to put instead. Every change is listed (request, where, before and after) before anything is saved.
3. Narrow it with **Match case**, **Regular expression** and the **Look in** chips (URLs, params, headers, bodies, auth, scripts, names), then **Replace**. **Undo** in the message puts the collection back.

[More](/api-testing/collections#find-and-replace)

## Base URLs per environment: move collection variables

A collection variable wins over the environment, so the same value is used in every environment. When **Where it's set** shows the collection's value is used, click **Move to environments…** (also on the collection's **Variables** tab). Tick the variables and environments, check the preview, then **Move**, and set each environment's value. [More](/api-testing/environments#move-collection-variables-to-environments)

## The collection Overview and Tools menu

- **Overview ▸ Request health** lists the requests sent from the app (failing first, then the slowest). The chips above it switch to **Not sent yet** or **Without checks**, with their counts; when nothing has been sent it offers **Run the collection**.
- **Tools** in the collection header holds **Find and replace…**, **Tidy up…**, **Move variables to environments…** and **Security review…** (secrets typed in, secrets in URLs, plain http, TLS checks turned off). **Export** offers TestPion, Postman, OpenAPI, Bruno, `.http` and AsyncAPI.

## Collection name

In a collection's settings the name is plain text. **Double-click** it (or press F2 or Enter on it) to rename it in place. **Enter** saves the new name and **Escape** keeps the old one, as when renaming a request.

## Realtime: Kafka, AsyncAPI

### Kafka

1. Open **WebSocket** on the rail and choose **Kafka**.
2. Type the brokers (`kafka://localhost:9092`, several separated by commas; `kafkas://` for TLS).
3. In **Topics**, add the topics to read (switch on *from the beginning* to see old messages), then **Connect**.
4. In **Produce**, choose the topic, a key and headers, write the message and **Produce**. Each message shows its topic, partition, offset, key and headers.

[More](/api-testing/websocket#kafka)

### Check realtime messages against AsyncAPI

Add `{ type: asyncapi, spec: specs/asyncapi/events.yaml }` to a WebSocket, MQTT or Kafka test's assertions: each received message must match one of the messages its channel declares. A message that doesn't says which one, on which channel, and what is wrong. For plain WebSocket, add `channel: /path`. [More](/api-testing/websocket#check-messages-against-an-asyncapi-document)

### Import and export AsyncAPI

1. **Import** an AsyncAPI 2 or 3 document. Each channel becomes a saved connection: a Kafka topic, an MQTT topic, a WebSocket path or a Socket.IO event, with its example messages ready to send. The servers become an environment named after the API, such as *Clinic events servers*.
2. Choose that environment and open a connection from the collection.
3. The document is listed under **API definitions** (marked ASYNC). Its **Preview** shows the servers and each channel: whether the API publishes or consumes there, and its messages with their payloads and examples.
4. To test the channels, click **Generate tests** in the Preview (or run `testpion tests-from-spec specs/asyncapi/<api>.yaml`). Each channel gets a test that sends the example and checks what comes back with the `asyncapi` check.
5. **Export ▸ AsyncAPI 3.0** turns a collection's connections into a document.

In a realtime test, `{ type: asyncapi, spec: specs/asyncapi/events.yaml }` fails a message that doesn't match its channel. [More](/api-testing/collections#asyncapi)

## .http files (VS Code REST Client, JetBrains)

1. **Import** a `.http` or `.rest` file. It becomes a collection named after the file: one request per `###` block, `@name = value` lines as collection variables.
2. Requests that read another one's response (`{{login.response.body.$.token}}`) work when the collection runs, and JetBrains `> {% … %}` handlers run as tests.
3. **Export ▸ .http file** writes a collection back as one file for those tools.

[More](/api-testing/collections#http-files)

## GraphQL subscriptions in tests

A test file or a collection run with a `subscription` subscribes and checks the first event like a query's response:

```yaml
name: Vitals arrive
type: graphql
endpoint: "{{graphqlEndpoint}}"
query: "subscription { vitals(pet: 7) { beat } }"
events: 3          # wait for three events (default 1)
wait: 15000        # at most 15 seconds (default 10)
checks:            # checks: works as well as assertions:
  - { type: equals, path: $.count, expected: 3 }
```

[More](/graphql/subscriptions#in-test-files-and-collection-runs)

## The CLI on npm

`npx testpion --help` runs the CLI without cloning the repository, once a release is published to npm. In CI, pin the version: `npx testpion@0.44.0 run …`. [More](/installation/cli)

:::
